/**
 * Focused probe: trace notepad's command-line file-open decision chain.
 * Decision points (all verified VAs from static analysis):
 *   0x412807  string prefix compare entry (logs the arg chars)
 *   0x412fdd  GetStartupInfoW dwFlags check (untrusted source?)
 *   0x412c0c  "/.SETUP" switch parser
 *   0x412d8a  "/PT" / "/P" print-switch parser
 *   0x412f3e  "RestartByRestartManager:" check
 *   0x413e2a  file-open entry (arg non-empty?)
 *   0x413e61  CreateFileW call site
 *   0x41382e / 0x413830  window-init path (skip)
 *   0x413f40  join target after file open
 *   0x41392b  [0x429e2c] guard (loader vs skip)
 *   0x41403c  loader skip/inc target
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { MemoryFileStore } from '../packages/host/src/memory-store';
import { FileSystemBridgeImpl } from '@specter-core/bridges';
import type { ApiHost, FileStore } from '@specter-core/contracts';
import {
  ApiInterceptorImpl,
  GuestProcessRunner,
  JitEngineImpl,
  PeLoaderImpl,
  registerDefaultHandlers,
  WasmRuntimeImpl,
} from '@specter-core/core';

const sync = (line: string): void => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('node:fs').writeSync(2, `${line}\n`);
  } catch {
    console.error(line);
  }
};

async function seed(store: FileStore, p: string, data: Uint8Array): Promise<void> {
  const segs = p.split('/');
  const parent = segs.slice(0, -1).join('/');
  if (parent) await store.createDirectory(parent).catch(() => undefined);
  const f = await store.openFile(p, 'create');
  try {
    await f.write(0, data);
  } finally {
    await f.close();
  }
}

class LoggingInterceptor extends ApiInterceptorImpl {
  private readonly rt: WasmRuntimeImpl;
  constructor(host: ApiHost, rt: WasmRuntimeImpl) {
    super(host);
    this.rt = rt;
  }
  override async dispatch(ctx: import('@specter-core/core').ApiCallContext): Promise<import('@specter-core/core').ApiResult> {
    const result = await super.dispatch(ctx);
    if (/CharNextW/i.test(ctx.proc)) return result;
    this.calls += 1;
    // Track the command-line arg buffer: report the FIRST call after which
    // the string at 0x20003b0 changes (pinpoint who clobbers it).
    const now = readW(this.rt, 0x20003b0, 24);
    if (now !== this.cmdlineState && this.calls <= 420) {
      sync(`[clobber] after api#${this.calls} ${ctx.proc}: arg=0x20003b0 -> ${JSON.stringify(now)}`);
      this.cmdlineState = now;
    }
    // Track the JIT context ebx slot (guest addr 0x1018) — handlers must not
    // write into the register context.
    const ebxNow = readDword(this.rt, 0x1018);
    if (ebxNow !== this.ebxState || /CharUpperW/.test(ctx.proc)) {
      const espNow = this.rt.getReg('esp') >>> 0;
      sync(`[ebx] after api#${this.calls} ${ctx.proc}: ctx.ebx=0x${ebxNow.toString(16)} (was 0x${this.ebxState.toString(16)}) esp=0x${espNow.toString(16)}`);
      this.ebxState = ebxNow;
    }
    if (this.calls <= 400 || /CreateFile|ReadFile|GetFileAttributes|CharUpper|GetStartupInfo|GetSystemMenu|SetWindowLong|LoadAccelerator|SetWindowText|vswprintf|SendMessage|EnumFonts|GetTextExtent|GetTextMetrics/i.test(ctx.proc)) {
      let s = '';
      try {
        const addr = result.returnValue >>> 0;
        const bytes = this.rt.readBytes(addr, 60);
        const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        for (let i = 0; i + 1 < bytes.byteLength; i += 2) {
          const c = v.getUint16(i, true);
          if (c === 0) break;
          s += String.fromCharCode(c);
        }
      } catch {
        /* not a string */
      }
      let pathStr = '';
      if (ctx.rawArgs[0]) {
        try {
          const a = ctx.rawArgs[0]!;
          const bytes = this.rt.readBytes(a >>> 0, 160);
          const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
          for (let i = 0; i + 1 < bytes.byteLength; i += 2) {
            const c = v.getUint16(i, true);
            if (c === 0) break;
            pathStr += String.fromCharCode(c);
          }
        } catch {
          /* ignore */
        }
      }
      const extra = s ? ` str=${JSON.stringify(s)}` : '';
      const extraPath = pathStr ? ` a0=${JSON.stringify(pathStr)}` : '';
      console.error(`[api#${this.calls}] ${ctx.proc} ret=0x${(result.returnValue >>> 0).toString(16)}${extra}${extraPath}`);
    }
    return result;
  }
  private calls = 0;
  private cmdlineState = '';
  private ebxState = 0;
}

