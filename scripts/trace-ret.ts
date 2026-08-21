/**
 * API-return tracer: wraps interceptor.dispatch to log every API call with its
 * return value (HRESULT for WinRT, errorCode for Win32) so we can see exactly
 * where notepad-x64 bails before reaching its message loop.
 *
 *   node node_modules/.cache/trace-ret.mjs apps/web/public/win/notepad-x64.exe
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  ApiInterceptorImpl,
  GuestProcessRunner,
  JitEngineImpl,
  PeLoaderImpl,
  registerDefaultHandlers,
  WasmRuntimeImpl,
} from '@specter-core/core';

async function main(): Promise<void> {
  const [file] = process.argv.slice(2);
  if (!file) { console.error('usage: trace-ret <exe>'); process.exit(2); }
  const image = new Uint8Array(await readFile(file));
  const modulePath = resolve(file);
  const runtime = new WasmRuntimeImpl();
  const host = {
    memory: {
      read: (a: number, l: number) => runtime.readBytes(a, l),
      write: (a: number, d: Uint8Array) => runtime.writeBytes(a, d),
    },
    fs: {
      createFile: async () => ({ handle: 0, error: 2 }),
      readFile: async () => ({ bytesRead: 0, data: new Uint8Array(0), error: 2 }),
      writeFile: async () => ({ bytesWritten: 0, error: 5 }),
      setFilePointer: async () => ({ newPointer: 0, error: 2 }),
      getFileSize: async () => 0,
      getFilePointer: () => 0,
      closeHandle: async () => 0,
      findFirstFile: async () => ({ searchHandle: 0, entries: [], error: 2 }),
      findNextFile: async () => ({ entries: [], error: 2 }),
      findClose: async () => {},
      createDirectory: async () => 5,
      removeDirectory: async () => 2,
      deleteFile: async () => 5,
      getFileAttributes: async () => ({ attributes: 0, error: 2 }),
      setFileAttributes: async () => 5,
      moveFile: async () => 5,
      lockFile: async () => 120,
      unlockFile: async () => 120,
      releaseAll: async () => {},
      onChange: () => () => {},
    },
  } as never;

  const interceptor = new ApiInterceptorImpl(host);
  registerDefaultHandlers(interceptor);

  const readHstr = (h: number): string => {
    if (!h) return '(null)';
    const len = runtime.readInt32(h - 8);
    if (len < 0 || len > 0x400) return `(len=${len})`;
    const b = runtime.readBytes(h, len * 2);
    let s = '';
    for (let i = 0; i + 1 < b.byteLength; i += 2) {
      const c = b[i]! | (b[i + 1]! << 8);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  };

  const events: string[] = [];
  const origDispatch = interceptor.dispatch.bind(interceptor);
  const safeReadStr = (h: number): string => {
    try { return readHstr(h); } catch { return '(err)'; }
  };
  const guid = (p: number): string => {
    try {
      if (!p) return '(null)';
      const b = runtime.readBytes(p, 16);
      const h = (n: number) => (n ?? 0).toString(16).padStart(2, '0');
      const g = (off: number, len: number) => {
        let s = '';
        for (let i = off; i < off + len; i++) s += h(b[i]);
        return s;
      };
      return `{${g(0, 4)}-${g(4, 2)}-${g(6, 2)}-${g(8, 2)}${g(10, 2)}-${g(12, 6)}}`;
    } catch { return '(err)'; }
  };
  interceptor.dispatch = async (ctx: { module: string; proc: string; rawArgs?: number[] }) => {
    const name = `${ctx.module}!${ctx.proc}`;
    const res = (await origDispatch(ctx)) as { returnValue: number; errorCode: number };
    const rv = (res?.returnValue ?? 0) >>> 0;
    const failed = (rv & 0x80000000) !== 0 || (res?.errorCode ?? 0) !== 0;
    let extra = '';
    const proc = String(ctx.proc).toLowerCase();
    try {
      if (proc === 'rogetactivationfactory') extra = ` class="${safeReadStr((ctx.rawArgs?.[0] ?? 0) >>> 0)}"`;
      if (proc === 'cocreateinstance') extra = ` rclsid=${guid((ctx.rawArgs?.[0] ?? 0) >>> 0)} riid=${guid((ctx.rawArgs?.[1] ?? 0) >>> 0)}`;
      if (proc.startsWith('com_')) {
        const a = (ctx.rawArgs ?? []).map((x) => '0x' + ((x ?? 0) >>> 0).toString(16)).slice(0, 4);
        extra = ` this=0x${(ctx.rawArgs?.[0] ?? 0).toString(16)} args=[${a.join(',')}]`;
      }
    } catch { extra = ' (meta-err)'; }
    events.push(`${failed ? 'FAIL ' : 'ok   '} ${name}${extra} rv=0x${rv.toString(16)} ec=${res?.errorCode ?? 0}`);
    if (events.length > 200) events.shift();
    return res;
  };

  const runner = new GuestProcessRunner(
    runtime,
    new JitEngineImpl(runtime),
    new PeLoaderImpl(),
    interceptor,
  );

  const result = await runner.run(image, {
    createEngine: (mode) => new JitEngineImpl(runtime, mode),
    modulePath,
    readFile: async () => null,
    onOutput: () => {},
  });

  console.log(`\n=== last ${events.length} API events ===`);
  for (const e of events) console.log(e);
  console.log(`\n[result] status=${result.status} eip=0x${result.eip.toString(16)} exitCode=${result.exitCode}`);
}

main().catch((e) => { console.error('failed', e); process.exit(1); });