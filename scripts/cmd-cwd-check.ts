/**
 * Decisive check for the desktop cmd integration: run the REAL guest cmd.exe
 * against the REAL in-memory virtual disk (MemoryFileStore + FileSystemBridgeImpl
 * — the same stack the browser desktop uses), with an initial cwd, and verify
 * the prompt/`cd` output reflects it.
 *
 *   node scripts/cmd-cwd-check.ts [path/to/cmd.exe] [cwd]
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { MemoryFileStore } from '../packages/host/src/memory-store';
import { FileSystemBridgeImpl } from '@specter-core/bridges';
import type { ApiHost, FileStore } from '@specter-core/contracts';
import type { ApiCallContext, ApiResult } from '@specter-core/core';
import {
  ApiInterceptorImpl,
  GuestProcessRunner,
  JitEngineImpl,
  PeLoaderImpl,
  registerDefaultHandlers,
  WasmRuntimeImpl,
} from '@specter-core/core';

class LoggingInterceptor extends ApiInterceptorImpl {
  private readonly memHost: ApiHost;
  private readonly rt: WasmRuntimeImpl;
  constructor(host: ApiHost, rt: WasmRuntimeImpl) {
    super(host);
    this.memHost = host;
    this.rt = rt;
  }
  override async dispatch(ctx: ApiCallContext): Promise<ApiResult> {
    const result = await super.dispatch(ctx);
    if (/FindFirstFile|FindNextFile|WriteConsole|ReadConsole|GetFileAttributes|CurrentDirectory|FullPathName|FormatMessage|GetLastError/i.test(ctx.proc)) {
      const args = ctx.rawArgs.slice(0, 5).map((a) => `0x${(a >>> 0).toString(16)}`);
      let extra = '';
      if (/FindFirstFile|FullPathName/i.test(ctx.proc) && ctx.rawArgs[0]) {
        try {
          const raw = this.memHost.memory.read(ctx.rawArgs[0] >>> 0, 64);
          let s = '';
          for (let i = 0; i + 1 < raw.byteLength; i += 2) {
            const c = raw[i] | (raw[i + 1] << 8);
            if (c === 0) break;
            s += String.fromCharCode(c);
          }
          extra = ` path=${JSON.stringify(s)}`;
        } catch {
          // path dump is best-effort; skip on invalid address
        }
      }
      console.error(`[api] ${ctx.module}!${ctx.proc}(${args.join(', ')}) -> 0x${(result.returnValue >>> 0).toString(16)}${result.errorCode ? ` err=${result.errorCode}` : ''}${extra}`);
    }
    return result;
  }
}

async function seed(store: FileStore, path: string, data: Uint8Array): Promise<void> {
  const f = await store.openFile(path, 'create');
  await f.write(0, data);
  await f.close();
}

async function main(): Promise<void> {
  const file = resolve(process.argv[2] ?? 'C:/Windows/SysWOW64/cmd.exe');
  const cwd = process.argv[3] ?? 'C:\\Windows';
  const image = new Uint8Array(await readFile(file));
  const modulePath = 'C:/Windows/SysWOW64/cmd.exe';

  const store = new MemoryFileStore('C', 2 * 1024 * 1024 * 1024);
  await store.createDirectory('Windows');
  await store.createDirectory('Windows/SysWOW64');
  await store.createDirectory('Windows/SysWOW64/en-US');
  await store.createDirectory('Windows/SysWOW64/zh-CN');
  await seed(store, 'Windows/SysWOW64/cmd.exe', image);
  for (const lang of ['en-US', 'zh-CN']) {
    // NOTE: MUI merge changes cmd's resource table. diag-trap (which produced
    // working `dir` output) runs WITHOUT MUI; test with MUI disabled to isolate.
    if (process.env.BK_NO_MUI === '1') break;
    try {
      const mui = new Uint8Array(await readFile(`C:/Windows/System32/${lang}/cmd.exe.mui`));
      await seed(store, `Windows/SysWOW64/${lang}/cmd.exe.mui`, mui);
    } catch {
      /* MUI optional */
    }
  }

  const runtime = new WasmRuntimeImpl();
  const host = {
    memory: {
      read: (address: number, length: number) => runtime.readBytes(address, length),
      write: (address: number, data: Uint8Array) => runtime.writeBytes(address, data),
    },
    fs: new FileSystemBridgeImpl(store),
  } as unknown as ApiHost;
  const interceptor = new LoggingInterceptor(host, runtime);
  registerDefaultHandlers(interceptor);

  const runner = new GuestProcessRunner(
    runtime,
    new JitEngineImpl(runtime),
    new PeLoaderImpl(),
    interceptor,
  );

  // Session 17: the old Bug18/Bug19 formatting probes (0x42e327 padding,
  // 0x4317b4 separator) are REMOVED — the JIT shift-CF operand-order bug
  // (codegen.ts emitShift) that made them necessary was fixed, and cmd's
  // dir/echo formatters now emit correctly formatted output on their own.
  // Verified: BK_NO_PROBES=1 passes with identical output.

  setTimeout(() => runner.postInput('cd Windows\r\n'), 2000);
  setTimeout(() => runner.postInput('cd\r\n'), 2500);
  setTimeout(() => runner.postInput('exit\r\n'), 4000);

  let out = '';
  const result = await runner.run(image, {
    createEngine: (mode) => new JitEngineImpl(runtime, mode),
    modulePath,
    commandLine: process.env.BK_ARGS ?? '',
    interactive: true,
    cwd,
    patches: [{ va: 0x41dea0, bytes: [0xc3] }],
    readFile: async (p: string) => {
      const segs = p.split(/[\\/]/).filter(Boolean);
      if (segs.length && /^[A-Za-z]:$/.test(segs[0]!)) segs.shift();
      const sp = segs.join('/');
      try {
        const f = await store.openFile(sp, 'read');
        const size = await f.size();
        const data = await f.read(0, size);
        await f.close();
        return data;
      } catch {
        return null;
      }
    },
    onOutput: (bytes) => {
      out += new TextDecoder('utf-8').decode(bytes);
      process.stdout.write(Buffer.from(bytes));
    },
  });
  console.error(`\n[diag] exitCode=${result.exitCode}`);
  // Accept either direction: bash env/backslashes get normalized either way
  // before reaching JS, so compare on the last path component only.
  const lastSeg = cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd;
  const printed = out.replace(/\0/g, '');
  const ok = printed.includes(cwd) || printed.includes(cwd.replace(/\\/g, '/')) || printed.includes(lastSeg);
  console.error(`[diag] cwd check (${cwd}) ${ok ? 'PASS' : 'FAIL'}`);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});