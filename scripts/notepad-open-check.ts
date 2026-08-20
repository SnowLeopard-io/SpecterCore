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
    // Always log file APIs + everything after call #200 (the file-open path
    // runs late in notepad's startup).
    if (/CharNextW/i.test(ctx.proc)) return result;
    this.calls += 1;
    // Capture the caller's return address: at API entry (trap stub), guest esp
    // points at the return address.
    let caller = 0;
    try {
      const esp = this.rt.getReg('esp') >>> 0;
      const b = this.rt.readBytes(esp, 4);
      caller = new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true) >>> 0;
    } catch {
      /* ignore */
    }
    const isFileApi = /CreateFile|ReadFile|GetFileAttributes|GetFileSize|SetFilePointer|WriteFile|CloseHandle|PathFileExists|FindFirstFile|GetFullPathName|GetLastError|MessageBox|CharUpper|_errno|invalid_parameter|CoTaskMem|PathIsFileSpec|PathFindExt/i.test(ctx.proc);
    if (isFileApi || this.calls >= 200) {
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
      // For file APIs, also dump the first arg (path pointer): numeric value
      // ALWAYS (so we can see a 0 / garbage pointer), string when readable.
      let arg0Hex = '';
      let pathStr = '';
      if (ctx.rawArgs[0]) {
        arg0Hex = ` arg0=0x${(ctx.rawArgs[0] >>> 0).toString(16)}`;
        try {
          const a = ctx.rawArgs[0]!;
          const bytes = this.rt.readBytes(a >>> 0, 300);
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
      let extraArgs = '';
      if (/GetFullPathNameW|FindFirstFileW|FindClose/i.test(ctx.proc)) {
        const dump = (a: number | undefined, maxB: number): string => {
          if (!a) return '0';
          try {
            const bytes = this.rt.readBytes(a >>> 0, maxB);
            const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            let t = '';
            for (let i = 0; i + 1 < bytes.byteLength && i < maxB; i += 2) {
              const c = v.getUint16(i, true);
              if (c === 0) break;
              t += String.fromCharCode(c);
            }
            return t ? JSON.stringify(t) : '(empty)';
          } catch {
            return '(unreadable)';
          }
        };
        extraArgs = ctx.rawArgs.map((a, i) => ` a${i}=0x${(a >>> 0).toString(16)}:${dump(a, 300)}`).join('');
      }
      // Dump guest registers when the CRT invalid-parameter path fires — these
      // show the exact (destSize, srcBytes) pair that failed the memcpy_s check.
      let regDump = '';
      if (/errno|invalid_parameter/i.test(ctx.proc)) {
        const r = (n: string): string => {
          try {
            return ` ${n}=0x${(this.rt.getReg(n) >>> 0).toString(16)}`;
          } catch {
            return '';
          }
        };
        regDump = ['eax', 'ebx', 'ecx', 'edx', 'esi', 'edi', 'ebp', 'esp'].map(r).join('');
        // Find 0x40cbe6's caller: its ebp frame -> [ebp+4] = ret addr into caller.
        try {
          const ebp = this.rt.getReg('ebp') >>> 0;
          const b = this.rt.readBytes(ebp + 4, 4);
          regDump += ` callerOf40cbe6=0x${(new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true) >>> 0).toString(16)}`;
        } catch {
          /* ignore */
        }
      }
      // When the 66-byte path buffer is allocated, dump the source buffer that
      // the upcoming memcpy_s will scan (GetFullPathNameW's output at 0x7ffed30).
      if (/CoTaskMemAlloc/i.test(ctx.proc) && (ctx.rawArgs[0] ?? 0) === 0x42) {
        try {
          const b = this.rt.readBytes(0x7ffed30, 320);
          const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
          const words: string[] = [];
          for (let i = 0; i + 1 < b.byteLength; i += 2) {
            const c = v.getUint16(i, true);
            words.push(c === 0 ? '.' : String.fromCharCode(c));
          }
          regDump += ` srcBuf@0x7ffed30=${JSON.stringify(words.join(''))}`;
        } catch {
          /* ignore */
        }
      }
      console.error(`[api#${this.calls}] ${ctx.proc} ret=0x${(result.returnValue >>> 0).toString(16)} caller=0x${caller.toString(16)}${arg0Hex}${extra}${extraPath}${extraArgs}${regDump}`);
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
      // --- Session 16: file-open error path instrumentation ---
      {
        eip: 0x413e35,
        fn: (rt: WasmRuntimeImpl) => {
          const readW = (a: number): string => {
            try {
              const bytes = rt.readBytes(a >>> 0, 200);
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
          sync(`[probe] 0x413e35 prep-open: ebx=0x${(rt.getReg('ebx') >>> 0).toString(16)} fileArg=${JSON.stringify(readW(rt.getReg('ebx')))}`);
        },
      },
      {
        eip: 0x413e43,
        fn: (rt: WasmRuntimeImpl) => {
          const ebp = rt.getReg('ebp') >>> 0;
          const buf = (ebp - 0xc0c) >>> 0;
          const readW = (a: number): string => {
            try {
              const bytes = rt.readBytes(a >>> 0, 200);
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
          sync(`[probe] 0x413e43 call 0x412853: ebx=0x${(rt.getReg('ebx') >>> 0).toString(16)} edx=0x${(rt.getReg('edx') >>> 0).toString(16)} buf@0x${buf.toString(16)}=${JSON.stringify(readW(buf))}`);
        },
      },
      {
        eip: 0x413e48,
        fn: (rt: WasmRuntimeImpl) => {
          const ebp = rt.getReg('ebp') >>> 0;
          const slot = (ebp - 0xc0c) >>> 0;
          let ptr = 0;
          try {
            const b = rt.readBytes(slot, 4);
            ptr = new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true) >>> 0;
          } catch {
            /* ignore */
          }
          const readW = (a: number): string => {
            if (!a) return '';
            try {
              const bytes = rt.readBytes(a >>> 0, 300);
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
          // stack buffer that GetFullPathNameW wrote into (0x7ffed30) — dump it too
          sync(`[probe] 0x413e48 after 0x412853: slot@0x${slot.toString(16)}=0x${ptr.toString(16)} path=${JSON.stringify(readW(ptr))}`);
        },
      },
      {
        eip: 0x413e61,
        fn: (rt: WasmRuntimeImpl) => {
          const ebp = rt.getReg('ebp') >>> 0;
          const buf = (ebp - 0xc0c) >>> 0;
          const readW = (a: number): string => {
            try {
              const bytes = rt.readBytes(a >>> 0, 300);
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
          sync(`[probe] 0x413e61 CreateFileW arg: buf@0x${buf.toString(16)}=${JSON.stringify(readW(buf))}`);
        },
      },
      {
        eip: 0x413e7b,
        fn: (rt: WasmRuntimeImpl) => sync(`[probe] 0x413e7b GetLastError ret=0x${(rt.getReg('eax') >>> 0).toString(16)}`),
      },
      { eip: 0x413e80, fn: () => sync('[probe] 0x413e80 err==2 dialog path') },
      { eip: 0x413ee6, fn: () => sync('[probe] 0x413ee6 err!=2 cleanup path') },
      { eip: 0x413ec2, fn: () => sync('[probe] 0x413ec2 ret==6 path') },
      { eip: 0x413f0b, fn: () => sync('[probe] 0x413f0b post-open') },
      { eip: 0x413f35, fn: () => sync('[probe] 0x413f35 close/destroy path') },
      { eip: 0x413830, fn: () => sync('[probe] 0x413830 tail target') },
      { eip: 0x413eaf, fn: () => sync('[probe] 0x413eaf fail return (dup)') },
      {
        eip: 0x4067e1,
        fn: (rt: WasmRuntimeImpl) => {
          const readW = (a: number): string => {
            if (!a) return '';
            try {
              const bytes = rt.readBytes(a >>> 0, 300);
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
          const esp = rt.getReg('esp') >>> 0;
          let src = 0;
          let srcBytes = 0;
          try {
            const b = rt.readBytes(esp + 4, 8);
            const v = new DataView(b.buffer, b.byteOffset, 8);
            src = v.getUint32(0, true) >>> 0;
            srcBytes = v.getUint32(4, true) >>> 0;
          } catch {
            /* ignore */
          }
          sync(`[probe] 0x4067d5 entry: ecx(dest)=0x${(rt.getReg('ecx') >>> 0).toString(16)} edx(destSize)=0x${(rt.getReg('edx') >>> 0).toString(16)} [esp+4](src)=0x${src.toString(16)} [esp+8](srcBytes)=0x${srcBytes.toString(16)} srcStr=${JSON.stringify(readW(src))}`);
        },
      },
      {
        eip: 0x406809,
        fn: (rt: WasmRuntimeImpl) => sync(`[probe] 0x406809 cmp: edi(destSize)=0x${(rt.getReg('edi') >>> 0).toString(16)} esi(srcBytes)=0x${(rt.getReg('esi') >>> 0).toString(16)}`),
      },
      {
        eip: 0x40681c,
        fn: (rt: WasmRuntimeImpl) => sync(`[probe] 0x40681c ERROR path (memset+ERANGE): edi=0x${(rt.getReg('edi') >>> 0).toString(16)} esi=0x${(rt.getReg('esi') >>> 0).toString(16)} ebx(src)=0x${(rt.getReg('ebx') >>> 0).toString(16)}`),
      },
      {
        eip: 0x406818,
        fn: () => sync('[probe] 0x406818 SUCCESS path (memcpy)'),
      },
      // --- allocator 0x40cbe6 register dumps ---
      {
        eip: 0x40cbe6,
        fn: (rt: WasmRuntimeImpl) => {
          const readW = (a: number): string => {
            if (!a) return '';
            try {
              const bytes = rt.readBytes(a >>> 0, 100);
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
          const esp = rt.getReg('esp') >>> 0;
          let a0 = 0;
          try {
            const b = rt.readBytes(esp + 4, 4);
            a0 = new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true) >>> 0;
          } catch {
            /* ignore */
          }
          sync(`[probe] 0x40cbe6 entry: edx(src)=0x${(rt.getReg('edx') >>> 0).toString(16)} srcStr=${JSON.stringify(readW(rt.getReg('edx')))} [esp+4](count)=0x${a0.toString(16)}`);
        },
      },
      {
        eip: 0x4067d5,
        fn: (rt: WasmRuntimeImpl) => {
          const readW = (a: number): string => {
            if (!a) return '';
            try {
              const bytes = rt.readBytes(a >>> 0, 300);
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
          const esp = rt.getReg('esp') >>> 0;
          let a0 = 0;
          let a1 = 0;
          try {
            const b = rt.readBytes(esp + 4, 8);
            const v = new DataView(b.buffer, b.byteOffset, 8);
            a0 = v.getUint32(0, true) >>> 0;
            a1 = v.getUint32(4, true) >>> 0;
          } catch {
            /* ignore */
          }
          sync(`[probe] 0x4067d5 entry: ecx(dest)=0x${(rt.getReg('ecx') >>> 0).toString(16)} edx(destSize)=0x${(rt.getReg('edx') >>> 0).toString(16)} [esp+4](src)=0x${a0.toString(16)} srcStr=${JSON.stringify(readW(a0))} [esp+8](srcBytes)=0x${a1.toString(16)}`);
        },
      },
      {
        eip: 0x40fabb,
        fn: (rt: WasmRuntimeImpl) => {
          const readW = (a: number): string => {
            try {
              const bytes = rt.readBytes(a >>> 0, 200);
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
          sync(`[probe] 0x40fabb error-dialog wrapper: ecx(caption)=${JSON.stringify(readW(rt.getReg('ecx')))} edx(text)=${JSON.stringify(readW(rt.getReg('edx')))}`);
        },
      },
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
