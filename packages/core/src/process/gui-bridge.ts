/**
 * GUI bridge: window/class/menu registration, the synthetic message queue, GDI capture and the nested WndProc executor (Layer 1/2/3).
 *
 * Split out of guest-process.ts (design doc 4.2.x); pure code movement, no logic changes.
 */

import type {
  ApiCallContext,
  ApiInterceptor,
  ApiResult,
  Color,
  DibSurface,
  GdiBridge,
  JitEngine,
  Rect,
} from '@specter-core/contracts';
import { WinError as E } from '@specter-core/contracts';
import { ApiTrapDispatcher } from '../jit/trap-dispatcher';
import { Executor, type TrapHandler } from '../jit/executor';
import type { ArchBackend } from '../arch';
import type { WasmRuntimeImpl } from '../jit/runtime';
import { SEH_SENTINEL_VECTOR, restoreRegs, snapshotRegs } from './seh';
import type {
  GuestMenuItem,
  GuestMenuSection,
  GuestProcessOptions,
  GuestWindowRecord,
  PaintCommand,
} from './guest-process';

/**
 * Module-level HWND mint: shared across every GuiBridge instance so two
 * concurrently-running guests never hand out the same window handle. The
 * GDI bridge registry (guest hwnd -> canvas bridge) is a global map keyed by
 * hwnd, so colliding handles would route one guest's drawing to another's
 * canvas (e.g. opening winmine twice made the first window paint the second's
 * board).
 */
let hwndSeq = 0x10000;

/** Accessors for runner-owned per-run state (refreshed by run()). */
export interface GuiBridgeDeps {
  runtime: WasmRuntimeImpl;
  interceptor: ApiInterceptor;
  arch: () => ArchBackend;
  activeJit: () => JitEngine;
  activeOptions: () => GuestProcessOptions;
  sehSentinelAddr: () => number;
  guestHeapAlloc: () => ((size: number) => number) | null;
  gdiBridgeProvider: () => ((hwnd: number) => GdiBridge | null) | undefined;
  screenSize: () => { width: number; height: number };
  interactive: () => boolean;
  onMessageWait: () => (() => void) | undefined;
  onTextChanged: () => ((hwnd: number, text: string) => void) | undefined;
}

export class GuiBridge {
  private readonly deps: GuiBridgeDeps;
  /** Class atom -> window procedure address. */
  classWndProcs = new Map<number, number>();
  windowRecords = new Map<
    number,
    {
      wndProc: number;
      parent: number;
      className: string;
      text: string;
      menu: GuestMenuSection[];
      exStyle: number;
      style: number;
      width: number;
      height: number;
    }
  >();
  /** LoadMenuW handle -> parsed RT_MENU sections (Layer 3 menu bar). */
  menuByHandle = new Map<number, GuestMenuSection[]>();
  /** Class atom -> menu parsed from WNDCLASSEXW.lpszMenuName (RT_MENU). */
  classMenus = new Map<number, GuestMenuSection[]>();
  /** RT_MENU (type 4) resources by numeric id, from the exe/MUI table. */
  menuResourceTable = new Map<number, { size: number; address: number }>();
  guiMessageQueue: Array<{ hwnd: number; msg: number; wParam: number; lParam: number }> = [];
  /** Active guest timers (SetTimer): key = ((hwnd & 0xffff) << 16) | id. */
  guiTimers = new Map<number, ReturnType<typeof setInterval>>();
  /** GDI draw operations captured by the Layer 2 bridge. */
  paintCommands: PaintCommand[] = [];
  /** Pseudo object handles minted by GDI handlers (DC / font / brush / pen). */
  gdiObjSeq = 0x3000;
  /** DC handle -> owning bridge, for the pixel GDI path (L6 image bridge). */
  gdiBridgeByHdc = new Map<number, GdiBridge>();
  /** Set by PostQuitMessage; GetMessageW returns 0 (WM_QUIT) once set. */
  quitRequested = false;
  /** Resolver for the GetMessageW block in interactive mode. */
  pendingMessageResolve: (() => void) | null = null;
  /** Trap dispatcher used by nested WndProc executions. */
  private guiDispatcher!: ApiTrapDispatcher;

  constructor(deps: GuiBridgeDeps) {
    this.deps = deps;
  }

  /** Resets all per-run GUI state (run() start). */
  reset(): void {
    this.classWndProcs.clear();
    this.windowRecords.clear();
    this.guiMessageQueue.length = 0;
    this.clearTimers();
    this.paintCommands = [];
    this.gdiObjSeq = 0x3000;
    this.gdiBridgeByHdc.clear();
    this.quitRequested = false;
    this.pendingMessageResolve = null;
  }

  /** Stops all guest timers (per-run lifecycle; run() start and exit). */
  clearTimers(): void {
    for (const handle of this.guiTimers.values()) clearInterval(handle);
    this.guiTimers.clear();
  }

  /**
   * GUI bridge — layer 1 of the graphics bridge: turns the "fake handle"
   * message loop (GetMessageW always returning 0 = WM_QUIT) into a REAL one
   * that delivers messages to the guest's own window procedure.
   *
   *  - RegisterClassExW/A: reads WNDCLASSEXW.lpfnWndProc (+8) and
   *    lpszClassName (+40), mapping both atom -> wndProc and name -> atom.
   *  - CreateWindowExW/A: resolves the class (atom or name), records
   *    hwnd -> { wndProc, parent }, and enqueues a synthetic WM_CREATE so the
   *    guest's message loop actually delivers it.
   *  - GetMessageW/A: pops the synthetic queue — returns 1 with a filled MSG
   *    while messages remain, 0 (= WM_QUIT) once it is empty.
   *  - DispatchMessageW: reads MSG from guest memory and calls the guest
   *    WndProc through a nested Executor (the same snapshot/restore + sentinel
   *    machinery the SEH handlers use), passing hwnd/msg/wParam/lParam on the
   *    stack (stdcall — the callee pops them).
   *
   * The remaining message-loop slots (TranslateAcceleratorW etc.) keep their
   * sane zero defaults. x64 DispatchMessageW runs the guest WndProc through a
   * nested Executor using the Microsoft x64 calling convention (rcx/rdx/r8/r9
   * + shadow space + 8-byte sentinel return), so 64-bit guests (e.g.
   * notepad-x64) render through the same bridge path as x86.
   */

