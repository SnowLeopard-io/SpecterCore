import type { ApiCallContext, ApiHandler, ApiHost, ApiInterceptor, ApiResult } from '@bk/contracts';
import { CreationDisposition, DesiredAccess, WinError as E } from '@bk/contracts';

/** Windows pseudo-handles for the standard console streams (winbase.h). */
export const STD_INPUT_HANDLE = -10;
export const STD_OUTPUT_HANDLE = -11;
export const STD_ERROR_HANDLE = -12;

function ok(returnValue: number): ApiResult {
  return { returnValue, errorCode: E.NO_ERROR };
}

function fail(errorCode: number): ApiResult {
  return { returnValue: 0, errorCode };
}

/** Raw stack argument (stdcall: arg0 is pushed last, at [esp+4]). */
function raw(ctx: ApiCallContext, index: number): number {
  return ctx.rawArgs[index] ?? 0;
}

/** NUL-terminated string at `address` in the guest linear memory. */
function memCStr(host: ApiHost, address: number, maxLength = 4096): string {
  if (address === 0) return '';
  const bytes = host.memory.read(address, maxLength);
  let end = 0;
  while (end < bytes.byteLength && bytes[end] !== 0) end += 1;
  return new TextDecoder('latin1').decode(bytes.subarray(0, end));
}

function numArg(ctx: ApiCallContext, key: string, fallback = 0): number {
  const value = ctx.marshalled?.[key];
  return typeof value === 'number' ? value : fallback;
}

function strArg(ctx: ApiCallContext, key: string): string {
  const value = ctx.marshalled?.[key];
  return typeof value === 'string' ? value : '';
}

