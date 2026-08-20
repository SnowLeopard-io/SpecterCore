/**
 * Debug: trace which API traps the guest hits, in order, to see where the
 * x64 startup diverges from a clean ExitProcess path.
 *   node scripts/trace-x64.mjs <exe>
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
  if (!file) {
    console.error('usage: trace-x64 <path-to.exe>');
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

  const called: string[] = [];
  const tail: number[] = [];
  const origDispatch = interceptor.dispatch.bind(interceptor);
  interceptor.dispatch = (ctx: { module: string; proc: string; rawArgs?: number[] }) => {
    const name = `${String(ctx.module)}!${String(ctx.proc)}`;
    called.push(name);
    if (String(ctx.proc).toLowerCase() === 'shgetknownfolderpath') {
      const rsp = runtime.getReg('rsp');
      const ret = runtime.readInt32(rsp);
      console.log(`[shg] rsp=0x${rsp.toString(16)} ret=0x${ret.toString(16)} args=${(ctx.rawArgs ?? []).map((a) => '0x' + (a >>> 0).toString(16)).join(',')}`);
      const out = (ctx.rawArgs?.[3] ?? 0) >>> 0;
      console.log(`[shg] out=0x${out.toString(16)} [out]=0x${out ? runtime.readInt32(out) : 0} [out+4]=0x${out ? runtime.readInt32(out + 4) : 0}`);
    }
    return origDispatch(ctx);
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
    probes: [],
    onStep: (eip, rt) => {
      tail.push(eip);
      if (tail.length > 120) tail.shift();
      if (eip >= 0x1008000 && eip <= 0x1022100) {
        console.log(`[t] 0x${eip.toString(16)} rsp=0x${rt.getReg('rsp').toString(16)}`);
      }
      if (eip === 0x1022092) {
        const rsp = rt.getReg('rsp');
        const words: string[] = [];
        for (let i = 0; i < 12; i++) words.push(`[rsp+0x${(i * 8).toString(16)}]=0x${rt.readInt32(rsp + i * 8).toString(16)}:0x${rt.readInt32(rsp + i * 8 + 4).toString(16)}`);
        console.log(`[epilogue] rsp=0x${rsp.toString(16)} ${words.join(' ')}`);
        console.log(`[epilogue] rax=0x${rt.getReg('rax').toString(16)} rdi=0x${rt.getReg('rdi').toString(16)} rbx=0x${rt.getReg('rbx').toString(16)}`);
      }
    },
  });

  const counts = new Map<string, number>();
  for (const c of called) counts.set(c, (counts.get(c) ?? 0) + 1);
  const unique = [...counts.entries()].map(([n, c]) => `${n}x${c}`).join(' ');
  console.log(`[trace] status=${result.status} eip=0x${result.eip.toString(16)} traps=${called.length}`);
  console.log(`[trace] calls: ${unique}`);
  console.log(`[trace] last 20: ${called.slice(-20).join(' ')}`);
  console.log(`[trace] tail eips: ${tail.map((e) => '0x' + e.toString(16)).join(' ')}`);
}

main().catch((error) => {
  console.error('[trace] failed', error);
  process.exit(1);
});