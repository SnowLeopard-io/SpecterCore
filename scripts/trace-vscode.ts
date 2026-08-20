/**
 * Trace：运行 32 位 VSCode 安装器，记录每次 API 调用的【返回地址】(=调用指令
 * 的下一条地址，从栈顶 [esp] 读出)，用于判断执行流是「逻辑早退」还是
 * 「后续基本块执行错位」。零核心文件改动。
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ApiCallContext, ApiHost, ApiInterceptor, ApiResult, FileSystemBridge, WinError } from '@specter-core/contracts';
import {
  ApiInterceptorImpl,
  GuestProcessRunner,
  JitEngineImpl,
  PeLoaderImpl,
  registerDefaultHandlers,
  WasmRuntimeImpl,
} from '@specter-core/core';

const E_NO_ERROR = 0;
const TRACE_TAIL = 60;

class TracingInterceptor extends ApiInterceptorImpl implements ApiInterceptor {
  private tail: string[] = [];
  private errored: string[] = [];
  private count = 0;
  constructor(host: ApiHost, private readonly rt: WasmRuntimeImpl) {
    super(host);
  }
  async dispatch(ctx: ApiCallContext): Promise<ApiResult> {
    this.count++;
    const before = this.count;
    // 调用 API 指令的【下一条】地址 = CALL 压栈的返回地址，位于 [esp]。
    let ra = 0;
    try {
      const esp = this.rt.getReg('esp');
      ra = this.rt.readInt32(esp);
    } catch {
      /* ignore */
    }
    const result = await super.dispatch(ctx);
    const args = (ctx.rawArgs ?? []).slice(0, 6).map((a) => `0x${(a >>> 0).toString(16)}`).join(',');
    const line = `#${before} ${ctx.module}.${ctx.proc} ra=0x${(ra >>> 0).toString(16)} (${args}) -> rv=0x${(result.returnValue >>> 0).toString(16)} err=${result.errorCode}`;
    this.tail.push(line);
    if (this.tail.length > TRACE_TAIL) this.tail.shift();
    if (result.errorCode !== E_NO_ERROR) {
      this.errored.push(line);
      if (this.errored.length > 200) this.errored.shift();
    }
    return result;
  }
  dump(entryVa: number): void {
    console.error(`\n[trace] total API calls: ${this.count}  entry VA = 0x${entryVa.toString(16)}`);
    if (this.errored.length) {
      console.error(`\n[trace] === calls returning ERROR (${this.errored.length}) ===`);
      for (const l of this.errored) console.error('  ' + l);
    }
    console.error(`\n[trace] === last ${this.tail.length} calls (with return addresses) ===`);
    for (const l of this.tail) console.error('  ' + l);
  }
}

function buildExeFs(exePath: string, exeBytes: Uint8Array): FileSystemBridge {
  const handles = new Map<number, { ptr: number }>();
  let next = 1;
  const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();
  const self = norm(exePath);
  const ok0 = 0 as WinError;
  const notFound = 2 as WinError;
  const denied = 5 as WinError;
  const invalidHandle = 6 as WinError;
  return {
    async createFile(path) {
      if (norm(path) === self) {
        handles.set(next, { ptr: 0 });
        return { handle: next++, error: ok0 };
      }
      return { handle: 0, error: notFound };
    },
    async readFile(handle, bytesToRead) {
      const rec = handles.get(handle);
      if (!rec) return { bytesRead: 0, data: new Uint8Array(0), error: invalidHandle };
      const end = Math.min(rec.ptr + bytesToRead, exeBytes.length);
      const data = exeBytes.slice(rec.ptr, end);
      rec.ptr = end;
      return { bytesRead: data.length, data, error: ok0 };
    },
    async writeFile() {
      return { bytesWritten: 0, error: denied };
    },
    async setFilePointer(handle, distance, moveMethod) {
      const rec = handles.get(handle);
      if (!rec) return { newPointer: 0xffffffff, error: invalidHandle };
      const base = moveMethod === 2 ? exeBytes.length : moveMethod === 1 ? rec.ptr : 0;
      rec.ptr = Math.max(0, base + distance);
      return { newPointer: rec.ptr, error: ok0 };
    },
    async getFileSize() {
      return exeBytes.length;
    },
    getFilePointer(handle) {
      return handles.get(handle)?.ptr ?? 0;
    },
    async closeHandle(handle) {
      handles.delete(handle);
      return ok0;
    },
    async findFirstFile() {
      return { searchHandle: 0, entries: [], error: notFound };
    },
    async findNextFile() {
      return { entries: [], error: notFound };
    },
    async findClose() {},
    async createDirectory() {
      return denied;
    },
    async removeDirectory() {
      return notFound;
    },
    async deleteFile() {
      return denied;
    },
    async getFileAttributes() {
      return { attributes: 0x20, error: ok0 };
    },
    async setFileAttributes() {
      return denied;
    },
    async moveFile() {
      return denied;
    },
    async lockFile() {
      return 120 as WinError;
    },
    async unlockFile() {
      return 120 as WinError;
    },
    async releaseAll() {
      handles.clear();
    },
    onChange() {
      return () => {};
    },
  };
}

