/**
 * Debug harness: dump the 64-bit number formatter loop (0x4317b4) in cmd.exe
 * to understand why 4-digit sizes format as "31,024" instead of "1,024".
 *
 *   node scripts/cmd-dir-debug.ts [path/to/cmd.exe]
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

class QuietInterceptor extends ApiInterceptorImpl {
  constructor(host: ApiHost) {
    super(host);
  }
  override async dispatch(ctx: ApiCallContext): Promise<ApiResult> {
    return super.dispatch(ctx);
  }
}

async function seed(store: FileStore, path: string, data: Uint8Array): Promise<void> {
  const f = await store.openFile(path, 'create');
  await f.write(0, data);
  await f.close();
}

async function main(): Promise<void> {
  const file = resolve(process.argv[2] ?? 'C:/Windows/SysWOW64/cmd.exe');
  const image = new Uint8Array(await readFile(file));
  const modulePath = 'C:/Windows/SysWOW64/cmd.exe';

  const store = new MemoryFileStore('C', 2 * 1024 * 1024 * 1024);
  const dirs = ['Windows', 'Windows/SysWOW64', 'Windows/SysWOW64/en-US', 'Windows/SysWOW64/zh-CN', 'Users', 'Users/Guest', 'Users/Guest/Desktop', 'Windows/Fonts'];
  for (const d of dirs) {
    const parts = d.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const p = parts.slice(0, i).join('/');
      try {
        await store.createDirectory(p);
      } catch {
        /* already exists */
      }
    }
  }
  await seed(store, 'Windows/SysWOW64/cmd.exe', image);
  for (const lang of ['en-US', 'zh-CN']) {
    try {
      const mui = new Uint8Array(await readFile(`C:/Windows/System32/${lang}/cmd.exe.mui`));
      await seed(store, `Windows/SysWOW64/${lang}/cmd.exe.mui`, mui);
    } catch {
      /* MUI optional */
    }
  }
  const files: Array<[string, number]> = [
    ['Users/Guest/Desktop/c-1024.txt', 1024],
  ];
  for (const [p, n] of files) {
    await seed(store, p, new Uint8Array(n).fill(0x41));
  }

  const runtime = new WasmRuntimeImpl();
  const host = {
    memory: {
      read: (address: number, length: number) => runtime.readBytes(address, length),
      write: (address: number, data: Uint8Array) => runtime.writeBytes(address, data),
    },
    fs: new FileSystemBridgeImpl(store),
  } as unknown as ApiHost;
  const interceptor = new QuietInterceptor(host);
  registerDefaultHandlers(interceptor);

  const runner = new GuestProcessRunner(
    runtime,
    new JitEngineImpl(runtime),
    new PeLoaderImpl(),
    interceptor,
  );

  // Bug18-style separator probe is still applied so we observe the loop with
  // the production setup; the dump probe is what we're studying.
  const probes = [
    {
      eip: 0x4317b4,
      fn: (rt: WasmRuntimeImpl) => {
        const rd32 = (a: number): number => {
          const b = rt.readBytes(a >>> 0, 4);
          return b.byteLength < 4 ? 0 : new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true);
        };
        const ebp = rt.getReg('ebp') >>> 0;
        const b = new Uint8Array(4);
        new DataView(b.buffer).setUint32(0, 1, true);
        rt.writeBytes((ebp - 0xd8) >>> 0, b);
        // --- dump loop state ---
        const regs = ['eax', 'ecx', 'edx', 'esi', 'edi', 'ebx'] as const;
        const vals = regs.map((r) => rt.getReg(r) >>> 0);
        const buf = rd32(ebp - 0xd0) >>> 0;
        let w = '';
        for (let i = 0; i < 12; i++) {
          const c = rd32(buf + i * 2) & 0xffff;
          if (c === 0) break;
          w += String.fromCharCode(c);
        }
        const [eax, ecx, edx, esi, edi, ebx] = vals;
        console.error(`[loop] eax=${eax.toString(16)} ecx=${ecx.toString(16)} edx=${edx.toString(16)} esi=${esi.toString(16)} edi=${edi.toString(16)} ebx=${ebx.toString(16)} buf=${buf.toString(16)} w="${w}"`);
      },
    },
    {
      // dump wcsncpy_s entry (0x4136f0): ecx=dst, edx=dstSize, [esp+4]=src
      eip: 0x4136f0,
      fn: (rt: WasmRuntimeImpl) => {
        const rd32 = (a: number): number => {
          const b = rt.readBytes(a >>> 0, 4);
          return b.byteLength < 4 ? 0 : new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true);
        };
        const rw = (addr: number, max = 32): string => {
          let s = '';
          for (let i = 0; i < max; i++) {
            const c = rd32(addr + i * 2) & 0xffff;
            if (c === 0) break;
            s += String.fromCharCode(c);
          }
          return s;
        };
        const ecx = rt.getReg('ecx') >>> 0;
        const edx = rt.getReg('edx') >>> 0;
        const esp = rt.getReg('esp') >>> 0;
        const src = rd32(esp + 4) >>> 0;
        if (src && rd32(src) === 0x1024) {
          console.error(`[cpy] ecx(dst)=${ecx.toString(16)} edx(dstSize)=${edx.toString(16)} src=${src.toString(16)} srcW="${rw(src)}" dstW="${rw(ecx)}"`);
          // dump the wchar right BEFORE dst to see the residue
          const before = rd32(ecx - 2) & 0xffff;
          console.error(`[cpy] dst[-1]='${String.fromCharCode(before)}' dst[-2]='${String.fromCharCode(rd32(ecx - 4) & 0xffff)}'`);
        }
      },
    },
    {
      // dump wcsncpy_s exit (0x41374a ret) — dst content after copy
      eip: 0x41374a,
      fn: (rt: WasmRuntimeImpl) => {
        const rd32 = (a: number): number => {
          const b = rt.readBytes(a >>> 0, 4);
          return b.byteLength < 4 ? 0 : new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true);
        };
        const esp = rt.getReg('esp') >>> 0;
        const retAddr = rd32(esp) >>> 0;
        // the dst is in ecx? No — at ret, ecx is modified by the copy loop.
        // Reconstruct from the frame: saved dst was in edi at 0x4318ef path.
        // Simpler: log return site only; the value dump at entry is enough.
        if (retAddr === 0x4318f9) {
          console.error(`[cpy-return] caller=0x4318f9`);
        }
      },
    },
    {
      // dump 0x42e327 (padding formatter) entry: ecx=obj, edx=arg
      eip: 0x42e327,
      fn: (rt: WasmRuntimeImpl) => {
        const rd32 = (a: number): number => {
          const b = rt.readBytes(a >>> 0, 4);
          return b.byteLength < 4 ? 0 : new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true);
        };
        const rw = (addr: number, max = 48): string => {
          let s = '';
          for (let i = 0; i < max; i++) {
            const c = rd32(addr + i * 2) & 0xffff;
            if (c === 0) break;
            s += String.fromCharCode(c);
          }
          return s;
        };
        const ecx = rt.getReg('ecx') >>> 0;
        const edx = rt.getReg('edx') >>> 0;
        const savedLen = rd32(ecx + 8) >>> 0;
        const bufPtr = rd32(ecx + 0x10) >>> 0;
        console.error(`[pad-in] ecx=${ecx.toString(16)} edx=${edx.toString(16)} savedLen=${savedLen.toString(16)} bufPtr=${bufPtr.toString(16)} lineW="${rw(bufPtr)}"`);
      },
    },
    {
      // dump 0x42e327 exit (ret): line buffer after padding
      eip: 0x42e3e7,
      fn: (rt: WasmRuntimeImpl) => {
        const rd32 = (a: number): number => {
          const b = rt.readBytes(a >>> 0, 4);
          return b.byteLength < 4 ? 0 : new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true);
        };
        const rw = (addr: number, max = 48): string => {
          let s = '';
          for (let i = 0; i < max; i++) {
            const c = rd32(addr + i * 2) & 0xffff;
            if (c === 0) break;
            s += String.fromCharCode(c);
          }
          return s;
        };
        const ebx = rt.getReg('ebx') >>> 0;
        const savedLen = rd32(ebx + 8) >>> 0;
        const bufPtr = rd32(ebx + 0x10) >>> 0;
        console.error(`[pad-out] savedLen=${savedLen.toString(16)} bufPtr=${bufPtr.toString(16)} lineW="${rw(bufPtr)}"`);
      },
    },
    {
      // dump vswprintf wrapper entry (0x41d755): ecx=obj, edx=fmt,
      // [esp+4]=arg0 (points at the formatted size string)
      eip: 0x41d755,
      fn: (rt: WasmRuntimeImpl) => {
        const rd32 = (a: number): number => {
          const b = rt.readBytes(a >>> 0, 4);
          return b.byteLength < 4 ? 0 : new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true);
        };
        const rw = (addr: number, max = 48): string => {
          let s = '';
          for (let i = 0; i < max; i++) {
            const c = rd32(addr + i * 2) & 0xffff;
            if (c === 0) break;
            s += String.fromCharCode(c);
          }
          return s;
        };
        const ecx = rt.getReg('ecx') >>> 0;
        const edx = rt.getReg('edx') >>> 0;
        const esp = rt.getReg('esp') >>> 0;
        const arg0 = rd32(esp + 4) >>> 0;
        // 0x402c20 is the size-field fmt from the 0x430e52 caller
        if (edx === 0x402c20 || edx === 0x403e74) {
          const fmt = edx === 0x402c20 ? 'size-fmt' : 'name-fmt';
          const savedLen = rd32(ecx + 8) >>> 0;
          const bufPtr = rd32(ecx + 0x10) >>> 0;
          console.error(`[vsw] fmt=${fmt} ecx=${ecx.toString(16)} savedLen=${savedLen.toString(16)} bufPtr=${bufPtr.toString(16)} arg0=${arg0.toString(16)} arg0W="${rw(arg0)}" lineW="${rw(bufPtr)}" tail="${rw(bufPtr + savedLen * 2 - 4)}"`);
        }
      },
    },
    {
      // dump vswprintf exit (0x41d7e2 leave): line buffer after append
      eip: 0x41d7e2,
      fn: (rt: WasmRuntimeImpl) => {
        const rd32 = (a: number): number => {
          const b = rt.readBytes(a >>> 0, 4);
          return b.byteLength < 4 ? 0 : new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true);
        };
        const rw = (addr: number, max = 48): string => {
          let s = '';
          for (let i = 0; i < max; i++) {
            const c = rd32(addr + i * 2) & 0xffff;
            if (c === 0) break;
            s += String.fromCharCode(c);
          }
          return s;
        };
        const ebx = rt.getReg('ebx') >>> 0;
        const savedLen = rd32(ebx + 8) >>> 0;
        const bufPtr = rd32(ebx + 0x10) >>> 0;
        console.error(`[vsw-exit] ebx=${ebx.toString(16)} savedLen=${savedLen.toString(16)} lineW="${rw(bufPtr)}"`);
      },
    },
  ];

  setTimeout(() => runner.postInput('dir C:\\Users\\Guest\\Desktop\r\n'), 2000);
  setTimeout(() => runner.postInput('exit\r\n'), 8000);

  let out = '';
  const result = await runner.run(image, {
    createEngine: (mode) => new JitEngineImpl(runtime, mode),
    modulePath,
    commandLine: '',
    interactive: true,
    cwd: 'C:\\Windows',
    patches: [{ va: 0x41dea0, bytes: [0xc3] }],
    probes,
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
    },
  });
  console.error(`\n[diag] exitCode=${result.exitCode}`);
  const clean = out.replace(/\0/g, '');
  console.error(clean);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