  install(dispatcher: ApiTrapDispatcher, _jit: JitEngine): void {
    const runtime = this.deps.runtime;
    this.guiDispatcher = dispatcher;
    // Bounds-checked 32-bit guest read (never grows the linear memory).
    const peek = (a: number): number => {
      if (a < 0 || a + 4 > runtime.memory.buffer.byteLength) return 0;
      return new DataView(runtime.memory.buffer).getInt32(a, true) >>> 0;
    };
    const readWStr = (address: number): string => {
      if (!address) return '';
      const bytes = runtime.readBytes(address, 4096);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      let s = '';
      for (let i = 0; i + 1 < bytes.byteLength; i += 2) {
        const c = view.getUint16(i, true);
        if (c === 0) break;
        s += String.fromCharCode(c);
      }
      return s;
    };

    const classNames = new Map<string, number>(); // lowercase class name -> atom
    let classAtom = 0;
    const registerClass = (ctx: ApiCallContext): ApiResult => {
      const atom = ++classAtom;
      const lpWndClass = ctx.rawArgs[0] ?? 0;
      if (lpWndClass) {
        // WNDCLASSEXW field offsets differ between x86 and x64 because x64 has
        // 8-byte pointers: x86  lpfnWndProc=+8, lpszMenuName=+36, lpszClassName=+40
        //                  x64  lpfnWndProc=+8, lpszMenuName=+56, lpszClassName=+64
        const { menuName: menuNameOff, name: nameOff } = this.deps.arch().wndClassExOffsets();
        this.classWndProcs.set(atom, peek(lpWndClass + 8)); // WNDCLASSEXW.lpfnWndProc
        const name = readWStr(peek(lpWndClass + nameOff)); // lpszClassName
        if (name) classNames.set(name.toLowerCase(), atom);
        // WNDCLASSEXW.lpszMenuName: numeric MAKEINTRESOURCE -> RT_MENU.
        // notepad attaches its menu to the class, so parse it here (Layer 3).
        const menuName = peek(lpWndClass + menuNameOff);
        if (menuName >>> 16 === 0) {
          const entry = this.menuResourceTable.get(menuName & 0xffff);
          if (entry) this.classMenus.set(atom, this.parseMenuResource(entry.address, entry.size));
        }
      }
      return { returnValue: atom, errorCode: E.NO_ERROR };
    };
    this.deps.interceptor.hook('user32.dll', 'RegisterClassExW', registerClass);
    this.deps.interceptor.hook('user32.dll', 'RegisterClassExA', registerClass);
    // RegisterClassW/A takes a WNDCLASSW (not EX): lpfnWndProc is at +4 and
    // lpszClassName at +36 (EX moves them to +8/+40). winmine registers its
    // board window class through this — returning 0 makes it _cexit and abort.
    const registerClassW = (ctx: ApiCallContext): ApiResult => {
      const atom = ++classAtom;
      const lpWndClass = ctx.rawArgs[0] ?? 0;
      if (lpWndClass) {
        this.classWndProcs.set(atom, peek(lpWndClass + 4)); // WNDCLASSW.lpfnWndProc
        const name = readWStr(peek(lpWndClass + 36)); // WNDCLASSW.lpszClassName
        if (name) classNames.set(name.toLowerCase(), atom);
        const menuName = peek(lpWndClass + 32); // WNDCLASSW.lpszMenuName
        if (menuName >>> 16 === 0) {
          const entry = this.menuResourceTable.get(menuName & 0xffff);
          if (entry) this.classMenus.set(atom, this.parseMenuResource(entry.address, entry.size));
        }
      }
      return { returnValue: atom, errorCode: E.NO_ERROR };
    };
    this.deps.interceptor.hook('user32.dll', 'RegisterClassW', registerClassW);
    this.deps.interceptor.hook('user32.dll', 'RegisterClassA', registerClassW);

    const createWindow = (ctx: ApiCallContext): ApiResult => {
      const hwnd = ++hwndSeq;
      const classNameArg = ctx.rawArgs[1] ?? 0;
      // CreateWindowExW layout (stdcall, [esp+4] = arg1):
      //   rawArgs[0]=dwExStyle, [1]=lpClassName, [2]=lpWindowName, [3]=dwStyle,
      //   [8]=hWndParent, [9]=hMenu. We keep exStyle/style so the host can
      //   emulate non-client chrome the guest never paints (WS_EX_CLIENTEDGE,
      //   WS_BORDER) — winmine relies on the OS for its sunken board frame.
      const exStyle = ctx.rawArgs[0] ?? 0;
      const style = ctx.rawArgs[3] ?? 0;
      const nameArg = ctx.rawArgs[2] ?? 0;
      const text = nameArg >>> 16 !== 0 ? readWStr(nameArg) : '';
      let wndProc = 0;
      let className = '';
      let atom = 0;
      if (classNameArg >>> 16 === 0) {
        // Class given as an atom (MAKEINTRESOURCE).
        className = `#${classNameArg & 0xffff}`;
        atom = classNameArg & 0xffff;
        wndProc = this.classWndProcs.get(atom) ?? 0;
      } else {
        className = readWStr(classNameArg);
        atom = className.toLowerCase() ? (classNames.get(className.toLowerCase()) ?? 0) : 0;
        if (atom) wndProc = this.classWndProcs.get(atom) ?? 0;
      }
      const menu =
        this.menuByHandle.get(ctx.rawArgs[9] ?? 0) ??
        (atom ? (this.classMenus.get(atom) ?? []) : []);
      this.windowRecords.set(hwnd, {
        wndProc,
        parent: ctx.rawArgs[8] ?? 0,
        className,
        text,
        exStyle,
        style,
        menu,
        width: 0,
        height: 0,
      });
      // Windows delivers WM_CREATE to every window as it is created. Enqueue
      // it for windows that have a real guest window procedure so the message
      // loop actually delivers it (system classes like "EDIT" have none).
      // WM_PAINT is appended too so the guest's paint path (the GDI bridge
      // target) actually runs during startup.
      if (wndProc) {
        this.guiMessageQueue.push({ hwnd, msg: 0x0001 /* WM_CREATE */, wParam: 0, lParam: 0 });
        this.guiMessageQueue.push({ hwnd, msg: 0x000f /* WM_PAINT */, wParam: 0, lParam: 0 });
      }
      return { returnValue: hwnd, errorCode: E.NO_ERROR };
    };
    this.deps.interceptor.hook('user32.dll', 'CreateWindowExW', createWindow);
    this.deps.interceptor.hook('user32.dll', 'CreateWindowExA', createWindow);

    // The window is "shown and painted" instantly.
    this.deps.interceptor.hook('user32.dll', 'ShowWindow', () => ok1());
    // UpdateWindow is registered further down (flushes a WM_PAINT).

    // Message loop: pop the synthetic queue. A non-empty queue yields one
    // message (return 1, MSG written to lpMsg); an empty queue is WM_QUIT
    // (return 0) in the CLI baseline. In interactive mode the call BLOCKS
    // (awaits) until the host pushes a message via postMessage/postText —
    // this keeps the guest process alive for real input.
    const writeMsg = (
      ctx: ApiCallContext,
      m: { hwnd: number; msg: number; wParam: number; lParam: number },
    ): ApiResult => {
      const lpMsg = ctx.rawArgs[0] ?? 0;
      if (lpMsg) {
        runtime.writeInt32(lpMsg + 0, m.hwnd);
        runtime.writeInt32(lpMsg + 4, m.msg);
        runtime.writeInt32(lpMsg + 8, m.wParam);
        runtime.writeInt32(lpMsg + 12, m.lParam);
        runtime.writeInt32(lpMsg + 16, 0); // time
        runtime.writeInt32(lpMsg + 20, 0); // pt.x
        runtime.writeInt32(lpMsg + 24, 0); // pt.y
      }
      return { returnValue: 1, errorCode: E.NO_ERROR };
    };
    const getMessage = async (ctx: ApiCallContext): Promise<ApiResult> => {
      const m = this.guiMessageQueue.shift();
      if (m) {
        console.log(
          '[GDI-walk] GetMessageW → queue msg=0x' +
            m.msg.toString(16) +
            ' hwnd=0x' +
            m.hwnd.toString(16),
        );
        return writeMsg(ctx, m);
      }
      if (this.quitRequested || !this.deps.interactive())
        return { returnValue: 0, errorCode: E.NO_ERROR };
      // Interactive: block until the host posts a message.
      this.deps.onMessageWait()?.();
      await new Promise<void>((resolve) => {
        this.pendingMessageResolve = resolve;
      });
      const m2 = this.guiMessageQueue.shift();
      console.log(
        '[GDI-walk] GetMessageW ← blocked wait msg=' +
          (m2 ? 'Y' : 'N') +
          ' msgVal=0x' +
          (m2 ? m2.msg.toString(16) : '0'),
      );
      if (!m2) return { returnValue: 0, errorCode: E.NO_ERROR };
      return writeMsg(ctx, m2);
    };
    this.deps.interceptor.hook('user32.dll', 'GetMessageW', getMessage);
    this.deps.interceptor.hook('user32.dll', 'GetMessageA', getMessage);

    // PeekMessageW/A: non-blocking queue drain sharing GetMessage's MSG
    // layout. winmine imports PeekMessageW for its dialog/sleep paths; a
    // missing stub would report "no message" forever there.
    const peekMessage = (ctx: ApiCallContext): ApiResult => {
      const m = this.guiMessageQueue[0];
      if (!m) return { returnValue: 0, errorCode: E.NO_ERROR };
      if (((ctx.rawArgs[4] ?? 0) & 0x0001) !== 0) {
        // PM_REMOVE: consume the message and fill the MSG struct.
        this.guiMessageQueue.shift();
        return writeMsg(ctx, m);
      }
      // PM_NOREMOVE: report presence without consuming.
      return { returnValue: 1, errorCode: E.NO_ERROR };
    };
    this.deps.interceptor.hook('user32.dll', 'PeekMessageW', peekMessage);
    this.deps.interceptor.hook('user32.dll', 'PeekMessageA', peekMessage);

    // PtInRect gates winmine's board clicks: the WndProc drops WM_LBUTTONUP
    // unless the point is inside the board/tile rect. Without this hook the
    // generic stub returns 0 ("outside") and the game is unclickable.
    // PtInRect(const RECT*, POINT pt) — pt is packed (x = low word, y = high
    // word), each a signed 16-bit value.
    this.deps.interceptor.hook('user32.dll', 'PtInRect', (ctx) => {
      const rc = readRect(ctx.rawArgs[0] ?? 0);
      const pt = ctx.rawArgs[1] ?? 0;
      const px = ((pt & 0xffff) << 16) >> 16;
      const py = ((pt >>> 16) << 16) >> 16;
      const inside = px >= rc.x && px < rc.x + rc.w && py >= rc.y && py < rc.y + rc.h;
      return { returnValue: inside ? 1 : 0, errorCode: E.NO_ERROR };
    });

    // Rect helpers. winmine builds its smiley-face hit rect with SetRect at
    // click time — the generic stub returned 0 WITHOUT writing the struct, so
    // PtInRect tested stack garbage and the face was unclickable while tiles
    // (arithmetically hit-tested) worked. RECT = {left, top, right, bottom}.
    this.deps.interceptor.hook('user32.dll', 'SetRect', (ctx) => {
      const lprc = ctx.rawArgs[0] ?? 0;
      if (lprc) {
        runtime.writeInt32(lprc + 0, ctx.rawArgs[1] ?? 0);
        runtime.writeInt32(lprc + 4, ctx.rawArgs[2] ?? 0);
        runtime.writeInt32(lprc + 8, ctx.rawArgs[3] ?? 0);
        runtime.writeInt32(lprc + 12, ctx.rawArgs[4] ?? 0);
      }
      return ok1();
    });
    this.deps.interceptor.hook('user32.dll', 'OffsetRect', (ctx) => {
      const lprc = ctx.rawArgs[0] ?? 0;
      if (lprc) {
        runtime.writeInt32(lprc + 0, runtime.readInt32(lprc + 0) + (ctx.rawArgs[1] ?? 0));
        runtime.writeInt32(lprc + 4, runtime.readInt32(lprc + 4) + (ctx.rawArgs[2] ?? 0));
        runtime.writeInt32(lprc + 8, runtime.readInt32(lprc + 8) + (ctx.rawArgs[1] ?? 0));
        runtime.writeInt32(lprc + 12, runtime.readInt32(lprc + 12) + (ctx.rawArgs[2] ?? 0));
      }
      return ok1();
    });
    this.deps.interceptor.hook('user32.dll', 'InflateRect', (ctx) => {
      const lprc = ctx.rawArgs[0] ?? 0;
      const dx = ctx.rawArgs[1] ?? 0;
      const dy = ctx.rawArgs[2] ?? 0;
      if (lprc) {
        runtime.writeInt32(lprc + 0, runtime.readInt32(lprc + 0) - dx);
        runtime.writeInt32(lprc + 4, runtime.readInt32(lprc + 4) - dy);
        runtime.writeInt32(lprc + 8, runtime.readInt32(lprc + 8) + dx);
        runtime.writeInt32(lprc + 12, runtime.readInt32(lprc + 12) + dy);
      }
      return ok1();
    });
    this.deps.interceptor.hook('user32.dll', 'CopyRect', (ctx) => {
      const dst = ctx.rawArgs[0] ?? 0;
      const src = ctx.rawArgs[1] ?? 0;
      if (dst && src) runtime.writeBytes(dst, runtime.readBytes(src, 16));
      return ok1();
    });
    this.deps.interceptor.hook('user32.dll', 'IsRectEmpty', (ctx) => {
      const lprc = ctx.rawArgs[0] ?? 0;
      const rc = readRect(lprc);
      return { returnValue: rc.w <= 0 || rc.h <= 0 ? 1 : 0, errorCode: E.NO_ERROR };
    });

    // Mouse capture: winmine captures on WM_LBUTTONDOWN and releases on
    // WM_LBUTTONUP. Returning the previous-owner NULL (0) / TRUE (1) keeps
    // that flow intact without real capture semantics.
    this.deps.interceptor.hook('user32.dll', 'SetCapture', () => ({
      returnValue: 0,
      errorCode: E.NO_ERROR,
    }));
    this.deps.interceptor.hook('user32.dll', 'ReleaseCapture', () => ok1());

    // InvalidateRect: our paint model is queue-driven, so "mark dirty" means
    // queue a WM_PAINT. Without this the board state changes on click but
    // nothing ever repaints — the game looks dead. UpdateWindow (below)
    // flushes the same way, at the front of the queue.
    const wakeMessageLoop = (): void => {
      if (this.pendingMessageResolve) {
        const resolve = this.pendingMessageResolve;
        this.pendingMessageResolve = null;
        resolve();
      }
    };
    this.deps.interceptor.hook('user32.dll', 'InvalidateRect', (ctx) => {
      const hwnd = ctx.rawArgs[0] ?? 0;
      if (hwnd) {
        this.queueGuiMessage({ hwnd, msg: 0x000f /* WM_PAINT */, wParam: 0, lParam: 0 });
        wakeMessageLoop();
      }
      return ok1();
    });
    this.deps.interceptor.hook('user32.dll', 'UpdateWindow', (ctx) => {
      const hwnd = ctx.rawArgs[0] ?? 0;
      if (hwnd) {
        // Real UpdateWindow paints synchronously if the update region is
        // non-empty; front-of-queue is the closest queue-driven equivalent.
        this.queueGuiMessage({ hwnd, msg: 0x000f /* WM_PAINT */, wParam: 0, lParam: 0 }, true);
        wakeMessageLoop();
      }
      return ok1();
    });

    // SetTimer/KillTimer: winmine starts a 1s game timer once the first tile
    // is revealed; WM_TIMER ticks drive the LED clock. A real SetTimer
    // returns a nonzero id — the generic 0 stub read as failure. Intervals
    // are torn down on run() start/end and PostQuitMessage.
    this.deps.interceptor.hook('user32.dll', 'SetTimer', (ctx) => {
      const hwnd = ctx.rawArgs[0] ?? 0;
      const id = ctx.rawArgs[1] ?? 0;
      const elapse = Math.max(1, ctx.rawArgs[2] ?? 1000);
      const key = ((hwnd & 0xffff) << 16) | (id & 0xffff);
      const prev = this.guiTimers.get(key);
      if (prev !== undefined) clearInterval(prev);
      const handle = setInterval(() => {
        this.queueGuiMessage({ hwnd, msg: 0x0113 /* WM_TIMER */, wParam: id & 0xffff, lParam: 0 });
        wakeMessageLoop();
      }, elapse);
      this.guiTimers.set(key, handle);
      return { returnValue: key || 1, errorCode: E.NO_ERROR };
    });
    this.deps.interceptor.hook('user32.dll', 'KillTimer', (ctx) => {
      const hwnd = ctx.rawArgs[0] ?? 0;
      const id = ctx.rawArgs[1] ?? 0;
      const key = ((hwnd & 0xffff) << 16) | (id & 0xffff);
      const prev = this.guiTimers.get(key);
      if (prev !== undefined) clearInterval(prev);
      this.guiTimers.delete(key);
      return ok1();
    });

    // Message-loop slots only reached when GetMessageW returns a message.
    this.deps.interceptor.hook('user32.dll', 'TranslateAcceleratorW', () => ({
      returnValue: 0,
      errorCode: E.NO_ERROR,
    }));
    this.deps.interceptor.hook('user32.dll', 'IsDialogMessageW', () => ({
      returnValue: 0,
      errorCode: E.NO_ERROR,
    }));
    this.deps.interceptor.hook('user32.dll', 'TranslateMessage', () => ({
      returnValue: 0,
      errorCode: E.NO_ERROR,
    }));
    this.deps.interceptor.hook('user32.dll', 'DefWindowProcW', async (ctx) => {
      const hwnd = ctx.rawArgs[0] ?? 0;
      const msg = ctx.rawArgs[1] ?? 0;
      console.log(
        '[GDI-walk] DefWindowProcW hwnd=0x%s msg=0x%s wParam=%d lParam=%d',
        hwnd.toString(16),
        msg.toString(16),
        ctx.rawArgs[2] ?? 0,
        ctx.rawArgs[3] ?? 0,
      );
      if (msg === 0x000f /* WM_PAINT */) {
        // Validate the window by creating a DC on the bridge and flushing.
        const bridge = this.deps.gdiBridgeProvider()?.(hwnd) ?? null;
        if (bridge) {
          const hdc = await bridge.createDC('DISPLAY');
          await safe(() => bridge.flush(hdc));
          await safe(() => bridge.deleteDC(hdc));
        }
        return { returnValue: 0, errorCode: E.NO_ERROR };
      }
      return { returnValue: 0, errorCode: E.NO_ERROR };
    });
    this.deps.interceptor.hook('user32.dll', 'PostQuitMessage', () => {
      this.clearTimers();
      this.guiMessageQueue.length = 0;
      this.quitRequested = true; // next GetMessageW returns 0 (WM_QUIT)
      if (this.pendingMessageResolve) {
        const r = this.pendingMessageResolve;
        this.pendingMessageResolve = null;
        r();
      }
      return { returnValue: 0, errorCode: E.NO_ERROR };
    });
    // SendMessageW: minimal system-control behaviour — the EDIT control's
    // text is tracked so the window record carries real content for the
    // renderer. All other messages keep the sane zero default.
    const sendMessage = (ctx: ApiCallContext): ApiResult => {
      const hwnd = ctx.rawArgs[0] ?? 0;
      const msg = ctx.rawArgs[1] ?? 0;
      const wParam = ctx.rawArgs[2] ?? 0;
      const lParam = ctx.rawArgs[3] ?? 0;
      const rec = this.windowRecords.get(hwnd);
      if (rec && rec.className.toLowerCase() === 'edit') {
        switch (msg) {
          case 0x000c: {
            // WM_SETTEXT
            rec.text = readWStr(lParam);
            console.log(
              '[GDI-walk] SendMessageW WM_SETTEXT hwnd=0x%s text="%s"',
              hwnd.toString(16),
              rec.text,
            );
            this.deps.onTextChanged()?.(hwnd, rec.text);
            return { returnValue: 1, errorCode: E.NO_ERROR };
          }
          case 0x000d: {
            // WM_GETTEXT: copy rec.text (max-1 chars + NUL)
            const s = rec.text;
            const n = Math.min(s.length, Math.max(0, wParam - 1));
            const w = new Uint8Array(n * 2 + 2);
            for (let i = 0; i < n; i++) {
              w[i * 2] = s.charCodeAt(i) & 0xff;
              w[i * 2 + 1] = (s.charCodeAt(i) >> 8) & 0xff;
            }
            runtime.writeBytes(lParam, w);
            return { returnValue: n, errorCode: E.NO_ERROR };
          }
          case 0x000e: // WM_GETTEXTLENGTH
            return { returnValue: rec.text.length, errorCode: E.NO_ERROR };
          case 0x00b8: // EM_GETMODIFY: report unmodified so New/Open/Exit
            return { returnValue: 0, errorCode: E.NO_ERROR }; // skip save prompt
          case 0x00b9: // EM_SETMODIFY
            return { returnValue: 0, errorCode: E.NO_ERROR };
          case 0x00b1: // EM_SETSEL
            return { returnValue: 0, errorCode: E.NO_ERROR };
          case 0x00c2: {
            // EM_REPLACESEL: notepad's New/Paste path — replace
            // the (all-selected) text with the given string.
            const rep = readWStr(lParam);
            if (rec.text !== rep) {
              rec.text = rep;
              this.deps.onTextChanged()?.(hwnd, rec.text);
            }
            return { returnValue: 0, errorCode: E.NO_ERROR };
          }
          case 0x00b6: // EM_GETLINECOUNT
            return {
              returnValue: rec.text === '' ? 1 : rec.text.split('\n').length,
              errorCode: E.NO_ERROR,
            };
          case 0x00bc: {
            // EM_SETHANDLE: notepad hands the EDIT a LocalAlloc'd
            // buffer containing the loaded file text (LMEM_FIXED here, so the
            // "handle" is the guest pointer). Adopt it as rec.text so the
            // renderer and the save path (EM_GETHANDLE) see the loaded content.
            const s = readWStr(wParam);
            if (rec.text !== s) {
              rec.text = s;
              this.deps.onTextChanged()?.(hwnd, rec.text);
            }
            return { returnValue: 0, errorCode: E.NO_ERROR };
          }
          case 0x00bd: {
            // EM_GETHANDLE: notepad's Save As asks the EDIT
            // control for its text handle, then reads the buffer directly
            // (GetWindowTextW path is NOT used). Allocate a guest buffer with
            // the UTF-16 text + NUL and return its address as the "handle".
            const s = rec.text;
            const size = Math.max(2, (s.length + 1) * 2);
            const alloc = this.deps.guestHeapAlloc();
            const p = alloc ? alloc(size) : 0;
            if (p) {
              const w = new Uint8Array(size);
              for (let i = 0; i < s.length; i++) {
                w[i * 2] = s.charCodeAt(i) & 0xff;
                w[i * 2 + 1] = (s.charCodeAt(i) >> 8) & 0xff;
              }
              runtime.writeBytes(p, w);
              console.log(
                '[GDI-walk] EM_GETHANDLE hwnd=0x%s -> 0x%s len=%d',
                hwnd.toString(16),
                p.toString(16),
                s.length,
              );
              return { returnValue: p, errorCode: E.NO_ERROR };
            }
            return { returnValue: 0, errorCode: E.ERROR_NOT_ENOUGH_MEMORY };
          }
          default:
            return { returnValue: 0, errorCode: E.NO_ERROR };
        }
      }
      return { returnValue: 0, errorCode: E.NO_ERROR };
    };
    this.deps.interceptor.hook('user32.dll', 'SendMessageW', sendMessage);
    this.deps.interceptor.hook('user32.dll', 'SendMessageA', sendMessage);
    this.deps.interceptor.hook('user32.dll', 'PostMessageW', (ctx) => {
      const hwnd = ctx.rawArgs[0] ?? 0;
      const msg = ctx.rawArgs[1] ?? 0;
      console.log(
        '[GDI-walk] PostMessageW hwnd=0x%s msg=0x%s wParam=%d lParam=%d',
        hwnd.toString(16),
        msg.toString(16),
        ctx.rawArgs[2] ?? 0,
        ctx.rawArgs[3] ?? 0,
      );
      this.queueGuiMessage({ hwnd, msg, wParam: ctx.rawArgs[2] ?? 0, lParam: ctx.rawArgs[3] ?? 0 });
      if (this.pendingMessageResolve) {
        const r = this.pendingMessageResolve;
        this.pendingMessageResolve = null;
        r();
      }
      return { returnValue: 1, errorCode: E.NO_ERROR };
    });
    this.deps.interceptor.hook('user32.dll', 'PostMessageA', (ctx) => {
      const hwnd = ctx.rawArgs[0] ?? 0;
      const msg = ctx.rawArgs[1] ?? 0;
      this.queueGuiMessage({ hwnd, msg, wParam: ctx.rawArgs[2] ?? 0, lParam: ctx.rawArgs[3] ?? 0 });
      if (this.pendingMessageResolve) {
        const r = this.pendingMessageResolve;
        this.pendingMessageResolve = null;
        r();
      }
      return { returnValue: 1, errorCode: E.NO_ERROR };
    });
    this.deps.interceptor.hook('user32.dll', 'GetWindowLongW', () => ({
      returnValue: 0,
      errorCode: E.NO_ERROR,
    }));
    this.deps.interceptor.hook('user32.dll', 'SetWindowLongW', () => ({
      returnValue: 0,
      errorCode: E.NO_ERROR,
    }));
    this.deps.interceptor.hook('user32.dll', 'DestroyWindow', () => ok1());
    // GetSystemMetrics: report a real virtual screen so GUI guests (winmine
    // centers its board window) compute positive coordinates. Without it the
    // default stub returns 0 and the window lands off-screen (x/y negative).
    this.deps.interceptor.hook('user32.dll', 'GetSystemMetrics', (ctx) => {
      const { width, height } = this.deps.screenSize();
      const index = ctx.rawArgs[0] ?? 0;
      let value = 0;
      switch (index) {
        case 0: // SM_CXSCREEN
        case 78: // SM_CXVIRTUALSCREEN
          value = width;
          break;
        case 1: // SM_CYSCREEN
        case 79: // SM_CYVIRTUALSCREEN
          value = height;
          break;
        case 4: // SM_CYCAPTION
        case 54: // SM_CXMENUSIZE
          value = 19;
          break;
        case 5: // SM_CXBORDER
        case 6: // SM_CYBORDER
          value = 1;
          break;
        case 7: // SM_CXDLGFRAME
        case 8: // SM_CYDLGFRAME
        case 32: // SM_CXFRAME
        case 33: // SM_CYFRAME
          value = 4;
          break;
        case 11: // SM_CXICON
        case 12: // SM_CYICON
          value = 32;
          break;
        case 13: // SM_CXCURSOR
        case 14: // SM_CYCURSOR
          value = 32;
          break;
        case 15: // SM_CXSMICON
        case 16: // SM_CYSMCAPTION
        case 49: // SM_CXSMICON (alt)
        case 50: // SM_CYSMCAPTION (alt)
          value = 16;
          break;
        case 45: // SM_CXEDGE
        case 46: // SM_CYEDGE
          value = 2;
          break;
        case 19: // SM_MOUSEPRESENT
        case 43: // SM_CMOUSEBUTTONS
          value = 1;
          break;
        case 75: // SM_MOUSEWHEELPRESENT
          value = 1;
          break;
        default:
          value = 0;
          break;
      }
      return { returnValue: value, errorCode: E.NO_ERROR };
    });
    this.deps.interceptor.hook('user32.dll', 'MoveWindow', (ctx) => {
      const hwnd = ctx.rawArgs[0] ?? 0;
      const w = ctx.rawArgs[3] ?? 0;
      const h = ctx.rawArgs[4] ?? 0;
      const bRepaint = ctx.rawArgs[5] ?? 0;
      const rec = this.windowRecords.get(hwnd);
      if (rec) {
        rec.width = w;
        rec.height = h;
      }
      console.log(
        '[GDI-walk] MoveWindow hwnd=0x%s x=%d y=%d w=%d h=%d repaint=%d',
        hwnd.toString(16),
        ctx.rawArgs[1] ?? 0,
        ctx.rawArgs[2] ?? 0,
        w,
        h,
        bRepaint,
      );
      if (bRepaint) {
        this.guiMessageQueue.push({ hwnd, msg: 0x000f /* WM_PAINT */, wParam: 0, lParam: 0 });
        if (this.pendingMessageResolve) {
          const r = this.pendingMessageResolve;
          this.pendingMessageResolve = null;
          r();
        }
      }
      return { returnValue: 1, errorCode: E.NO_ERROR };
    });
    // CreateStatusWindowW (comctl32): notepad's status bar — mint a unique
    // fake HWND from the same sequence as CreateWindowExW.
    this.deps.interceptor.hook('comctl32.dll', 'CreateStatusWindowW', () => ({
      returnValue: ++hwndSeq,
      errorCode: E.NO_ERROR,
    }));
    this.deps.interceptor.hook('comctl32.dll', 'CreateStatusWindowA', () => ({
      returnValue: ++hwndSeq,
      errorCode: E.NO_ERROR,
    }));
    // GetClientRect: report a sane client area so guest layout math (edit
    // control placement, margins) works instead of collapsing to zero.
    this.deps.interceptor.hook('user32.dll', 'GetClientRect', (ctx) => {
      const lprc = ctx.rawArgs[1] ?? 0;
      if (lprc) {
        runtime.writeInt32(lprc + 0, 0);
        runtime.writeInt32(lprc + 4, 0);
        runtime.writeInt32(lprc + 8, 800);
        runtime.writeInt32(lprc + 12, 560);
      }
      return { returnValue: 1, errorCode: E.NO_ERROR };
    });
    this.deps.interceptor.hook('user32.dll', 'GetWindowRect', (ctx) => {
      const lprc = ctx.rawArgs[1] ?? 0;
      if (lprc) {
        runtime.writeInt32(lprc + 0, 0);
        runtime.writeInt32(lprc + 4, 0);
        runtime.writeInt32(lprc + 8, 800);
        runtime.writeInt32(lprc + 12, 600);
      }
      return { returnValue: 1, errorCode: E.NO_ERROR };
    });

    // ------------------------------------------------------------------
    // GDI bridge (Layer 2): pseudo object handles + paint-command capture.
    // Real GDI drawing (from a WndProc WM_PAINT or any paint path) is
    // recorded as PaintCommands so a host renderer (L6 desktop) can replay
    // it; the guest only sees well-behaved pseudo-handles / 1s in return.
    //
    // Pixel path (design doc 3.2 / L6 image bridge): when `gdiBridge` is
    // provided and returns a bridge for the guest hwnd, drawing is forwarded
    // to that bridge instead of being captured — the L6 canvas owns the
    // pixels, and EndPaint/BitBlt flush them. Fallback (null bridge / headless)
    // keeps the PaintCommand capture above, so CLI runs are unchanged.
    // ------------------------------------------------------------------
    const nextGdiObj = (): number => ++this.gdiObjSeq;
    const recordPaint = (cmd: PaintCommand): ApiResult => {
      this.paintCommands.push(cmd);
      return { returnValue: 1, errorCode: E.NO_ERROR };
    };
    const bridgeByHdc = this.gdiBridgeByHdc;
    const bridgeFor = (hdc: number): GdiBridge | null => bridgeByHdc.get(hdc) ?? null;
    const ok1 = (): ApiResult => ({ returnValue: 1, errorCode: E.NO_ERROR });
    /** COLORREF (0x00BBGGRR) -> ARGB Color. */
    const colorFromBgr = (n: number): Color => ({
      r: n & 0xff,
      g: (n >>> 8) & 0xff,
      b: (n >>> 16) & 0xff,
      a: 255,
    });
    const BLACK: Color = { r: 0, g: 0, b: 0, a: 255 };
    const WHITE: Color = { r: 255, g: 255, b: 255, a: 255 };
    const brushColorByObj = new Map<number, Color>();
    const penColorByObj = new Map<number, Color>();
    const curBrushByHdc = new Map<number, Color>();
    const curPenByHdc = new Map<number, Color>();
    const penPosByHdc = new Map<number, { x: number; y: number }>();
    /**
     * Software DIB fallback: DCs created before the host bridge is registered
     * (winmine loads its 16 board tiles in WinMain, before the first
     * GetMessageW → onMessageWait wires the bridge) have no bridge surface.
     * SetDIBitsToDevice stores their pixels here so a later BitBlt from that
     * DC can still reach the real window bridge.
     */
    const softDibByHdc = new Map<number, DibSurface>();
    /** Swallow drawing errors (e.g. a guest passing a stale HDC). */
    const safe = async (fn: () => Promise<unknown>): Promise<void> => {
      try {
        await fn();
      } catch {
        /* ignore drawing errors */
      }
    };
    const readRect = (lprc: number): { x: number; y: number; w: number; h: number } =>
      lprc
        ? {
            x: runtime.readInt32(lprc + 0),
            y: runtime.readInt32(lprc + 4),
            w: runtime.readInt32(lprc + 8) - runtime.readInt32(lprc + 0),
            h: runtime.readInt32(lprc + 12) - runtime.readInt32(lprc + 4),
          }
        : { x: 0, y: 0, w: 0, h: 0 };
    const toRect = (r: { x: number; y: number; w: number; h: number }): Rect => ({
      x: r.x,
      y: r.y,
      width: r.w,
      height: r.h,
    });
    const readWStr16 = (address: number, cch: number): string => {
      const w = runtime.readBytes(address, Math.min(cch * 2, 4096));
      const view = new DataView(w.buffer, w.byteOffset, w.byteLength);
      let text = '';
      for (let i = 0; i + 1 < w.byteLength && i / 2 < cch; i += 2) {
        const c = view.getUint16(i, true);
        if (c === 0) break;
        text += String.fromCharCode(c);
      }
      return text;
    };

    // Object creation: mint pseudo handles and remember brush/pen colours so
    // the pixel path can resolve FillRect(brush) / LineTo(pen) colours.
    this.deps.interceptor.hook('gdi32.dll', 'GetStockObject', (ctx) => {
      const obj = nextGdiObj();
      const n = ctx.rawArgs[0] ?? 0;
      const c = n === 4 || n === 7 ? BLACK : WHITE; // BLACK_BRUSH(4), BLACK_PEN(7)
      if (n === 6 || n === 7) penColorByObj.set(obj, c);
      else brushColorByObj.set(obj, c);
      return { returnValue: obj, errorCode: E.NO_ERROR };
    });
    this.deps.interceptor.hook('gdi32.dll', 'SelectObject', (ctx) => {
      const hdc = ctx.rawArgs[0] ?? 0;
      const obj = ctx.rawArgs[1] ?? 0;
      if (brushColorByObj.has(obj)) curBrushByHdc.set(hdc, brushColorByObj.get(obj) ?? WHITE);
      if (penColorByObj.has(obj)) curPenByHdc.set(hdc, penColorByObj.get(obj) ?? BLACK);
      return { returnValue: 0, errorCode: E.NO_ERROR };
    });
    this.deps.interceptor.hook('gdi32.dll', 'DeleteObject', () => ok1());
    this.deps.interceptor.hook('gdi32.dll', 'CreateSolidBrush', (ctx) => {
      const obj = nextGdiObj();
      brushColorByObj.set(obj, colorFromBgr(ctx.rawArgs[0] ?? 0));
      return { returnValue: obj, errorCode: E.NO_ERROR };
    });
    this.deps.interceptor.hook('gdi32.dll', 'CreateHatchBrush', (ctx) => {
      const obj = nextGdiObj();
      brushColorByObj.set(obj, colorFromBgr(ctx.rawArgs[1] ?? 0));
      return { returnValue: obj, errorCode: E.NO_ERROR };
    });
    this.deps.interceptor.hook('gdi32.dll', 'CreatePen', (ctx) => {
      const obj = nextGdiObj();
      penColorByObj.set(obj, colorFromBgr(ctx.rawArgs[2] ?? 0));
      return { returnValue: obj, errorCode: E.NO_ERROR };
    });
    this.deps.interceptor.hook('gdi32.dll', 'CreateFontIndirectW', (ctx) => {
      const lpLogFont = ctx.rawArgs[0] ?? 0;
      if (lpLogFont) readWStr(lpLogFont + 28); // LOGFONTW.lfFaceName — validate
      return { returnValue: nextGdiObj(), errorCode: E.NO_ERROR };
    });
    this.deps.interceptor.hook('gdi32.dll', 'CreateFontIndirectA', () => ({
      returnValue: nextGdiObj(),
      errorCode: E.NO_ERROR,
    }));
    // DC acquisition: mint pseudo HDCs, or create real DCs on the guest's
    // bridge when one is wired (pixel path). BeginPaint also fills
    // PAINTSTRUCT.hdc with the handle the drawing calls will use.
    this.deps.interceptor.hook('user32.dll', 'GetDC', async (ctx) => {
      const bridge = this.deps.gdiBridgeProvider()?.(ctx.rawArgs[0] ?? 0) ?? null;
      if (!bridge) return { returnValue: nextGdiObj(), errorCode: E.NO_ERROR };
      const hdc = await bridge.createDC('DISPLAY');
      bridgeByHdc.set(hdc, bridge);
      return { returnValue: hdc, errorCode: E.NO_ERROR };
    });
    this.deps.interceptor.hook('user32.dll', 'GetWindowDC', async (ctx) => {
      const bridge = this.deps.gdiBridgeProvider()?.(ctx.rawArgs[0] ?? 0) ?? null;
      if (!bridge) return { returnValue: nextGdiObj(), errorCode: E.NO_ERROR };
      const hdc = await bridge.createDC('DISPLAY');
      bridgeByHdc.set(hdc, bridge);
      return { returnValue: hdc, errorCode: E.NO_ERROR };
    });
    this.deps.interceptor.hook('user32.dll', 'ReleaseDC', async (ctx) => {
      const hdc = ctx.rawArgs[1] ?? 0;
      const bridge = bridgeFor(hdc);
      if (!bridge) return ok1();
      // Flush before teardown: guests that draw via GetDC/ReleaseDC outside
      // the BeginPaint/EndPaint cycle (winmine reveals tiles this way) have
      // their pixels stuck in the surface until the NEXT paint otherwise —
      // the board only "caught up" when a menu action forced a WM_PAINT.
      await safe(() => bridge.flush(hdc));
      await safe(() => bridge.deleteDC(hdc));
      bridgeByHdc.delete(hdc);
      return ok1();
    });
    this.deps.interceptor.hook('user32.dll', 'BeginPaint', async (ctx) => {
      const hwnd = ctx.rawArgs[0] ?? 0;
      const lpPaint = ctx.rawArgs[1] ?? 0;
      const bridge = this.deps.gdiBridgeProvider()?.(hwnd) ?? null;
      if (bridge) {
        const hdc = await bridge.createDC('DISPLAY');
        bridgeByHdc.set(hdc, bridge);
        if (lpPaint) {
          runtime.writeInt32(lpPaint + 0, hdc);
          runtime.writeInt32(lpPaint + 4, 0); // fErase
        }
        console.log(
          '[GDI-walk] BeginPaint hwnd=0x%s bridge=%s hdc=%d',
          hwnd.toString(16),
          'Y',
          hdc,
        );
        return { returnValue: hdc, errorCode: E.NO_ERROR };
      }
      if (lpPaint) {
        runtime.writeInt32(lpPaint + 0, this.gdiObjSeq + 1); // hdc
        runtime.writeInt32(lpPaint + 4, 0); // fErase
      }
      console.log(
        '[GDI-walk] BeginPaint hwnd=0x%s bridge=N (fallback gdiObj=%d)',
        hwnd.toString(16),
        this.gdiObjSeq + 1,
      );
      return { returnValue: ++this.gdiObjSeq, errorCode: E.NO_ERROR };
    });
    this.deps.interceptor.hook('user32.dll', 'EndPaint', async (ctx) => {
      const hdc = ctx.rawArgs[1] ? peek(ctx.rawArgs[1]) : 0;
      const bridge = bridgeFor(hdc);
      if (!bridge) return ok1();
      console.log('[GDI-walk] EndPaint hdc=%d → flush', hdc);
      await safe(() => bridge.flush(hdc));
      bridgeByHdc.delete(hdc);
      return ok1();
    });
    // Drawing primitives: forward to the pixel bridge when available, else
    // capture a PaintCommand for the classic replay renderer.
    this.deps.interceptor.hook('gdi32.dll', 'TextOutW', async (ctx) => {
      const hdc = ctx.rawArgs[0] ?? 0;
      const x = ctx.rawArgs[1] ?? 0;
      const y = ctx.rawArgs[2] ?? 0;
      const text = readWStr16(ctx.rawArgs[3] ?? 0, ctx.rawArgs[4] ?? 0);
      const bridge = bridgeFor(hdc);
      if (bridge) {
        await safe(() => bridge.textOut(hdc, x, y, text));
        return ok1();
      }
      return recordPaint({ op: 'text', hdc, x, y, text });
    });
    this.deps.interceptor.hook('gdi32.dll', 'ExtTextOutW', async (ctx) => {
      const hdc = ctx.rawArgs[0] ?? 0;
      const x = ctx.rawArgs[1] ?? 0;
      const y = ctx.rawArgs[2] ?? 0;
      const text = readWStr16(ctx.rawArgs[4] ?? 0, ctx.rawArgs[5] ?? 0);
      const bridge = bridgeFor(hdc);
      if (bridge) {
        await safe(() => bridge.textOut(hdc, x, y, text));
        return ok1();
      }
      return recordPaint({ op: 'text', hdc, x, y, text });
    });
    this.deps.interceptor.hook('gdi32.dll', 'SetTextColor', async (ctx) => {
      const bridge = bridgeFor(ctx.rawArgs[0] ?? 0);
      if (bridge)
        await safe(() =>
          bridge.setTextColor(ctx.rawArgs[0] ?? 0, colorFromBgr(ctx.rawArgs[1] ?? 0)),
        );
      return { returnValue: ctx.rawArgs[1] ?? 0, errorCode: E.NO_ERROR };
    });
    this.deps.interceptor.hook('gdi32.dll', 'SetBkColor', async (ctx) => {
      const bridge = bridgeFor(ctx.rawArgs[0] ?? 0);
      if (bridge)
        await safe(() => bridge.setBkColor(ctx.rawArgs[0] ?? 0, colorFromBgr(ctx.rawArgs[1] ?? 0)));
      return { returnValue: ctx.rawArgs[1] ?? 0, errorCode: E.NO_ERROR };
    });
    this.deps.interceptor.hook('gdi32.dll', 'SetBkMode', async (ctx) => {
      const bridge = bridgeFor(ctx.rawArgs[0] ?? 0);
      if (bridge) await safe(() => bridge.setBkMode(ctx.rawArgs[0] ?? 0, ctx.rawArgs[1] ?? 0));
      return { returnValue: ctx.rawArgs[1] ?? 0, errorCode: E.NO_ERROR };
    });
    this.deps.interceptor.hook('gdi32.dll', 'GetBkColor', () => ({
      returnValue: 0x00ffffff,
      errorCode: E.NO_ERROR,
    }));
    this.deps.interceptor.hook('gdi32.dll', 'GetTextColor', () => ({
      returnValue: 0,
      errorCode: E.NO_ERROR,
    }));
    this.deps.interceptor.hook('gdi32.dll', 'GetTextAlign', () => ({
      returnValue: 0,
      errorCode: E.NO_ERROR,
    }));
    this.deps.interceptor.hook('gdi32.dll', 'SetTextAlign', (ctx) => ({
      returnValue: ctx.rawArgs[1] ?? 0,
      errorCode: E.NO_ERROR,
    }));
    this.deps.interceptor.hook('gdi32.dll', 'SetMapMode', (ctx) => ({
      returnValue: ctx.rawArgs[1] ?? 0,
      errorCode: E.NO_ERROR,
    }));
    this.deps.interceptor.hook('gdi32.dll', 'GetMapMode', () => ({
      returnValue: 1,
      errorCode: E.NO_ERROR,
    }));
    this.deps.interceptor.hook('gdi32.dll', 'SetViewportOrgEx', () => ok1());
    this.deps.interceptor.hook('gdi32.dll', 'SetWindowOrgEx', () => ok1());
    this.deps.interceptor.hook('gdi32.dll', 'GetTextMetrics', (ctx) => {
      const lptm = ctx.rawArgs[1] ?? 0;
      if (lptm) {
        runtime.writeInt32(lptm + 0, 16); // tmHeight
        runtime.writeInt32(lptm + 4, 12); // tmAscent
        runtime.writeInt32(lptm + 8, 4); // tmDescent
      }
      return { returnValue: 1, errorCode: E.NO_ERROR };
    });
    this.deps.interceptor.hook('gdi32.dll', 'GetTextFaceW', (ctx) => {
      const buf = ctx.rawArgs[1] ?? 0;
      if (buf) {
        runtime.writeBytes(
          buf,
          new Uint8Array([
            0x43, 0, 0x6f, 0, 0x6e, 0, 0x73, 0, 0x6f, 0, 0x6c, 0, 0x61, 0, 0x73, 0, 0, 0,
          ]),
        ); // "Consolas"
      }
      return { returnValue: 8, errorCode: E.NO_ERROR };
    });
    this.deps.interceptor.hook('gdi32.dll', 'GetDeviceCaps', () => ({
      returnValue: 96,
      errorCode: E.NO_ERROR,
    }));
    this.deps.interceptor.hook('gdi32.dll', 'MoveToEx', (ctx) => {
      const hdc = ctx.rawArgs[0] ?? 0;
      const x = ctx.rawArgs[1] ?? 0;
      const y = ctx.rawArgs[2] ?? 0;
      penPosByHdc.set(hdc, { x, y });
      const lppt = ctx.rawArgs[3] ?? 0;
      if (lppt) {
        runtime.writeInt32(lppt + 0, x);
        runtime.writeInt32(lppt + 4, y);
      }
      return { returnValue: 1, errorCode: E.NO_ERROR };
    });
    this.deps.interceptor.hook('gdi32.dll', 'LineTo', async (ctx) => {
      const hdc = ctx.rawArgs[0] ?? 0;
      const x = ctx.rawArgs[1] ?? 0;
      const y = ctx.rawArgs[2] ?? 0;
      const bridge = bridgeFor(hdc);
      // GDI: LineTo draws from the current position AND moves it to the
      // endpoint. winmine draws its 3D bevels with MoveToEx/LineTo chains —
      // without the update every segment after the first started from the
      // stale start point (the diagonal-line artifact across the board).
      const from = penPosByHdc.get(hdc) ?? { x: 0, y: 0 };
      penPosByHdc.set(hdc, { x, y });
      if (bridge) {
        await safe(() => bridge.lineTo(hdc, from.x, from.y, x, y, curPenByHdc.get(hdc) ?? BLACK));
        return ok1();
      }
      return recordPaint({ op: 'line', hdc, x, y });
    });
    this.deps.interceptor.hook('gdi32.dll', 'FillRect', async (ctx) => {
      const hdc = ctx.rawArgs[0] ?? 0;
      const rc = readRect(ctx.rawArgs[1] ?? 0);
      const bridge = bridgeFor(hdc);
      if (bridge) {
        const color = brushColorByObj.get(ctx.rawArgs[2] ?? 0) ?? curBrushByHdc.get(hdc) ?? WHITE;
        await safe(() => bridge.fillRect(hdc, toRect(rc), color));
        return ok1();
      }
      return recordPaint({ op: 'fillrect', hdc, x: rc.x, y: rc.y, w: rc.w, h: rc.h });
    });
    this.deps.interceptor.hook('gdi32.dll', 'FrameRect', async (ctx) => {
      const hdc = ctx.rawArgs[0] ?? 0;
      const rc = readRect(ctx.rawArgs[1] ?? 0);
      const bridge = bridgeFor(hdc);
      if (bridge) {
        const color = brushColorByObj.get(ctx.rawArgs[2] ?? 0) ?? curBrushByHdc.get(hdc) ?? WHITE;
        await safe(() => bridge.frameRect(hdc, toRect(rc), color));
        return ok1();
      }
      return recordPaint({ op: 'rect', hdc, x: rc.x, y: rc.y, w: rc.w, h: rc.h });
    });
    this.deps.interceptor.hook('gdi32.dll', 'Rectangle', async (ctx) => {
      const hdc = ctx.rawArgs[0] ?? 0;
      const x = Math.min(ctx.rawArgs[1] ?? 0, ctx.rawArgs[3] ?? 0);
      const y = Math.min(ctx.rawArgs[2] ?? 0, ctx.rawArgs[4] ?? 0);
      const w = Math.abs((ctx.rawArgs[3] ?? 0) - (ctx.rawArgs[1] ?? 0));
      const h = Math.abs((ctx.rawArgs[4] ?? 0) - (ctx.rawArgs[2] ?? 0));
      const bridge = bridgeFor(hdc);
      if (bridge) {
        const rc = { x, y, w, h };
        const R = toRect(rc);
        await safe(async () => {
          await bridge.fillRect(hdc, R, curBrushByHdc.get(hdc) ?? WHITE);
          await bridge.frameRect(hdc, R, curPenByHdc.get(hdc) ?? BLACK);
        });
        return ok1();
      }
      return recordPaint({ op: 'rect', hdc, x, y, w, h });
    });
    this.deps.interceptor.hook('gdi32.dll', 'PatBlt', async (ctx) => {
      const hdc = ctx.rawArgs[0] ?? 0;
      const rc = {
        x: ctx.rawArgs[1] ?? 0,
        y: ctx.rawArgs[2] ?? 0,
        w: ctx.rawArgs[3] ?? 0,
        h: ctx.rawArgs[4] ?? 0,
      };
      const bridge = bridgeFor(hdc);
      if (bridge) {
        await safe(() =>
          bridge.patBlt(hdc, toRect(rc), curBrushByHdc.get(hdc) ?? WHITE, ctx.rawArgs[5] ?? 0),
        );
        return ok1();
      }
      return ok1();
    });
    this.deps.interceptor.hook('gdi32.dll', 'BitBlt', async (ctx) => {
      const dest = ctx.rawArgs[0] ?? 0;
      const src = ctx.rawArgs[5] ?? 0;
      const destBridge = bridgeFor(dest);
      const srcBridge = bridgeFor(src);
      const rc = {
        x: ctx.rawArgs[1] ?? 0,
        y: ctx.rawArgs[2] ?? 0,
        w: ctx.rawArgs[3] ?? 0,
        h: ctx.rawArgs[4] ?? 0,
      };
      if (destBridge && srcBridge === destBridge) {
        await safe(() =>
          destBridge.bitBlt(
            dest,
            toRect(rc),
            src,
            toRect({ x: ctx.rawArgs[6] ?? 0, y: ctx.rawArgs[7] ?? 0, w: rc.w, h: rc.h }),
            ctx.rawArgs[8] ?? 0,
          ),
        );
      } else if (destBridge && !srcBridge) {
        // Source DC was created before the bridge existed (winmine's board
        // tiles): replay its stored DIB pixels onto the real window bridge.
        const dib = softDibByHdc.get(src);
        if (dib) {
          const sx = ctx.rawArgs[6] ?? 0;
          const sy = ctx.rawArgs[7] ?? 0;
          await safe(() =>
            destBridge.setDIBitsToDevice(dest, rc.x, rc.y, {
              ...dib,
              xSrc: dib.xSrc + sx,
              ySrc: dib.ySrc + sy,
              drawWidth: rc.w,
              drawHeight: rc.h,
            }),
          );
        }
      }
      return ok1();
    });
    // SetDIBitsToDevice(hdc, xDest, yDest, w, h, xSrc, ySrc, StartScan, cLines,
    // lpvBits, lpbmi, ColorUse): winmine blits its 4bpp board tiles through this.
    // Parse BITMAPINFO + palette + bits from guest memory and forward to the
    // bridge's pixel path so the board actually reaches the canvas.
    this.deps.interceptor.hook('gdi32.dll', 'SetDIBitsToDevice', async (ctx) => {
      const hdc = ctx.rawArgs[0] ?? 0;
      const xDest = ctx.rawArgs[1] ?? 0;
      const yDest = ctx.rawArgs[2] ?? 0;
      const drawWidth = ctx.rawArgs[3] ?? 0;
      const drawHeight = ctx.rawArgs[4] ?? 0;
      const xSrc = ctx.rawArgs[5] ?? 0;
      const ySrc = ctx.rawArgs[6] ?? 0;
      const startScan = ctx.rawArgs[7] ?? 0;
      const cLines = ctx.rawArgs[8] ?? 0;
      const lpvBits = ctx.rawArgs[9] ?? 0;
      const lpbmi = ctx.rawArgs[10] ?? 0;
      const bridge = bridgeFor(hdc);
      if (!lpbmi || !lpvBits) return ok1();
      const biSize = peek(lpbmi);
      if (biSize < 40) return ok1();
      const biWidth = peek(lpbmi + 4);
      const biHeight = peek(lpbmi + 8);
      const biBitCount = peek(lpbmi + 14) & 0xffff;
      const biCompression = peek(lpbmi + 16);
      if (biCompression !== 0 || biWidth <= 0 || biHeight === 0) return ok1(); // BI_RGB only
      const biClrUsed = peek(lpbmi + 32);
      let palette: Uint32Array | null = null;
      if (biBitCount <= 8) {
        const nColors = biClrUsed || 1 << biBitCount;
        const palBytes = runtime.readBytes(lpbmi + 40, nColors * 4);
        const view = new DataView(palBytes.buffer, palBytes.byteOffset, palBytes.byteLength);
        palette = new Uint32Array(nColors);
        for (let i = 0; i < nColors; i++) {
          const b = view.getUint8(i * 4);
          const g = view.getUint8(i * 4 + 1);
          const r = view.getUint8(i * 4 + 2);
          palette[i] = (0xff000000 | (r << 16) | (g << 8) | b) >>> 0;
        }
      }
      // lpvBits 只含 cLines 条扫描线（从 StartScan 起），winmine 把 bits 指针
      // 直接指向精灵图内某块 tile 的数据，bmi 却描述整张 16x256 图——按
      // stride*cLines 读取，避免越界读入相邻数据。
      const stride = Math.floor((biWidth * biBitCount + 31) / 32) * 4;
      const bits = runtime.readBytes(lpvBits, stride * Math.max(0, cLines));
      const dib: DibSurface = {
        width: biWidth,
        height: biHeight,
        bitCount: biBitCount,
        palette,
        bits,
        xSrc,
        ySrc,
        drawWidth,
        drawHeight,
        startScan,
        cLines,
      };
      if (bridge) {
        await safe(() => bridge.setDIBitsToDevice(hdc, xDest, yDest, dib));
      } else {
        // Pre-bridge DC: keep the pixels so a later BitBlt can replay them.
        softDibByHdc.set(hdc, dib);
      }
      return { returnValue: cLines, errorCode: E.NO_ERROR };
    });
    this.deps.interceptor.hook('gdi32.dll', 'StretchBlt', async (ctx) => {
      const dest = ctx.rawArgs[0] ?? 0;
      const src = ctx.rawArgs[5] ?? 0;
      const destBridge = bridgeFor(dest);
      if (destBridge && bridgeFor(src) === destBridge) {
        const rc = {
          x: ctx.rawArgs[1] ?? 0,
          y: ctx.rawArgs[2] ?? 0,
          w: ctx.rawArgs[3] ?? 0,
          h: ctx.rawArgs[4] ?? 0,
        };
        const srcRc = {
          x: ctx.rawArgs[6] ?? 0,
          y: ctx.rawArgs[7] ?? 0,
          w: ctx.rawArgs[8] ?? 0,
          h: ctx.rawArgs[9] ?? 0,
        };
        await safe(() =>
          destBridge.stretchBlt(dest, toRect(rc), src, toRect(srcRc), ctx.rawArgs[10] ?? 0),
        );
      }
      return ok1();
    });
    this.deps.interceptor.hook('gdi32.dll', 'CreateCompatibleDC', async (ctx) => {
      const src = ctx.rawArgs[0] ?? 0;
      const bridge = bridgeFor(src);
      console.log(
        '[GDI-walk] CreateCompatibleDC src=0x%s bridge=%s',
        src.toString(16),
        bridge ? 'Y' : 'N',
      );
      if (bridge) {
        const hdc = await bridge.createCompatibleDC(src);
        bridgeByHdc.set(hdc, bridge);
        return { returnValue: hdc, errorCode: E.NO_ERROR };
      }
      return { returnValue: nextGdiObj(), errorCode: E.NO_ERROR };
    });
    this.deps.interceptor.hook('gdi32.dll', 'CreateCompatibleBitmap', () => ({
      returnValue: nextGdiObj(),
      errorCode: E.NO_ERROR,
    }));
    this.deps.interceptor.hook('gdi32.dll', 'SelectPalette', () => ({
      returnValue: 0,
      errorCode: E.NO_ERROR,
    }));
    this.deps.interceptor.hook('gdi32.dll', 'RealizePalette', () => ({
      returnValue: 0,
      errorCode: E.NO_ERROR,
    }));
    this.deps.interceptor.hook('gdi32.dll', 'SaveDC', async (ctx) => {
      const bridge = bridgeFor(ctx.rawArgs[0] ?? 0);
      if (bridge) await safe(() => bridge.saveDC(ctx.rawArgs[0] ?? 0));
      return { returnValue: 1, errorCode: E.NO_ERROR };
    });
    this.deps.interceptor.hook('gdi32.dll', 'RestoreDC', async (ctx) => {
      const bridge = bridgeFor(ctx.rawArgs[0] ?? 0);
      if (bridge) await safe(() => bridge.restoreDC(ctx.rawArgs[0] ?? 0, ctx.rawArgs[1] ?? 0));
      return ok1();
    });

    // DispatchMessageW: run the guest WndProc with (hwnd, msg, wParam,
    // lParam) on the stack (stdcall) and a sentinel return address; the
    // nested Executor stops when WndProc's `ret 16` pops it.
    const dispatchMessage = async (ctx: ApiCallContext): Promise<ApiResult> => {
      const lpMsg = ctx.rawArgs[0] ?? 0;
      if (!lpMsg) return { returnValue: 0, errorCode: E.NO_ERROR };
      const hwnd = peek(lpMsg);
      const message = peek(lpMsg + 4);
      const wParam = peek(lpMsg + 8);
      const lParam = peek(lpMsg + 12);
      await this.dispatchMessageRecord({ hwnd, msg: message, wParam, lParam });
      return { returnValue: 0, errorCode: E.NO_ERROR };
    };
    this.deps.interceptor.hook('user32.dll', 'DispatchMessageW', dispatchMessage);
    this.deps.interceptor.hook('user32.dll', 'DispatchMessageA', dispatchMessage);
  }

