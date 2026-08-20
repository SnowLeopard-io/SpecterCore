/**
 * End-to-end check: does the REAL guest notepad.exe open a file passed on the
 * command line (GetCommandLineW), like `notepad.exe C:\...\hello.txt`?
 * The desktop wires this via launchGuestWindow's commandLine (double-clicked
 * txt). If notepad loads the file, its EDIT control contains the file text and
 * the window title carries the file name.
 *
 *   node scripts/notepad-open-check.ts [path/to/notepad.exe]
 *   BK_ARGS='C:\Users\Guest\Desktop\hello.txt'
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
    // Always log file APIs + everything after call #90 (the file-open path
    // runs late in notepad's startup).
    if (/CharNextW/i.test(ctx.proc)) return result;
    this.calls += 1;
    const isFileApi = /CreateFile|ReadFile|GetFileAttributes|GetFileSize|SetFilePointer|WriteFile|CloseHandle|PathFileExists/i.test(ctx.proc);
    if (isFileApi || (this.calls >= 20 && this.calls <= 200)) {
      let s = '';
      try {
        const addr = result.returnValue >>> 0;
        const bytes = this.rt.readBytes(addr, 120);
        const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        for (let i = 0; i + 1 < bytes.byteLength; i += 2) {
          const c = v.getUint16(i, true);
          if (c === 0) break;
          s += String.fromCharCode(c);
        }
      } catch {
        /* not a string */
      }
      // For file APIs, also dump the first arg (path pointer).
      let pathStr = '';
      if (isFileApi && ctx.rawArgs[0]) {
        try {
          const a = ctx.rawArgs[0]!;
          const bytes = this.rt.readBytes(a >>> 0, 200);
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
      const extraPath = pathStr ? ` path=${JSON.stringify(pathStr)}` : '';
      console.error(`[api#${this.calls}] ${ctx.proc} ret=0x${(result.returnValue >>> 0).toString(16)}${extra}${extraPath}`);
    }
    return result;
  }
  private calls = 0;
}

