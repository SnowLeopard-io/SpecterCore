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

import type {
  ApiCallContext,
  ApiHandler,
  ApiInterceptor,
  ApiResult,
  JitEngine,
  PeImage,
  PeLoader,
} from '@bk/contracts';
import { WinError as E } from '@bk/contracts';
import { STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE } from '../api/handlers';
import { ApiTrapDispatcher } from '../jit/trap-dispatcher';
import { Executor, type TrapHandler } from '../jit/executor';
import { mapPeImage, X86_API_ARG_COUNT, type ApiStub, type MappedImage } from '../pe/mapper';
import type { WasmRuntimeImpl } from '../jit/runtime';
import type { RegName } from '../jit/ir';

// SEH exception dispositions returned by guest handlers (winnt.h).
const EXCEPTION_CONTINUE_EXECUTION = 0;
const EXCEPTION_EXECUTE_HANDLER = 2;
// Exception flags: EXCEPTION_NONCONTINUABLE / EXCEPTION_UNWINDING (cUnwinding).
const EXCEPTION_UNWINDING = 2;
const EXCEPTION_UNWINDING_FOR_EXIT = 4;
/** Sentinel vector: a trap with this vector means "guest handler returned". */
const SEH_SENTINEL_VECTOR = 0x2d;
/**
 * Internal callHandler result: the guest handler accepted the exception by
 * calling RtlUnwind, which transferred control to the unwind target — the
 * transfer has already been applied to the runtime; do not restore registers.
 */
const EXCEPTION_TRANSFERRED = -2;
/** x86 CONTEXT record size (CONTEXT_FULL, 0x2CC bytes). */
const X86_CONTEXT_SIZE = 0x2cc;

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
  onStep?: (eip: number) => void;
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
}

export class GuestProcessRunner {
  private readonly stdout: number[] = [];
  private readonly stderr: number[] = [];
  private exitCode = 0;
  private exitRequested = false;
  private onOutput?: (bytes: Uint8Array, stderr: boolean) => void;
  private modulePath = '';
  /** MUI satellite-resource reader (see GuestProcessOptions.readFile). */
  private readFile?: (path: string) => Promise<Uint8Array | null>;
  /** SEH scratch guest addresses (allocated per run, see installStartupHandlers). */
  private sehSentinelAddr = 0;
  private sehExcAddr = 0;
  private sehCtxAddr = 0;
  /** Accepting record of the phase-2 transfer (sentinel fallback target). */
  private sehPending = 0;
  /** Nested RaiseException dispatch recursion guard. */
  private sehDepth = 0;
  /** Set by the RtlUnwind handler when it transfers control (unwind target). */
  private sehTransfer: { eip: number; esp: number } | null = null;
  /**
   * GUI bridge state (see installGuiBridge): class atom -> window procedure
   * address, fake HWND -> { window procedure, parent } record, and the
   * synthetic message queue that drives the guest's GetMessageW loop.
   */
  private classWndProcs = new Map<number, number>();
  private windowRecords = new Map<
    number,
    { wndProc: number; parent: number; className: string; text: string; menu: GuestMenuSection[] }
  >();
  /** LoadMenuW handle -> parsed RT_MENU sections (Layer 3 menu bar). */
  private menuByHandle = new Map<number, GuestMenuSection[]>();
  /** Class atom -> menu parsed from WNDCLASSEXW.lpszMenuName (RT_MENU). */
  private classMenus = new Map<number, GuestMenuSection[]>();
  /** RT_MENU (type 4) resources by numeric id, from the exe/MUI table. */
  private menuResourceTable = new Map<number, { size: number; address: number }>();
  private guiMessageQueue: Array<{ hwnd: number; msg: number; wParam: number; lParam: number }> = [];
  /** GDI draw operations captured by the Layer 2 bridge. */
  private paintCommands: PaintCommand[] = [];
  /** Pseudo object handles minted by GDI handlers (DC / font / brush / pen). */
  private gdiObjSeq = 0x3000;
  /** Interactive mode flag (see GuestProcessOptions.interactive). */
  private interactive = false;
  /** Set by PostQuitMessage; GetMessageW returns 0 (WM_QUIT) once set. */
  private quitRequested = false;
  /** Resolver for the GetMessageW block in interactive mode. */
  private pendingMessageResolve: (() => void) | null = null;
  /** Host callback for EDIT text changes (see GuestProcessOptions.onTextChanged). */
  private onTextChanged?: (hwnd: number, text: string) => void;
  /** Host callback when GetMessageW blocks (see GuestProcessOptions.onMessageWait). */
  private onMessageWait?: () => void;
  /** True when MUI satellite resources were merged (real strings/menus). */
  private muiLoaded = false;
  /** Path of the .mui file that was merged (diagnostics). */
  private muiSource = '';

  constructor(
    private readonly runtime: WasmRuntimeImpl,
    private readonly jit: JitEngine,
    private readonly loader: PeLoader,
    private readonly interceptor: ApiInterceptor,
  ) {
    this.installConsoleWriteFile();
  }

  async run(image: Uint8Array, options: GuestProcessOptions = {}): Promise<GuestProcessResult> {
    this.stdout.length = 0;
    this.stderr.length = 0;
    this.exitCode = 0;
    this.exitRequested = false;
    this.onOutput = options.onOutput;
    this.modulePath = options.modulePath ?? '';
    this.readFile = options.readFile;
    this.sehPending = 0;
    this.sehDepth = 0;
    this.sehTransfer = null;
    // GUI bridge state is per-run.
    this.classWndProcs.clear();
    this.windowRecords.clear();
    this.guiMessageQueue.length = 0;
    this.paintCommands = [];
    this.gdiObjSeq = 0x3000;
    this.interactive = options.interactive ?? false;
    this.quitRequested = false;
    this.pendingMessageResolve = null;
    this.onTextChanged = options.onTextChanged;
    this.onMessageWait = options.onMessageWait;
    this.muiLoaded = false;
    this.muiSource = '';

    this.runtime.resetCpu();

    const pe = await this.loader.load(image);
    const mapped = mapPeImage(this.runtime, image, pe);
    // Mutable stub table: GetProcAddress may append dynamic stubs at runtime.
    const stubs = [...mapped.stubs];
    let dynStubCursor = mapped.stubEnd;
    await this.installStartupHandlers(pe, mapped, stubs, () => dynStubCursor, (next) => { dynStubCursor = next; }, image);
    const mode: 'x86' | 'x64' = pe.is64 ? 'x64' : 'x86';
    const jit = options.createEngine ? options.createEngine(mode) : this.jit;

    // Initial stack: grows down from stackTop; the null return address makes a
    // bare `ret` out of the entry point look like a clean exit (eip -> 0).
    // On x86-64 the stack is 8-byte aligned and slots are 8 bytes wide.
    const stackTop = options.stackTop ?? DEFAULT_STACK_TOP;
    const width = mode === 'x64' ? 8 : 4;
    // Headroom above the stack top so the entry function's shadow-space and
    // prologue writes ([rsp+N]) don't exceed the allocated linear memory.
    // Real CRT startup also probes the stack guard region ABOVE the top (e.g.
    // `xor edx,edx; lock or [eax],edx` with eax = stackTop+0x20000). Keeping
    // the top of memory well past that point (instead of exactly at it) turns
    // such probes into no-op writes inside zeroed memory instead of a WASM
    // "memory access out of bounds" trap.
    const stackHeadroom = 0x80000; // 512 KiB of slack above the stack top
    this.runtime.ensure(stackTop + stackHeadroom);
    this.runtime.writeInt32(stackTop - 4, 0);
    if (mode === 'x64') this.runtime.writeInt32(stackTop - 8, 0);
    this.runtime.setReg(mode === 'x64' ? 'rsp' : 'esp', stackTop - width);

    // 16 arg slots: CreateWindowExW has 12 params and handlers (GUI bridge)
    // read hWndParent at rawArgs[8] — the default 8 slots were not enough.
    const dispatcher = new ApiTrapDispatcher(this.interceptor, this.runtime, stubs, 16, mode);
    this.installSehDispatch(dispatcher, jit, mode);
    this.installGuiBridge(dispatcher, jit, mode);
    const trapHandler: TrapHandler = {
      handle: async (vector, rt) => {
        if (vector === SEH_SENTINEL_VECTOR) {
          this.handleSehSentinel(rt);
          return;
        }
        await dispatcher.handle(vector);
        const last = dispatcher.lastCalled;
        if (last && last.proc.toLowerCase() === 'exitprocess') {
          this.exitCode = rt.getReg('eax') & 0xffffffff;
          this.exitRequested = true;
          rt.setEip(0);
        }
      },
    };

    const executor = new Executor(this.runtime, jit, trapHandler, {
      maxSteps: options.maxSteps,
      onStep: options.onStep,
    });
    const result = await executor.run(mapped.entryPoint);

    const guestResult: GuestProcessResult = {
      status: this.exitRequested ? 'exit' : result.status,
      exitCode: this.exitRequested ? this.exitCode : 0,
      cleanExit: this.exitRequested,
      eip: result.eip,
      error: result.error,
      stubs: mapped.stubs,
      output: new Uint8Array(this.stdout),
      stderrOutput: new Uint8Array(this.stderr),
      windows: [...this.windowRecords.entries()].map(([hwnd, r]) => ({
        hwnd,
        className: r.className,
        wndProc: r.wndProc,
        parent: r.parent,
        text: r.text,
        menu: r.menu,
      })),
      paintCommands: [...this.paintCommands],
      muiLoaded: this.muiLoaded,
      muiSource: this.muiSource,
    };
    if (guestResult.status === 'fault') options.onFault?.(this.runtime, guestResult);
    return guestResult;
  }

