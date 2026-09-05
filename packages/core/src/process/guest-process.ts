/**
 * Guest process runner (design doc 4.2.x).
 *
 * Orchestrates a single Windows PE run inside the shared WASM linear memory:
 *   reset CPU -> load PE -> map sections + rewrite the IAT -> seed the initial
 *   stack -> execute blocks via the Executor -> translate `int 0x2E` traps
 *   through the API interceptor -> detect ExitProcess and report the exit code.
 *
 * Console streams (WriteFile on the STD_* pseudo handles) are captured into
 * `result.output` / `result.stderrOutput` and forwarded to `options.onOutput`,
 * so a console exe's stdout can be printed by a CLI wrapper or rendered by the
 * L6 desktop.
 */

import type { ApiInterceptor, GdiBridge, JitEngine, PeLoader } from '@specter-core/contracts';
import { ApiTrapDispatcher } from '../jit/trap-dispatcher';
import { Executor, type TrapHandler } from '../jit/executor';
import { mapPeImage, type ApiStub } from '../pe/mapper';
import { archForPe, type ArchBackend } from '../arch';
import type { WasmRuntimeImpl } from '../jit/runtime';
import { SEH_SENTINEL_VECTOR, SehController } from './seh';
import { ConsoleIo } from './console-io';
import { GuiBridge } from './gui-bridge';
import { installFileDialogs } from './file-dialogs';
import { installStartupHandlers } from './startup-handlers';
import type { RunState } from './guest-common';

/** Initial stack region (kept clear of the 0x00400000 image base). */
export const DEFAULT_STACK_TOP = 0x08000000;

/**
 * File offset where the overlay begins: one past the last section's raw data.
 * Installers (Inno Setup) append their payload archive after the sections and
 * expose it as an RT_RCDATA resource.
 */
export function computeOverlayStart(raw: Uint8Array): number {
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  if (view.getUint16(0, true) !== 0x5a4d) return 0;
  const eLfanew = view.getUint32(0x3c, true);
  const coff = eLfanew + 4;
  const numSections = view.getUint16(coff + 2, true);
  const sizeOfOpt = view.getUint16(coff + 16, true);
  const sectionTable = coff + 20 + sizeOfOpt;
  let end = 0;
  for (let i = 0; i < numSections; i++) {
    const s = sectionTable + i * 40;
    const rawSize = view.getUint32(s + 16, true);
    const rawOffset = view.getUint32(s + 20, true);
    end = Math.max(end, rawOffset + rawSize);
  }
  return end;
}

/** A GDI draw operation captured by the GUI bridge (Layer 2), ready for a
 * host renderer (L6 desktop) to consume. */
export interface PaintCommand {
  op: 'text' | 'fillrect' | 'rect' | 'line' | 'bitblt' | 'patblt';
  hdc: number;
  x: number;
  y: number;
  w?: number;
  h?: number;
  text?: string;
  color?: number;
}

/** One flat menu section parsed from an RT_MENU resource (Layer 3). */
export interface GuestMenuItem {
  id: number;
  label: string;
}

export interface GuestMenuSection {
  title: string;
  items: GuestMenuItem[];
}

/** Summary of a guest window as seen by the GUI bridge. */
export interface GuestWindowRecord {
  hwnd: number;
  className: string;
  wndProc: number;
  parent: number;
  text: string;
  /** Menu bar sections parsed from the window's RT_MENU (empty when none). */
  menu: GuestMenuSection[];
  /** Window styles from CreateWindowExW — used to emulate non-client chrome
   * (e.g. WS_EX_CLIENTEDGE sunken border, WS_BORDER) the guest never paints. */
  exStyle: number;
  style: number;
  /** Client size last reported by MoveWindow (0 when never resized). */
  width: number;
  height: number;
}