async function main(): Promise<void> {
  const file = resolve(process.argv[2] ?? 'C:/Windows/SysWOW64/notepad.exe');
  const image = new Uint8Array(await readFile(file));
  const modulePath = 'C:/Windows/SysWOW64/notepad.exe';
  // NOTE: bash/MSYS converts backslashes in env vars to forward slashes, so
  // force the backslash form here to mirror what desktop-controller sends.
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

  const sync = (line: string): void => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('node:fs').writeSync(2, `${line}\n`);
    } catch {
      console.error(line);
    }
  };
  let finished = false;
  let sawRead = false;
  const finish = (ok: boolean, detail: string): void => {
    if (finished) return;
    finished = true;
    sync(`[diag] open-check ${ok ? 'PASS' : 'FAIL'}: ${detail}`);
    process.exit(ok ? 0 : 1);
  };

  const checkEdit = (): void => {
    const wins = runner.getWindows();
    const edit = wins.find((w) => w.className.toLowerCase() === 'edit');
    if (!edit) {
      sync('[diag] no EDIT control yet');
      return;
    }
    const text = edit.text ?? '';
    const title = wins[0]?.text ?? '';
    sync(`[diag] EDIT=${JSON.stringify(text.slice(0, 60))}`);
    sync(`[diag] title=${JSON.stringify(title.slice(0, 60))}`);
    sync(`[diag] readFileCalled=${sawRead}`);
    const opened = text.includes('Hello from the virtual disk!') || text.includes('Hello');
    const titleOk = /hello\.txt/i.test(title);
    finish(opened, `text=${JSON.stringify(text.slice(0, 40))} title=${JSON.stringify(title.slice(0, 40))} read=${sawRead} titleOk=${titleOk}`);
  };

  // Poll once the guest settles.
  setTimeout(() => {
    // Give notepad time to parse the command line and load the file.
    let attempts = 0;
    const poll = (): void => {
      attempts += 1;
      const wins = runner.getWindows();
      const edit = wins.find((w) => w.className.toLowerCase() === 'edit');
      if (edit && (edit.text?.length ?? 0) > 0) checkEdit();
      else if (attempts < 10) setTimeout(poll, 800);
      else finish(false, `edit text never populated (attempts=${attempts})`);
    };
    setTimeout(poll, 1500);
  }, 3000);

  // Hard stop after 30s (guest never posts WM_QUIT in the emulator).
  setTimeout(() => finish(false, 'timeout 30s'), 30000);

  const result = await runner.run(image, {
    createEngine: (mode) => new JitEngineImpl(runtime, mode),
    modulePath,
    commandLine,
    interactive: true,
    cwd: 'C:\\Users\\Guest\\Desktop',
    probes: [
      // Tokenizer (0x40f04c..0x40f0aa) — capture the caller return address at
      // its `ret` to find who parses the command line and how.
      {
        eip: 0x40f04c,
        fn: (rt: WasmRuntimeImpl) => {
          try {
            const esp = rt.getReg('esp') >>> 0;
            const b = rt.readBytes(esp >>> 0, 4);
            const ret = new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true) >>> 0;
            const ecx = rt.getReg('ecx') >>> 0;
            const readW = (a: number): string => {
              try {
                const bytes = rt.readBytes(a >>> 0, 120);
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
            sync(`[probe] tokenizer ENTRY: caller=0x${ret.toString(16)} ecx=0x${ecx.toString(16)} input=${JSON.stringify(readW(ecx))}`);
          } catch {
            sync('[probe] tokenizer entry (read failed)');
          }
        },
      },
      { eip: 0x40f054, fn: () => sync('[probe] tokenizer entry 0x40f054') },
      { eip: 0x40f063, fn: () => sync('[probe] tokenizer loop 0x40f063') },
      { eip: 0x40f093, fn: () => sync('[probe] tokenizer skipws 0x40f093') },
      { eip: 0x40f0b1, fn: (rt: WasmRuntimeImpl) => sync(`[probe] 0x40f0b1 entry ebx=0x${(rt.getReg('ebx') >>> 0).toString(16)} esi=0x${(rt.getReg('esi') >>> 0).toString(16)}`) },
      { eip: 0x40f0c5, fn: () => sync('[probe] 0x40f0c5 (GetCurrentProcess call)') },
      { eip: 0x40f0d4, fn: () => sync('[probe] 0x40f0d4 (after token APIs)') },
      { eip: 0x40f0ff, fn: () => sync('[probe] 0x40f0ff (0x40f0b1 end)') },
      {
        eip: 0x40f184,
        fn: (rt: WasmRuntimeImpl) => {
          const readW = (a: number): string => {
            try {
              const bytes = rt.readBytes(a >>> 0, 150);
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
          sync(`[probe] 0x40f184 push eax=0x${(rt.getReg('eax') >>> 0).toString(16)} arg=${JSON.stringify(readW(rt.getReg('eax')))}`);
        },
      },
      { eip: 0x413902, fn: () => sync('[probe] 0x413902 (lock cmpxchg)') },
      { eip: 0x413903, fn: () => sync('[probe] 0x413903 (cmpxchg no-lock?)') },
      { eip: 0x41390a, fn: (rt: WasmRuntimeImpl) => sync(`[probe] 0x41390a eax=0x${(rt.getReg('eax') >>> 0).toString(16)} (after cmpxchg)`) },
      { eip: 0x4138de, fn: () => sync('[probe] 0x4138de (after WM_SETTEXT)') },
      { eip: 0x41392b, fn: (rt: WasmRuntimeImpl) => sync(`[probe] 0x41392b test eax=0x${(rt.getReg('eax') >>> 0).toString(16)} (=[0x429e2c], jnz skips file open)`) },
      { eip: 0x413934, fn: () => sync('[probe] 0x413934 (file open prep branch)') },
      { eip: 0x413940, fn: () => sync('[probe] 0x413940 (GetProcessHeap in file branch)') },
      { eip: 0x414030, fn: () => sync('[probe] 0x414030 (skipped file open)') },
      { eip: 0x413eaf, fn: () => sync('[probe] 0x413eaf (0x41325f fail return)') },
      { eip: 0x40f196, fn: () => sync('[probe] 0x40f196 (call 0x40f0b1 token check)') },
      { eip: 0x40f2db, fn: () => sync('[probe] 0x40f2db (jz skip path)') },
      { eip: 0x40f2e3, fn: () => sync('[probe] 0x40f2e3') },
      {
        eip: 0x40f0a5,
        fn: (rt: WasmRuntimeImpl) => {
          try {
            const esp = rt.getReg('esp') >>> 0;
            const b = rt.readBytes(esp >>> 0, 4);
            const ret = new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true) >>> 0;
            const edx = rt.getReg('edx') >>> 0;
            const readW = (a: number): string => {
              try {
                const bytes = rt.readBytes(a >>> 0, 120);
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
            sync(`[probe] tokenizer exit: caller=0x${ret.toString(16)} edx=0x${edx.toString(16)} arg=${JSON.stringify(readW(edx))}`);
          } catch {
            sync('[probe] tokenizer exit (read failed)');
          }
        },
      },
      {
        eip: 0x40f0aa,
        fn: (rt: WasmRuntimeImpl) => {
          try {
            const esp = rt.getReg('esp') >>> 0;
            const b = rt.readBytes(esp >>> 0, 4);
            const ret = new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true) >>> 0;
            const eax = rt.getReg('eax') >>> 0;
            const readW = (a: number): string => {
              try {
                const bytes = rt.readBytes(a >>> 0, 120);
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
            sync(`[probe] tokenizer ret: caller=0x${ret.toString(16)} eax=0x${eax.toString(16)} arg=${JSON.stringify(readW(eax))}`);
          } catch {
            sync('[probe] tokenizer ret (esp read failed)');
          }
        },
      },
      { eip: 0x40f174, fn: () => sync('[probe] hit 0x40f174') },
      { eip: 0x40f187, fn: () => sync('[probe] hit 0x40f187') },
      { eip: 0x40f191, fn: () => sync('[probe] hit 0x40f191') },
    ],
    readFile: async (p: string) => {
      const segs = p.split(/[\\/]/).filter(Boolean);
      if (segs.length && /^[A-Za-z]:$/.test(segs[0]!)) segs.shift();
      const sp = segs.join('/');
      sync(`[diag] readFile requested: ${JSON.stringify(p)} -> ${JSON.stringify(sp)}`);
      if (p.toLowerCase().includes('hello.txt')) sawRead = true;
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
    fileDialog: async (kind, opts) => {
      sync(`[diag] unexpected fileDialog kind=${kind} title=${JSON.stringify(opts.title)}`);
      return null;
    },
    onMessageWait: () => {
      /* message loop settled */
    },
    onFault: (rt, r) => {
      sync(`[fault] eip=0x${r.eip.toString(16)} status=${r.status} error=${String(r.error)}`);
    },
  });
  sync(`[diag] run returned status=${result.status} exitCode=${result.exitCode}`);
  finish(false, 'run returned before edit was verified');
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