  /**
   * Startup-critical kernel32 functions every real exe needs before it can do
   * anything useful. Installed per-run because they need the loaded image:
   *  - GetModuleHandleW/A(NULL) -> the exe's image base (CRT fetches its own
   *    module handle first thing; returning 0 aborts startup silently);
   *  - GetProcAddress -> resolves the exe's own export table;
   *  - LoadLibraryW/A -> pseudo-loads the exe itself so GetProcAddress works
   *    against the returned handle (no real system DLLs exist yet).
   */
  private async installStartupHandlers(
    pe: PeImage,
    mapped: MappedImage,
    stubs: ApiStub[],
    dynCursor: () => number,
    setDynCursor: (next: number) => void,
    image: Uint8Array,
  ): Promise<void> {
    const base = mapped.baseAddress;
    const exports = new Map<string, number>();
    const byOrdinal = new Map<number, number>();
    for (const e of pe.exports) {
      exports.set(e.name.toLowerCase(), e.address);
      byOrdinal.set(e.ordinal, e.address);
    }
    const readCStr = (address: number): string => {
      if (!address) return '';
      const bytes = this.runtime.readBytes(address, 4096);
      let end = 0;
      while (end < bytes.byteLength && bytes[end] !== 0) end += 1;
      return new TextDecoder('latin1').decode(bytes.subarray(0, end));
    };
    const readWStr = (address: number): string => {
      if (!address) return '';
      const bytes = this.runtime.readBytes(address, 8192);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      let s = '';
      for (let i = 0; i + 1 < bytes.byteLength; i += 2) {
        const c = view.getUint16(i, true);
        if (c === 0) break;
        s += String.fromCharCode(c);
      }
      return s;
    };

    // ------------------------------------------------------------------
    // PE resource table (RT_RCDATA). Inno's SetupLdr locates its payload
    // archive via FindResourceW(0, 0x2B67, RT_RCDATA) + SizeofResource +
    // LoadResource/LockResource: the (tiny) resource is a descriptor holding
    // the archive's file offset, which the installer then reads via its own
    // CreateFileW handle. SizeofResource must therefore return the RESOURCE
    // entry size (44 bytes here), not the overlay length — returning the
    // overlay size made Inno's integrity check fail with "The setup files are
    // corrupted". Parse the real .rsrc directory and serve entries from it.
    // ------------------------------------------------------------------
    const resourceTable = new Map<number, { size: number; address: number }>();
    // Named resources from the merged .mui (key `type:name` lowercase) — e.g.
    // notepad's accelerators live under the string name "GlobalAcc".
    const namedResources = new Map<string, { size: number; address: number }>();
    {
      const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
      const u16 = (o: number): number => (o + 2 <= image.byteLength ? view.getUint16(o, true) : 0);
      const u32 = (o: number): number => (o + 4 <= image.byteLength ? view.getUint32(o, true) : 0);
      const eLfanew = u32(0x3c);
      const coff = eLfanew + 4;
      const numSections = u16(coff + 2);
      const optSize = u16(coff + 16);
      const optMagic = u16(eLfanew + 24);
      const dataDir = eLfanew + 24 + (optMagic === 0x20b ? 112 : 96);
      const resRva = u32(dataDir + 16);
      const secTable = coff + 20 + optSize;
      let resRaw = 0;
      for (let i = 0; i < numSections; i++) {
        const s = secTable + i * 40;
        if (u32(s + 12) === resRva) {
          resRaw = u32(s + 20);
          break;
        }
      }
      if (resRaw) {
        const r2o = (rva: number): number => resRaw + (rva - resRva);
        const inBounds = (o: number, n: number): boolean => o >= 0 && o + n <= image.byteLength;
        const walk = (rva: number, depth: number, typeId: number, nameId: number): void => {
          const off = r2o(rva);
          if (!inBounds(off, 16)) return;
          const named = u16(off + 12);
          const ids = u16(off + 14);
          for (let k = 0; k < named + ids; k++) {
            const e = off + 16 + k * 8;
            if (!inBounds(e, 8)) break;
            const name = u32(e);
            const data = u32(e + 4);
            if (depth === 0) {
              // type level: name = typeId, data -> name-level directory
              walk(resRva + (data & 0x7fffffff), 1, name & 0xffff, 0);
            } else if (depth === 1) {
              // name level: name = nameId, data -> language-level directory
              walk(resRva + (data & 0x7fffffff), 2, typeId, name & 0xffff);
            } else {
              // language level: data -> data entry { DataRVA, Size }
              const de = r2o(resRva + data);
              if (inBounds(de, 8)) {
                const key = ((typeId & 0xffff) << 16) | (nameId & 0xffff);
                if (!resourceTable.has(key)) {
                  resourceTable.set(key, { size: u32(de + 4), address: base + u32(de) });
                }
              }
            }
          }
        };
        walk(resRva, 0, 0, 0);
      }
    }
    let lastResourceKey = 0;
    this.interceptor.hook('kernel32.dll', 'FindResourceW', (ctx) => {
      const name = ctx.rawArgs[1] ?? 0;
      const type = ctx.rawArgs[2] ?? 0;
      // Inno uses numeric IDs; string names would need the guest string.
      if (type > 0xffff || (name & 0x80000000) !== 0) return { returnValue: 0, errorCode: E.ERROR_FILE_NOT_FOUND };
      const key = ((type & 0xffff) << 16) | (name & 0xffff);
      if (!resourceTable.has(key)) return { returnValue: 0, errorCode: E.ERROR_FILE_NOT_FOUND };
      lastResourceKey = key;
      return { returnValue: key, errorCode: E.NO_ERROR };
    });
    this.interceptor.hook('kernel32.dll', 'SizeofResource', (ctx) => {
      const key = (ctx.rawArgs[1] ?? 0) >>> 0;
      const entry = resourceTable.get(key);
      return entry ? { returnValue: entry.size, errorCode: E.NO_ERROR } : { returnValue: 0, errorCode: E.ERROR_FILE_NOT_FOUND };
    });
    this.interceptor.hook('kernel32.dll', 'LoadResource', () => ({ returnValue: 2, errorCode: E.NO_ERROR }));
    this.interceptor.hook('kernel32.dll', 'LockResource', () => {
      const entry = resourceTable.get(lastResourceKey);
      return entry ? { returnValue: entry.address, errorCode: E.NO_ERROR } : { returnValue: 0, errorCode: E.NO_ERROR };
    });

    // LoadStringW: reads a string from the RT_STRING resource (type 6).
    // String resources are blocks of 16 strings, each prefixed with a 1-byte
    // length followed by UTF-16 code units; id = block*16 + index. notepad
    // loads its whole UI (menus, dialogs) through this — returning 0 makes it
    // fail-fast.
    const readWChar = (addr: number): number => {
      const b = this.runtime.readBytes(addr, 2);
      return b.byteLength >= 2 ? new DataView(b.buffer, b.byteOffset, 2).getUint16(0, true) : 0;
    };
    this.interceptor.hook('user32.dll', 'LoadStringW', (ctx) => {
      const id = (ctx.rawArgs[1] ?? 0) >>> 0;
      const buf = (ctx.rawArgs[2] ?? 0) >>> 0;
      const cch = (ctx.rawArgs[3] ?? 0) >>> 0;
      if (!buf || !cch) return { returnValue: 0, errorCode: E.NO_ERROR };
      // RT_STRING: block id = (stringId >> 4) + 1 (string ids are 1-based,
      // block 1 holds ids 1..15 at slots 1..15, slot 0 of block 1 is the
      // unused id 0), in-block slot = stringId & 0xF. The previous code used
      // floor(id/16) and id%16, which looked up the wrong block (id 1 -> block
      // 0) and the wrong slot (id 16 -> slot 0 of block 1, which is empty).
      const block = resourceTable.get((6 << 16) | ((id >> 4) + 1));
      if (block) {
        let off = block.address;
        const slot = id & 0xf;
        for (let i = 0; i < 16; i++) {
          const b = this.runtime.readBytes(off, 1);
          const len = b.byteLength >= 1 ? b[0]! : 0;
          if (i === slot) {
            const n = Math.min(len, cch);
            const w = new Uint8Array(n * 2);
            for (let j = 0; j < n; j++) {
              const c = readWChar(off + 1 + j * 2);
              w[j * 2] = c & 0xff;
              w[j * 2 + 1] = (c >> 8) & 0xff;
            }
            this.runtime.writeBytes(buf, w);
            this.runtime.writeInt32(buf + n * 2, 0); // NUL terminator
            return { returnValue: n, errorCode: E.NO_ERROR };
          }
          off += 1 + len * 2;
        }
      }
      // Fallback: the RT_STRING table is missing (no MUI satellite resources,
      // e.g. in the browser). Real Windows aborts notepad here; returning a
      // non-empty placeholder keeps the GUI init going so the window /
      // message-loop / paint pipeline can be exercised. Content is a stub.
      const placeholder = `S${id}`;
      const n = Math.min(placeholder.length, cch - 1);
      const w = new Uint8Array(n * 2 + 2);
      for (let j = 0; j < n; j++) {
        const c = placeholder.charCodeAt(j);
        w[j * 2] = c & 0xff;
        w[j * 2 + 1] = (c >> 8) & 0xff;
      }
      this.runtime.writeBytes(buf, w);
      return { returnValue: n, errorCode: E.NO_ERROR };
    });

    // LoadMenuW/A + LoadAcceleratorsW: return the raw resource bytes (the
    // guest parses the RT_MENU / RT_ACCELERATOR structures itself). The
    // returned "handle" doubles as the resource address in guest memory, which
    // is what CreateWindowExW receives as hMenu — good enough to keep the UI
    // init path alive. Numeric ids (MAKEINTRESOURCE) resolve from the resource
    // table; string names (e.g. notepad's LoadAcceleratorsW(hInst, L"GlobalAcc"))
    // resolve from the named-resource map merged from the .mui file.
    const loadResBytes = (ctx: ApiCallContext, type: number): ApiResult => {
      const name = ctx.rawArgs[1] ?? 0;
      let entry: { size: number; address: number } | undefined;
      if ((name >>> 16) === 0) {
        const key = ((type & 0xffff) << 16) | (name & 0xffff);
        entry = resourceTable.get(key);
        if (entry) lastResourceKey = key;
      } else {
        const s = readWStr(name).toLowerCase();
        if (s) entry = namedResources.get(`${type}:${s}`);
      }
      if (entry) return { returnValue: entry.address, errorCode: E.NO_ERROR };
      // Fallback: resource missing (no MUI) — mint a unique pseudo-handle so
      // guests that null-check LoadMenuW/LoadAcceleratorsW keep going. The
      // handle is never dereferenced as a real resource by our bridge.
      return { returnValue: ++resHandleSeq, errorCode: E.NO_ERROR };
    };
    let resHandleSeq = 0x2000;
    this.interceptor.hook('user32.dll', 'LoadMenuW', (ctx) => {
      const res = loadResBytes(ctx, 4);
      if (res.returnValue) this.menuByHandle.set(res.returnValue, this.parseMenuResource(res.returnValue));
      return res;
    });
    this.interceptor.hook('user32.dll', 'LoadMenuA', (ctx) => loadResBytes(ctx, 4));
    this.interceptor.hook('user32.dll', 'LoadAcceleratorsW', (ctx) => loadResBytes(ctx, 9));
    this.interceptor.hook('user32.dll', 'LoadAcceleratorsA', (ctx) => loadResBytes(ctx, 9));

    // LoadCursorW/LoadIconW: notepad stores these handles in globals and tests
    // them for NULL during window init (`cmp [g_cursor], 0; je fail`). The
    // guest never dereferences the handle contents, so a unique non-zero
    // pseudo-handle is enough to keep the init path alive.
    let uiHandleSeq = 0x1000;
    const pseudoUiHandle = (): ApiResult => ({ returnValue: ++uiHandleSeq, errorCode: E.NO_ERROR });
    this.interceptor.hook('user32.dll', 'LoadCursorW', pseudoUiHandle);
    this.interceptor.hook('user32.dll', 'LoadCursorA', pseudoUiHandle);
    this.interceptor.hook('user32.dll', 'LoadIconW', pseudoUiHandle);
    this.interceptor.hook('user32.dll', 'LoadIconA', pseudoUiHandle);

    // ------------------------------------------------------------------
    // GUI layer: class registration / window creation / message loop are
    // installed by installGuiBridge() (called from run() after the SEH
    // machinery, which owns the nested-executor helpers it needs).
    // ------------------------------------------------------------------

    // ------------------------------------------------------------------
    // Kernel32 mutex fake-handle layer: notepad's single-instance check is
    // `CreateMutexExW(0, name, 0, 0x1f0001)`; with the default 0 return the
    // NULL handle reads as "another instance owns the mutex" and notepad
    // exits before its message loop (the Step 7 blocker). Minting a unique
    // non-zero handle + GetLastError=0 (the existing default) makes the
    // mutex "created by this instance", so the check passes and notepad
    // proceeds to GetMessageW.
    // ------------------------------------------------------------------
    let mutexSeq = 0x20000;
    const createMutex = (): ApiResult => ({ returnValue: ++mutexSeq, errorCode: E.NO_ERROR });
    this.interceptor.hook('kernel32.dll', 'CreateMutexExW', createMutex);
    this.interceptor.hook('kernel32.dll', 'CreateMutexW', createMutex);
    this.interceptor.hook('kernel32.dll', 'CreateMutexA', createMutex);
    this.interceptor.hook('kernel32.dll', 'OpenMutexW', createMutex);
    this.interceptor.hook('kernel32.dll', 'OpenMutexA', createMutex);
    this.interceptor.hook('kernel32.dll', 'ReleaseMutex', () => this.ok1());
    // notepad's second single-instance step: after the mutex it opens a named
    // semaphore; NULL + GetLastError()==ERROR_FILE_NOT_FOUND means "first
    // run" and startup continues, anything else aborts. Report exactly that.
    this.interceptor.hook('kernel32.dll', 'OpenSemaphoreW', () => ({
      returnValue: 0,
      errorCode: E.ERROR_FILE_NOT_FOUND,
    }));
    this.interceptor.hook('kernel32.dll', 'OpenSemaphoreA', () => ({
      returnValue: 0,
      errorCode: E.ERROR_FILE_NOT_FOUND,
    }));
    this.interceptor.hook('kernel32.dll', 'CreateSemaphoreExW', createMutex);
    // GetLastError must reflect the last failed API call (the interceptor
    // stores non-zero errorCode from dispatched handlers), otherwise guests
    // branching on it — like notepad's single-instance semaphore check —
    // see ERROR_SUCCESS and take the wrong path. The default handler in
    // handlers.ts returns a hard-coded 0.
    this.interceptor.hook('kernel32.dll', 'GetLastError', (ctx) => ({
      returnValue: this.interceptor.getLastError(ctx.pid),
      errorCode: E.NO_ERROR,
    }));
    this.interceptor.hook('kernel32.dll', 'SetLastError', (ctx) => {
      this.interceptor.setLastError(ctx.pid, ctx.rawArgs[0] ?? 0);
      return { returnValue: 0, errorCode: E.NO_ERROR };
    });

    const moduleHandle = (ctx: ApiCallContext): ApiResult => ({
      returnValue: ctx.rawArgs[0] === 0 ? base : 0,
      errorCode: E.NO_ERROR,
    });
    this.interceptor.hook('kernel32.dll', 'GetModuleHandleW', moduleHandle);
    this.interceptor.hook('kernel32.dll', 'GetModuleHandleA', moduleHandle);

    // Resolves APIs resolved DYNAMICALLY via GetProcAddress (installers do
    // this for functions they don't statically import). Known Windows APIs
    // get a fresh trap stub appended after the static ones, so `call` lands
    // in the dispatcher and the handler registry answers; unknown names
    // return NULL like a real lookup miss.
    const allocDynamicStub = (procName: string): number => {
      let module = 'kernel32.dll';
      for (const key of this.interceptor.listHooks()) {
        const bang = key.indexOf('!');
        if (bang > 0 && key.slice(bang + 1) === procName) {
          module = key.slice(0, bang);
          break;
        }
      }
      const argCount = X86_API_ARG_COUNT[procName] ?? 0;
      const index = stubs.length;
      const stubAddress = dynCursor();
      const stubLen = argCount === 0 ? 8 : 10;
      const stub = new Uint8Array(stubLen);
      stub[0] = 0xb8;
      stub[1] = index & 0xff;
      stub[2] = (index >> 8) & 0xff;
      stub[3] = (index >> 16) & 0xff;
      stub[4] = (index >> 24) & 0xff;
      stub[5] = 0xcd;
      stub[6] = 0x2e;
      if (argCount > 0) {
        const popBytes = argCount * 4;
        stub[7] = 0xc2;
        stub[8] = popBytes & 0xff;
        stub[9] = (popBytes >> 8) & 0xff;
      } else {
        stub[7] = 0xc3;
      }
      this.runtime.writeBytes(stubAddress, stub);
      stubs.push({ index, module, proc: procName, stubAddress, iatAddress: 0 });
      setDynCursor(stubAddress + stubLen);
      return stubAddress;
    };

    this.interceptor.hook('kernel32.dll', 'GetProcAddress', (ctx) => {
      const mod = ctx.rawArgs[0] ?? 0;
      const name = ctx.rawArgs[1] ?? 0;
      if (name === 0) return { returnValue: 0, errorCode: E.NO_ERROR };
      if ((name & 0x80000000) !== 0) {
        // ordinal: only resolvable against the exe's own export table
        const address = byOrdinal.get(name & 0xffff);
        return address === undefined
          ? { returnValue: 0, errorCode: E.NO_ERROR }
          : { returnValue: base + address, errorCode: E.NO_ERROR };
      }
      const procName = readCStr(name).toLowerCase();
      if (!procName) return { returnValue: 0, errorCode: E.NO_ERROR };
      // 1) the exe's own exports (GetProcAddress on the image base)
      const own = exports.get(procName);
      if (own !== undefined) return { returnValue: base + own, errorCode: E.NO_ERROR };
      // 2) known Windows APIs -> dynamic trap stub (module ignored: we have no
      //    real DLLs, only the handler registry)
      if (mod !== 0 && mod !== base) return { returnValue: 0, errorCode: E.NO_ERROR };
      const stub = allocDynamicStub(procName);
      return { returnValue: stub, errorCode: E.NO_ERROR };
    });

    // ResolveDelayLoadedAPI: notepad delay-loads COMCTL32/SHELL32 functions
    // through .didat thunks. The CRT helper calls this with the delay-load
    // descriptor; we read the DLL/function name, mint a dynamic trap stub and
    // fill the IAT slot so the thunk's `jmp [slot]` lands in our dispatcher.
    // Signature (delayhlp.cpp): (ParentModuleBase, DelayloadDescriptor,
    //   FailureDllHook, RvaToVa, ThunkAddress, Flags).
    this.interceptor.hook('kernel32.dll', 'ResolveDelayLoadedAPI', (ctx) => {
      const parentBase = (ctx.rawArgs[0] ?? 0) >>> 0;
      const desc = (ctx.rawArgs[1] ?? 0) >>> 0;
      const thunk = (ctx.rawArgs[4] ?? 0) >>> 0;
      const rd32 = (a: number): number => (a ? this.runtime.readInt32(a) >>> 0 : 0);
      const dllRva = rd32(desc + 4);
      const iatRva = rd32(desc + 12);
      const intRva = rd32(desc + 16);
      if (!parentBase || !dllRva || !intRva || !thunk || !iatRva) return { returnValue: 0, errorCode: E.NO_ERROR };
      const dllName = readCStr(parentBase + dllRva).toLowerCase();
      const idx = (thunk - (parentBase + iatRva)) / 4;
      const intThunk = parentBase + intRva + idx * 4;
      const nameVal = rd32(intThunk);
      let procName: string;
      if (nameVal & 0x80000000) {
        procName = `#${nameVal & 0xffff}`;
      } else {
        // hint/name entry: u16 hint followed by the ASCII name
        procName = readCStr(parentBase + nameVal + 2);
      }
      if (!procName) return { returnValue: 0, errorCode: E.NO_ERROR };
      const stub = allocDynamicStub(procName);
      if (!stub) return { returnValue: 0, errorCode: E.NO_ERROR };
      this.runtime.writeInt32(thunk, stub);
      if (dllName) this.runtime.writeInt32(thunk + 4, 0);
      return { returnValue: stub, errorCode: E.NO_ERROR };
    });

    const pseudoLoad = (): ApiResult => ({ returnValue: base, errorCode: E.NO_ERROR });
    this.interceptor.hook('kernel32.dll', 'LoadLibraryW', pseudoLoad);
    this.interceptor.hook('kernel32.dll', 'LoadLibraryA', pseudoLoad);

    // CRT exit paths terminate the process like ExitProcess. Without this,
    // notepad's WinMain failure path calls _o_exit (ucrtbase), our handler
    // registry answers 0, the guest falls through the trailing int3 padding
    // into __scrt_common_main_seh and re-enters WinMain — an infinite
    // re-init loop (each pass reallocates the string table and stacks grow).
    const crtExit = (ctx: ApiCallContext): ApiResult => {
      this.exitCode = (ctx.rawArgs[0] ?? 0) & 0xffffffff;
      this.exitRequested = true;
      this.runtime.setEip(0);
      return { returnValue: 0, errorCode: E.NO_ERROR };
    };
    for (const name of ['_exit', '_Exit', 'exit', '_o_exit', '_o__exit']) {
      this.interceptor.hook('ucrtbase.dll', name, crtExit);
    }

    // GetModuleFileNameW/A: report the module path so the guest can reopen its
    // own file (installers read their archive overlay from disk).
    if (this.modulePath) {
      const pathW = this.modulePath + '\0';
      const pathA = this.modulePath + '\0';
      this.interceptor.hook('kernel32.dll', 'GetModuleFileNameW', (ctx) => {
        const buf = ctx.rawArgs[1] ?? 0;
        const cap = ctx.rawArgs[2] ?? 0;
        if (!buf || !cap) return { returnValue: 0, errorCode: E.NO_ERROR };
        const bytes = new TextEncoder().encode(pathW);
        const n = Math.min(cap, pathW.length - 1); // exclude the NUL
        const w = new Uint8Array(n * 2);
        for (let i = 0; i < n; i++) w[i * 2] = bytes[i] ?? 0;
        this.runtime.writeBytes(buf, w);
        return { returnValue: n, errorCode: E.NO_ERROR };
      });
      this.interceptor.hook('kernel32.dll', 'GetModuleFileNameA', (ctx) => {
        const buf = ctx.rawArgs[1] ?? 0;
        const cap = ctx.rawArgs[2] ?? 0;
        if (!buf || !cap) return { returnValue: 0, errorCode: E.NO_ERROR };
        const bytes = new TextEncoder().encode(pathA);
        const n = Math.min(cap, pathA.length);
        this.runtime.writeBytes(buf, bytes.subarray(0, n));
        return { returnValue: n, errorCode: E.NO_ERROR };
      });
    }

    // SetFilePointer -> fs bridge (the default handler returns 0 and installers
    // that read their own payload in chunks get stuck at offset 0).
    this.interceptor.hook('kernel32.dll', 'SetFilePointer', (ctx, host) => {
      const handle = ctx.rawArgs[0] ?? 0;
      const dist = (ctx.rawArgs[1] ?? 0) | 0;
      const method = ctx.rawArgs[3] ?? 0;
      return host.fs
        .setFilePointer(handle, dist, method)
        .then((r) => (r.error === E.NO_ERROR ? { returnValue: r.newPointer, errorCode: E.NO_ERROR } : { returnValue: 0xffffffff, errorCode: r.error }));
    });

    // CreateFileW with proper UTF-16 path decoding (the default handler reads
    // the wide string as ANSI and stops at the first NUL byte).
    this.interceptor.hook('kernel32.dll', 'CreateFileW', (ctx, host) => {
      const path = readWStr(ctx.rawArgs[0] ?? 0);
      if (!path) return { returnValue: 0xffffffff, errorCode: E.ERROR_FILE_NOT_FOUND };
      return host.fs
        .createFile(path, ctx.rawArgs[1] ?? 0, ctx.rawArgs[2] ?? 0, ctx.rawArgs[4] ?? 0, ctx.rawArgs[5] ?? 0)
        .then((r) => (r.error === E.NO_ERROR ? { returnValue: r.handle, errorCode: E.NO_ERROR } : { returnValue: 0xffffffff, errorCode: r.error }));
    });

    // Truthful VirtualQuery. The default handler claims the whole 4GB is one
    // committed region (RegionSize=0xFFFFFFFF), which makes region-walking
    // loops (packers/installers probe every 64KB page of their image) walk
    // past the actual linear-memory end and trap with "memory access out of
    // bounds" exactly at the memory boundary. Answer with the real region:
    // one committed page-aligned region from the queried page to the end of
    // the current linear memory, and fail (return 0) beyond it so walkers
    // stop instead of probing into the void.
    const memSize = this.runtime.memory.buffer.byteLength;
    this.interceptor.hook('kernel32.dll', 'VirtualQuery', (ctx) => {
      const address = ctx.rawArgs[0] ?? 0;
      const out = ctx.rawArgs[1] ?? 0;
      const len = ctx.rawArgs[2] ?? 0;
      if (!address || !out || address >= memSize) return { returnValue: 0, errorCode: E.ERROR_INVALID_PARAMETER };
      const baseAddress = address & ~0xfff; // page-align down
      const regionSize = memSize - baseAddress;
      const w = new Uint8Array(28);
      const view = new DataView(w.buffer);
      view.setUint32(0, baseAddress, true); // BaseAddress
      view.setUint32(4, baseAddress, true); // AllocationBase
      view.setUint32(8, 0x04, true); // AllocationProtect = PAGE_READWRITE
      view.setUint32(12, regionSize, true); // RegionSize (real, not 4GB)
      view.setUint32(16, 0x1000, true); // State = MEM_COMMIT
      view.setUint32(20, 0x04, true); // Protect = PAGE_READWRITE
      view.setUint32(24, 0x20000, true); // Type = MEM_PRIVATE
      const n = Math.min(28, len);
      this.runtime.writeBytes(out, w.subarray(0, n));
      return { returnValue: n, errorCode: E.NO_ERROR };
    });

    // ------------------------------------------------------------------
    // Minimal heap / virtual memory (real installers unpack megabytes).
    // A bump allocator over the free space ABOVE the stack headroom: the
    // stack grows down from 0x08000000 while the heap grows up from just
    // past it, so they never collide. Blocks get an 8-byte size header at
    // [user-4] (what msvcrt/NSIS heap code reads); frees are no-ops.
    // ------------------------------------------------------------------
    const heapBase = (this.runtime.memory.buffer.byteLength + 0xffff) & ~0xffff;
    let heapCursor = heapBase;
    const heapHandle = heapBase;
    const bumpAlloc = (size: number): number => {
      const blockSize = Math.max(8, (size + 8 + 7) & ~7);
      heapCursor = (heapCursor + 7) & ~7;
      const user = heapCursor;
      heapCursor += blockSize;
      this.runtime.ensure(heapCursor + 0x1000);
      this.runtime.writeInt32(user - 4, blockSize);
      return user;
    };

    // SEH dispatch scratch (see installSehDispatch): an executable sentinel
    // stub (`int 0x2d` stops the nested handler run with EAX = disposition),
    // plus room for the EXCEPTION_RECORD (80 bytes) and x86 CONTEXT (0x2CC).
    // Allocated from the bump heap — never freed, stable for the whole run.
    this.sehSentinelAddr = bumpAlloc(8);
    this.sehExcAddr = bumpAlloc(0x80);
    this.sehCtxAddr = bumpAlloc(X86_CONTEXT_SIZE);
    this.runtime.writeBytes(this.sehSentinelAddr, new Uint8Array([0xcd, SEH_SENTINEL_VECTOR]));

    // GetCommandLineW/A: return pointers to a valid (empty) command line in
    // guest memory. Returning 0 makes CRT arg parsing walk address 0 and
    // spin forever (e.g. notepad's tokenizer + CharNextW).
    const cmdLineW = bumpAlloc(4);
    this.runtime.writeBytes(cmdLineW, new Uint8Array(4)); // L""
    const cmdLineA = bumpAlloc(1);
    this.runtime.writeBytes(cmdLineA, new Uint8Array(1)); // ""
    this.interceptor.hook('kernel32.dll', 'GetCommandLineW', () => ({ returnValue: cmdLineW, errorCode: E.NO_ERROR }));
    this.interceptor.hook('kernel32.dll', 'GetCommandLineA', () => ({ returnValue: cmdLineA, errorCode: E.NO_ERROR }));
    // UCRT's wide command-line accessor (imported via api-ms-win-crt-private,
    // normalized to ucrtbase.dll). Returning 0 makes the CRT arg tokenizer
    // call CharNextW(0) forever.
    this.interceptor.hook('ucrtbase.dll', '_o__get_wide_winmain_command_line', () => ({ returnValue: cmdLineW, errorCode: E.NO_ERROR }));
    this.interceptor.hook('ucrtbase.dll', '_get_wide_winmain_command_line', () => ({ returnValue: cmdLineW, errorCode: E.NO_ERROR }));

    // ------------------------------------------------------------------
    // TEB + TLS. The decoder ignores segment prefixes, so fs: behaves like
    // a flat base of 0 — i.e. the guest TEB sits at guest address 0. That is
    // already how SEH works here (fs:[0] -> [0]). TEB+0x2C is the
    // ThreadLocalStoragePointer; Inno's embedded RTL reads TLS INLINE via
    // fs:[0x2c] (see 0x40f7d0) instead of calling TlsGetValue, so both the
    // inlined path and the kernel32 TlsSetValue/TlsGetValue handlers must
    // agree on the SAME array. Slot 0 is where Inno stores its exception
    // frame list head (TlsSetValue(0, ...) in the log).
    // ------------------------------------------------------------------
    const tlsSlotCount = 128;
    const tlsArray = bumpAlloc(tlsSlotCount * 4);
    this.runtime.writeInt32(0x2c, tlsArray);
    this.interceptor.hook('kernel32.dll', 'TlsGetValue', (ctx) => {
      const slot = (ctx.rawArgs[0] ?? 0) >>> 0;
      return {
        returnValue: slot < tlsSlotCount ? this.runtime.readInt32(tlsArray + slot * 4) : 0,
        errorCode: E.NO_ERROR,
      };
    });
    this.interceptor.hook('kernel32.dll', 'TlsSetValue', (ctx) => {
      const slot = (ctx.rawArgs[0] ?? 0) >>> 0;
      const value = (ctx.rawArgs[1] ?? 0) >>> 0;
      if (slot < tlsSlotCount) this.runtime.writeInt32(tlsArray + slot * 4, value);
      return { returnValue: 1, errorCode: E.NO_ERROR };
    });

    this.interceptor.hook('kernel32.dll', 'GetProcessHeap', () => ({ returnValue: heapHandle, errorCode: E.NO_ERROR }));
    this.interceptor.hook('kernel32.dll', 'GetProcessHeapEx', () => ({ returnValue: heapHandle, errorCode: E.NO_ERROR }));
    this.interceptor.hook('kernel32.dll', 'HeapCreate', () => ({ returnValue: heapHandle, errorCode: E.NO_ERROR }));
    this.interceptor.hook('kernel32.dll', 'HeapDestroy', () => this.ok1());
    this.interceptor.hook('kernel32.dll', 'HeapAlloc', (ctx) => {
      const size = ctx.rawArgs[2] ?? 0;
      return { returnValue: bumpAlloc(size), errorCode: E.NO_ERROR };
    });
    this.interceptor.hook('kernel32.dll', 'HeapReAlloc', (ctx) => {
      const old = ctx.rawArgs[1] ?? 0;
      const size = ctx.rawArgs[3] ?? 0;
      if (!old) return { returnValue: bumpAlloc(size), errorCode: E.NO_ERROR };
      const oldSize = Math.max(0, this.runtime.readInt32(old - 4) & ~7);
      const next = bumpAlloc(size);
      const n = Math.min(oldSize, size);
      if (n > 0) this.runtime.writeBytes(next, this.runtime.readBytes(old, n));
      return { returnValue: next, errorCode: E.NO_ERROR };
    });
    this.interceptor.hook('kernel32.dll', 'HeapFree', () => this.ok1());
    this.interceptor.hook('kernel32.dll', 'HeapSize', (ctx) => {
      const p = ctx.rawArgs[1] ?? 0;
      return { returnValue: p ? Math.max(0, this.runtime.readInt32(p - 4) & ~7) : 0, errorCode: E.NO_ERROR };
    });
    this.interceptor.hook('kernel32.dll', 'LocalAlloc', (ctx) => {
      const size = ctx.rawArgs[1] ?? 0;
      return { returnValue: bumpAlloc(size), errorCode: E.NO_ERROR };
    });
    this.interceptor.hook('kernel32.dll', 'LocalFree', () => ({ returnValue: 0, errorCode: E.NO_ERROR }));
    // LocalSize: notepad reads the allocated size back right after LocalAlloc
    // (`mov esi,eax; shr esi,1; je fail`) — an unimplemented 0 aborts startup
    // with STATUS_STACK_BUFFER_OVERRUN. Same [user-4] size header as HeapSize.
    this.interceptor.hook('kernel32.dll', 'LocalSize', (ctx) => {
      const p = ctx.rawArgs[0] ?? 0;
      return { returnValue: p ? Math.max(0, this.runtime.readInt32(p - 4) & ~7) : 0, errorCode: E.NO_ERROR };
    });

    // ucrtbase heap allocators. notepad's C++ `operator new` routes through
    // malloc; returning 0 makes `new` throw std::bad_alloc via
    // _CxxThrowException (which needs full MSVC C++ exception dispatch to
    // unwind — out of scope), so allocate from the same bump heap instead.
    // These are cdecl (caller cleans up); the stub argCount for them is 0.
    const ucrtAlloc = (ctx: ApiCallContext): ApiResult => ({
      returnValue: bumpAlloc(ctx.rawArgs[0] ?? 0),
      errorCode: E.NO_ERROR,
    });
    const ucrtRealloc = (ctx: ApiCallContext): ApiResult => {
      const old = ctx.rawArgs[0] ?? 0;
      const size = ctx.rawArgs[1] ?? 0;
      if (!old) return { returnValue: bumpAlloc(size), errorCode: E.NO_ERROR };
      const oldSize = Math.max(0, this.runtime.readInt32(old - 4) & ~7);
      const next = bumpAlloc(size);
      const n = Math.min(oldSize, size);
      if (n > 0) this.runtime.writeBytes(next, this.runtime.readBytes(old, n));
      return { returnValue: next, errorCode: E.NO_ERROR };
    };
    const ucrtCalloc = (ctx: ApiCallContext): ApiResult => {
      const n = (ctx.rawArgs[0] ?? 0) >>> 0;
      const size = (ctx.rawArgs[1] ?? 0) >>> 0;
      const total = n * size;
      const p = bumpAlloc(total);
      if (total > 0) this.runtime.writeBytes(p, new Uint8Array(total));
      return { returnValue: p, errorCode: E.NO_ERROR };
    };
    for (const name of ['malloc', '_o_malloc', '_malloc_base']) {
      this.interceptor.hook('ucrtbase.dll', name, ucrtAlloc);
    }
    for (const name of ['calloc', '_o_calloc', '_calloc_base']) {
      this.interceptor.hook('ucrtbase.dll', name, ucrtCalloc);
    }
    for (const name of ['realloc', '_o_realloc', '_realloc_base']) {
      this.interceptor.hook('ucrtbase.dll', name, ucrtRealloc);
    }
    for (const name of ['free', '_o_free', '_free_base', '_o__free_base']) {
      this.interceptor.hook('ucrtbase.dll', name, () => ({ returnValue: 0, errorCode: E.NO_ERROR }));
    }

    // COM task allocators (normalized from api-ms-win-core-com-* to ole32).
    this.interceptor.hook('ole32.dll', 'CoTaskMemAlloc', ucrtAlloc);
    this.interceptor.hook('ole32.dll', 'CoTaskMemRealloc', ucrtRealloc);
    this.interceptor.hook('ole32.dll', 'CoTaskMemFree', () => ({ returnValue: 0, errorCode: E.NO_ERROR }));
    // CoCreateGuid: fill a (unique-enough) GUID so callers can key on it.
    let guidCounter = 0x10203040;
    this.interceptor.hook('ole32.dll', 'CoCreateGuid', (ctx) => {
      const p = ctx.rawArgs[0] ?? 0;
      if (!p) return { returnValue: 0x80070057, errorCode: E.NO_ERROR }; // E_INVALIDARG
      guidCounter = (guidCounter + 0x9e3779b9) | 0;
      const t = Date.now() & 0xffffffff;
      // GUID layout: Data1 u32 @0, Data2 u16 @4, Data3 u16 @6, Data4 u8[8] @8.
      // Data4 MUST start at p+8 — writing at p+10 spilled 2 bytes past the
      // GUID and clobbered the caller's stack cookie ([ebp-4] low 16 bits),
      // which made every cookie-checked function fail-fast afterwards.
      this.runtime.writeInt32(p, guidCounter);
      this.runtime.writeInt32(p + 4, t);
      const b = new Uint8Array(8);
      for (let i = 0; i < 8; i++) b[i] = ((guidCounter >>> (i * 4)) ^ (t >> (i * 3))) & 0xff;
      this.runtime.writeBytes(p + 8, b);
      return { returnValue: 0, errorCode: E.NO_ERROR }; // S_OK
    });
    // CoCreateInstance: no COM servers exist in this environment. notepad's
    // lazy COM-object getter (0x423246) does `test eax,eax; js` and skips
    // gracefully on a FAILED HRESULT — but the generic unimplemented handler
    // returns 0 = S_OK WITHOUT writing ppv, so the guest then dereferences the
    // stale global (0x429e18) and derails. Report the class as not registered.
    this.interceptor.hook('ole32.dll', 'CoCreateInstance', () => ({
      returnValue: 0x80040154, // REGDB_E_CLASSNOTREG
      errorCode: E.NO_ERROR,
    }));
    this.interceptor.hook('kernel32.dll', 'LocalReAlloc', (ctx) => {
      const old = ctx.rawArgs[0] ?? 0;
      const size = ctx.rawArgs[1] ?? 0;
      if (!old) return { returnValue: bumpAlloc(size), errorCode: E.NO_ERROR };
      const oldSize = Math.max(0, this.runtime.readInt32(old - 4) & ~7);
      const next = bumpAlloc(size);
      const n = Math.min(oldSize, size);
      if (n > 0) this.runtime.writeBytes(next, this.runtime.readBytes(old, n));
      return { returnValue: next, errorCode: E.NO_ERROR };
    });
    this.interceptor.hook('kernel32.dll', 'VirtualAlloc', (ctx) => {
      const size = ctx.rawArgs[1] ?? 0;
      const type = ctx.rawArgs[2] ?? 0;
      // MEM_COMMIT (0x1000) alone is a valid request (commits in an existing
      // reservation) — the MM uses VirtualAlloc(0, pool, COMMIT, RW) to grow
      // its arena. Only pure MEM_RESERVE (0x2000 without COMMIT) or size 0
      // returns NULL. Real Windows returns 64KB-aligned addresses.
      if (!size || (type & 0x1000) === 0) return { returnValue: 0, errorCode: E.NO_ERROR };
      if ((heapCursor & 0xffff) !== 0) heapCursor = (heapCursor + 0xffff) & ~0xffff;
      const user = bumpAlloc(size);
      return { returnValue: user, errorCode: E.NO_ERROR };
    });
    this.interceptor.hook('kernel32.dll', 'VirtualFree', () => this.ok1());
    this.interceptor.hook('kernel32.dll', 'VirtualProtect', () => this.ok1());
    this.interceptor.hook('kernel32.dll', 'Sleep', () => ({ returnValue: 0, errorCode: E.NO_ERROR }));

    // ------------------------------------------------------------------
    // WinRT string/activation helpers (api-ms-win-core-winrt-* normalize to
    // kernel32) + SHELL32 delay-loads. These return HRESULTs, and the generic
    // unimplemented handler returns 0 = S_OK WITHOUT writing the output
    // pointers — the guest then believes the call succeeded and dereferences
    // uninitialized outputs (notepad's WIP check: RoGetActivationFactory
    // "succeeds" with a garbage factory -> vtable call through garbage ->
    // runaway). Two rules:
    //   - WindowsCreateStringReference/CreateString MUST succeed AND write a
    //     valid HSTRING; notepad's `js` on their failure throws via 0x40cc99
    //     (not a graceful path).
    //   - RoGetActivationFactory (and the error-info helpers) MUST return a
    //     FAILED HRESULT so notepad's `jns` check takes its trace-and-skip
    //     path and continues to the message loop.
    // HSTRING layout (winstring): [h-8] = u32 length, [h-4] = flags,
    // h = UTF-16 data. For a reference string the header is caller-provided
    // and HSTRING = header + 8.
    // ------------------------------------------------------------------
    const createStringReference = (ctx: ApiCallContext): ApiResult => {
      const source = (ctx.rawArgs[0] ?? 0) >>> 0;
      const len = (ctx.rawArgs[1] ?? 0) >>> 0;
      const headerPtr = (ctx.rawArgs[2] ?? 0) >>> 0; // HSTRING_HEADER* (caller-provided)
      const out = (ctx.rawArgs[3] ?? 0) >>> 0; // HSTRING* out
      if (!out) return { returnValue: 0x80070057, errorCode: E.NO_ERROR }; // E_INVALIDARG
      // Heap-copy the source so the HSTRING has the same layout as
      // WindowsCreateString ([h-8]=len, [h-4]=flags, h=data). Real reference
      // strings alias the caller's source via the HSTRING_HEADER, but then
      // RoGetActivationFactory can't read the class name back; the bump-heap
      // copy is single-use and never freed (acceptable).
      const p = bumpAlloc(len * 2 + 8);
      this.runtime.writeInt32(p, len);
      this.runtime.writeInt32(p + 4, 0);
      if (source && len) {
        this.runtime.writeBytes(p + 8, this.runtime.readBytes(source, len * 2));
      }
      this.runtime.writeInt32(out, p + 8);
      void headerPtr;
      return { returnValue: 0, errorCode: E.NO_ERROR }; // S_OK
    };
    const createString = (ctx: ApiCallContext): ApiResult => {
      const source = (ctx.rawArgs[0] ?? 0) >>> 0;
      const len = (ctx.rawArgs[1] ?? 0) >>> 0;
      const out = (ctx.rawArgs[2] ?? 0) >>> 0;
      if (!out) return { returnValue: 0x80070057, errorCode: E.NO_ERROR };
      const p = bumpAlloc(len * 2 + 8);
      this.runtime.writeInt32(p, len);
      this.runtime.writeInt32(p + 4, 0);
      if (source && len) {
        this.runtime.writeBytes(p + 8, this.runtime.readBytes(source, len * 2));
      }
      this.runtime.writeInt32(out, p + 8);
      return { returnValue: 0, errorCode: E.NO_ERROR };
    };
    const getStringRawBuffer = (ctx: ApiCallContext): ApiResult => {
      const h = (ctx.rawArgs[0] ?? 0) >>> 0;
      const lenOut = (ctx.rawArgs[1] ?? 0) >>> 0;
      if (lenOut) this.runtime.writeInt32(lenOut, h ? this.runtime.readInt32(h - 8) : 0);
      return { returnValue: h, errorCode: E.NO_ERROR };
    };
    // E_NOTIMPL (0x80004001, sign bit set) — guests check HRESULTs with
    // `jns`/`js` and take their documented failure path.
    const failHr = (): ApiResult => ({ returnValue: 0x80004001, errorCode: E.NO_ERROR });
    this.interceptor.hook('kernel32.dll', 'WindowsCreateStringReference', createStringReference);
    this.interceptor.hook('kernel32.dll', 'WindowsCreateString', createString);
    this.interceptor.hook('kernel32.dll', 'WindowsDeleteString', () => ({ returnValue: 0, errorCode: E.NO_ERROR }));
    this.interceptor.hook('kernel32.dll', 'WindowsGetStringRawBuffer', getStringRawBuffer);
    // RoGetActivationFactory is a split personality:
    //  - The early WIP check (0x40bcaa) tolerates a FAILED HRESULT and skips
    //    gracefully (Step 7 behavior — E_NOTIMPL).
    //  - The EDP helper (edpapphelper.cpp:246, 0x424f8b) does
    //    `test edi,edi; jns` — ANY negative HRESULT triggers WIL report +
    //    __fastfail (0x424f96 -> 0x4076c9 -> ... -> int 0x29), which ends the
    //    process. On real systems RoGetActivationFactory succeeds for this
    //    class, so notepad never sees the failure path.
    // For "Windows.Security.EnterpriseData.ProtectionPolicyManager" we
    // therefore mint a fake IInspectable factory whose vtable slots are trap
    // stubs: vtable[12] (CheckAccess-ish) answers S_OK, vtable[14]
    // (IsProtectionEnabled-ish) writes "not protected" (bool 0) and returns
    // S_OK. Other classes keep the E_NOTIMPL behavior.
    const pmpFactoryAddr = ((): number => {
      const vt = bumpAlloc(0x40); // 16 vtable slots
      const factory = bumpAlloc(0x10);
      // IUnknown: [0]=QueryInterface(3 args), [1]=AddRef(0), [2]=Release(0).
      // notepad's EDP helper then calls [12] (CheckAccess-ish, 3 args) and
      // [14] (IsProtectionEnabled-ish, 2 args). Everything else answers with
      // a 0-arg stub so an unexpected Release() cannot pop the caller's stack.
      const slotName = (i: number): string =>
        i === 0
          ? 'pmp_qi'
          : i === 2
            ? 'pmp_release'
            : i === 12
              ? 'pmp_checkaccess'
              : i === 14
                ? 'pmp_isprotected'
                : 'pmp_vtbl_stub';
      for (let i = 0; i < 16; i++) {
        const stub = allocDynamicStub(slotName(i));
        this.runtime.writeInt32(vt + i * 4, stub);
      }
      this.runtime.writeInt32(factory, vt);
      return factory;
    })();
    this.interceptor.hook('kernel32.dll', 'RoGetActivationFactory', (ctx) => {
      const classId = (ctx.rawArgs[0] ?? 0) >>> 0;
      const out = (ctx.rawArgs[2] ?? 0) >>> 0;
      // HSTRING: [h-8] = char length, h = UTF-16 data.
      let name = '';
      if (classId) {
        const len = this.runtime.readInt32(classId - 8);
        if (len >= 0 && len <= 0x100) {
          const b = this.runtime.readBytes(classId, len * 2);
          for (let i = 0; i + 1 < b.byteLength; i += 2) {
            const c = b[i]! | (b[i + 1]! << 8);
            if (c === 0) break;
            name += String.fromCharCode(c);
          }
        }
      }
      if (name === 'Windows.Security.EnterpriseData.ProtectionPolicyManager') {
        if (out) this.runtime.writeInt32(out, pmpFactoryAddr);
        return { returnValue: 0, errorCode: E.NO_ERROR }; // S_OK
      }
      return { returnValue: 0x80004001, errorCode: E.NO_ERROR }; // E_NOTIMPL
    });
    // Mock IProtectionPolicyManager vtable method handlers (dispatched via
    // the trap stubs minted above; stdcall arg counts live in mapper.ts).
    const pmpOk = (): ApiResult => ({ returnValue: 0, errorCode: E.NO_ERROR });
    this.interceptor.hook('kernel32.dll', 'pmp_vtbl_stub', pmpOk);
    this.interceptor.hook('kernel32.dll', 'pmp_qi', (ctx) => {
      // (this, riid, void** out) — return a copy of the interface pointer.
      const out = ctx.rawArgs[2] ?? 0;
      const self = ctx.rawArgs[0] ?? 0;
      if (out) this.runtime.writeInt32(out, self);
      return { returnValue: 0, errorCode: E.NO_ERROR };
    });
    this.interceptor.hook('kernel32.dll', 'pmp_checkaccess', pmpOk);
    this.interceptor.hook('kernel32.dll', 'pmp_release', pmpOk);
    this.interceptor.hook('kernel32.dll', 'pmp_isprotected', (ctx) => {
      // (this, bool* out) — report "not protected".
      const out = ctx.rawArgs[1] ?? 0;
      if (out) this.runtime.writeInt32(out, 0);
      return { returnValue: 0, errorCode: E.NO_ERROR };
    });
    this.interceptor.hook('kernel32.dll', 'RoGetMatchingRestrictedErrorInfo', failHr);
    this.interceptor.hook('kernel32.dll', 'SetRestrictedErrorInfo', failHr);
    // notepad delay-loads SHGetKnownFolderPath (resolved as kernel32 by
    // allocDynamicStub) and skips the title/banner path when it fails.
    this.interceptor.hook('kernel32.dll', 'SHGetKnownFolderPath', failHr);
    this.interceptor.hook('shell32.dll', 'SHGetKnownFolderPath', failHr);

    // OS version reporting (NSIS / CRT gate on it).
    this.interceptor.hook('kernel32.dll', 'GetVersion', () => ({
      returnValue: 0x8000000a, // NT, major 10, minor 0 (0x80000000 = NT)
      errorCode: E.NO_ERROR,
    }));
    this.interceptor.hook('kernel32.dll', 'GetVersionExW', (ctx) => {
      const out = ctx.rawArgs[0] ?? 0;
      if (!out) return { returnValue: 0, errorCode: E.NO_ERROR };
      const w = new Uint8Array(284); // OSVERSIONINFOW
      const view = new DataView(w.buffer);
      view.setUint32(0, 284, true); // dwOSVersionInfoSize
      view.setUint32(4, 10, true); // dwMajorVersion
      view.setUint32(8, 0, true); // dwMinorVersion
      view.setUint32(12, 19045, true); // dwBuildNumber
      view.setUint32(16, 2, true); // dwPlatformId = VER_PLATFORM_WIN32_NT
      this.runtime.writeBytes(out, w);
      return { returnValue: 1, errorCode: E.NO_ERROR };
    });
    this.interceptor.hook('kernel32.dll', 'GetVersionExA', (ctx) => {
      const out = ctx.rawArgs[0] ?? 0;
      if (!out) return { returnValue: 0, errorCode: E.NO_ERROR };
      const w = new Uint8Array(148); // OSVERSIONINFOA
      const view = new DataView(w.buffer);
      view.setUint32(0, 148, true);
      view.setUint32(4, 10, true);
      view.setUint32(8, 0, true);
      view.setUint32(12, 19045, true);
      view.setUint32(16, 2, true);
      this.runtime.writeBytes(out, w);
      return { returnValue: 1, errorCode: E.NO_ERROR };
    });

    // ------------------------------------------------------------------
    // OS version gating (installers refuse to run on "old" Windows).
    // VerSetConditionMask builds a 64-bit condition mask (8-bit condition
    // fields at bit-offset == TypeMask value); VerifyVersionInfoW compares the
    // emulated OS (10.0.19045, NT) against it. Returning 0 from the verify
    // makes Inno/NSIS abort startup with no UI.
    // ------------------------------------------------------------------
    this.interceptor.hook('kernel32.dll', 'VerSetConditionMask', (ctx) => {
      const maskLow = (ctx.rawArgs[0] ?? 0) >>> 0;
      const maskHigh = (ctx.rawArgs[1] ?? 0) >>> 0;
      const typeBit = ctx.rawArgs[2] ?? 0;
      const condition = (ctx.rawArgs[3] ?? 0) & 0xff;
      if (typeBit >= 32) {
        const p = typeBit - 32;
        return { returnValue: maskLow, returnValueHigh: (maskHigh & ~(0xff << p)) | (condition << p), errorCode: E.NO_ERROR };
      }
      return { returnValue: (maskLow & ~(0xff << typeBit)) | (condition << typeBit), returnValueHigh: maskHigh, errorCode: E.NO_ERROR };
    });
    this.interceptor.hook('kernel32.dll', 'VerifyVersionInfoW', (ctx) => {
      const lpvi = ctx.rawArgs[0] ?? 0;
      const typeMask = ctx.rawArgs[1] ?? 0;
      if (!lpvi || !typeMask) return { returnValue: 0, errorCode: E.ERROR_INVALID_PARAMETER };
      // The guest fills OSVERSIONINFOEXW with the minimum version it accepts
      // and compares field-by-field — but a naive per-field check fails for
      // (major,minor) pairs like "6.1" vs our "10.0" (0 >= 1 is false). Real
      // Windows solves this by reporting unmanifested apps a compatibility
      // version and by treating the check as a version ordering. We emulate
      // the outcome installers actually rely on: lexicographic comparison of
      // the emulated OS (10.0.19045, NT) against the requested version, over
      // the fields present in the type mask.
      const req = {
        major: this.runtime.readInt32(lpvi + 4),
        minor: this.runtime.readInt32(lpvi + 8),
        build: this.runtime.readInt32(lpvi + 12),
        platform: this.runtime.readInt32(lpvi + 16),
        spMajor: this.runtime.readInt32(lpvi + 276),
        spMinor: this.runtime.readInt32(lpvi + 278),
      };
      const ours = { major: 10, minor: 0, build: 19045, platform: 2, spMajor: 0, spMinor: 0 } as const;
      const order: Array<[keyof typeof req, number]> = [
        ['major', 0x2],
        ['minor', 0x1],
        ['build', 0x4],
        ['platform', 0x8],
        ['spMajor', 0x20],
        ['spMinor', 0x10],
      ];
      for (const [key, bit] of order) {
        if ((typeMask & bit) === 0) continue;
        if (ours[key] > req[key]) return { returnValue: 1, errorCode: E.NO_ERROR };
        if (ours[key] < req[key]) return { returnValue: 0, errorCode: E.NO_ERROR };
      }
      return { returnValue: 1, errorCode: E.NO_ERROR };
    });

    // MUI satellite resources: Windows 10+ apps keep strings/menus/dialogs in
    // a sibling "<lang>/<module>.mui"; the exe itself has no RT_STRING and
    // LoadStringW would always fail. Merge the .mui entries into the table so
    // the hooks above (LoadStringW/LoadMenuW/...) resolve them. Needs bumpAlloc
    // (defined above) to copy the bytes into guest memory.
    await this.mergeMuiResources(resourceTable, namedResources, bumpAlloc);
    // Keep the RT_MENU (type 4) entries for class-menu parsing (Layer 3):
    // notepad attaches its menu via WNDCLASSEXW.lpszMenuName, not LoadMenuW.
    this.menuResourceTable.clear();
    for (const [key, entry] of resourceTable) {
      if ((key >>> 16) === 4) this.menuResourceTable.set(key & 0xffff, entry);
    }
  }

