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
    GetConsoleMode: () => ok(1),
    GetConsoleOutputCP: () => ok(437),
    SetConsoleOutputCP: () => ok(1),
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
  };
  interceptor.hookBatch('ucrtbase.dll', ucrtbase);
}

export type { ApiHost, ApiResult, ApiCallContext };
