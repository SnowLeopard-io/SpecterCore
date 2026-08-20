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
    console.error(`[trap] ${name} idx=${called.length}`);
    if (String(ctx.proc).toLowerCase() === 'resolvedelayloadedapi') {
      console.error(`[rd] ResolveDelayLoadedAPI args=${(ctx.rawArgs ?? []).map((a) => '0x' + (a >>> 0).toString(16)).join(',')}`);
    }
    if (String(ctx.proc).toLowerCase() === 'rogetactivationfactory') {
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
      const classId = (ctx.rawArgs?.[0] ?? 0) >>> 0;
      const iid = (ctx.rawArgs?.[1] ?? 0) >>> 0;
      const iidBytes = iid ? [...runtime.readBytes(iid, 16)].map((x) => x.toString(16).padStart(2, '0')).join('') : 'null';
      console.error(`[raf] class="${readHstr(classId)}" iid=${iidBytes} out=0x${((ctx.rawArgs?.[2] ?? 0) >>> 0).toString(16)}`);
    }
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
    maxSteps: 1_500_000,
    onStep: (eip, rt) => {
      tail.push(eip);
      if (tail.length > 120) tail.shift();
      if (eip === 0x1022025) {
        const d = rt.getReg('rdx');
        const off = rt.getReg('rbx') * 2;
        const words: string[] = [];
        for (let i = 0; i < 16; i++) words.push(`${[...rt.readBytes((d + i * 2) >>> 0, 2)].map(x=>x.toString(16).padStart(2,'0')).join('')}`);
        console.error(`[wcs] rbx=0x${rt.getReg('rbx').toString(16)} [rdx+0..]: ${words.join(' ')}`);
        if (rt.getReg('rbx') === 0) {
          const dump: string[] = [];
          for (let i = 0; i < 64; i += 4) dump.push(`+${i.toString(16).padStart(2,'0')}=${rt.readInt32((d + i) >>> 0).toString(16)}`);
          console.error(`[wcs] rdx=0x${d.toString(16)} dump: ${dump.join(' ')}`);
        }
      }
      if (eip >= 0x1026f00 && eip <= 0x1027600) {
        console.error(`[dl] 0x${eip.toString(16)} rax=0x${rt.getReg('rax').toString(16)} rsp=0x${rt.getReg('rsp').toString(16)}`);
        if (eip === 0x10274e0) console.error(`[dl] IAT[0x102a450]=0x${rt.readInt32(0x102a450).toString(16)}`);
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