  /**
   * Loads MUI satellite resources for modulePath and merges their resource
   * entries into `resourceTable` (guest-address space). Windows 10+ keeps an
   * app's localizable resources (RT_STRING type 6, RT_MENU type 4,
   * RT_ACCELERATOR type 9) in `<exeDir>\<lang>\<module>.mui` — notepad.exe has
   * no strings of its own and LoadStringW fails (startup abort) without them.
   *
   * Each MUI resource block is copied into the guest bump heap so the address
   * handed to LoadStringW/LoadMenuW points at real bytes the guest can read.
   * Numeric resource ids only (MUI files use numeric ids; string names would
   * need guest string parsing).
   */
  private async mergeMuiResources(
    resourceTable: Map<number, { size: number; address: number }>,
    namedResources: Map<string, { size: number; address: number }>,
    bumpAlloc: (size: number) => number,
  ): Promise<void> {
    if (!this.modulePath || !this.readFile) return;
    const dir = this.modulePath.replace(/[\\/][^\\/]*$/, '');
    const base = this.modulePath.replace(/^.*[\\/]/, '').replace(/\.mui$/i, '');
    // The 32-bit notepad's satellite lives under System32\<lang> on x64 hosts
    // (the SysWOW64\<lang> directory does not exist), so probe both.
    const candidates = [
      `${dir}/en-US/${base}.mui`,
      `${dir}/zh-CN/${base}.mui`,
      `${dir}/zh-Hans/${base}.mui`,
      `C:/Windows/System32/en-US/${base}.mui`,
      `C:/Windows/System32/zh-CN/${base}.mui`,
      `C:/Windows/System32/zh-Hans/${base}.mui`,
    ];
    let mui: Uint8Array | null = null;
    let muiPath = '';
    for (const p of candidates) {
      try {
        mui = await this.readFile(p);
      } catch {
        mui = null;
      }
      if (mui && mui.byteLength > 0) {
        muiPath = p;
        break;
      }
    }
    if (!mui || mui.byteLength === 0) {
      console.warn(`[bk] MUI: no satellite found for ${this.modulePath} (candidates: ${candidates.join(', ')})`);
      return;
    }

    const view = new DataView(mui.buffer, mui.byteOffset, mui.byteLength);
    const u16 = (o: number): number => (o + 2 <= mui.byteLength ? view.getUint16(o, true) : 0);
    const u32 = (o: number): number => (o + 4 <= mui.byteLength ? view.getUint32(o, true) : 0);
    if (u16(0) !== 0x5a4d) return; // not a PE
    const eLfanew = u32(0x3c);
    const coff = eLfanew + 4;
    const numSections = u16(coff + 2);
    const optSize = u16(coff + 16);
    const optMagic = u16(eLfanew + 24);
    const dataDir = eLfanew + 24 + (optMagic === 0x20b ? 112 : 96);
    const resRva = u32(dataDir + 16);
    if (!resRva) return;
    const secTable = coff + 20 + optSize;
    let resRaw = 0;
    for (let i = 0; i < numSections; i++) {
      const s = secTable + i * 40;
      if (u32(s + 12) === resRva) {
        resRaw = u32(s + 20);
        break;
      }
    }
    if (!resRaw) return;
    const r2o = (rva: number): number => resRaw + (rva - resRva);
    const inBounds = (o: number, n: number): boolean => o >= 0 && o + n <= mui.byteLength;

    // Collect {type, nameId} -> raw data bytes (numeric) and
    // {type, nameStr} -> raw data bytes (named resources).
    const entries = new Map<number, Uint8Array>();
    const namedEntries = new Map<string, Uint8Array>();
    // Reads a resource-directory string name (u16 length + UTF-16LE) at the
    // given offset into the .mui file; returns '' when absent.
    const readNameStr = (off: number): string => {
      if (!inBounds(off, 2)) return '';
      const len = u16(off);
      if (!inBounds(off + 2, len * 2)) return '';
      let s = '';
      for (let i = 0; i < len; i++) s += String.fromCharCode(u16(off + 2 + i * 2));
      return s;
    };
    const walk = (rva: number, depth: number, typeId: number, nameId: number, nameStr: string): void => {
      const off = r2o(rva);
      if (!inBounds(off, 16)) return;
      const named = u16(off + 12);
      const ids = u16(off + 14);
      for (let k = 0; k < named + ids; k++) {
        const e = off + 16 + k * 8;
        if (!inBounds(e, 8)) break;
        const name = u32(e);
        const data = u32(e + 4);
        if (depth === 0) {
          walk(resRva + (data & 0x7fffffff), 1, name & 0xffff, 0, '');
        } else if (depth === 1) {
          if ((name & 0x80000000) !== 0) {
            const s = readNameStr(r2o(resRva + (name & 0x7fffffff)));
            walk(resRva + (data & 0x7fffffff), 2, typeId, 0, s);
          } else {
            walk(resRva + (data & 0x7fffffff), 2, typeId, name & 0xffff, '');
          }
        } else {
          const de = r2o(resRva + data);
          if (!inBounds(de, 8)) continue;
          const dataRva = u32(de);
          const size = u32(de + 4);
          const doff = r2o(dataRva);
          if (!inBounds(doff, size) || size === 0) continue;
          if (nameStr) {
            const key = `${typeId}:${nameStr.toLowerCase()}`;
            if (!namedEntries.has(key)) namedEntries.set(key, mui.subarray(doff, doff + size));
          } else {
            const key = ((typeId & 0xffff) << 16) | (nameId & 0xffff);
            if (!entries.has(key)) entries.set(key, mui.subarray(doff, doff + size));
          }
        }
      }
    };
    walk(resRva, 0, 0, 0, '');

    let merged = 0;
    for (const [key, data] of entries) {
      const type = key >>> 16;
      // Only merge resources the hooks can serve: strings/menus/accelerators.
      if (type !== 6 && type !== 4 && type !== 9) continue;
      const addr = bumpAlloc(data.byteLength);
      this.runtime.writeBytes(addr, data);
      resourceTable.set(key, { size: data.byteLength, address: addr });
      merged += 1;
    }
    for (const [key, data] of namedEntries) {
      const type = Number.parseInt(key, 10);
      if (type !== 4 && type !== 9) continue;
      const addr = bumpAlloc(data.byteLength);
      this.runtime.writeBytes(addr, data);
      namedResources.set(key, { size: data.byteLength, address: addr });
      merged += 1;
    }
    if (merged > 0) {
      this.muiLoaded = true;
      this.muiSource = muiPath;
      console.error(`[bk] merged ${merged} MUI resources (${muiPath})`);
    } else {
      console.warn(`[bk] MUI: found ${muiPath} but merged 0 resources`);
    }
  }

