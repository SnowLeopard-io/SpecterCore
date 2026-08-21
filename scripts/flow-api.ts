/**
 * API-call tracer for any guest exe. Logs every trap dispatch (module.proc,
 * raw args, return address, return value / error) plus the last N basic blocks
 * before a fault, so a bad return address can be traced to the API that
 * corrupted the stack.
 *
 *   node flow-api.mjs <exe> [tailCount]
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

const FLOW_CAP = 6000;
const eips = new Int32Array(FLOW_CAP);
const esps = new Int32Array(FLOW_CAP);
const tags: Array<string | null> = new Array(FLOW_CAP).fill(null);
let total = 0;

function pushStep(eip: number, esp: number): void {
  const i = total % FLOW_CAP;
  eips[i] = eip | 0;
  esps[i] = esp | 0;
  tags[i] = null;
  total++;
}

function tagCurrent(text: string): void {
  if (total === 0) return;
  const i = (total - 1) % FLOW_CAP;
  tags[i] = tags[i] ? `${tags[i]} | ${text}` : text;
}

function sectionOf(va: number): string {
  const rva = (va >>> 0) - 0x1000000;
  if (rva >= 0x1000 && rva < 0x1f000) return '.text';
  if (rva >= 0x1f000 && rva < 0x1f400) return '.rdata';
  if (rva >= 0x1f400 && rva < 0x20000) return '.data';
  if ((va >>> 0) === 0) return 'NULL';
  if ((va >>> 0) >= 0x70000000) return 'stub/fake-dll';
  return '?';
}

function dumpFlow(tailCount: number): void {
  const start = Math.max(0, total - Math.min(FLOW_CAP, tailCount));
  console.error(`\n[flow] total basic blocks executed: ${total}`);
  console.error(`[flow] === last ${total - start} blocks (eip / esp / section) ===`);
  let prevEsp = -1;
  for (let k = start; k < total; k++) {
    const i = k % FLOW_CAP;
    const eip = eips[i] >>> 0;
    const esp = esps[i] >>> 0;
    const dEsp = prevEsp < 0 ? '' : (() => {
      const d = esp - prevEsp;
      return d === 0 ? '' : ` (esp${d > 0 ? '+' : ''}${d})`;
    })();
    prevEsp = esp;
    const tag = tags[i] ? `   <<< ${tags[i]}` : '';
    console.error(
      `  [${String(k).padStart(6)}] eip=0x${eip.toString(16).padStart(8, '0')} ` +
        `esp=0x${esp.toString(16)}${dEsp} ${sectionOf(eip)}${tag}`,
    );
  }
}

class ApiTracer extends ApiInterceptorImpl implements ApiInterceptor {
  private count = 0;
  constructor(host: ApiHost, private readonly rt: WasmRuntimeImpl) {
    super(host);
  }
  async dispatch(ctx: ApiCallContext): Promise<ApiResult> {
    this.count++;
    const n = this.count;
    let ra = 0;
    try {
      ra = this.rt.readInt32(this.rt.getReg('esp')) >>> 0;
    } catch {
      /* ignore */
    }
    const args = (ctx.rawArgs ?? []).map((a) => `0x${(a >>> 0).toString(16)}`).join(',');
    const result = await super.dispatch(ctx);
    console.error(
      `[api] #${n} ${ctx.module}.${ctx.proc}(${args}) ra=0x${ra.toString(16)} ` +
        `-> 0x${(result.returnValue >>> 0).toString(16)} err=${result.errorCode}`,
    );
    tagCurrent(
      `API #${n} ${ctx.module}.${ctx.proc} ra=0x${ra.toString(16)} ` +
        `-> 0x${(result.returnValue >>> 0).toString(16)} err=${result.errorCode}`,
    );
    return result;
  }
  get apiCount(): number {
    return this.count;
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
  const [file, tailArg] = process.argv.slice(2);
  if (!file) {
    console.error('usage: node flow-api.mjs <path-to.exe> [tailCount]');
    process.exit(2);
  }
  const tailCount = tailArg ? Number(tailArg) : 120;

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

  const interceptor = new ApiTracer(host, runtime);
  registerDefaultHandlers(interceptor);
  const runner = new GuestProcessRunner(runtime, new JitEngineImpl(runtime), new PeLoaderImpl(), interceptor);

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
    onStep: (eip, rt) => pushStep(eip, rt.getReg('esp')),
    onOutput: (bytes, stderr) => {
      process[stderr ? 'stderr' : 'stdout'].write(Buffer.from(bytes));
    },
  });

  const label =
    result.status === 'exit'
      ? result.cleanExit
        ? `exit code ${result.exitCode}`
        : `entry returned WITHOUT ExitProcess (startup aborted, eip=0x${result.eip.toString(16)})`
      : result.status === 'fault'
        ? 'fault'
        : result.status === 'trap'
          ? 'trapped'
          : 'step limit reached';
  console.error(`\n[run] ${label} (eip=0x${result.eip.toString(16)}, stubs=${result.stubs.length}, api=${interceptor.apiCount})`);
  dumpFlow(tailCount);
  if (result.error) console.error('[run] error:', result.error);
}

main().catch((error) => {
  console.error('[flow-api] failed', error);
  process.exit(1);
});
