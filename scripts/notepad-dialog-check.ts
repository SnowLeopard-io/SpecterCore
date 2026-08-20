/**
 * End-to-end check for the comdlg32 file-dialog provider (Full fix for
 * "notepad cannot save"): run the REAL guest notepad.exe against the REAL
 * in-memory virtual disk, drive its File > Save As menu item, and verify:
 *   1. GetSaveFileNameW reaches the host fileDialog provider (the dialog
 *      would show in the browser; here we simulate a user picking a path);
 *   2. the picked path is written back into OPENFILENAME.lpstrFile;
 *   3. notepad then saves the edited text via WriteFile to the virtual disk.
 *
 *   node scripts/notepad-dialog-check.ts [path/to/notepad.exe]
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

class LoggingInterceptor extends ApiInterceptorImpl {
  private readonly rt: WasmRuntimeImpl;
  constructor(host: ApiHost, rt: WasmRuntimeImpl) {
    super(host);
    this.rt = rt;
  }
  override async dispatch(ctx: import('@specter-core/core').ApiCallContext): Promise<import('@specter-core/core').ApiResult> {
    // Capture the caller's return address ([esp]) and esp for API tracing.
    const esp = this.rt.getReg('esp') >>> 0;
    let retAddr = 0;
    try {
      const b = this.rt.readBytes(esp >>> 0, 4);
      if (b.byteLength >= 4) retAddr = new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true) >>> 0;
    } catch {
      /* ignore */
    }
    let result: import('@specter-core/core').ApiResult;
    try {
      result = await super.dispatch(ctx);
    } catch (err) {
      console.error(`[api-THROW] ${ctx.module}!${ctx.proc} threw: ${String(err)}`);
      throw err;
    }
    // Log everything after the Save As flow starts, plus anything unimplemented.
    if (this.saveFlow || result.errorCode === 120 || /WriteFile|CreateFile|DeleteFile|PathFileExists|MessageBox|CloseHandle|SetFilePointer|GetFileSize|FlushFile|GetSaveFileName|GetOpenFileName|ReadFile/i.test(ctx.proc)) {
      this.saveFlow = this.saveFlow || /GetSaveFileName/i.test(ctx.proc);
      let extra = ` ret=0x${retAddr.toString(16)}`;
      if (/MessageBox/i.test(ctx.proc) && ctx.rawArgs[1] && ctx.rawArgs[2]) {
        const readW = (a: number): string => {
          try {
            const b = this.rt.readBytes(a >>> 0, 512);
            const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
            let s = '';
            for (let i = 0; i + 1 < b.byteLength; i += 2) {
              const c = v.getUint16(i, true);
              if (c === 0) break;
              s += String.fromCharCode(c);
            }
            return s;
          } catch {
            return '?';
          }
        };
        extra = ` text=${JSON.stringify(readW(ctx.rawArgs[1]!))} cap=${JSON.stringify(readW(ctx.rawArgs[2]!))}`;
      } else if (/CreateFile|DeleteFile|PathFileExists/i.test(ctx.proc) && ctx.rawArgs[0]) {
        const readW = (a: number): string => {
          try {
            const b = this.rt.readBytes(a >>> 0, 512);
            const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
            let s = '';
            for (let i = 0; i + 1 < b.byteLength; i += 2) {
              const c = v.getUint16(i, true);
              if (c === 0) break;
              s += String.fromCharCode(c);
            }
            return s;
          } catch {
            return '?';
          }
        };
        const args = ctx.rawArgs.slice(0, 8).map((a) => `0x${(a >>> 0).toString(16)}`);
        extra = ` path=${JSON.stringify(readW(ctx.rawArgs[0]!))} args=[${args.join(', ')}]`;
      } else if (/WideCharToMultiByte|MultiByteToWideChar|wcsnlen|WriteFile|SetFilePointer|GetFileSize|ReadFile|LocalAlloc|malloc/i.test(ctx.proc)) {
        let dump = '';
        if (/wcsnlen|WriteFile|LocalAlloc|malloc/i.test(ctx.proc) && ctx.rawArgs[0]) {
          try {
            const b = this.rt.readBytes((ctx.rawArgs[0] ?? 0) >>> 0, 64);
            const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
            let s = '';
            for (let i = 0; i + 1 < b.byteLength; i += 2) {
              const c = v.getUint16(i, true);
              if (c === 0) break;
              s += String.fromCharCode(c);
            }
            if (s && [...s].some((ch) => ch.charCodeAt(0) > 0x1f)) dump = ` buf=«${s.slice(0, 48)}»`;
          } catch {
            /* ignore */
          }
        }
        extra = ` ret=0x${retAddr.toString(16)} args=[${ctx.rawArgs.slice(0, 8).map((a) => `0x${(a >>> 0).toString(16)}`).join(', ')}]${dump}`;
      } else if (/IsProcessorFeaturePresent|SendMessageW|SetCursor|GetLastError|GetFileAttributes/i.test(ctx.proc)) {
        extra = ` args=[${ctx.rawArgs.slice(0, 4).map((a) => `0x${(a >>> 0).toString(16)}`).join(', ')}]`;
      }
      console.error(`[api] ${ctx.module}!${ctx.proc} -> 0x${(result.returnValue >>> 0).toString(16)} err=${result.errorCode}${result.errorCode === 120 ? ' [NOT_IMPL]' : ''}${extra}`);
    }
    return result;
  }
  private saveFlow = false;
}