  /**
   * Dispatches a single window message to the guest WndProc. For x86 this runs
   * the classic stdcall 4-arg frame; for x64 it sets up the Microsoft x64
   * calling convention (rcx/rdx/r8/r9 + 32-byte shadow space) and an 8-byte
   * sentinel return address so the WndProc's `ret` lands on the SEH sentinel
   * and the nested executor stops. Re-entrant: a WndProc may itself trap into
   * the API dispatcher (e.g. DefWindowProcW, GDI) — those run on the main
   * dispatcher while this method awaits the nested executor.
   */
  private async dispatchMessageRecord(msg: {
    hwnd: number;
    msg: number;
    wParam: number;
    lParam: number;
  }): Promise<void> {
    const { hwnd, msg: message, wParam, lParam } = msg;
    const wndRec = this.windowRecords.get(hwnd);
    const wndProc = wndRec?.wndProc ?? 0;
    const sAddr = this.deps.sehSentinelAddr();
    console.log(
      '[GDI-walk] DispatchMessageW hwnd=0x%s wndProc=0x%s sAddr=0x%s mode=%s',
      hwnd.toString(16),
      wndProc.toString(16),
      sAddr.toString(16),
      this.deps.arch().mode,
    );
    // System classes (EDIT, BUTTON, STATIC, …) have no guest WndProc.
    // Handle their messages directly here instead of dropping them.
    if (!wndProc) {
      if (
        wndRec &&
        wndRec.className.toLowerCase() === 'edit' &&
        message === 0x000f /* WM_PAINT */
      ) {
        const bridge = this.deps.gdiBridgeProvider()?.(hwnd) ?? null;
        if (bridge) {
          try {
            const hdc = await bridge.createDC('DISPLAY');
            await bridge.flush(hdc);
            await bridge.deleteDC(hdc);
          } catch {
            /* ignore */
          }
        }
      }
      return;
    }
    if (sAddr === 0) return;
    const saved = snapshotRegs(this.deps.arch(), this.deps.runtime);
    this.deps
      .arch()
      .setupWndProcCall(this.deps.runtime, wndProc, hwnd, message, wParam, lParam, sAddr);
    const nested = new Executor(this.deps.runtime, this.deps.activeJit(), this.sentinelHandler(), {
      maxSteps: 500_000,
      onStep: this.dispatchOnStep(),
    });
    await nested.run(wndProc);
    restoreRegs(this.deps.runtime, saved);
  }