  /**
   * SEH exception dispatch for RaiseException (x86 only; x64 SEH needs the
   * .pdata unwind metadata and is out of scope — those images keep the legacy
   * "return 0" behaviour).
   *
   * The decoder maps fs:[0] to guest address 0 (segment prefixes are ignored),
   * so the SEH chain head lives at guest address 0 and each record is
   * `{ Next @R+0, Handler @R+4 }` pushed by the frame's prologue. We emulate
   * the two-phase Windows protocol:
   *   1. walk the chain, calling each handler with (ExceptionRecord,
   *      EstablisherFrame, ContextRecord, DispatcherContext);
   *   2. on EXCEPTION_EXECUTE_HANDLER, call the intermediate frames again with
   *      cUnwinding set (cleanup/finally), then transfer control into the
   *      accepting handler — it rebuilds its frame below the record and the
   *      frame's own epilogue eventually `ret`s to the real caller, continuing
   *      the guest program without ever returning through RaiseException.
   *
   * Handlers are guest code that may call APIs, so each search/unwind call
   * runs inside a NESTED executor whose trap handler forwards API traps and
   * treats the sentinel vector as "handler returned; EAX = disposition".
   * Registers are restored after every call except the final transfer.
   */
  private installSehDispatch(dispatcher: ApiTrapDispatcher, jit: JitEngine, mode: 'x86' | 'x64'): void {
    if (mode === 'x64' || this.sehSentinelAddr === 0) return;
    const runtime = this.runtime;
    const sentinel = this.sehSentinelAddr;
    const excAddr = this.sehExcAddr;
    const ctxAddr = this.sehCtxAddr;

    // temporary diagnostic (enabled by diag-trap via __bk_seh_debug)
    const dbg = (...parts: unknown[]): void => {
      if ((globalThis as { __bk_seh_debug?: boolean }).__bk_seh_debug) console.error('[seh]', ...parts);
    };

    // Bounds-checked 32-bit guest read. Unlike runtime.readInt32 this never
    // grows the linear memory, so a corrupt chain can't balloon the heap.
    const peek = (a: number): number => {
      if (a < 0 || a + 4 > runtime.memory.buffer.byteLength) return 0;
      return new DataView(runtime.memory.buffer).getInt32(a, true) >>> 0;
    };

    const snapshot = (): { regs: Array<[RegName, number]>; eflags: number; eip: number } => ({
      regs: (['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi'] as const).map((r) => [r, runtime.getReg64(r)]),
      eflags: runtime.getEflags(),
      eip: runtime.getEip(),
    });
    const restore = (s: { regs: Array<[RegName, number]>; eflags: number; eip: number }): void => {
      for (const [r, v] of s.regs) runtime.setReg64(r, v);
      runtime.setEflags(s.eflags);
      runtime.setEip(s.eip);
    };

    // EXCEPTION_RECORD (x86, 80 bytes) at `excAddr`.
    const buildExcRecord = (code: number, flags: number, nargs: number, argPtr: number, address: number): void => {
      const w = new Uint8Array(0x80);
      const view = new DataView(w.buffer);
      view.setUint32(0x00, code, true); // ExceptionCode
      view.setUint32(0x04, flags, true); // ExceptionFlags
      view.setUint32(0x08, 0, true); // nested record
      view.setUint32(0x0c, address, true); // ExceptionAddress
      view.setUint32(0x10, nargs, true); // NumberParameters
      for (let i = 0; i < 15; i++) view.setUint32(0x14 + i * 4, i < nargs ? peek(argPtr + i * 4) : 0, true);
      runtime.writeBytes(excAddr, w);
    };

    // x86 CONTEXT (CONTEXT_FULL, 0x2CC bytes) at `ctxAddr`, from live regs.
    const buildContext = (eip: number, esp: number, eflags: number): void => {
      const w = new Uint8Array(X86_CONTEXT_SIZE);
      const view = new DataView(w.buffer);
      view.setUint32(0x00, 0x10007, true); // ContextFlags
      view.setUint32(0x9c, runtime.getReg('edi') >>> 0, true);
      view.setUint32(0xa0, runtime.getReg('esi') >>> 0, true);
      view.setUint32(0xa4, runtime.getReg('ebx') >>> 0, true);
      view.setUint32(0xa8, runtime.getReg('edx') >>> 0, true);
      view.setUint32(0xac, runtime.getReg('ecx') >>> 0, true);
      view.setUint32(0xb0, runtime.getReg('eax') >>> 0, true);
      view.setUint32(0xb4, runtime.getReg('ebp') >>> 0, true);
      view.setUint32(0xb8, eip, true);
      view.setUint32(0xc0, eflags, true);
      view.setUint32(0xc4, esp, true);
      runtime.writeBytes(ctxAddr, w);
    };

    // Copies a guest-built EXCEPTION_RECORD (or zeros when the pointer is
    // null) into `excAddr` so cleanup handlers observe the real record.
    const copyExcRecord = (ptr: number): void => {
      const w = new Uint8Array(0x80);
      const view = new DataView(w.buffer);
      for (let i = 0; i < 0x80; i += 4) view.setUint32(i, peek(ptr + i), true);
      runtime.writeBytes(excAddr, w);
    };

    /**
     * Runs guest `handler` with a fresh 4-arg dispatch frame just below the
     * current ESP: [frame]=sentinel return address, then ExceptionRecord /
     * EstablisherFrame / ContextRecord / DispatcherContext. Returns the
     * disposition the handler left in EAX when it returned to the sentinel
     * (-1 if it faulted or never returned). Guest state is snapshotted first
     * and restored afterwards.
     */
    const callHandler = async (
      handler: number,
      record: number,
      flags: number,
      excCode: number,
      nargs: number,
      argPtr: number,
      address: number,
      prebuilt = false,
    ): Promise<number> => {
      const saved = snapshot();
      const frame = (runtime.getReg('esp') - 20) >>> 0;
      if (!prebuilt) buildExcRecord(excCode, flags, nargs, argPtr, address);
      runtime.writeInt32(frame + 0, sentinel);
      runtime.writeInt32(frame + 4, excAddr);
      runtime.writeInt32(frame + 8, record);
      runtime.writeInt32(frame + 12, ctxAddr);
      runtime.writeInt32(frame + 16, 0); // DispatcherContext
      runtime.setReg('esp', frame);
      runtime.setEip(handler);
      let disposition = -1;
      const nested = new Executor(
        runtime,
        jit,
        {
          handle: async (vector) => {
            if (vector === SEH_SENTINEL_VECTOR) {
              disposition = runtime.getReg('eax') >>> 0;
              runtime.setEip(0);
              return;
            }
            await dispatcher.handle(vector);
            if (this.sehTransfer) {
              // The handler accepted via RtlUnwind and control moved to the
              // unwind target — stop the nested run; callHandler propagates
              // the transfer to the outer dispatch instead of restoring.
              runtime.setEip(0);
              return;
            }
            const last = dispatcher.lastCalled;
            if (last && last.proc.toLowerCase() === 'exitprocess') {
              this.exitCode = runtime.getReg('eax') & 0xffffffff;
              this.exitRequested = true;
              runtime.setEip(0);
            }
          },
        },
        { maxSteps: 500_000 },
      );
      await nested.run(handler);
      const transfer = this.sehTransfer;
      this.sehTransfer = null;
      if (transfer) {
        // Apply the unwind target (RtlUnwind already unwound intermediate
        // frames) and signal the caller not to restore the guest state.
        runtime.setEip(transfer.eip);
        runtime.setReg('esp', transfer.esp);
        return EXCEPTION_TRANSFERRED;
      }
      restore(saved);
      return disposition;
    };

    this.interceptor.hook('kernel32.dll', 'RaiseException', async (ctx) => {
      const excCode = (ctx.rawArgs[0] ?? 0) >>> 0;
      const excFlags = (ctx.rawArgs[1] ?? 0) >>> 0;
      const nargs = (ctx.rawArgs[2] ?? 0) >>> 0;
      const argPtr = (ctx.rawArgs[3] ?? 0) >>> 0;
      const curEip = runtime.getEip() >>> 0;
      const address = (curEip - 2) >>> 0; // the int 0x2e inside the trap stub
      const eflags = runtime.getEflags();
      const esp = runtime.getReg('esp') >>> 0;

      dbg(`RaiseException code=0x${excCode.toString(16)} flags=${excFlags} nargs=${nargs} argPtr=0x${argPtr.toString(16)} esp=0x${esp.toString(16)} head=0x${peek(0).toString(16)}`);
      if ((globalThis as { __bk_seh_debug?: boolean }).__bk_seh_debug) {
        const dump32 = (base: number, n: number): string => {
          const out: string[] = [];
          for (let i = 0; i < n; i++) out.push(`0x${peek(base + i * 4).toString(16)}`);
          return out.join(' ');
        };
        dbg(`  params@0x${argPtr.toString(16)}: ${dump32(argPtr, Math.min(nargs, 8))}`);
        dbg(`  stack@0x${(esp - 16).toString(16)}: ${dump32(esp - 16, 20)}`);
      }

      if (this.sehDepth > 8) return { returnValue: 0, errorCode: E.NO_ERROR };
      this.sehDepth += 1;
      try {
        // --- phase 1: search the chain for a handler ---
        let record = peek(0); // fs:[0] -> guest address 0
        let accepting = 0;
        for (let guard = 0; guard < 64 && record !== 0 && record !== 0xffffffff; guard++) {
          const handler = peek(record + 4);
          if (!handler) break;
          dbg(`search record=0x${record.toString(16)} handler=0x${handler.toString(16)} next=0x${peek(record).toString(16)}`);
          buildContext(curEip, esp, eflags);
          const disp = await callHandler(handler, record, excFlags & 1, excCode, nargs, argPtr, address);
          dbg(`  -> disposition=${disp}`);
          if (this.exitRequested) {
            // a handler called ExitProcess — terminate the whole run
            runtime.setEip(0);
            return { returnValue: 0, errorCode: E.NO_ERROR };
          }
          if (disp === EXCEPTION_TRANSFERRED) {
            // a handler accepted via RtlUnwind and control already moved to
            // the unwind target — the main executor continues there.
            dbg('  -> transferred via RtlUnwind');
            return { returnValue: 0, errorCode: E.NO_ERROR };
          }
          if (disp === EXCEPTION_EXECUTE_HANDLER) {
            accepting = record;
            break;
          }
          if (disp === EXCEPTION_CONTINUE_EXECUTION) {
            // Resume after the raise (the trap already advanced EIP past the
            // int, so the stub's `ret` returns into the RaiseException caller).
            return { returnValue: 0, errorCode: E.NO_ERROR };
          }
          record = peek(record);
        }
        if (accepting === 0) {
          // Unhandled — keep the legacy behaviour (return 0 to the caller).
          dbg('unhandled (no accepting handler)');
          return { returnValue: 0, errorCode: E.NO_ERROR };
        }
        dbg(`accepting record=0x${accepting.toString(16)}`);

        // --- phase 2a: unwind the frames between the head and the accepting
        //     frame, letting their cleanup (finally) handlers run ---
        let u = peek(0);
        for (let guard = 0; guard < 64 && u !== 0 && u !== 0xffffffff && u !== accepting; guard++) {
          const uh = peek(u + 4);
          dbg(`unwind record=0x${u.toString(16)} handler=0x${uh.toString(16)}`);
          if (uh) {
            await callHandler(uh, u, EXCEPTION_UNWINDING, excCode, nargs, argPtr, address);
            if (this.exitRequested) {
              runtime.setEip(0);
              return { returnValue: 0, errorCode: E.NO_ERROR };
            }
          }
          u = peek(u);
        }

        // --- phase 2b: transfer into the accepting handler's except block.
        //     NO register restore: the except block continues the guest
        //     program from here and the frame epilogue `ret`s to its caller.
        const ah = peek(accepting + 4);
        const frame = (accepting - 20) >>> 0;
        dbg(`transfer accepting=0x${accepting.toString(16)} handler=0x${ah.toString(16)} frame=0x${frame.toString(16)}`);
        buildExcRecord(excCode, EXCEPTION_UNWINDING, nargs, argPtr, address);
        runtime.writeInt32(frame + 0, sentinel);
        runtime.writeInt32(frame + 4, excAddr);
        runtime.writeInt32(frame + 8, accepting);
        runtime.writeInt32(frame + 12, ctxAddr);
        runtime.writeInt32(frame + 16, 0);
        runtime.setReg('esp', frame);
        runtime.setEip(ah);
        this.sehPending = accepting;
        return { returnValue: 0, errorCode: E.NO_ERROR };
      } finally {
        this.sehDepth -= 1;
      }
    });

    // ------------------------------------------------------------------
    // RtlUnwind(EstablisherFrame, TargetIp, ExceptionRecord, ReturnValue).
    // Unwinds the SEH chain from the current frame down to (but excluding)
    // EstablisherFrame — running each intermediate handler with
    // cUnwinding|cUnwindingForExit so finally-cleanup code executes — then
    // transfers control to TargetIp with ESP = EstablisherFrame and
    // EAX = ReturnValue. RtlUnwind NEVER returns to its caller; the transfer
    // is applied directly to the guest state. Guest handlers that accept an
    // exception call RtlUnwind(their own record, ...) — this is the path the
    // Inno/Delphi RTL uses instead of returning EXCEPTION_EXECUTE_HANDLER.
    // Registered under both ntdll and kernel32 (kernel32 forwards it).
    // ------------------------------------------------------------------
    const rtlUnwindHandler: ApiHandler = async (ctx) => {
      const targetFrame = (ctx.rawArgs[0] ?? 0) >>> 0;
      const targetIp = (ctx.rawArgs[1] ?? 0) >>> 0;
      const excRecPtr = (ctx.rawArgs[2] ?? 0) >>> 0;
      const returnValue = (ctx.rawArgs[3] ?? 0) >>> 0;
      dbg(`RtlUnwind frame=0x${targetFrame.toString(16)} target=0x${targetIp.toString(16)} exc=0x${excRecPtr.toString(16)} ret=0x${returnValue.toString(16)}`);
      if ((globalThis as { __bk_seh_debug?: boolean }).__bk_seh_debug) {
        const dump32 = (base: number, n: number): string => {
          const out: string[] = [];
          for (let i = 0; i < n; i++) out.push(`0x${peek(base + i * 4).toString(16)}`);
          return out.join(' ');
        };
        dbg(`  excRec@0x${excRecPtr.toString(16)}: ${dump32(excRecPtr, 8)}`);
        dbg(`  stack@0x${(targetFrame - 0x10).toString(16)}: ${dump32(targetFrame - 0x10, 24)}`);
      }

      if (this.sehDepth > 12) return { returnValue: 0, errorCode: E.NO_ERROR };

      let u = peek(0);
      for (let guard = 0; guard < 64 && u !== 0 && u !== 0xffffffff && u !== targetFrame; guard++) {
        const uh = peek(u + 4);
        dbg(`  unwind record=0x${u.toString(16)} handler=0x${uh.toString(16)}`);
        if (uh) {
          copyExcRecord(excRecPtr);
          const disp = await callHandler(uh, u, EXCEPTION_UNWINDING | EXCEPTION_UNWINDING_FOR_EXIT, 0, 0, 0, 0, true);
          void disp;
          if (this.exitRequested) {
            runtime.setEip(0);
            return { returnValue: 0, errorCode: E.NO_ERROR };
          }
          if (this.sehTransfer) {
            // a nested unwind handler transferred again — propagate as-is
            return { returnValue: 0, errorCode: E.NO_ERROR };
          }
        }
        u = peek(u);
      }

      // Transfer: never returns; EAX = ReturnValue is set by the dispatcher
      // from the returned ApiResult.
      //
      // ESP: the guest handler pushed 8 dwords (at frame = record-0x14) before
      // calling RtlUnwind, and its continuation (TargetIp = the instruction
      // after the call) reads the ESTABLISHER FRAME back from [esp+0x28].
      // The only stack slot holding the record address itself is the inner
      // record's Next field — which sits exactly 0x28 bytes above the
      // post-push ESP (record-0x34). So the transfer ESP must be
      // EstablisherFrame - 0x34; then [esp+0x28] = [inner.Next] = the
      // accepting record, matching the second-phase handler at 0x4090fc that
      // reads Frame+4 / Frame+8 as jump target / saved EBP.
      dbg(`  transfer to 0x${targetIp.toString(16)} esp=0x${targetFrame.toString(16)}`);
      const transferEsp = (targetFrame - 0x34) >>> 0;
      this.sehTransfer = { eip: targetIp, esp: transferEsp };
      runtime.setEip(targetIp);
      runtime.setReg('esp', transferEsp);
      return { returnValue, errorCode: E.NO_ERROR };
    };
    this.interceptor.hook('ntdll.dll', 'RtlUnwind', rtlUnwindHandler);
    this.interceptor.hook('kernel32.dll', 'RtlUnwind', rtlUnwindHandler);

    // ------------------------------------------------------------------
    // _initterm / _initterm_e: the CRT calls these to run the table of
    // static initializers (which includes __security_init_cookie and the C
    // runtime constructors). Not implementing them means __security_cookie
    // is never seeded and every __security_check_cookie fails fast. Each
    // entry is a guest function called with no arguments, driven through the
    // same nested-executor machinery as the SEH handler calls.
    // ------------------------------------------------------------------
    const runInitFn = async (fn: number): Promise<boolean> => {
      const saved = snapshot();
      const esp = runtime.getReg('esp') >>> 0;
      const frame = (esp - 4) >>> 0;
      runtime.writeInt32(frame, sentinel); // return address
      runtime.setReg('esp', frame);
      runtime.setEip(fn);
      const nested = new Executor(
        runtime,
        jit,
        {
          handle: async (vector) => {
            if (vector === SEH_SENTINEL_VECTOR) {
              runtime.setEip(0);
              return;
            }
            await dispatcher.handle(vector);
            const last = dispatcher.lastCalled;
            if (last && last.proc.toLowerCase() === 'exitprocess') {
              this.exitCode = runtime.getReg('eax') & 0xffffffff;
              this.exitRequested = true;
              runtime.setEip(0);
            }
          },
        },
        { maxSteps: 500_000 },
      );
      await nested.run(fn);
      const ok = !this.exitRequested;
      restore(saved);
      return ok;
    };
    const inittermHandler: ApiHandler = async (ctx) => {
      const first = (ctx.rawArgs[0] ?? 0) >>> 0;
      const last = (ctx.rawArgs[1] ?? 0) >>> 0;
      for (let p = first; p < last && p + 4 <= runtime.memory.buffer.byteLength; p += 4) {
        const fn = peek(p);
        if (!fn) continue;
        if (!(await runInitFn(fn))) break;
      }
      return { returnValue: 0, errorCode: E.NO_ERROR };
    };
    this.interceptor.hook('ucrtbase.dll', '_initterm', inittermHandler);
    this.interceptor.hook('ucrtbase.dll', '_initterm_e', inittermHandler);
  }