/** NUL-terminated UTF-16 string at `address` in the guest linear memory. */
function memWStr(host: ApiHost, address: number, maxChars = 2048): string {
  if (!address) return '';
  const bytes = host.memory.read(address, maxChars * 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let s = '';
  for (let i = 0; i + 1 < bytes.byteLength; i += 2) {
    const c = view.getUint16(i, true);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

/** Splits 'C:\\Windows\\*.txt' into { dir: 'C:\\Windows', pattern: '*.txt' }. */
function splitFindPattern(path: string): { dir: string; pattern: string } {
  const idx = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
  if (idx === -1) return { dir: '', pattern: path };
  return { dir: path.slice(0, idx), pattern: path.slice(idx + 1) };
}

/** Writes a WIN32_FIND_DATAW record (592 bytes) from a bridge FindData. */
function writeFindData(host: ApiHost, address: number, data: { attributes: number; size: number; name: string }): void {
  if (!address) return;
  const w = new Uint8Array(592);
  const view = new DataView(w.buffer);
  view.setUint32(0, data.attributes ?? 0, true); // dwFileAttributes
  view.setUint32(32, data.size >>> 0, true); // nFileSizeLow
  const name = data.name ?? '';
  for (let i = 0; i < name.length && i < 259; i++) {
    view.setUint16(44 + i * 2, name.charCodeAt(i), true); // cFileName
  }
  host.memory.write(address, w);
}

/**
 * Default kernel32/user32/gdi32 handlers (design doc 4.2.x).
 *
 * Until the L3 marshaller lands, handlers read raw stdcall stack arguments
 * (`ctx.rawArgs`) and dereference pointers through `host.memory`. Console
 * streams (WriteFile on STD_OUTPUT_HANDLE) are routed by the guest-process
 * runner via `core:console:write` events or its output callback.
 */
export function registerDefaultHandlers(interceptor: ApiInterceptor): void {
  const kernel32: Record<string, ApiHandler> = {
    GetTickCount: () => ok(Date.now() & 0xffffffff),
    GetTickCount64: () => ok(Date.now()),
    GetSystemTimeAsFileTime: (ctx, host) => {
      // FILETIME = 100ns intervals since 1601-01-01. __security_init_cookie
      // mixes this into the stack cookie — returning 0 (and not writing the
      // output) made the cookie degenerate and __security_check_cookie fail.
      const out = raw(ctx, 0);
      const t = BigInt(Date.now()) * 10000n + 116444736000000000n;
      const w = new Uint8Array(8);
      new DataView(w.buffer).setBigUint64(0, t, true);
      host.memory.write(out, w);
      return ok(0);
    },
    QueryPerformanceCounter: (ctx, host) => {
      const out = raw(ctx, 0);
      const w = new Uint8Array(8);
      new DataView(w.buffer).setBigUint64(0, BigInt(Date.now()) * 1000n, true);
      host.memory.write(out, w);
      return ok(1);
    },
    QueryPerformanceFrequency: (ctx, host) => {
      const out = raw(ctx, 0);
      const w = new Uint8Array(8);
      new DataView(w.buffer).setBigUint64(0, 10000000n, true);
      host.memory.write(out, w);
      return ok(1);
    },
    GetCurrentProcessId: () => ok(1),
    GetCurrentThreadId: () => ok(1),
    GetCurrentProcess: () => ok(0xffffffff), // pseudo-handle (-1)
    GetCurrentThread: () => ok(0xffffffff), // pseudo-handle (-1)
    GetSystemTime: (ctx, host) => {
      // SYSTEMTIME is 8 x WORD; zero it (no RTC yet).
      const out = raw(ctx, 0);
      host.memory.write(out, new Uint8Array(16));
      return ok(0);
    },
    GetLastError: () => ok(0),
    GetStdHandle: (ctx) => {
      switch (raw(ctx, 0)) {
        case 0:
          return ok(STD_INPUT_HANDLE);
        case 1:
          return ok(STD_OUTPUT_HANDLE);
        case 2:
          return ok(STD_ERROR_HANDLE);
        default:
          return ok(raw(ctx, 0));
      }
    },
    // GetFileType(HANDLE): cmd.exe probes stdin/stdout/stderr with this after
    // _get_osfhandle. The standard pseudo-handles (-10/-11/-12) are consoles,
    // so return FILE_TYPE_CHAR (2) instead of 0 (UNKNOWN) — otherwise cmd
    // thinks the console is broken and longjmps to an uninitialised jmp_buf.
    GetFileType: (ctx) => {
      const h = raw(ctx, 0) >>> 0;
      if (h === 0xfffffff6 || h === 0xfffffff5 || h === 0xfffffff4) return ok(2); // FILE_TYPE_CHAR
      if (h === 0xffffffff) return ok(0); // INVALID_HANDLE_VALUE -> UNKNOWN
      return ok(0);
    },
    GetConsoleMode: () => ok(1),
    GetConsoleOutputCP: () => ok(437),
    SetConsoleOutputCP: () => ok(1),
    GetCPInfo: (ctx, host) => {
      // CPINFO: UINT MaxCharSize(+0), BYTE DefaultChar[2](+4), BYTE LeadByte[12](+6)
      // Success is non-zero; cmd.exe aborts console init when this returns 0.
      const out = raw(ctx, 1);
      if (out) {
        const w = new Uint8Array(18);
        const view = new DataView(w.buffer);
        view.setUint32(0, 2, true); // MaxCharSize (UTF-16)
        host.memory.write(out, w);
      }
      return ok(1);
    },
    GetThreadLocale: () => ok(0x409),
    GetUserDefaultLCID: () => ok(0x409),
    // cmd.exe opens its own thread during console init; a NULL handle aborts.
    OpenThread: () => ok(0x5001),
    GetExitCodeThread: () => ok(0),
    GetThreadTimes: (ctx, host) => {
      const out = raw(ctx, 1);
      if (out) host.memory.write(out, new Uint8Array(32));
      return ok(1);
    },
    // Registry: cmd.exe reads console/config values during init. Report
    // success, write a pseudo key handle and zero values so the guest sees
    // a well-defined (disabled) configuration instead of stack garbage.
    RegOpenKeyExW: (ctx, host) => {
      const out = raw(ctx, 4);
      if (out) host.memory.write(out, new Uint8Array([0x00, 0xa0, 0x41, 0x00]));
      return ok(0); // ERROR_SUCCESS
    },
    RegOpenKeyExA: (ctx, host) => {
      const out = raw(ctx, 4);
      if (out) host.memory.write(out, new Uint8Array([0x00, 0xa0, 0x41, 0x00]));
      return ok(0);
    },
    RegQueryValueExW: (ctx, host) => {
      // Do NOT write lpData (arg4): cmd.exe passes a stack slot that overlaps
      // the GS cookie copy in the caller frame ([ebp-4] in its big init
      // function) — writing 4 zero bytes there zeroes the cookie and every
      // later __security_check_cookie fails -> __report_gsfailure. Report the
      // size (4 bytes) so callers can still take the "value found" path.
      const cb = raw(ctx, 5);
      if (cb) host.memory.write(cb, new Uint8Array([0x04, 0, 0, 0]));
      return ok(0);
    },
    RegQueryValueExA: (ctx, host) => {
      const cb = raw(ctx, 5);
      if (cb) host.memory.write(cb, new Uint8Array([0x04, 0, 0, 0]));
      return ok(0);
    },
    RegCloseKey: () => ok(0),
    RegEnumValueW: (ctx, host) => {
      const data = raw(ctx, 5);
      if (data) host.memory.write(data, new Uint8Array(2));
      return fail(259); // ERROR_NO_MORE_ITEMS
    },
    RegEnumValueA: (ctx, host) => {
      const data = raw(ctx, 5);
      if (data) host.memory.write(data, new Uint8Array(2));
      return fail(259); // ERROR_NO_MORE_ITEMS
    },
    ExitProcess: (ctx) => ok(raw(ctx, 0)),
    CreateFileA: async (ctx, host) => {
      const path = strArg(ctx, 'path') || memCStr(host, raw(ctx, 0));
      if (!path) return fail(E.ERROR_NOT_IMPLEMENTED);
      const result = await host.fs.createFile(
        path,
        numArg(
          ctx,
          'desiredAccess',
          raw(ctx, 1) || DesiredAccess.GENERIC_READ | DesiredAccess.GENERIC_WRITE,
        ),
        numArg(ctx, 'shareMode', raw(ctx, 2) || 0x03),
        numArg(ctx, 'creationDisposition', raw(ctx, 4) || CreationDisposition.OPEN_ALWAYS),
      );
      return result.error === E.NO_ERROR ? ok(result.handle) : fail(result.error);
    },
    ReadFile: async (ctx, host) => {
      const handle = raw(ctx, 0);
      if (!handle) return fail(E.ERROR_NOT_IMPLEMENTED);
      const buffer = raw(ctx, 1);
      const bytesToRead = raw(ctx, 2) || 1024;
      const result = await host.fs.readFile(handle, bytesToRead);
      if (result.error === E.NO_ERROR) {
        host.memory.write(buffer, result.data);
        return ok(result.bytesRead);
      }
      return fail(result.error);
    },
    WriteFile: async (ctx, host) => {
      // WriteFile(hFile, lpBuffer, nNumberOfBytesToWrite, lpNumberOfBytesWritten, lpOverlapped)
      const handle = raw(ctx, 0);
      const bytes = host.memory.read(raw(ctx, 1), raw(ctx, 2));
      const result = await host.fs.writeFile(handle, bytes);
      return result.error === E.NO_ERROR ? ok(result.bytesWritten) : fail(result.error);
    },
    CloseHandle: async (ctx, host) => {
      const error = await host.fs.closeHandle(numArg(ctx, 'handle', raw(ctx, 0)));
      return error === E.NO_ERROR ? ok(1) : fail(error);
    },
    FindFirstFileW: async (ctx, host) => {
      const path = memWStr(host, raw(ctx, 0));
      if (!path) return fail(E.ERROR_FILE_NOT_FOUND);
      const { dir, pattern } = splitFindPattern(path);
      const res = await host.fs.findFirstFile(dir, pattern);
      if (res.error !== E.NO_ERROR) return fail(res.error);
      const first = res.entries[0];
      if (first) writeFindData(host, raw(ctx, 1), first);
      return ok(res.searchHandle);
    },
    FindFirstFileA: async (ctx, host) => {
      const path = memCStr(host, raw(ctx, 0));
      if (!path) return fail(E.ERROR_FILE_NOT_FOUND);
      const { dir, pattern } = splitFindPattern(path);
      const res = await host.fs.findFirstFile(dir, pattern);
      if (res.error !== E.NO_ERROR) return fail(res.error);
      const first = res.entries[0];
      if (first) writeFindData(host, raw(ctx, 1), first);
      return ok(res.searchHandle);
    },
    FindNextFileW: async (ctx, host) => {
      const res = await host.fs.findNextFile(raw(ctx, 0));
      if (res.error !== E.NO_ERROR) return fail(res.error);
      const next = res.entries[0];
      if (!next) return fail(E.ERROR_NO_MORE_FILES);
      writeFindData(host, raw(ctx, 1), next);
      return ok(1);
    },
    FindNextFileA: async (ctx, host) => {
      const res = await host.fs.findNextFile(raw(ctx, 0));
      if (res.error !== E.NO_ERROR) return fail(res.error);
      const next = res.entries[0];
      if (!next) return fail(E.ERROR_NO_MORE_FILES);
      writeFindData(host, raw(ctx, 1), next);
      return ok(1);
    },
    FindClose: async (ctx, host) => {
      await host.fs.findClose(raw(ctx, 0));
      return ok(1);
    },
    GetFileSize: async (ctx, host) => {
      const size = await host.fs.getFileSize(numArg(ctx, 'handle', raw(ctx, 0)));
      return ok(size);
    },
    GetCommandLineA: () => ok(0),
    GetCommandLineW: () => ok(0),
    GetSystemInfo: (ctx, host) => {
      // SYSTEM_INFO (x86, 36 bytes): oemid/arch word pair, page size,
      // min/max app address, active processor mask, cpu count, cpu type,
      // allocation granularity, processor level, processor revision.
      const out = raw(ctx, 0);
      const w = new Uint8Array(36);
      const view = new DataView(w.buffer);
      view.setUint16(0, 0, true); // wProcessorArchitecture = PROCESSOR_ARCHITECTURE_INTEL
      view.setUint16(2, 0, true);
      view.setUint32(4, 4096, true); // dwPageSize
      view.setUint32(8, 0x10000, true); // lpMinimumApplicationAddress
      view.setUint32(12, 0x7ffeffff, true); // lpMaximumApplicationAddress
      view.setUint32(16, 1, true); // dwActiveProcessorMask
      view.setUint32(20, 1, true); // dwNumberOfProcessors
      view.setUint32(24, 586, true); // dwProcessorType
      view.setUint32(28, 65536, true); // dwAllocationGranularity
      view.setUint16(32, 6, true); // wProcessorLevel
      view.setUint16(34, 0, true); // wProcessorRevision
      host.memory.write(out, w);
      return ok(0);
    },
    VirtualQuery: (ctx, host) => {
      // MEMORY_BASIC_INFORMATION (x86, 28 bytes). The whole guest linear
      // memory is one committed, read-write, private region — good enough for
      // CRT/Heap walkers that just want a sane answer for "what is this
      // address?".
      const address = raw(ctx, 0);
      const out = raw(ctx, 1);
      const len = raw(ctx, 2);
      if (!address || !out) return fail(E.ERROR_INVALID_PARAMETER);
      const w = new Uint8Array(28);
      const view = new DataView(w.buffer);
      view.setUint32(0, 0, true); // BaseAddress
      view.setUint32(4, 0, true); // AllocationBase
      view.setUint32(8, 0x04, true); // AllocationProtect = PAGE_READWRITE
      view.setUint32(12, 0xffffffff, true); // RegionSize (whole 4GB space)
      view.setUint32(16, 0x1000, true); // State = MEM_COMMIT
      view.setUint32(20, 0x04, true); // Protect = PAGE_READWRITE
      view.setUint32(24, 0x20000, true); // Type = MEM_PRIVATE
      const n = Math.min(28, len);
      host.memory.write(out, w.subarray(0, n));
      return ok(n);
    },
    GetStartupInfoW: (ctx, host) => {
      // STARTUPINFOW (x86, 68 bytes); zero it (no console/desktop yet).
      const out = raw(ctx, 0);
      host.memory.write(out, new Uint8Array(68));
      return ok(0);
    },
    GetStartupInfoA: (ctx, host) => {
      // STARTUPINFOA (x86, 68 bytes).
      const out = raw(ctx, 0);
      host.memory.write(out, new Uint8Array(68));
      return ok(0);
    },
  };

  // Shared counter for RegisterWindowMessage (module-level in the closure).
  const registeredMessageIds = [0xc000];

  const user32: Record<string, ApiHandler> = {
    MessageBoxA: (ctx) => {
      void ctx;
      // TODO(P3): route through L6 desktop to show a real message box
      return ok(1); // IDOK
    },
    MessageBoxW: (ctx) => {
      void ctx;
      // TODO(P3): route through L6 desktop to show a real message box
      return ok(1); // IDOK — the caller proceeds as if the user clicked OK
    },
    CharNextW: (ctx, host) => {
      // Returns a pointer to the next character (or the NUL) after lpsz.
      const p = raw(ctx, 0);
      if (!p) return ok(p);
      const w = host.memory.read(p, 4);
      const c = w.byteLength >= 2 ? new DataView(w.buffer, w.byteOffset, 2).getUint16(0, true) : 0;
      return ok(c === 0 ? p : p + 2);
    },
    // RegisterWindowMessageW/A: unique message ids live in 0xC000..0xFFFF.
    // Returning 0 makes apps treat registration as failed and abort startup
    // (notepad fail-fasts).
    RegisterWindowMessageW: (_ctx) => ok((registeredMessageIds[0] as number)++),
    RegisterWindowMessageA: (_ctx) => ok((registeredMessageIds[0] as number)++),
    // Device contexts: apps treat a NULL HDC as failure and abort (notepad
    // fail-fasts after GetDC(0) == 0). Return a stable fake handle.
    GetDC: (_ctx) => ok(0x1001),
    GetWindowDC: (_ctx) => ok(0x1001),
    ReleaseDC: () => ok(1),
    GetDCOrgEx: (ctx, host) => {
      const out = raw(ctx, 1);
      if (out) host.memory.write(out, new Uint8Array(8));
      return ok(1);
    },
  };

  const gdi32: Record<string, ApiHandler> = {
    GetDeviceCaps: () => ok(32),
  };

  interceptor.hookBatch('kernel32.dll', kernel32);
  interceptor.hookBatch('user32.dll', user32);
  interceptor.hookBatch('gdi32.dll', gdi32);

  // UCRT (ucrtbase) memory/string primitives. Modern CRT code imports these
  // through the api-ms-win-crt-* API-Set names (normalized to ucrtbase.dll
  // by the interceptor). Without them, CRT init memory ops silently no-op.
  const ucrtbase: Record<string, ApiHandler> = {
    memset: (ctx, host) => {
      const dst = raw(ctx, 0);
      const c = raw(ctx, 1) & 0xff;
      const n = raw(ctx, 2) >>> 0;
      if (n) host.memory.write(dst, new Uint8Array(n).fill(c));
      return ok(dst);
    },
    memcpy: (ctx, host) => {
      const dst = raw(ctx, 0);
      const src = raw(ctx, 1);
      const n = raw(ctx, 2) >>> 0;
      if (n) host.memory.write(dst, host.memory.read(src, n));
      return ok(dst);
    },
    memmove: (ctx, host) => {
      // src/dst overlap is handled by copying through a temporary.
      const dst = raw(ctx, 0);
      const src = raw(ctx, 1);
      const n = raw(ctx, 2) >>> 0;
      if (n) host.memory.write(dst, host.memory.read(src, n).slice());
      return ok(dst);
    },
    wcslen: (ctx, host) => {
      const p = raw(ctx, 0);
      const bytes = host.memory.read(p, 0x100000);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      let n = 0;
      while (n + 1 < bytes.byteLength && view.getUint16(n * 2, true) !== 0) n += 1;
      return ok(n);
    },
    // _o__wcsicmp / _wcsicmp / wcsicmp / _stricmp: case-insensitive wide/narrow
    // compare. cmd.exe matches its internal variable names (KEYS/GOTO/DPATH…)
    // and environment names with these; returning 0 (the default for an
    // unimplemented handler) makes every comparison "equal" and cmd misroutes.
    _o__wcsicmp: (ctx, host) => ok(wcsicmpImpl(host, raw(ctx, 0), raw(ctx, 1), true)),
    _wcsicmp: (ctx, host) => ok(wcsicmpImpl(host, raw(ctx, 0), raw(ctx, 1), true)),
    wcsicmp: (ctx, host) => ok(wcsicmpImpl(host, raw(ctx, 0), raw(ctx, 1), true)),
    _stricmp: (ctx, host) => {
      const a = memCStr(host, raw(ctx, 0)).toLowerCase();
      const b = memCStr(host, raw(ctx, 1)).toLowerCase();
      return ok(a < b ? -1 : a > b ? 1 : 0);
    },
    _time32: (ctx, host) => {
      const t = Math.floor(Date.now() / 1000);
      const out = raw(ctx, 0);
      if (out) {
        const b = new Uint8Array(4);
        new DataView(b.buffer).setUint32(0, t, true);
        host.memory.write(out, b);
      }
      return ok(t);
    },
    time: (ctx, host) => {
      const t = Math.floor(Date.now() / 1000);
      const out = raw(ctx, 0);
      if (out) {
        const b = new Uint8Array(4);
        new DataView(b.buffer).setUint32(0, t, true);
        host.memory.write(out, b);
      }
      return ok(t);
    },
    _o_srand: () => ok(0),
    srand: () => ok(0),
    // _o__get_osfhandle(int fd): maps a CRT file descriptor to an OS handle.
    // cmd.exe calls this for fd 0/1/2 during console init; returning 0 (the
    // default) makes GetFileType(0) return FILE_TYPE_UNKNOWN and cmd takes
    // its error-recovery path (longjmp to an uninitialised jmp_buf -> eip=0
    // trap). Return the standard pseudo-handles so cmd sees a console.
    _o__get_osfhandle: (ctx) => {
      const fd = raw(ctx, 0);
      if (fd === 0) return ok(0xfffffff6); // STD_INPUT_HANDLE (-10)
      if (fd === 1) return ok(0xfffffff5); // STD_OUTPUT_HANDLE (-11)
      if (fd === 2) return ok(0xfffffff4); // STD_ERROR_HANDLE (-12)
      return ok(0xffffffff); // INVALID_HANDLE_VALUE
    },
    _get_osfhandle: (ctx) => {
      const fd = raw(ctx, 0);
      if (fd === 0) return ok(0xfffffff6);
      if (fd === 1) return ok(0xfffffff5);
      if (fd === 2) return ok(0xfffffff4);
      return ok(0xffffffff);
    },
  };
  interceptor.hookBatch('ucrtbase.dll', ucrtbase);
}

/** Case-insensitive wide string compare (returns -1/0/1 like wcsicmp). */
function wcsicmpImpl(host: ApiHost, aPtr: number, bPtr: number, wide: boolean): number {
  const readW = (p: number): string => {
    if (!p) return '';
    const bytes = host.memory.read(p, 0x20000);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let s = '';
    for (let i = 0; i + 1 < bytes.byteLength; i += 2) {
      const c = view.getUint16(i, true);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s.toLowerCase();
  };
  const a = wide ? readW(aPtr) : memCStr(host, aPtr).toLowerCase();
  const b = wide ? readW(bPtr) : memCStr(host, bPtr).toLowerCase();
  return a < b ? -1 : a > b ? 1 : 0;
}

export type { ApiHost, ApiResult, ApiCallContext };
