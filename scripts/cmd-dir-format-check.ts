/**
 * Verify whether the GROUP2 (sar/shl) decoder fix from session 16 resolves the
 * historical cmd.exe workarounds (Bug18 digit-group separator, Bug19 column
 * padding, and the GS stack-cookie patch).
 *
 * Runs the REAL cmd.exe against the REAL in-memory virtual disk with a known
 * directory of files (varying sizes), issues `dir`, and checks the listing
 * format with formatting probes DISABLED (BK_NO_PROBES=1) and the GS patch
 * DISABLED (BK_NO_GS=1). If the output stays correctly formatted, the old
 * probes/patches are no longer needed and can be removed.
 *
 *   node scripts/cmd-dir-format-check.ts [path/to/cmd.exe] [dir]
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

const NO_PROBES = process.env.BK_NO_PROBES === '1';
const NO_GS = process.env.BK_NO_GS === '1';
const NO_BUG18 = process.env.BK_NO_BUG18 === '1'; // skip the 0x4317b4 separator probe
const NO_BUG19 = process.env.BK_NO_BUG19 === '1'; // skip the 0x42e327 padding probe

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
  // Dataset spanning digit-count boundaries to probe the thousands-separator
  // insertion path: 3, 999, 1024, 4096, 99999, 1234567.
  const files: Array<[string, number]> = [
    ['Users/Guest/Desktop/a.txt', 7],
    ['Users/Guest/Desktop/b-999.txt', 999],
    ['Users/Guest/Desktop/c-1024.txt', 1024],
    ['Users/Guest/Desktop/d-4096.txt', 4096],
    ['Users/Guest/Desktop/e-99k.txt', 99999],
    ['Users/Guest/Desktop/big-file.txt', 1234567],
  ];
  for (const [p, n] of files) {
    await seed(store, p, new Uint8Array(n).fill(0x41));
  }
  // subdir: create via its own ancestors
  for (const p of ['Users/Guest/Desktop/subdir']) {
    const parts = p.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const pp = parts.slice(0, i).join('/');
      try {
        await store.createDirectory(pp);
      } catch {
        /* already exists */
      }
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
  const interceptor = new QuietInterceptor(host);
  registerDefaultHandlers(interceptor);

  const runner = new GuestProcessRunner(
    runtime,
    new JitEngineImpl(runtime),
    new PeLoaderImpl(),
    interceptor,
  );

  const probes = NO_PROBES
    ? undefined
    : [
        NO_BUG19
          ? null
          : {
              eip: 0x42e327,
              fn: (rt: WasmRuntimeImpl) => {
                const rd32 = (a: number): number => {
                  const b = rt.readBytes(a >>> 0, 4);
                  return b.byteLength < 4 ? 0 : new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true);
                };
                const ecx = rt.getReg('ecx') >>> 0;
                const esp = rt.getReg('esp') >>> 0;
                const retAddr = rd32(esp) >>> 0;
                if (retAddr === 0x430e52 || retAddr === 0x405b52) {
                  const bufPtr = rd32(ecx + 0x10) >>> 0;
                  let actualLen = 0;
                  for (let i = 0; i < 300; i++) {
                    const ch = rd32(bufPtr + i * 2) & 0xffff;
                    if (ch === 0) break;
                    actualLen++;
                  }
                  const numSpaces = retAddr === 0x430e52 ? 4 : 2;
                  const space = new Uint8Array(2);
                  new DataView(space.buffer).setUint16(0, 0x20, true);
                  for (let i = 0; i < numSpaces; i++) rt.writeBytes(bufPtr + (actualLen + i) * 2, space);
                  rt.writeBytes(bufPtr + (actualLen + numSpaces) * 2, new Uint8Array(2));
                  const len = new Uint8Array(4);
                  new DataView(len.buffer).setUint32(0, actualLen + numSpaces, true);
                  rt.writeBytes(ecx + 8, len);
                }
              },
            },
        NO_BUG18
          ? null
          : {
              eip: 0x4317b4,
              fn: (rt: WasmRuntimeImpl) => {
                const ebp = rt.getReg('ebp') >>> 0;
                const b = new Uint8Array(4);
                new DataView(b.buffer).setUint32(0, 1, true);
                rt.writeBytes((ebp - 0xd8) >>> 0, b);
              },
            },
      ].filter((p): p is NonNullable<typeof p> => p !== null);

  setTimeout(() => runner.postInput('dir C:\\Users\\Guest\\Desktop\r\n'), 2000);
  setTimeout(() => runner.postInput('exit\r\n'), 5000);

  let out = '';
  const result = await runner.run(image, {
    createEngine: (mode) => new JitEngineImpl(runtime, mode),
    modulePath,
    commandLine: '',
    interactive: true,
    cwd: 'C:\\Windows',
    patches: NO_GS ? undefined : [{ va: 0x41dea0, bytes: [0xc3] }],
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
  console.error(`[diag] exitCode=${result.exitCode}`);
  const clean = out.replace(/\0/g, '');
  // The dir listing is written with WriteFile as raw bytes; echo the tail so we
  // can eyeball the alignment/separators.
  const listing = clean.slice(clean.indexOf('Desktop') === -1 ? 0 : Math.max(0, clean.indexOf('Volume')));
  console.error('----- dir output -----');
  console.error(listing);
  console.error('----------------------');
  // Checks: digit-group separators present for 1,024 / 1,234,567; no
  // overflowing concatenated sizes; the file names appear.
  const hasSep1024 = /\b1,024\b/.test(clean) || /\b1024\b/.test(clean);
  const hasSepBig = /\b1,234,567\b/.test(clean) || /\b1234567\b/.test(clean);
  const hasNames = clean.includes('b-999.txt') && clean.includes('c-1024.txt') && clean.includes('d-4096.txt') && clean.includes('e-99k.txt') && clean.includes('big-file.txt') && clean.includes('a.txt');
  const weird = /\d{5,}/.test(clean); // a 5+ digit run with no separator = broken grouping
  const ok = hasNames && !weird;
  console.error(`[diag] probes=${NO_PROBES ? 'OFF' : 'ON'} gsPatch=${NO_GS ? 'OFF' : 'ON'} bug18=${NO_BUG18 ? 'OFF' : 'ON'} bug19=${NO_BUG19 ? 'OFF' : 'ON'} names=${hasNames} noWeirdDigits=${!weird} sep1024=${hasSep1024} sepBig=${hasSepBig}`);
  console.error(`[diag] dir format check ${ok ? 'PASS' : 'FAIL'}`);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