export interface GuestProcessResult {
  status: 'exit' | 'fault' | 'trap' | 'limit';
  /** ExitProcess exit code (or 0 when the process ended by another path). */
  exitCode: number;
  /**
   * True only when the guest called ExitProcess. When false, `status === 'exit'`
   * means the entry point returned without terminating (typically startup
   * aborted and fell through to the null return address) — callers should NOT
   * present that as a clean `exited with code 0`.
   */
  cleanExit: boolean;
  eip: number;
  error?: unknown;
  stubs: readonly ApiStub[];
  /** Bytes written to the console stdout stream. */
  output: Uint8Array;
  /** Bytes written to the console stderr stream. */
  stderrOutput: Uint8Array;
  /** Windows created by the guest (GUI bridge Layer 1/2). */
  windows: GuestWindowRecord[];
  /** GDI draw operations captured during the run (Layer 2). */
  paintCommands: PaintCommand[];
  /** True when MUI satellite resources were merged (real strings/menus). */
  muiLoaded: boolean;
  /** Path of the .mui file merged (diagnostics; '' when none). */
  muiSource: string;
}

export interface GuestProcessOptions {
  /** PID reported to API handlers (default 0). */
  pid?: number;
  maxSteps?: number;
  stackTop?: number;
  /**
   * Absolute path of the module being run. When set, GetModuleFileNameW/A
   * return it, so installers can reopen their own file to read the archive.
   */
  modulePath?: string;
  /**
   * Optional file reader used to load MUI satellite resources. Windows 10+
   * apps (e.g. notepad) keep their strings/menus/dialogs in a sibling
   * `<lang>/<module>.mui` file rather than the exe itself; without them
   * LoadStringW returns 0 and startup aborts. When provided, the runner
   * searches common MUI locations next to modulePath and merges the
   * RT_STRING/RT_MENU/RT_ACCELERATOR entries into the resource table.
   * Return null when the path does not exist (not an error).
   */
  readFile?: (path: string) => Promise<Uint8Array | null>;
  onOutput?: (bytes: Uint8Array, stderr: boolean) => void;
  /** Forwarded to the executor: per-block trace (diagnostics). */
  onStep?: (eip: number, runtime: WasmRuntimeImpl) => void;
  /**
   * Invoked with the runtime + result when the guest faults (memory OOB,
   * unsupported opcode, ...). Lets CLIs and the L6 desktop show register state
   * / decoded instructions at the fault site instead of only the block start.
   */
  onFault?: (runtime: WasmRuntimeImpl, result: GuestProcessResult) => void;
  /**
   * Builds the JIT engine for a given mode. Required to run PE32+ images; the
   * default falls back to the engine passed to the constructor (which must
   * then already be in the correct mode).
   */
  createEngine?: (mode: 'x86' | 'x64') => JitEngine;
  /**
   * Interactive mode: GetMessageW blocks (awaits) when the synthetic queue is
   * empty instead of returning 0 (WM_QUIT). The host keeps the process alive
   * and drives it with `postMessage`/`postText` (e.g. keyboard input to a
   * guest EDIT control). Without this the loop drains its queued messages
   * (WM_CREATE/WM_PAINT) and exits — the CLI baseline.
   */
  interactive?: boolean;
  /** Called when GetMessageW is about to block waiting for host messages. */
  onMessageWait?: () => void;
  /** Called when a guest EDIT control's text changes (host syncs the UI). */
  onTextChanged?: (hwnd: number, text: string) => void;
  /**
   * Called when a window's menu/title/style changes *after* creation — most
   * importantly when the guest calls SetMenu (winmine attaches its Game/Help
   * bar this way, after CreateWindowExW already returned). Lets the host
   * refresh the rendered menu bar without re-creating the desktop window.
   */
  onWindowMetaChanged?: (hwnd: number) => void;
  /**
   * Command line reported by GetCommandLineW/A (e.g. 'cmd.exe /c dir').
   * Empty by default; cmd.exe needs it to decide interactive vs /c mode.
   */
  commandLine?: string;
  /**
   * Initial working directory reported by GetCurrentDirectoryW/A (and used
   * as the base for relative paths). Defaults to 'C:\\'. Setting it lets the
   * desktop open cmd.exe already inside a folder without relying on cmd's
   * `cd` builtin.
   */
  cwd?: string;
  /**
   * Optional per-window GDI bridge provider. When it returns a bridge for a
   * guest hwnd, the guest's GDI calls (GetDC/BeginPaint/TextOutW/FillRect/
   * LineTo/... /EndPaint) are forwarded to that bridge and rendered to its
   * canvas — the L6 "image bridge" path (设计文档 3.2). When it returns null
   * (or is not set), the classic PaintCommand capture is used instead, so
   * headless/CLI runs keep working unchanged. The bridge instance for a DC is
   * looked up by DC handle, so a bridge may own multiple DCs.
   */
  gdiBridge?: (hwnd: number) => GdiBridge | null;
  /**
   * Raw memory patches applied to the mapped guest image immediately after it
   * is loaded and before execution begins. Each patch writes `bytes` at the
   * given absolute VA. Intended for well-understood workarounds such as
   * neutralizing cmd.exe's `__security_check_cookie` so a benign stack-cookie
   * slot overflow (a JIT string-instruction boundary quirk) no longer triggers
   * a fast-fail. Keep this list tiny and documented.
   */
  patches?: Array<{ va: number; bytes: number[] }>;
  /**
   * Runtime per-block probes, fired from onStep when the executor reaches a
   * block starting at `eip`. The callback runs with live registers and memory
   * and may patch guest state — used to work around JIT formatting bugs that
   * a static `patches` entry cannot express (they need register values, e.g.
   * cmd.exe's space-padding formatter at 0x42e327 / 64-bit formatter at
   * 0x4317b4, see scripts/diag-trap.ts). Probes only run when provided.
   */
  probes?: Array<{ eip: number; fn: (rt: WasmRuntimeImpl) => void }>;
  /**
   * Host-driven common file dialog (comdlg32 GetOpenFileNameW/A and
   * GetSaveFileNameW/A). When the guest opens an Open/Save dialog, the runner
   * calls this instead of showing a dialog itself — the L6 shell renders a
   * virtual-disk browser and returns the chosen path (Windows format, e.g.
   * 'C:\\Users\\Guest\\Desktop\\notes.txt') or null when cancelled. When not
   * provided the dialogs return 0 (FALSE, cancelled) like a no-op host.
   */
  fileDialog?: (kind: 'open' | 'save', opts: FileDialogOptions) => Promise<string | null>;
  /**
   * Virtual screen size reported by GetSystemMetrics (SM_CXSCREEN/SM_CYSCREEN
   * and the SM_CXVIRTUALSCREEN/SM_CYVIRTUALSCREEN pair). GUI guests center
   * their main window on this; a 0 default (no handler) makes them compute
   * negative coordinates and place the window off-screen. Defaults to
   * 1024x768 when not provided.
   */
  screenSize?: { width: number; height: number };
}