  /** Nested-executor trap handler: SEH sentinel ends the WndProc, others go to the API dispatcher. */
  private sentinelHandler(): TrapHandler {
    return {
      handle: async (vector: number): Promise<void> => {
        if (vector === SEH_SENTINEL_VECTOR) {
          console.log('[GDI-walk] nested sentinel hit → WndProc returned');
          this.deps.runtime.setEip(0);
          return;
        }
        console.log('[GDI-walk] nested trap vector=%d', vector);
        await this.guiDispatcher.handle(vector);
        const lastStub = this.guiDispatcher.lastCalled;
        if (lastStub) {
          console.log(
            '[GDI-walk] nested trap → %s!%s idx=%d',
            lastStub.module,
            lastStub.proc,
            this.deps.runtime.getReg('eax'),
          );
        } else {
          console.log(
            '[GDI-walk] nested trap → unknown stub (eax=%d)',
            this.deps.runtime.getReg('eax'),
          );
        }
      },
    };
  }

  /** onStep wrapper that fires probes + the host onStep inside the nested WndProc executor. */
  private dispatchOnStep(): ((eip: number, rt: WasmRuntimeImpl) => void) | undefined {
    const opts = this.deps.activeOptions();
    if (!opts.probes?.length && !opts.onStep) return undefined;
    return (eip: number, rt: WasmRuntimeImpl) => {
      for (const p of opts.probes ?? []) if (p.eip === eip) p.fn(rt);
      opts.onStep?.(eip, rt);
    };
  }