async function main(): Promise<void> {
  const [file] = process.argv.slice(2);
  if (!file) {
    console.error('usage: node trace-vscode.mjs <path-to.exe>');
    process.exit(2);
  }

  const image = new Uint8Array(await readFile(file));
  const modulePath = resolve(file);

  const runtime = new WasmRuntimeImpl();
  const host = {
    memory: {
      read: (address: number, length: number) => runtime.readBytes(address, length),
      write: (address: number, data: Uint8Array) => runtime.writeBytes(address, data),
    },
    fs: buildExeFs(modulePath, image),
  } as unknown as ApiHost;

  const interceptor = new TracingInterceptor(host, runtime);
  registerDefaultHandlers(interceptor);
  // 实验性：GetVersionExW 默认实现写死 284 字节，若安装器传入 276 字节的
  // OSVERSIONINFOW 会越界踩栈。这里改成按传入的 dwOSVersionInfoSize 精确写入。
  interceptor.hook('kernel32.dll', 'GetVersionExW', (ctx) => {
    const out = ctx.rawArgs[0] ?? 0;
    if (!out) return { returnValue: 0, errorCode: 0 };
    const size = runtime.readInt32(out);
    const n = Math.max(4, Math.min(size || 284, 284));
    const w = new Uint8Array(n);
    const view = new DataView(w.buffer);
    view.setUint32(0, n, true); // dwOSVersionInfoSize 回写原值
    view.setUint32(4, 10, true); // dwMajorVersion
    view.setUint32(8, 0, true); // dwMinorVersion
    view.setUint32(12, 19045, true); // dwBuildNumber
    view.setUint32(16, 2, true); // dwPlatformId = WIN32_NT
    runtime.writeBytes(out, w);
    return { returnValue: 1, errorCode: 0 };
  });
  const runner = new GuestProcessRunner(
    runtime,
    new JitEngineImpl(runtime),
    new PeLoaderImpl(),
    interceptor,
  );

  const result = await runner.run(image, {
    createEngine: (mode) => new JitEngineImpl(runtime, mode),
    modulePath,
    readFile: async (p) => {
      try {
        return new Uint8Array(await readFile(p));
      } catch {
        return null;
      }
    },
    onOutput: (bytes, stderr) => {
      process[stderr ? 'stderr' : 'stdout'].write(Buffer.from(bytes));
    },
  });

  console.error(`\n[trace] status=${result.status} cleanExit=${result.cleanExit} eip=0x${result.eip.toString(16)} exitCode=${result.exitCode}`);
  if (result.output.byteLength > 0) console.error(`[trace] stdout: ${JSON.stringify(new TextDecoder().decode(result.output))}`);
  if (result.stderrOutput.byteLength > 0) console.error(`[trace] stderr: ${JSON.stringify(new TextDecoder().decode(result.stderrOutput))}`);
  if (result.error) console.error(`[trace] error:`, result.error);
  interceptor.dump(0x4b5eec);
}

main().catch((error) => {
  console.error('[trace] failed', error);
  process.exit(1);
});