/** What comdlg32 told us about the dialog the guest is opening. */
export interface FileDialogOptions {
  /** Dialog title from OPENFILENAME.lpstrTitle ('' when NULL). */
  title: string;
  /** Initial directory from lpstrInitialDir ('' when NULL). */
  initialDir: string;
  /** Default file name from lpstrFile ('' when empty/Untitled). */
  defaultName: string;
  /** File-type filter string (the raw double-NUL-terminated lpstrFilter). */
  filter: string;
}
export class GuestProcessRunner {
  /** SEH dispatch state (scratch addresses allocated by the startup handlers). */
  private readonly seh = new SehController();
  /** Console I/O subsystem (installed once in the constructor). */
  private readonly consoleIo: ConsoleIo;
  /** GUI bridge subsystem (window/menu/message/GDI handlers). */
  private readonly gui: GuiBridge;
  /** Per-run mutable state shared with the subsystem modules. */
  private state: RunState = {
    exitRequested: false,
    exitCode: 0,
    cwd: 'C:\\',
    modulePath: '',
    commandLine: '',
    muiLoaded: false,
    muiSource: '',
    wideEnvBlock: 0,
    narrowEnvBlock: 0,
    guestHeapAlloc: null,
  };
  /** Optional per-hwnd GDI bridge provider (see GuestProcessOptions.gdiBridge). */
  private gdiBridgeProvider?: (hwnd: number) => GdiBridge | null;
  /** Interactive mode flag (see GuestProcessOptions.interactive). */
  private interactive = false;
  /** Host callback for EDIT text changes (see GuestProcessOptions.onTextChanged). */
  private onTextChanged?: (hwnd: number, text: string) => void;
  /** Host callback when a window's menu/title/style changes post-creation. */
  private onWindowMetaChanged?: (hwnd: number) => void;
  /** Host callback when GetMessageW blocks (see GuestProcessOptions.onMessageWait). */
  private onMessageWait?: () => void;
  /** Host-driven file dialog (see GuestProcessOptions.fileDialog). */
  private fileDialog?: (kind: 'open' | 'save', opts: FileDialogOptions) => Promise<string | null>;
  /** Virtual screen size reported by GetSystemMetrics (see GuestProcessOptions.screenSize). */
  private screenSize = { width: 1024, height: 768 };
  /** Architecture backend (owns all mode-specific policy) for the current run. */
  private arch!: ArchBackend;
  /** Mode-correct JIT engine (per-run, from run()'s createEngine path). */
  private activeJit!: JitEngine;
  /** Run options captured for nested-executor onStep/probes. */
  private activeOptions: GuestProcessOptions = {};