  /**
   * Sentinel (vector 0x2d) reached from the MAIN executor: a phase-2
   * accepting handler returned instead of transferring to its except block.
   * Mimic the frame epilogue — continue at the frame's saved return address
   * (record + 12) with ESP just past it. With no pending record this ends the
   * run (the nested handler stopped but its disposition was lost).
   */
  private handleSehSentinel(rt: WasmRuntimeImpl): void {
    const rec = this.sehPending;
    this.sehPending = 0;
    if (rec) {
      rt.setReg('esp', rec + 16);
      rt.setEip(rt.readInt32(rec + 12) >>> 0);
    } else {
      rt.setEip(0);
    }
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
   * sane zero defaults. x64 mode keeps the minimal fake-handle behaviour (the
   * sentinel-stop infrastructure is only wired up for x86 so far).
   */
  private installGuiBridge(dispatcher: ApiTrapDispatcher, jit: JitEngine, mode: 'x86' | 'x64'): void {
    const runtime = this.runtime;
    const sentinel = this.sehSentinelAddr;
    // Bounds-checked 32-bit guest read (never grows the linear memory).
    const peek = (a: number): number => {
      if (a < 0 || a + 4 > runtime.memory.buffer.byteLength) return 0;
      return new DataView(runtime.memory.buffer).getInt32(a, true) >>> 0;
    };
    const snapshot = (): { regs: Array<[RegName, number]>; eflags: number; eip: number } => ({
      regs: (['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi'] as const).map((r) => [r, runtime.getReg64(r)]),
      eflags: runtime.getEflags(),
      eip: runtime.getEip(),
    });
    const restore = (s: { regs: Array<[RegName, number]>; eflags: number; eip: number }): void => {
      for (const [r, v] of s.regs) runtime.setReg64(r, v);
      runtime.setEflags(s.eflags);
      runtime.setEip(s.eip);
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
    let hwndSeq = 0x10000;
    const registerClass = (ctx: ApiCallContext): ApiResult => {
      const atom = ++classAtom;
      const lpWndClass = ctx.rawArgs[0] ?? 0;
      if (lpWndClass) {
        this.classWndProcs.set(atom, peek(lpWndClass + 8)); // WNDCLASSEXW.lpfnWndProc
        const name = readWStr(peek(lpWndClass + 40)); // lpszClassName
        if (name) classNames.set(name.toLowerCase(), atom);
        // WNDCLASSEXW.lpszMenuName (+36): numeric MAKEINTRESOURCE -> RT_MENU.
        // notepad attaches its menu to the class, so parse it here (Layer 3).
        const menuName = peek(lpWndClass + 36);
        if ((menuName >>> 16) === 0) {
          const entry = this.menuResourceTable.get(menuName & 0xffff);
          if (entry) this.classMenus.set(atom, this.parseMenuResource(entry.address, entry.size));
        }
      }
      return { returnValue: atom, errorCode: E.NO_ERROR };
    };
    this.interceptor.hook('user32.dll', 'RegisterClassExW', registerClass);
    this.interceptor.hook('user32.dll', 'RegisterClassExA', registerClass);

    const createWindow = (ctx: ApiCallContext): ApiResult => {
      const hwnd = ++hwndSeq;
      const classNameArg = ctx.rawArgs[1] ?? 0;
      let wndProc = 0;
      let className = '';
      let atom = 0;
      if ((classNameArg >>> 16) === 0) {
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
        this.menuByHandle.get(ctx.rawArgs[9] ?? 0) ?? (atom ? (this.classMenus.get(atom) ?? []) : []);
      this.windowRecords.set(hwnd, {
        wndProc,
        parent: ctx.rawArgs[8] ?? 0,
        className,
        text: '',
        menu,
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
    this.interceptor.hook('user32.dll', 'CreateWindowExW', createWindow);
    this.interceptor.hook('user32.dll', 'CreateWindowExA', createWindow);

    // The window is "shown and painted" instantly.
    this.interceptor.hook('user32.dll', 'ShowWindow', () => this.ok1());
    this.interceptor.hook('user32.dll', 'UpdateWindow', () => this.ok1());

    // Message loop: pop the synthetic queue. A non-empty queue yields one
    // message (return 1, MSG written to lpMsg); an empty queue is WM_QUIT
    // (return 0) in the CLI baseline. In interactive mode the call BLOCKS
    // (awaits) until the host pushes a message via postMessage/postText —
    // this keeps the guest process alive for real input.
    const writeMsg = (ctx: ApiCallContext, m: { hwnd: number; msg: number; wParam: number; lParam: number }): ApiResult => {
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
      if (m) return writeMsg(ctx, m);
      if (this.quitRequested || !this.interactive) return { returnValue: 0, errorCode: E.NO_ERROR };
      // Interactive: block until the host posts a message.
      this.onMessageWait?.();
      await new Promise<void>((resolve) => {
        this.pendingMessageResolve = resolve;
      });
      const m2 = this.guiMessageQueue.shift();
      if (!m2) return { returnValue: 0, errorCode: E.NO_ERROR };
      return writeMsg(ctx, m2);
    };
    this.interceptor.hook('user32.dll', 'GetMessageW', getMessage);
    this.interceptor.hook('user32.dll', 'GetMessageA', getMessage);

    // Message-loop slots only reached when GetMessageW returns a message.
    this.interceptor.hook('user32.dll', 'TranslateAcceleratorW', () => ({ returnValue: 0, errorCode: E.NO_ERROR }));
    this.interceptor.hook('user32.dll', 'IsDialogMessageW', () => ({ returnValue: 0, errorCode: E.NO_ERROR }));
    this.interceptor.hook('user32.dll', 'TranslateMessage', () => ({ returnValue: 0, errorCode: E.NO_ERROR }));
    this.interceptor.hook('user32.dll', 'DefWindowProcW', () => ({ returnValue: 0, errorCode: E.NO_ERROR }));
    this.interceptor.hook('user32.dll', 'PostQuitMessage', () => {
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
          case 0x000c: { // WM_SETTEXT
            rec.text = readWStr(lParam);
            return { returnValue: 1, errorCode: E.NO_ERROR };
          }
          case 0x000d: { // WM_GETTEXT: copy rec.text (max-1 chars + NUL)
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
          default:
            return { returnValue: 0, errorCode: E.NO_ERROR };
        }
      }
      return { returnValue: 0, errorCode: E.NO_ERROR };
    };
    this.interceptor.hook('user32.dll', 'SendMessageW', sendMessage);
    this.interceptor.hook('user32.dll', 'SendMessageA', sendMessage);
    this.interceptor.hook('user32.dll', 'PostMessageW', () => this.ok1());
    this.interceptor.hook('user32.dll', 'PostMessageA', () => this.ok1());
    this.interceptor.hook('user32.dll', 'GetWindowLongW', () => ({ returnValue: 0, errorCode: E.NO_ERROR }));
    this.interceptor.hook('user32.dll', 'SetWindowLongW', () => ({ returnValue: 0, errorCode: E.NO_ERROR }));
    this.interceptor.hook('user32.dll', 'DestroyWindow', () => this.ok1());
    // CreateStatusWindowW (comctl32): notepad's status bar — mint a unique
    // fake HWND from the same sequence as CreateWindowExW.
    this.interceptor.hook('comctl32.dll', 'CreateStatusWindowW', () => ({ returnValue: ++hwndSeq, errorCode: E.NO_ERROR }));
    this.interceptor.hook('comctl32.dll', 'CreateStatusWindowA', () => ({ returnValue: ++hwndSeq, errorCode: E.NO_ERROR }));
    // GetClientRect: report a sane client area so guest layout math (edit
    // control placement, margins) works instead of collapsing to zero.
    this.interceptor.hook('user32.dll', 'GetClientRect', (ctx) => {
      const lprc = ctx.rawArgs[1] ?? 0;
      if (lprc) {
        runtime.writeInt32(lprc + 0, 0);
        runtime.writeInt32(lprc + 4, 0);
        runtime.writeInt32(lprc + 8, 800);
        runtime.writeInt32(lprc + 12, 560);
      }
      return { returnValue: 1, errorCode: E.NO_ERROR };
    });
    this.interceptor.hook('user32.dll', 'GetWindowRect', (ctx) => {
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
    // ------------------------------------------------------------------
    const nextGdiObj = (): number => ++this.gdiObjSeq;
    const recordPaint = (cmd: PaintCommand): ApiResult => {
      this.paintCommands.push(cmd);
      return { returnValue: 1, errorCode: E.NO_ERROR };
    };
    this.interceptor.hook('gdi32.dll', 'GetStockObject', () => ({ returnValue: nextGdiObj(), errorCode: E.NO_ERROR }));
    this.interceptor.hook('gdi32.dll', 'SelectObject', () => ({ returnValue: 0, errorCode: E.NO_ERROR }));
    this.interceptor.hook('gdi32.dll', 'DeleteObject', () => this.ok1());
    this.interceptor.hook('gdi32.dll', 'CreateSolidBrush', () => ({ returnValue: nextGdiObj(), errorCode: E.NO_ERROR }));
    this.interceptor.hook('gdi32.dll', 'CreateHatchBrush', () => ({ returnValue: nextGdiObj(), errorCode: E.NO_ERROR }));
    this.interceptor.hook('gdi32.dll', 'CreatePen', () => ({ returnValue: nextGdiObj(), errorCode: E.NO_ERROR }));
    this.interceptor.hook('gdi32.dll', 'CreateFontIndirectW', (ctx) => {
      const lpLogFont = ctx.rawArgs[0] ?? 0;
      if (lpLogFont) readWStr(lpLogFont + 28); // LOGFONTW.lfFaceName — validate
      return { returnValue: nextGdiObj(), errorCode: E.NO_ERROR };
    });
    this.interceptor.hook('gdi32.dll', 'CreateFontIndirectA', () => ({ returnValue: nextGdiObj(), errorCode: E.NO_ERROR }));
    // DC acquisition: mint pseudo HDCs. BeginPaint also fills PAINTSTRUCT.hdc.
    this.interceptor.hook('user32.dll', 'GetDC', () => ({ returnValue: nextGdiObj(), errorCode: E.NO_ERROR }));
    this.interceptor.hook('user32.dll', 'GetWindowDC', () => ({ returnValue: nextGdiObj(), errorCode: E.NO_ERROR }));
    this.interceptor.hook('user32.dll', 'ReleaseDC', () => this.ok1());
    this.interceptor.hook('user32.dll', 'BeginPaint', (ctx) => {
      const lpPaint = ctx.rawArgs[1] ?? 0;
      if (lpPaint) {
        runtime.writeInt32(lpPaint + 0, this.gdiObjSeq + 1); // hdc
        runtime.writeInt32(lpPaint + 4, 0); // fErase
      }
      return { returnValue: ++this.gdiObjSeq, errorCode: E.NO_ERROR };
    });
    this.interceptor.hook('user32.dll', 'EndPaint', () => this.ok1());
    // Drawing primitives: capture and report success.
    this.interceptor.hook('gdi32.dll', 'TextOutW', (ctx) => {
      const hdc = ctx.rawArgs[0] ?? 0;
      const x = ctx.rawArgs[1] ?? 0;
      const y = ctx.rawArgs[2] ?? 0;
      const lpString = ctx.rawArgs[3] ?? 0;
      const cch = ctx.rawArgs[4] ?? 0;
      const w = runtime.readBytes(lpString, Math.min(cch * 2, 4096));
      const view = new DataView(w.buffer, w.byteOffset, w.byteLength);
      let text = '';
      for (let i = 0; i + 1 < w.byteLength && i / 2 < cch; i += 2) {
        const c = view.getUint16(i, true);
        if (c === 0) break;
        text += String.fromCharCode(c);
      }
      return recordPaint({ op: 'text', hdc, x, y, text });
    });
    this.interceptor.hook('gdi32.dll', 'ExtTextOutW', (ctx) => {
      const hdc = ctx.rawArgs[0] ?? 0;
      const x = ctx.rawArgs[1] ?? 0;
      const y = ctx.rawArgs[2] ?? 0;
      const lpString = ctx.rawArgs[4] ?? 0;
      const cch = ctx.rawArgs[5] ?? 0;
      const w = runtime.readBytes(lpString, Math.min(cch * 2, 4096));
      const view = new DataView(w.buffer, w.byteOffset, w.byteLength);
      let text = '';
      for (let i = 0; i + 1 < w.byteLength && i / 2 < cch; i += 2) {
        const c = view.getUint16(i, true);
        if (c === 0) break;
        text += String.fromCharCode(c);
      }
      return recordPaint({ op: 'text', hdc, x, y, text });
    });
    this.interceptor.hook('gdi32.dll', 'SetTextColor', (ctx) => ({ returnValue: ctx.rawArgs[1] ?? 0, errorCode: E.NO_ERROR }));
    this.interceptor.hook('gdi32.dll', 'SetBkColor', (ctx) => ({ returnValue: ctx.rawArgs[1] ?? 0, errorCode: E.NO_ERROR }));
    this.interceptor.hook('gdi32.dll', 'SetBkMode', (ctx) => ({ returnValue: ctx.rawArgs[1] ?? 0, errorCode: E.NO_ERROR }));
    this.interceptor.hook('gdi32.dll', 'GetBkColor', () => ({ returnValue: 0x00ffffff, errorCode: E.NO_ERROR }));
    this.interceptor.hook('gdi32.dll', 'GetTextColor', () => ({ returnValue: 0, errorCode: E.NO_ERROR }));
    this.interceptor.hook('gdi32.dll', 'GetTextAlign', () => ({ returnValue: 0, errorCode: E.NO_ERROR }));
    this.interceptor.hook('gdi32.dll', 'SetTextAlign', (ctx) => ({ returnValue: ctx.rawArgs[1] ?? 0, errorCode: E.NO_ERROR }));
    this.interceptor.hook('gdi32.dll', 'SetMapMode', (ctx) => ({ returnValue: ctx.rawArgs[1] ?? 0, errorCode: E.NO_ERROR }));
    this.interceptor.hook('gdi32.dll', 'GetMapMode', () => ({ returnValue: 1, errorCode: E.NO_ERROR }));
    this.interceptor.hook('gdi32.dll', 'SetViewportOrgEx', () => this.ok1());
    this.interceptor.hook('gdi32.dll', 'SetWindowOrgEx', () => this.ok1());
    this.interceptor.hook('gdi32.dll', 'GetTextMetrics', (ctx) => {
      const lptm = ctx.rawArgs[1] ?? 0;
      if (lptm) {
        runtime.writeInt32(lptm + 0, 16); // tmHeight
        runtime.writeInt32(lptm + 4, 12); // tmAscent
        runtime.writeInt32(lptm + 8, 4); // tmDescent
      }
      return { returnValue: 1, errorCode: E.NO_ERROR };
    });
    this.interceptor.hook('gdi32.dll', 'GetTextFaceW', (ctx) => {
      const buf = ctx.rawArgs[1] ?? 0;
      if (buf) {
        runtime.writeBytes(buf, new Uint8Array([0x43, 0, 0x6f, 0, 0x6e, 0, 0x73, 0, 0x6f, 0, 0x6c, 0, 0x61, 0, 0x73, 0, 0, 0])); // "Consolas"
      }
      return { returnValue: 8, errorCode: E.NO_ERROR };
    });
    this.interceptor.hook('gdi32.dll', 'GetDeviceCaps', () => ({ returnValue: 96, errorCode: E.NO_ERROR }));
    this.interceptor.hook('gdi32.dll', 'MoveToEx', (ctx) => {
      const lppt = ctx.rawArgs[3] ?? 0;
      if (lppt) {
        runtime.writeInt32(lppt + 0, ctx.rawArgs[1] ?? 0);
        runtime.writeInt32(lppt + 4, ctx.rawArgs[2] ?? 0);
      }
      return { returnValue: 1, errorCode: E.NO_ERROR };
    });
    this.interceptor.hook('gdi32.dll', 'LineTo', (ctx) =>
      recordPaint({ op: 'line', hdc: ctx.rawArgs[0] ?? 0, x: ctx.rawArgs[1] ?? 0, y: ctx.rawArgs[2] ?? 0 }),
    );
    this.interceptor.hook('gdi32.dll', 'FillRect', (ctx) => {
      const lprc = ctx.rawArgs[1] ?? 0;
      const rc = lprc
        ? {
            x: runtime.readInt32(lprc + 0),
            y: runtime.readInt32(lprc + 4),
            w: runtime.readInt32(lprc + 8) - runtime.readInt32(lprc + 0),
            h: runtime.readInt32(lprc + 12) - runtime.readInt32(lprc + 4),
          }
        : { x: 0, y: 0, w: 0, h: 0 };
      return recordPaint({ op: 'fillrect', hdc: ctx.rawArgs[0] ?? 0, x: rc.x, y: rc.y, w: rc.w, h: rc.h });
    });
    this.interceptor.hook('gdi32.dll', 'FrameRect', (ctx) => {
      const lprc = ctx.rawArgs[1] ?? 0;
      const rc = lprc
        ? {
            x: runtime.readInt32(lprc + 0),
            y: runtime.readInt32(lprc + 4),
            w: runtime.readInt32(lprc + 8) - runtime.readInt32(lprc + 0),
            h: runtime.readInt32(lprc + 12) - runtime.readInt32(lprc + 4),
          }
        : { x: 0, y: 0, w: 0, h: 0 };
      return recordPaint({ op: 'rect', hdc: ctx.rawArgs[0] ?? 0, x: rc.x, y: rc.y, w: rc.w, h: rc.h });
    });
    this.interceptor.hook('gdi32.dll', 'Rectangle', (ctx) =>
      recordPaint({
        op: 'rect',
        hdc: ctx.rawArgs[0] ?? 0,
        x: Math.min(ctx.rawArgs[1] ?? 0, ctx.rawArgs[3] ?? 0),
        y: Math.min(ctx.rawArgs[2] ?? 0, ctx.rawArgs[4] ?? 0),
        w: Math.abs((ctx.rawArgs[3] ?? 0) - (ctx.rawArgs[1] ?? 0)),
        h: Math.abs((ctx.rawArgs[4] ?? 0) - (ctx.rawArgs[2] ?? 0)),
      }),
    );
    this.interceptor.hook('gdi32.dll', 'BitBlt', () => this.ok1());
    this.interceptor.hook('gdi32.dll', 'StretchBlt', () => this.ok1());
    this.interceptor.hook('gdi32.dll', 'PatBlt', () => this.ok1());
    this.interceptor.hook('gdi32.dll', 'CreateCompatibleDC', () => ({ returnValue: nextGdiObj(), errorCode: E.NO_ERROR }));
    this.interceptor.hook('gdi32.dll', 'CreateCompatibleBitmap', () => ({ returnValue: nextGdiObj(), errorCode: E.NO_ERROR }));
    this.interceptor.hook('gdi32.dll', 'SelectPalette', () => ({ returnValue: 0, errorCode: E.NO_ERROR }));
    this.interceptor.hook('gdi32.dll', 'RealizePalette', () => ({ returnValue: 0, errorCode: E.NO_ERROR }));
    this.interceptor.hook('gdi32.dll', 'SaveDC', () => ({ returnValue: 1, errorCode: E.NO_ERROR }));
    this.interceptor.hook('gdi32.dll', 'RestoreDC', () => this.ok1());

    // DispatchMessageW: run the guest WndProc with (hwnd, msg, wParam,
    // lParam) on the stack (stdcall) and a sentinel return address; the
    // nested Executor stops when WndProc's `ret 16` pops it.
    const dispatchMessage = async (ctx: ApiCallContext): Promise<ApiResult> => {
      const lpMsg = ctx.rawArgs[0] ?? 0;
      if (!lpMsg) return { returnValue: 0, errorCode: E.NO_ERROR };
      const hwnd = peek(lpMsg);
      const wndProc = this.windowRecords.get(hwnd)?.wndProc ?? 0;
      if (!wndProc || mode === 'x64' || sentinel === 0) {
        return { returnValue: 0, errorCode: E.NO_ERROR };
      }
      const message = peek(lpMsg + 4);
      const wParam = peek(lpMsg + 8);
      const lParam = peek(lpMsg + 12);
      const saved = snapshot();
      const esp = runtime.getReg('esp') >>> 0;
      const frame = (esp - 20) >>> 0; // 4 stdcall args + sentinel return addr
      runtime.writeInt32(frame + 0, sentinel);
      runtime.writeInt32(frame + 4, hwnd);
      runtime.writeInt32(frame + 8, message);
      runtime.writeInt32(frame + 12, wParam);
      runtime.writeInt32(frame + 16, lParam);
      runtime.setReg('esp', frame);
      runtime.setEip(wndProc);
      const nested = new Executor(
        runtime,
        jit,
        {
          handle: async (vector) => {
            if (vector === SEH_SENTINEL_VECTOR) {
              runtime.setEip(0);
              return;
            }
            await dispatcher.handle(vector);
          },
        },
        { maxSteps: 500_000 },
      );
      await nested.run(wndProc);
      const result = runtime.getReg('eax') >>> 0;
      restore(saved);
      return { returnValue: result, errorCode: E.NO_ERROR };
    };
    this.interceptor.hook('user32.dll', 'DispatchMessageW', dispatchMessage);
    this.interceptor.hook('user32.dll', 'DispatchMessageA', dispatchMessage);
  }

  /** Small helper: BOOL TRUE with NO_ERROR. */
  private ok1(): ApiResult {
    return { returnValue: 1, errorCode: E.NO_ERROR };
  }

  /**
   * Parses an RT_MENU (type 4) resource into flat menu sections for the host
   * to render. notepad's layout: MENUHEADER {version, size} (4 bytes), then
   * records of WORD flags + string. MF_POPUP (0x10) items carry their title
   * right after the 4-byte header; plain items put it after the flags word.
   * There is no mtID field in this menu, and notepad's command ids are the
   * sequential 1..n classic layout — assign them in order.
   */
  private parseMenuResource(addr: number, size = 0): GuestMenuSection[] {
    if (!addr) return [];
    const mem = this.runtime.memory.buffer;
    const peekW16 = (a: number): number =>
      a + 2 <= mem.byteLength ? new DataView(mem).getUint16(a, true) : 0;
    const readW = (a: number): string => {
      if (!a) return '';
      const view = new DataView(mem);
      let s = '';
      for (let i = 0; a + i + 1 < mem.byteLength && i < 512; i += 2) {
        const c = view.getUint16(a + i, true);
        if (c === 0) break;
        s += String.fromCharCode(c);
      }
      return s;
    };
    const sections: GuestMenuSection[] = [];
    let cur: GuestMenuSection | null = null;
    let depth = 0;
    const limit = size > 0 ? addr + size : mem.byteLength;
    let off = (addr + 4 + 3) & ~3;
    for (let guard = 0; guard < 1024 && off + 2 <= limit; guard++) {
      const flags = peekW16(off);
      if (flags === 0) {
        off += 2; // alignment/padding between records
        continue;
      }
      if ((flags & 0x80) !== 0) {
        // MF_END: popup items are done. Nested popups (submenus) flatten into
        // the current top-level section; the section itself stays open until
        // the next top-level popup (notepad puts File>Exit after an MF_END).
        depth = Math.max(0, depth - 1);
        off += 2;
        continue;
      }
      if ((flags & 0x800) !== 0) {
        // MF_SEPARATOR: no title — just the flags word.
        off += 2;
        continue;
      }
      if ((flags & 0x10) !== 0) {
        // Popup: like plain items, the title immediately follows the flags
        // word (there is no popupOffset field — notepad's first title char
        // occupies that slot). Top-level popups open a section; nested ones
        // (submenus like Edit>Format) become items of the current section
        // (flattened, children appended after them).
        const title = readW(off + 2);
        if (depth === 0) {
          cur = { title, items: [] };
          sections.push(cur);
        } else if (cur) {
          cur.items.push({ id: flags & 0xffff, label: title });
        }
        depth += 1;
        off = (off + 2 + (title.length + 1) * 2 + 3) & ~3;
      } else {
        const label = readW(off + 2);
        if (cur && label) cur.items.push({ id: flags & 0xffff, label });
        off = (off + 2 + (label.length + 1) * 2 + 3) & ~3;
      }
    }
    return sections;
  }

  /**
   * Interactive API (see GuestProcessOptions.interactive): pushes a message
   * into the guest's queue and wakes a GetMessageW that is blocked waiting.
   */
  postMessage(msg: { hwnd: number; msg: number; wParam: number; lParam: number }): void {
    this.guiMessageQueue.push(msg);
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
    this.onTextChanged?.(hwnd, text);
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
    }));
  }

  /**
   * Routes WriteFile on the console pseudo-handles into the output buffers.
   * Non-console handles fall through to the fs bridge (same path as the
   * default handler).
   */
  private installConsoleWriteFile(): void {
    this.interceptor.hook('kernel32.dll', 'WriteFile', (ctx, host) => {
      const handle = ctx.rawArgs[0] ?? 0;
      const buffer = ctx.rawArgs[1] ?? 0;
      const bytes = host.memory.read(buffer, ctx.rawArgs[2] ?? 0);
      if (
        handle === STD_OUTPUT_HANDLE ||
        handle === STD_ERROR_HANDLE ||
        handle === STD_INPUT_HANDLE
      ) {
        if (handle !== STD_INPUT_HANDLE) this.capture(handle === STD_ERROR_HANDLE, bytes);
        return { returnValue: bytes.byteLength, errorCode: E.NO_ERROR };
      }
      return host.fs
        .writeFile(handle, bytes)
        .then((result) =>
          result.error === E.NO_ERROR
            ? { returnValue: result.bytesWritten, errorCode: E.NO_ERROR }
            : { returnValue: 0, errorCode: result.error },
        );
    });
  }

  private capture(stderr: boolean, bytes: Uint8Array): void {
    const sink = stderr ? this.stderr : this.stdout;
    for (const b of bytes) sink.push(b);
    this.onOutput?.(bytes, stderr);
  }
}