  /**
   * Message pump for the WinUI/THF host object. notepad-x64's message loop
   * lives inside the framework COM object's method, not in its own WinMain, so
   * the fake host `com_method` runs this pump. Non-interactive (headless) runs
   * drain the already-queued WM_CREATE/WM_PAINT once; interactive runs loop
   * until a WM_QUIT (posted by the host on window close).
   */
  async runPump(): Promise<number> {
    if (!this.deps.interactive()) {
      while (this.guiMessageQueue.length > 0) {
        const m = this.guiMessageQueue.shift()!;
        await this.dispatchMessageRecord(m);
      }
      return 0;
    }
    while (true) {
      if (this.guiMessageQueue.length === 0) {
        // Signal the host (mirrors GetMessageW) so it can post WM_PAINT /
        // WM_QUIT and keep the pump alive.
        this.deps.onMessageWait()?.();
        await new Promise<void>((resolve) => {
          this.pendingMessageResolve = resolve;
        });
      }
      const m = this.guiMessageQueue.shift()!;
      if (m.msg === 0x0012 /* WM_QUIT */) {
        this.quitRequested = true;
        return m.wParam;
      }
      await this.dispatchMessageRecord(m);
    }
  }

  /**
   * Parses an RT_MENU (type 4) resource into flat menu sections for the host
   * to render. Classic MENUITEMTEMPLATE layout with NO alignment padding
   * (verified against winmine.exe menu #500):
   *   header: WORD version, WORD offset — items start right after
   *   item:   WORD option; if not MF_POPUP, WORD command id; then a
   *           NUL-terminated wide string.
   * MF_POPUP (0x10) opens a submenu (top-level ones become sections), MF_END
   * (0x80) marks the last item of the current level, separators ([option
   * 0x800] or empty-string items) render nothing. The command id is the
   * resource's own WORD — posting it back via WM_COMMAND is what makes menu
   * items actually work (winmine expects 0x1FE = New, 0x209 = Beginner, ...).
   */
  parseMenuResource(addr: number, size = 0): GuestMenuSection[] {
    if (!addr) return [];
    const mem = this.deps.runtime.memory.buffer;
    const view = new DataView(mem);
    const u16 = (a: number): number => (a + 2 <= mem.byteLength ? view.getUint16(a, true) : 0);
    const readW = (a: number): string => {
      if (!a) return '';
      let s = '';
      for (let i = 0; a + i + 1 < mem.byteLength && i < 512; i += 2) {
        const c = view.getUint16(a + i, true);
        if (c === 0) break;
        s += String.fromCharCode(c);
      }
      return s;
    };
    const sections: GuestMenuSection[] = [];
    // Stack of open item containers: [0] is a top-level pseudo list, each
    // open popup pushes the array its children belong to. Nested popups
    // flatten: the submenu title becomes an item and its children share the
    // parent section's list (the host renders one flat list per menu).
    // `ends` is parallel to the stack: whether the popup that OPENED this
    // level carried MF_END. That flag means "last item of the PARENT level",
    // so completing the level completes the parent too — cascade pop
    // (winmine's "&Help" is 0x0090 = MF_POPUP|MF_END).
    const stack: GuestMenuItem[][] = [[]];
    const ends: boolean[] = [false];
    let top: GuestMenuSection | null = null;
    const limit = size > 0 ? Math.min(addr + size, mem.byteLength) : mem.byteLength;
    let off = addr + 4 + u16(addr + 2);
    for (let guard = 0; guard < 1024 && off + 2 <= limit && stack.length > 0; guard++) {
      const option = u16(off);
      off += 2;
      let id = 0;
      if ((option & 0x10) === 0) {
        id = u16(off); // plain items carry a WORD command id before the string
        off += 2;
      }
      const label = readW(off);
      off += (label.length + 1) * 2;
      const popup = (option & 0x10) !== 0;
      const end = (option & 0x80) !== 0;
      if (popup) {
        if (stack.length === 1) {
          top = { title: label, items: [] };
          sections.push(top);
        } else {
          top?.items.push({ id: 0, label });
        }
        if (top) {
          stack.push(top.items);
          ends.push(end);
        }
      } else if (label.length > 0 && (option & 0x800) === 0 && stack.length > 1) {
        stack[stack.length - 1]!.push({ id, label });
      }
      // MF_END on a plain item closes its level. On a POPUP item it means
      // "last entry of the parent level" — the level just opened still
      // receives its children first, so the immediate pop is skipped and the
      // stored flag cascades when the child level completes instead.
      if (end && !popup) {
        stack.pop();
        let cascade = ends.pop();
        while (cascade && stack.length > 1) {
          stack.pop();
          cascade = ends.pop() ?? false;
        }
      }
    }
    return sections;
  }