  constructor(
    private readonly runtime: WasmRuntimeImpl,
    private readonly jit: JitEngine,
    private readonly loader: PeLoader,
    private readonly interceptor: ApiInterceptor,
  ) {
    this.consoleIo = new ConsoleIo({
      interceptor: this.interceptor,
      interactive: () => this.interactive,
    });
    this.consoleIo.install();
    this.gui = new GuiBridge({
      runtime: this.runtime,
      interceptor: this.interceptor,
      arch: () => this.arch,
      activeJit: () => this.activeJit,
      activeOptions: () => this.activeOptions,
      sehSentinelAddr: () => this.seh.sentinelAddr,
      guestHeapAlloc: () => this.state.guestHeapAlloc,
      gdiBridgeProvider: () => this.gdiBridgeProvider,
      screenSize: () => this.screenSize,
      interactive: () => this.interactive,
      onMessageWait: () => this.onMessageWait,
      onTextChanged: () => this.onTextChanged,
    });
  }

  async run(image: Uint8Array, options: GuestProcessOptions = {}): Promise<GuestProcessResult> {
    this.state = {
      exitRequested: false,
      exitCode: 0,
      cwd: options.cwd ?? 'C:\\',
      modulePath: options.modulePath ?? '',
      commandLine: options.commandLine ?? '',
      readFile: options.readFile,
      muiLoaded: false,
      muiSource: '',
      wideEnvBlock: 0,
      narrowEnvBlock: 0,
      guestHeapAlloc: null,
    };
    this.consoleIo.reset();
    this.consoleIo.onOutput = options.onOutput;
    this.seh.reset();
    // GUI bridge state is per-run.
    this.gui.reset();
    this.gdiBridgeProvider = options.gdiBridge;
    this.interactive = options.interactive ?? false;
    this.onTextChanged = options.onTextChanged;
    this.onMessageWait = options.onMessageWait;
    this.onWindowMetaChanged = options.onWindowMetaChanged;
    this.fileDialog = options.fileDialog;
    this.screenSize = options.screenSize ?? { width: 1024, height: 768 };

    this.runtime.resetCpu();

    const pe = await this.loader.load(image);
    this.arch = archForPe(pe);
    const mapped = mapPeImage(this.runtime, image, pe, this.arch);
    // Apply raw memory patches (e.g. neutralize cmd.exe's GS cookie check)
    // right after the image is mapped and before any execution, so the JIT
    // compiles the patched bytes on first call.
    for (const p of options.patches ?? []) {
      this.runtime.writeBytes(p.va, new Uint8Array(p.bytes));
    }
    // Mutable stub table: GetProcAddress may append dynamic stubs at runtime.
    const stubs = [...mapped.stubs];
    let dynStubCursor = mapped.stubEnd;

    await installStartupHandlers(
      {
        runtime: this.runtime,
        interceptor: this.interceptor,
        arch: this.arch,
        state: this.state,
        seh: this.seh,
        gui: this.gui,
        onWindowMetaChanged: () => this.onWindowMetaChanged,
      },
      pe,
      mapped,
      stubs,
      () => dynStubCursor,
      (next) => {
        dynStubCursor = next;
      },
      image,
    );
    installFileDialogs({
      runtime: this.runtime,
      interceptor: this.interceptor,
      arch: this.arch,
      fileDialog: this.fileDialog,
    });

    const jit = options.createEngine ? options.createEngine(this.arch.mode) : this.jit;
    this.activeJit = jit;
    this.activeOptions = options;

    // Initial stack: grows down from stackTop; the null return address makes a
    // bare `ret` out of the entry point look like a clean exit (eip -> 0). The
    // x86/x64 framing (sentinel + stack pointer) is delegated to the backend.
    const stackTop = options.stackTop ?? DEFAULT_STACK_TOP;
    // Headroom above the stack top so the entry function's shadow-space and
    // prologue writes ([rsp+N]) don't exceed the allocated linear memory.
    // Real CRT startup also probes the stack guard region ABOVE the top (e.g.
    // `xor edx,edx; lock or [eax],edx` with eax = stackTop+0x20000). Keeping
    // the top of memory well past that point (instead of exactly at it) turns
    // such probes into no-op writes inside zeroed memory instead of a WASM
    // "memory access out of bounds" trap.
    const stackHeadroom = 0x80000; // 512 KiB of slack above the stack top
    this.runtime.ensure(stackTop + stackHeadroom);
    this.arch.setupStack(this.runtime, stackTop);

    // 16 arg slots: CreateWindowExW has 12 params and handlers (GUI bridge)
    // read hWndParent at rawArgs[8] — the default 8 slots were not enough.
    const dispatcher = new ApiTrapDispatcher(this.interceptor, this.runtime, stubs, 16, this.arch);

    this.seh.install(
      { runtime: this.runtime, interceptor: this.interceptor, arch: this.arch, state: this.state },
      dispatcher,
      jit,
    );
    this.gui.install(dispatcher, jit);

    const trapHandler: TrapHandler = {
      handle: async (vector, rt) => {
        if (vector === SEH_SENTINEL_VECTOR) {
          this.seh.handleSentinel(rt);
          return;
        }
        await dispatcher.handle(vector);
        const last = dispatcher.lastCalled;
        if (last && last.proc.toLowerCase() === 'exitprocess') {
          this.state.exitCode = rt.getReg('eax') & 0xffffffff;
          this.state.exitRequested = true;
          rt.setEip(0);
        }
      },
    };

    const executor = new Executor(this.runtime, jit, trapHandler, {
      maxSteps: options.maxSteps,
      onStep: options.probes?.length
        ? (eip: number, rt: WasmRuntimeImpl) => {
            for (const p of options.probes ?? []) if (p.eip === eip) p.fn(rt);
            options.onStep?.(eip, rt);
          }
        : options.onStep,
    });
    const result = await executor.run(mapped.entryPoint);

    // The guest is done — stop WM_TIMER intervals before the host inspects
    // the result (faults/limits exit without PostQuitMessage).
    this.gui.clearTimers();

    const guestResult: GuestProcessResult = {
      status: this.state.exitRequested ? 'exit' : result.status,
      exitCode: this.state.exitRequested ? this.state.exitCode : 0,
      cleanExit: this.state.exitRequested,
      eip: result.eip,
      error: result.error,
      stubs: mapped.stubs,
      output: this.consoleIo.output,
      stderrOutput: this.consoleIo.stderrOutput,
      windows: this.gui.getWindows(),
      paintCommands: [...this.gui.paintCommands],
      muiLoaded: this.state.muiLoaded,
      muiSource: this.state.muiSource,
    };
    if (guestResult.status === 'fault') options.onFault?.(this.runtime, guestResult);
    return guestResult;
  }

  /** Interactive API (see GuestProcessOptions.interactive): pushes a message
   * into the guest's queue and wakes a GetMessageW that is blocked waiting. */
  postMessage(msg: { hwnd: number; msg: number; wParam: number; lParam: number }): void {
    this.gui.postMessage(msg);
  }

  /** Replaces an EDIT control's text from the host side (input bridge). */
  postText(hwnd: number, text: string): void {
    this.gui.postText(hwnd, text);
  }

  /** Live window tree — the interactive host reads it while the process runs. */
  getWindows(): GuestWindowRecord[] {
    return this.gui.getWindows();
  }

  /** Host → guest console input. Appends `text` (caller supplies the line
   * terminator, e.g. "dir\r\n") and wakes any ReadConsoleW/A blocked in
   * interactive mode. */
  postInput(text: string): void {
    this.consoleIo.postInput(text);
  }
}