async function seed(store: FileStore, path: string, data: Uint8Array): Promise<void> {
  const f = await store.openFile(path, 'create');
  await f.write(0, data);
  await f.close();
}

async function main(): Promise<void> {
  const file = resolve(process.argv[2] ?? 'C:/Windows/SysWOW64/notepad.exe');
  const image = new Uint8Array(await readFile(file));
  const modulePath = 'C:/Windows/SysWOW64/notepad.exe';

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
  // A document to open later (the dialog must see it).
  await seed(store, 'Users/Guest/Desktop/hello.txt', new TextEncoder().encode('Hello from the virtual disk!'));

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

  // Host-side dialog provider: capture the request, return a fixed path so
  // the check is deterministic. Real desktop wires FileDialogApp here.
  let dialogCalls = 0;
  const pickedPath = 'C:\\Users\\Guest\\Desktop\\saved.txt';

  // Type a marker line into the EDIT control first, then trigger Save As.
  const typeAndSave = (): void => {
    const wins = runner.getWindows();
    const edit = wins.find((w) => w.className.toLowerCase() === 'edit');
    if (!edit) {
      console.error('[diag] no EDIT control yet');
      return;
    }
    // Post text via the guest's EM_SETTEXT path, then send the File > Save As
    // menu command (WM_COMMAND 0x0111 with the menu item's command id).
    runner.postText(edit.hwnd, 'Typed by dialog-check\r\n');
    const fileMenu = wins[0]?.menu.find((s) => /file/i.test(s.title));
    console.error(`[diag] fileMenu items: ${JSON.stringify(fileMenu?.items.map((it) => ({ id: it.id, label: it.label })))}`);
    const saveAs = fileMenu?.items.find((it) => /save\s*&?as/i.test(it.label));
    if (!saveAs) {
      console.error('[diag] Save As menu item not found; sections=', JSON.stringify(wins[0]?.menu.map((s) => s.title)));
      return;
    }
    console.error(`[diag] posting WM_COMMAND id=${saveAs.id} (${saveAs.label})`);
    runner.postMessage({ hwnd: wins[0]!.hwnd, msg: 0x0111, wParam: saveAs.id, lParam: 0 });
  };

  let verifyTimer: ReturnType<typeof setTimeout> | null = null;
  let finished = false;
  const finish = (ok: boolean): void => {
    if (finished) return;
    finished = true;
    // Synchronous stderr write: process.exit() truncates async console
    // writes when stderr is redirected, silently dropping the verdict.
    const msg = `[diag] notepad save-via-dialog check ${ok ? 'PASS' : 'FAIL'}\n`;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('node:fs').writeSync(2, msg);
    } catch {
      console.error(msg.trim());
    }
    process.exit(ok ? 0 : 1);
  };
  const verifyAndExit = async (s: FileStore): Promise<boolean> => {
    let saved = '';
    try {
      const f = await s.openFile('Users/Guest/Desktop/saved.txt', 'read');
      const size = await f.size();
      const data = await f.read(0, size);
      await f.close();
      saved = new TextDecoder('utf-8').decode(data);
    } catch {
      saved = '';
    }
    const sync = (line: string): void => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('node:fs').writeSync(2, `${line}\n`);
      } catch {
        console.error(line);
      }
    };
    sync(`[diag] saved.txt=${JSON.stringify(saved.slice(0, 80))}`);
    sync(`[diag] dialogCalls=${dialogCalls}`);
    return dialogCalls >= 1 && saved.includes('dialog-check');
  };
  // Drive Save As once the guest has settled (window created + message loop
  // running): post the EDIT text, then the File > Save As menu command.
  setTimeout(() => typeAndSave(), 2500);
  // After Save As completes, post a QUIT-ish message so the process exits and
  // the script can assert on the written file (notepad keeps looping on the
  // message queue otherwise).
  setTimeout(() => {
    console.error('[diag] 20s elapsed — posting WM_CLOSE to exit');
    const wins = runner.getWindows();
    for (const w of wins) {
      if (w.parent === 0) runner.postMessage({ hwnd: w.hwnd, msg: 0x0010 /* WM_CLOSE */, wParam: 0, lParam: 0 });
    }
    // Fallback verdict if the dialog never fired (save flow never started).
    if (!verifyTimer) {
      verifyTimer = setTimeout(() => {
        void verifyAndExit(store).then((ok) => finish(ok));
      }, 1000);
    }
  }, 20000);
  const result = await runner.run(image, {
    createEngine: (mode) => new JitEngineImpl(runtime, mode),
    modulePath,
    commandLine: process.env.BK_ARGS ?? '',
    interactive: true,
    cwd: 'C:\\Users\\Guest\\Desktop',
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
    fileDialog: async (kind, opts) => {
      dialogCalls += 1;
      console.error(`[diag] fileDialog kind=${kind} title=${JSON.stringify(opts.title)} initialDir=${JSON.stringify(opts.initialDir)} defaultName=${JSON.stringify(opts.defaultName)}`);
      // The dialog returning kicks off notepad's save routine; the WriteFile
      // lands on the virtual disk shortly after. Check it independently of
      // runner.run() (the guest never posts WM_QUIT in our emulator, so run()
      // can hang after the 20s WM_CLOSE).
      if (!verifyTimer) {
        verifyTimer = setTimeout(() => {
          void verifyAndExit(store).then((ok) => finish(ok));
        }, 4000);
      }
      return pickedPath;
    },
    onMessageWait: () => {
      // The guest settled into its message loop; nothing to do here — the
      // 2.5s timeout drives Save As (mirrors cmd-cwd-check's setTimeout).
    },
    onFault: (rt, result) => {
      console.error(`[fault] eip=0x${result.eip.toString(16)} status=${result.status} error=${String(result.error)}`);
      const bytes = rt.readBytes(result.eip, 16);
      console.error(`[fault] bytes=${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);
      console.error(`[fault] regs eax=0x${(rt.getReg('eax') >>> 0).toString(16)} ebx=0x${(rt.getReg('ebx') >>> 0).toString(16)} ecx=0x${(rt.getReg('ecx') >>> 0).toString(16)} edx=0x${(rt.getReg('edx') >>> 0).toString(16)} esp=0x${(rt.getReg('esp') >>> 0).toString(16)}`);
    },
    onTextChanged: (_hwnd, text) => {
      console.error(`[diag] EDIT text: ${JSON.stringify(text.slice(0, 40))}`);
    },
  });
  console.error(`\n[diag] exitCode=${result.exitCode} cleanExit=${result.cleanExit} status=${result.status}`);
  void verifyAndExit(store).then((ok) => finish(ok));
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