  /**
   * Queues a GUI message with Windows-style coalescing. The real message
   * queue never holds more than one WM_MOUSEMOVE per window (mouse motion
   * replaces the pending one) and coalesces WM_PAINT as well. Without this,
   * a sweep of the mouse queues dozens of WM_MOUSEMOVEs ahead of a click —
   * and since every dispatch is a nested JIT WndProc run, the click and its
   * repaint starve for seconds (winmine felt unclickable).
   */
  private queueGuiMessage(
    msg: { hwnd: number; msg: number; wParam: number; lParam: number },
    atFront = false,
  ): void {
    if (msg.msg === 0x0200 /* WM_MOUSEMOVE */) {
      const idx = this.guiMessageQueue.findIndex((q) => q.hwnd === msg.hwnd && q.msg === 0x0200);
      if (idx >= 0) {
        this.guiMessageQueue[idx] = msg;
        return;
      }
    } else if (msg.msg === 0x000f /* WM_PAINT */) {
      if (this.guiMessageQueue.some((q) => q.hwnd === msg.hwnd && q.msg === 0x000f)) return;
    }
    if (atFront) this.guiMessageQueue.unshift(msg);
    else this.guiMessageQueue.push(msg);
  }

  postMessage(msg: { hwnd: number; msg: number; wParam: number; lParam: number }): void {
    this.queueGuiMessage(msg);
    if (this.pendingMessageResolve) {
      const r = this.pendingMessageResolve;
      this.pendingMessageResolve = null;
      r();
    }
  }

  /** Replaces an EDIT control's text from the host side (input bridge). */
  postText(hwnd: number, text: string): void {
    const rec = this.windowRecords.get(hwnd);
    if (!rec) return;
    rec.text = text;
    this.deps.onTextChanged()?.(hwnd, text);
  }

  /** Live window tree — the interactive host reads it while the process runs. */
  getWindows(): GuestWindowRecord[] {
    return [...this.windowRecords.entries()].map(([hwnd, r]) => ({
      hwnd,
      className: r.className,
      wndProc: r.wndProc,
      parent: r.parent,
      text: r.text,
      menu: r.menu,
      exStyle: r.exStyle,
      style: r.style,
      width: r.width,
      height: r.height,
    }));
  }
}