const readW = (rt: WasmRuntimeImpl, a: number, max = 160): string => {
  try {
    const bytes = rt.readBytes(a >>> 0, max);
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let s = '';
    for (let i = 0; i + 1 < bytes.byteLength; i += 2) {
      const c = v.getUint16(i, true);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  } catch {
    return '?';
  }
};

const readDword = (rt: WasmRuntimeImpl, a: number): number => {
  try {
    const b = rt.readBytes(a >>> 0, 4);
    return new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true) >>> 0;
  } catch {
    return 0;
  }
};

async function main(): Promise<void> {
  const file = resolve(process.argv[2] ?? 'C:/Windows/SysWOW64/notepad.exe');
  const image = new Uint8Array(await readFile(file));
  const modulePath = 'C:/Windows/SysWOW64/notepad.exe';
  const commandLine = 'C:\\Users\\Guest\\Desktop\\hello.txt';

  const store = new MemoryFileStore('C', 2 * 1024 * 1024 * 1024);
  for (const dir of ['Windows', 'Windows/SysWOW64', 'Windows/SysWOW64/en-US', 'Windows/SysWOW64/zh-CN', 'Users', 'Users/Guest', 'Users/Guest/Desktop']) {
    await store.createDirectory(dir);
  }
  await seed(store, 'Windows/SysWOW64/notepad.exe', image);
  for (const lang of ['en-US', 'zh-CN']) {
    try {
      const mui = new Uint8Array(await readFile(`C:/Windows/System32/${lang}/notepad.exe.mui`));
      await seed(store, `Windows/SysWOW64/${lang}/notepad.exe.mui`, mui);
    } catch {
      /* MUI optional */
    }
  }
  const EXPECTED = 'Hello from the virtual disk!';
  await seed(store, 'Users/Guest/Desktop/hello.txt', new TextEncoder().encode(EXPECTED + '\r\n'));

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

  const runner = new GuestProcessRunner(runtime, new JitEngineImpl(runtime), new PeLoaderImpl(), interceptor);

  const probers: Array<{ eip: number; fn: (rt: WasmRuntimeImpl) => void }> = [
    {
      // 0x412807 entry (mov edi,edi) — dump the compare inputs.
      eip: 0x412807,
      fn: (rt) => {
        sync(`[cmp] 0x412807 entry ebx=0x${(rt.getReg('ebx') >>> 0).toString(16)} edx=0x${(rt.getReg('edx') >>> 0).toString(16)} ecx=0x${(rt.getReg('ecx') >>> 0).toString(16)} arg=${JSON.stringify(readW(rt, rt.getReg('edx')))}`);
      },
    },
    { eip: 0x4137c5, fn: (rt) => sync(`[cmp] after /A compare: ebx=0x${(rt.getReg('ebx') >>> 0).toString(16)}`) },
    { eip: 0x4137d1, fn: (rt) => sync(`[cmp] before /W compare: ebx=0x${(rt.getReg('ebx') >>> 0).toString(16)}`) },
    { eip: 0x4137f0, fn: (rt) => sync(`[cmp] after /W compare: ebx=0x${(rt.getReg('ebx') >>> 0).toString(16)} eax=0x${(rt.getReg('eax') >>> 0).toString(16)}`) },
    { eip: 0x4137f4, fn: (rt) => sync(`[cmp] 0x4137f4 (skip token): ebx=0x${(rt.getReg('ebx') >>> 0).toString(16)}`) },
    {
      // 0x412807 epilogue (pop edi; pop esi; pop ebx; ret) — block start.
      eip: 0x412844,
      fn: (rt) => {
        const esp = rt.getReg('esp') >>> 0;
        const ebx = rt.getReg('ebx') >>> 0;
        const s0 = readDword(rt, esp);
        const s1 = readDword(rt, (esp + 4) >>> 0);
        const s2 = readDword(rt, (esp + 8) >>> 0);
        const s3 = readDword(rt, (esp + 0xc) >>> 0);
        sync(`[cmp-ep] 0x412844 esp=0x${esp.toString(16)} ebx=0x${ebx.toString(16)} [esp]=0x${s0.toString(16)} [+4]=0x${s1.toString(16)} [+8]=0x${s2.toString(16)} [+c]=0x${s3.toString(16)}`);
      },
    },
    // Bisect ebx preservation across the internal calls between api#160-164.
    { eip: 0x41335f, fn: (rt) => sync(`[bisect] after 0x41f8cf: ebx=0x${(rt.getReg('ebx') >>> 0).toString(16)}`) },
    { eip: 0x413391, fn: (rt) => sync(`[bisect] after 0x40cdaf: ebx=0x${(rt.getReg('ebx') >>> 0).toString(16)}`) },
    { eip: 0x413396, fn: (rt) => sync(`[bisect] after 0x40ce33: ebx=0x${(rt.getReg('ebx') >>> 0).toString(16)}`) },
    { eip: 0x41339b, fn: (rt) => sync(`[bisect] after 0x412447: ebx=0x${(rt.getReg('ebx') >>> 0).toString(16)}`) },
    { eip: 0x4133a6, fn: (rt) => sync(`[bisect] after 0x4226d4: ebx=0x${(rt.getReg('ebx') >>> 0).toString(16)}`) },
    { eip: 0x4133b3, fn: (rt) => sync(`[bisect] after 0x41fbbe: ebx=0x${(rt.getReg('ebx') >>> 0).toString(16)}`) },
    { eip: 0x4133c4, fn: (rt) => sync(`[bisect] after 0x410133: ebx=0x${(rt.getReg('ebx') >>> 0).toString(16)}`) },
    { eip: 0x4133d2, fn: (rt) => sync(`[bisect] after 0x410133#2: ebx=0x${(rt.getReg('ebx') >>> 0).toString(16)}`) },
    { eip: 0x4133e7, fn: (rt) => sync(`[bisect] after CoTaskMemFree: ebx=0x${(rt.getReg('ebx') >>> 0).toString(16)}`) },
    { eip: 0x4133f9, fn: (rt) => sync(`[bisect] after 0x422847: ebx=0x${(rt.getReg('ebx') >>> 0).toString(16)}`) },
    {
      eip: 0x41f8cf,
      fn: (rt) => sync(`[bisect] 0x41f8cf ENTRY: ebx=0x${(rt.getReg('ebx') >>> 0).toString(16)} ecx=0x${(rt.getReg('ecx') >>> 0).toString(16)}`),
    },
    {
      // 0x413261 (mov edi,edi) — the real call target of 0x40f189.
      eip: 0x413261,
      fn: (rt) => {
        const esp = rt.getReg('esp') >>> 0;
        const ret = readDword(rt, esp);
        const a1 = readDword(rt, (esp + 4) >>> 0);
        const a2 = readDword(rt, (esp + 8) >>> 0);
        sync(`[arg] 0x413261 entry esp=0x${esp.toString(16)} ret=0x${ret.toString(16)} [esp+4]=0x${a1.toString(16)} (${JSON.stringify(readW(rt, a1))}) [esp+8]=0x${a2.toString(16)} (${JSON.stringify(readW(rt, a2))}) ecx=0x${(rt.getReg('ecx') >>> 0).toString(16)} edx=0x${(rt.getReg('edx') >>> 0).toString(16)}`);
      },
    },
    {
      // Right before `call 0x413261`: [esp] = the pushed arg pointer.
      eip: 0x40f189,
      fn: (rt) => {
        const esp = rt.getReg('esp') >>> 0;
        const p = readDword(rt, esp);
        sync(`[arg] 0x40f189 [esp]=0x${p.toString(16)} arg=${JSON.stringify(readW(rt, p))}`);
      },
    },
    {
      // Start of the space/tab scan over the arg (loop head).
      eip: 0x4137a0,
      fn: (rt) => {
        const ebx = rt.getReg('ebx') >>> 0;
        sync(`[arg] 0x4137a0 ebx=0x${ebx.toString(16)} arg=${JSON.stringify(readW(rt, ebx))}`);
      },
    },
    {
      // Before the "/A" compare.
      eip: 0x4137b2,
      fn: (rt) => {
        const ebx = rt.getReg('ebx') >>> 0;
        const ebp = rt.getReg('ebp') >>> 0;
        // Dump the stack words around the frame (locate where the arg was lost).
        let dump = '';
        for (let off = 0x10; off <= 0x70; off += 4) {
          const a = (ebp + off) >>> 0;
          dump += ` [ebp+0x${off.toString(16)}]=0x${readDword(rt, a).toString(16)}`;
        }
        sync(`[arg] 0x4137b2 ebp=0x${ebp.toString(16)} ebx=0x${ebx.toString(16)}${dump} arg=${JSON.stringify(readW(rt, ebx))}`);
      },
    },
    {
      // Before 0x412fdd (startup check).
      eip: 0x413809,
      fn: (rt) => {
        const ebx = rt.getReg('ebx') >>> 0;
        sync(`[arg] 0x413809 ebx=0x${ebx.toString(16)} arg=${JSON.stringify(readW(rt, ebx))}`);
      },
    },
    {
      // File-open entry (arg non-empty check).
      eip: 0x413e2a,
      fn: (rt) => {
        const ebx = rt.getReg('ebx') >>> 0;
        sync(`[arg] 0x413e2a ebx=0x${ebx.toString(16)} arg=${JSON.stringify(readW(rt, ebx))}`);
      },
    },
    {
      eip: 0x41382e,
      fn: (rt) => {
        const ebx = rt.getReg('ebx') >>> 0;
        sync(`[flow] 0x41382e window-init path (skip open) ebx=0x${ebx.toString(16)} arg=${JSON.stringify(readW(rt, ebx))}`);
      },
    },
    { eip: 0x413830, fn: () => sync('[flow] 0x413830 window-init (join target)') },
    { eip: 0x413df3, fn: () => sync('[flow] 0x413df3 after 0x412c0c==0') },
    {
      eip: 0x41392b,
      fn: (rt) => {
        const v = readDword(rt, 0x429e2c);
        sync(`[flow] 0x41392b [429e2c]=0x${v.toString(16)}`);
      },
    },
    { eip: 0x41403c, fn: () => sync('[flow] 0x41403c loader-skip/inc target') },
    { eip: 0x4138de, fn: () => sync('[flow] 0x4138de after WM_SETTEXT') },
    { eip: 0x40f196, fn: () => sync('[flow] 0x40f196 (0x41325f returned, token check)') },
  ];

  let finished = false;
  const finish = (ok: boolean, detail: string): void => {
    if (finished) return;
    finished = true;
    sync(`[diag] open-probe ${ok ? 'PASS' : 'FAIL'}: ${detail}`);
    process.exit(ok ? 0 : 1);
  };

  setTimeout(() => finish(false, 'timeout 25s (no edit check in probe mode)'), 25000);

  await runner.run(image, {
    createEngine: (mode) => new JitEngineImpl(runtime, mode),
    modulePath,
    commandLine,
    interactive: true,
    cwd: 'C:\\Users\\Guest\\Desktop',
    probes: probers,
    readFile: async (p: string) => {
      const segs = p.split(/[\\/]/).filter(Boolean);
      if (segs.length && /^[A-Za-z]:$/.test(segs[0]!)) segs.shift();
      const sp = segs.join('/');
      sync(`[diag] readFile requested: ${JSON.stringify(p)} -> ${JSON.stringify(sp)}`);
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
    fileDialog: async (kind, _opts) => {
      sync(`[diag] unexpected fileDialog kind=${kind}`);
      return null;
    },
    onMessageWait: () => {
      /* message loop settled */
    },
    onFault: (rt, r) => {
      sync(`[fault] eip=0x${r.eip.toString(16)} status=${r.status} error=${String(r.error)}`);
    },
  });
  sync('[diag] run returned');
  finish(false, 'run returned');
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
