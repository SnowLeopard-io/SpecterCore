/**
 * kernel32.dll handler table (design doc 4.2.x).
 *
 * Split out of handlers.ts (design doc 4.2.x); pure code movement, no logic changes.
 */

import type { ApiCallContext, ApiHandler, ApiHost, ApiResult } from '@specter-core/contracts';
import { CreationDisposition, DesiredAccess, WinError as E } from '@specter-core/contracts';
import {
  fail,
  memCStr,
  memWStr,
  memWStrLen,
  numArg,
  ok,
  raw,
  STD_ERROR_HANDLE,
  STD_INPUT_HANDLE,
  STD_OUTPUT_HANDLE,
  strArg,
} from './handlers-shared';
import { formatDateTime, LOCALE_STRINGS, readSysTime, writeDateStr } from './handlers-datetime';
import { splitFindPattern, volumeSerial, writeFindData } from './handlers-fs';

/** Unlocked CRITICAL_SECTION image (LockCount=-1, rest zeroed). */
function csInit(): Uint8Array {
  const b = new Uint8Array(24);
  new DataView(b.buffer).setInt32(4, -1, true);
  return b;
}

/**
 * SYSTEM_INFO (x86, 36 bytes): oemid/arch word pair, page size, min/max app
 * address, active processor mask, cpu count, cpu type, allocation granularity,
 * processor level, processor revision. Shared by GetSystemInfo and
 * GetNativeSystemInfo (32-bit installers query the native one via
 * GetProcAddress/delay-load).
 */
function writeSystemInfo(ctx: ApiCallContext, host: ApiHost): ApiResult {
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
}

export function kernel32Handlers(): Record<string, ApiHandler> {
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
    // CRITICAL_SECTION (x86, 24 bytes): +0 DebugInfo +4 LockCount +8
    // RecursionCount +0xC OwningThread +0x10 LockSemaphore +0x14 SpinCount.
    // Single-threaded guest: init writes LockCount=-1 (unlocked), enter/leave
    // are no-ops, try-enter always succeeds.
    InitializeCriticalSection: (ctx, host) => {
      const cs = raw(ctx, 0) >>> 0;
      if (cs) host.memory.write(cs, csInit());
      return ok(0);
    },
    InitializeCriticalSectionEx: (ctx, host) => {
      const cs = raw(ctx, 0) >>> 0;
      if (cs) host.memory.write(cs, csInit());
      return ok(0);
    },
    InitializeCriticalSectionAndSpinCount: (ctx, host) => {
      const cs = raw(ctx, 0) >>> 0;
      if (cs) host.memory.write(cs, csInit());
      return ok(0);
    },
    EnterCriticalSection: () => ok(0),
    LeaveCriticalSection: () => ok(0),
    DeleteCriticalSection: () => ok(0),
    TryEnterCriticalSection: () => ok(1),
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
    // GetConsoleMode(HANDLE, LPDWORD lpMode): must fill *lpMode, not just return
    // TRUE. cmd.exe checks `mode & 7` and `mode & 3` (0x411dbd / 0x427628) to
    // decide the console is usable; ENABLE_PROCESSED_*|ENABLE_LINE_INPUT (0x7)
    // satisfies both. Returning TRUE with a stale/garbage mode made cmd longjmp
    // into its error-recovery path and call _o_exit without running the command.
    GetConsoleMode: (ctx, host) => {
      const out = raw(ctx, 1);
      if (out) {
        const w = new Uint8Array(4);
        new DataView(w.buffer).setUint32(0, 0x7, true);
        host.memory.write(out, w);
      }
      return ok(1);
    },
    SetConsoleMode: () => ok(1),
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
    // ANSI code page. notepad's save path calls GetACP + WideCharToMultiByte
    // to convert the EDIT text into bytes before WriteFile. CP_ACP=65001
    // (UTF-8) makes the conversion handlers below agree with the wide strings
    // we store everywhere.
    GetACP: () => ok(65001),
    GetOEMCP: () => ok(65001),
    WideCharToMultiByte: (ctx, host) => {
      // (CodePage, dwFlags, lpWideCharStr, cchWideChar, lpMultiByteStr,
      //  cbMultiByte, lpDefaultChar, lpUsedDefaultChar)
      const widePtr = raw(ctx, 2);
      const cchWide = raw(ctx, 3) | 0;
      const mbPtr = raw(ctx, 4);
      const cbMultiByte = raw(ctx, 5) | 0;
      // lpUsedDefaultChar is an OUT param: notepad's save flow checks it
      // after the call to detect conversion failures (chars that fell back to
      // the default char). Leaving it untouched means whatever was on the
      // guest stack survives — a stale non-zero value makes notepad believe
      // the text couldn't be encoded and it aborts the save. Always clear it.
      const usedDefaultPtr = raw(ctx, 7);
      if (usedDefaultPtr) host.memory.write(usedDefaultPtr, new Uint8Array(4));
      // cchWideChar semantics: -1 = NUL-terminated; some callers pass 0 to
      // mean "scan until NUL" (notepad's save flow). Treat <= 0 as NUL scan.
      const s = cchWide > 0 ? memWStrLen(host, widePtr, cchWide) : memWStr(host, widePtr, 4096);
      const bytes = new TextEncoder().encode(s); // UTF-8
      if (mbPtr === 0 || cbMultiByte === 0) {
        // Length query: required size. An EXPLICIT cchWideChar (a real char
        // count, not a NUL scan) converts exactly that many chars and does
        // NOT append a NUL — the query must not add +1, or the caller
        // (notepad's write helper 0x410a66) sizes WriteFile one byte too
        // large and the saved file gains a trailing NUL. NUL-scan mode
        // (cchWide <= 0) includes the terminator, so +1 applies there.
        return ok(bytes.byteLength + (cchWide > 0 ? 0 : 1));
      }
      // Actual conversion: write up to cbMultiByte bytes (no forced NUL).
      const n = Math.min(bytes.byteLength, Math.max(0, cbMultiByte));
      host.memory.write(mbPtr, bytes.subarray(0, n));
      return ok(n);
    },
    MultiByteToWideChar: (ctx, host) => {
      // (CodePage, dwFlags, lpMultiByteStr, cbMultiByte, lpWideCharStr,
      //  cchWideChar)
      const mbPtr = raw(ctx, 2);
      const cbMultiByte = raw(ctx, 3) | 0;
      const widePtr = raw(ctx, 4);
      const cchWide = raw(ctx, 5) | 0;
      if (!mbPtr) return ok(0);
      const bytes = host.memory.read(mbPtr, cbMultiByte < 0 ? 4096 : cbMultiByte);
      const len = cbMultiByte < 0 ? bytes.byteLength : Math.min(cbMultiByte, bytes.byteLength);
      const s = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, len));
      const chars = [...s]; // UTF-16 code units
      if (widePtr === 0 || cchWide === 0) {
        // Length query. NUL-terminated source (cbMultiByte == -1) includes
        // the terminator in the count; an explicit byte count does not.
        return ok(chars.length + (cbMultiByte < 0 ? 1 : 0));
      }
      const n = Math.min(chars.length, Math.max(0, cchWide));
      const w = new Uint8Array(n * 2 + 2);
      for (let i = 0; i < n; i++) {
        w[i * 2] = chars[i]!.charCodeAt(0) & 0xff;
        w[i * 2 + 1] = (chars[i]!.charCodeAt(0) >> 8) & 0xff;
      }
      host.memory.write(widePtr, w);
      return ok(n);
    },
    // FILETIME <-> SYSTEMTIME: cmd formats `dir` row dates/times from the
    // WIN32_FIND_DATAW times. Unhandled, these return 0 + ERROR_NOT_IMPLEMENTED
    // and cmd aborts the dir command before printing rows.
    FileTimeToSystemTime: (ctx, host) => {
      const ft = raw(ctx, 0);
      const st = raw(ctx, 1);
      if (!ft || !st) return ok(0);
      const b = host.memory.read(ft, 8);
      const t = new DataView(b.buffer, b.byteOffset, 8).getBigUint64(0, true);
      const ms = Number((t - 116444736000000000n) / 10000n);
      const d = new Date(ms);
      const w = new Uint8Array(16);
      const v = new DataView(w.buffer);
      v.setUint16(0, d.getUTCFullYear(), true);
      v.setUint16(2, d.getUTCMonth() + 1, true);
      v.setUint16(4, d.getUTCDay(), true);
      v.setUint16(6, d.getUTCDate(), true);
      v.setUint16(8, d.getUTCHours(), true);
      v.setUint16(10, d.getUTCMinutes(), true);
      v.setUint16(12, d.getUTCSeconds(), true);
      v.setUint16(14, d.getUTCMilliseconds(), true);
      host.memory.write(st, w);
      return ok(1);
    },
    SystemTimeToFileTime: (ctx, host) => {
      const st = raw(ctx, 0);
      const ft = raw(ctx, 1);
      if (!st || !ft) return ok(0);
      const b = host.memory.read(st, 16);
      const v = new DataView(b.buffer, b.byteOffset, 16);
      const year = v.getUint16(0, true);
      const month = v.getUint16(2, true);
      const day = v.getUint16(6, true);
      const hour = v.getUint16(8, true);
      const minute = v.getUint16(10, true);
      const second = v.getUint16(12, true);
      const ms = v.getUint16(14, true);
      const d = Date.UTC(year, month - 1, day, hour, minute, second, ms);
      const t = BigInt(d) * 10000n + 116444736000000000n;
      const w = new Uint8Array(8);
      new DataView(w.buffer).setBigUint64(0, t, true);
      host.memory.write(ft, w);
      return ok(1);
    },
    FileTimeToLocalFileTime: (ctx, host) => {
      // The emulated clock is UTC-based; keep the value (cmd only cares that
      // the conversion succeeds and stays monotonic).
      const ft = raw(ctx, 0);
      const out = raw(ctx, 1);
      if (!ft || !out) return ok(0);
      host.memory.write(out, host.memory.read(ft, 8));
      return ok(1);
    },
    // GetLocaleInfoW/A: cmd reads LOCALE_SSHORTDATE / LOCALE_STIME / SDATE /
    // S1159 / S2359 etc. to build the dir row date column. A 0 return is
    // tolerated by cmd for most types but the date/time format strings must
    // resolve or the row formatting fails.
    GetLocaleInfoW: (ctx, host) => {
      const lcType = raw(ctx, 1) >>> 0;
      const buf = raw(ctx, 2);
      const cch = raw(ctx, 3);
      const s = LOCALE_STRINGS[lcType];
      if (s === undefined || !buf || !cch) return ok(0);
      const n = Math.min(s.length, cch - 1);
      const w = new Uint8Array(n * 2 + 2);
      for (let i = 0; i < n; i++) {
        w[i * 2] = s.charCodeAt(i) & 0xff;
        w[i * 2 + 1] = (s.charCodeAt(i) >> 8) & 0xff;
      }
      host.memory.write(buf, w);
      return ok(n + 1); // count INCLUDING the NUL
    },
    GetLocaleInfoA: (ctx, host) => {
      const lcType = raw(ctx, 1) >>> 0;
      const buf = raw(ctx, 2);
      const cch = raw(ctx, 3);
      const s = LOCALE_STRINGS[lcType];
      if (s === undefined || !buf || !cch) return ok(0);
      const n = Math.min(s.length, cch - 1);
      const w = new Uint8Array(n + 1);
      for (let i = 0; i < n; i++) w[i] = s.charCodeAt(i) & 0xff;
      host.memory.write(buf, w);
      return ok(n + 1);
    },
    GetDateFormatW: (ctx, host) => {
      const lpDate = raw(ctx, 2);
      const lpFormat = raw(ctx, 3);
      const out = raw(ctx, 4);
      const cch = raw(ctx, 5);
      if (!lpDate) return ok(0);
      const st = readSysTime(host, lpDate);
      const fmt = lpFormat ? memWStr(host, lpFormat) : 'M/d/yyyy';
      const s = formatDateTime(st, fmt, false);
      // Size query (cchDate==0 or NULL buffer): return required chars incl NUL.
      if (!out || !cch) return ok(s.length + 1);
      return writeDateStr(host, out, cch, s);
    },
    GetDateFormatA: (ctx, host) => {
      const lpDate = raw(ctx, 2);
      const lpFormat = raw(ctx, 3);
      const out = raw(ctx, 4);
      const cch = raw(ctx, 5);
      if (!lpDate) return ok(0);
      const st = readSysTime(host, lpDate);
      const fmt = lpFormat ? memCStr(host, lpFormat) : 'M/d/yyyy';
      const s = formatDateTime(st, fmt, false);
      if (!out || !cch) return ok(s.length + 1);
      const n = Math.min(s.length, cch - 1);
      const w = new Uint8Array(n + 1);
      for (let i = 0; i < n; i++) w[i] = s.charCodeAt(i) & 0xff;
      host.memory.write(out, w);
      return ok(n + 1);
    },
    GetTimeFormatW: (ctx, host) => {
      const lpTime = raw(ctx, 2);
      const lpFormat = raw(ctx, 3);
      const out = raw(ctx, 4);
      const cch = raw(ctx, 5);
      if (!lpTime) return ok(0);
      const st = readSysTime(host, lpTime);
      const fmt = lpFormat ? memWStr(host, lpFormat) : 'h:mm:ss tt';
      const s = formatDateTime(st, fmt, true);
      if (!out || !cch) return ok(s.length + 1);
      return writeDateStr(host, out, cch, s);
    },
    GetTimeFormatA: (ctx, host) => {
      const lpTime = raw(ctx, 2);
      const lpFormat = raw(ctx, 3);
      const out = raw(ctx, 4);
      const cch = raw(ctx, 5);
      if (!lpTime) return ok(0);
      const st = readSysTime(host, lpTime);
      const fmt = lpFormat ? memCStr(host, lpFormat) : 'h:mm:ss tt';
      const s = formatDateTime(st, fmt, true);
      if (!out || !cch) return ok(s.length + 1);
      const n = Math.min(s.length, cch - 1);
      const w = new Uint8Array(n + 1);
      for (let i = 0; i < n; i++) w[i] = s.charCodeAt(i) & 0xff;
      host.memory.write(out, w);
      return ok(n + 1);
    },
    // GetConsoleScreenBufferInfo(HANDLE, PCONSOLE_SCREEN_BUFFER_INFO): cmd
    // queries the buffer size to lay out `dir` columns and to decide between
    // WriteConsoleW vs WriteFile. Return a plausible 80x300 console so it
    // proceeds with the columnar layout instead of failing console init.
    GetConsoleScreenBufferInfo: (ctx, host) => {
      const out = raw(ctx, 1);
      if (out) {
        // CONSOLE_SCREEN_BUFFER_INFO: dwSize(COORD=4), dwCursorPosition(4),
        // wAttributes(2), srWindow(SMALL_RECT=8), dwMaximumWindowSize(4).
        const w = new Uint8Array(22);
        const view = new DataView(w.buffer);
        view.setUint16(0, 80, true); // dwSize.X
        view.setUint16(2, 300, true); // dwSize.Y
        view.setUint16(8, 0x7, true); // wAttributes (FOREGROUND_* defaults)
        view.setUint16(10, 0, true); // srWindow.Left
        view.setUint16(12, 0, true); // srWindow.Top
        view.setUint16(14, 79, true); // srWindow.Right
        view.setUint16(16, 24, true); // srWindow.Bottom
        view.setUint16(18, 80, true); // dwMaximumWindowSize.X
        view.setUint16(20, 300, true); // dwMaximumWindowSize.Y
        host.memory.write(out, w);
      }
      return ok(1);
    },
    // GetVolumeInformationW(lpRootPathName, lpVolumeNameBuffer,
    //   nVolumeNameSize, lpVolumeSerialNumber, lpMaximumComponentLength,
    //   lpFileSystemFlags, lpFileSystemNameBuffer, nFileSystemNameSize)
    // cmd.exe `dir` prints " Volume in drive C has no label." from this; a
    // 0 return (default handler) sets ERROR_CALL_NOT_IMPLEMENTED and cmd
    // aborts the dir command with exit code 1 before printing anything.
    GetVolumeInformationW: (ctx, host) => {
      const root = memWStr(host, raw(ctx, 0)) ?? '';
      const nameBuf = raw(ctx, 1);
      const nameCap = raw(ctx, 2);
      const serialBuf = raw(ctx, 3);
      const maxLenBuf = raw(ctx, 4);
      const flagsBuf = raw(ctx, 5);
      const fsBuf = raw(ctx, 6);
      const fsCap = raw(ctx, 7);
      const writeW = (addr: number, cap: number, s: string): void => {
        if (!addr || cap < 2) return;
        const n = Math.min(s.length, cap - 1);
        const w = new Uint8Array(n * 2 + 2);
        for (let i = 0; i < n; i++) {
          w[i * 2] = s.charCodeAt(i) & 0xff;
          w[i * 2 + 1] = (s.charCodeAt(i) >> 8) & 0xff;
        }
        host.memory.write(addr, w);
      };
      writeW(nameBuf, nameCap, 'Specter FS'); // virtual-disk label
      if (serialBuf) {
        const w = new Uint8Array(4);
        new DataView(w.buffer).setUint32(0, volumeSerial(root), true);
        host.memory.write(serialBuf, w);
      }
      if (maxLenBuf) {
        const w = new Uint8Array(4);
        new DataView(w.buffer).setUint32(0, 255, true);
        host.memory.write(maxLenBuf, w);
      }
      if (flagsBuf) {
        const w = new Uint8Array(4);
        new DataView(w.buffer).setUint32(0, 0x000700ff, true); // NTFS-ish flags
        host.memory.write(flagsBuf, w);
      }
      writeW(fsBuf, fsCap, 'NTFS');
      return ok(1);
    },
    GetVolumeInformationA: (ctx, host) => {
      const root = memCStr(host, raw(ctx, 0)) ?? '';
      const nameBuf = raw(ctx, 1);
      const nameCap = raw(ctx, 2);
      const serialBuf = raw(ctx, 3);
      const maxLenBuf = raw(ctx, 4);
      const flagsBuf = raw(ctx, 5);
      const fsBuf = raw(ctx, 6);
      const fsCap = raw(ctx, 7);
      const writeA = (addr: number, cap: number, s: string): void => {
        if (!addr || cap < 2) return;
        const n = Math.min(s.length, cap - 1);
        const w = new Uint8Array(n + 1);
        for (let i = 0; i < n; i++) w[i] = s.charCodeAt(i) & 0xff;
        host.memory.write(addr, w);
      };
      writeA(nameBuf, nameCap, 'Specter FS');
      if (serialBuf) {
        const w = new Uint8Array(4);
        new DataView(w.buffer).setUint32(0, volumeSerial(root), true);
        host.memory.write(serialBuf, w);
      }
      if (maxLenBuf) {
        const w = new Uint8Array(4);
        new DataView(w.buffer).setUint32(0, 255, true);
        host.memory.write(maxLenBuf, w);
      }
      if (flagsBuf) {
        const w = new Uint8Array(4);
        new DataView(w.buffer).setUint32(0, 0x000700ff, true);
        host.memory.write(flagsBuf, w);
      }
      writeA(fsBuf, fsCap, 'NTFS');
      return ok(1);
    },
    // GetDriveTypeW/A(rootPath): cmd.exe's `cd`/`pushd` validate the drive letter
    // first — a 0 (DRIVE_UNKNOWN) makes cd fail with ERROR_INVALID_DRIVE (15).
    // The virtual disk is always mounted as C:, so any drive-lettered root is a
    // fixed disk; empty/invalid roots are unknown.
    GetDriveTypeW: (ctx, host) => {
      const root = memWStr(host, raw(ctx, 0)) ?? '';
      return ok(/^[A-Za-z]:/.test(root.trim()) ? 3 : 0); // DRIVE_FIXED=3
    },
    GetDriveTypeA: (ctx, host) => {
      const root = memCStr(host, raw(ctx, 0)) ?? '';
      return ok(/^[A-Za-z]:/.test(root.trim()) ? 3 : 0); // DRIVE_FIXED=3
    },
    // GetLogicalDrives: the virtual disk mounts drive C: -> bitmask 0x4.
    GetLogicalDrives: () => ok(0x4),
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
    // FindFirstFileExW/A: cmd.exe `dir` enumerates via FindFirstFileExW with
    // fInfoLevelId=1 (FindExInfoBasic) + fSearchOp=0 (FindExSearchNameMatch).
    // FindExInfoBasic still uses the WIN32_FIND_DATAW layout (alternate name
    // just left empty), so writeFindData works for both levels.
    FindFirstFileExW: async (ctx, host) => {
      const path = memWStr(host, raw(ctx, 0));
      if (!path) return fail(E.ERROR_FILE_NOT_FOUND);
      const { dir, pattern } = splitFindPattern(path);
      const res = await host.fs.findFirstFile(dir, pattern);
      if (res.error !== E.NO_ERROR) return fail(res.error);
      const first = res.entries[0];
      if (first) writeFindData(host, raw(ctx, 2), first);
      return ok(res.searchHandle);
    },
    FindFirstFileExA: async (ctx, host) => {
      const path = memCStr(host, raw(ctx, 0));
      if (!path) return fail(E.ERROR_FILE_NOT_FOUND);
      const { dir, pattern } = splitFindPattern(path);
      const res = await host.fs.findFirstFile(dir, pattern);
      if (res.error !== E.NO_ERROR) return fail(res.error);
      const first = res.entries[0];
      if (first) writeFindData(host, raw(ctx, 2), first);
      return ok(res.searchHandle);
    },
    FindNextFileW: async (ctx, host) => {
      const res = await host.fs.findNextFile(raw(ctx, 0));
      // An exhausted enumeration must surface as ERROR_NO_MORE_FILES (18), not
      // ERROR_FILE_NOT_FOUND (2): cmd's dir loop treats 2 as a real failure
      // and prints "File Not Found" + exits 1 even after a successful first
      // file; 18 ends the loop normally and prints the summary.
      const next = res.entries[0];
      if (!next) return fail(E.ERROR_NO_MORE_FILES);
      if (res.error !== E.NO_ERROR) return fail(res.error);
      writeFindData(host, raw(ctx, 1), next);
      return ok(1);
    },
    FindNextFileA: async (ctx, host) => {
      const res = await host.fs.findNextFile(raw(ctx, 0));
      const next = res.entries[0];
      if (!next) return fail(E.ERROR_NO_MORE_FILES);
      if (res.error !== E.NO_ERROR) return fail(res.error);
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
    // GetFileInformationByHandle(hFile, lpFileInformation): notepad's open path
    // calls this right after CreateFileW and bails with an error dialog if it
    // fails. Without a handler the interceptor returned 0 + ERROR_NOT_IMPLEMENTED,
    // so every command-line file open died before the read. Fill the x86
    // BY_HANDLE_FILE_INFORMATION (52 bytes) from the handle's path/size/attrs.
    GetFileInformationByHandle: async (ctx, host) => {
      const handle = numArg(ctx, 'handle', raw(ctx, 0));
      const out = raw(ctx, 1);
      if (!out) return fail(E.ERROR_INVALID_PARAMETER);
      const info = await host.fs.getFileInformation(handle);
      if (info.error !== E.NO_ERROR) return fail(info.error);
      const w = new Uint8Array(52);
      const view = new DataView(w.buffer);
      view.setUint32(0, info.attributes >>> 0, true); // dwFileAttributes
      // FILETIME = 100ns since 1601-01-01; convert ms since epoch.
      const filetime = (ms: number): bigint =>
        ms > 0 ? (BigInt(Math.floor(ms)) + 11644473600000n) * 10000n : 0n;
      const writeFt = (offset: number, ms: number): void => {
        const ft = filetime(ms);
        view.setUint32(offset, Number(ft & 0xffffffffn), true);
        view.setUint32(offset + 4, Number(ft >> 32n), true);
      };
      writeFt(4, info.modified); // ftCreationTime
      writeFt(12, info.modified); // ftLastAccessTime
      writeFt(20, info.modified); // ftLastWriteTime
      view.setUint32(28, volumeSerial(info.path.replace(/[\\/]+.*$/, '')) >>> 0, true); // dwVolumeSerialNumber
      view.setUint32(32, 0, true); // nFileSizeHigh
      view.setUint32(36, info.size >>> 0, true); // nFileSizeLow
      view.setUint32(40, 1, true); // nNumberOfLinks
      // Stable pseudo file index from the path.
      const idx = volumeSerial(info.path);
      view.setUint32(44, 0, true); // nFileIndexHigh
      view.setUint32(48, idx >>> 0, true); // nFileIndexLow
      host.memory.write(out, w);
      return ok(1);
    },
    // GetFileAttributesW/A: cmd.exe's dir handler calls this to decide whether
    // the target is a directory (FILE_ATTRIBUTE_DIRECTORY=0x10) or a file/
    // wildcard. Without a handler the interceptor returns 0 (not -1), so cmd's
    // `cmp eax,-1` falls through and `test al,0x10` sees no directory bit — it
    // then treats the whole path as a wildcard, strips the last component via
    // wcsrchr, and the header prints "C:\" instead of "C:\Windows".
    GetFileAttributesW: async (ctx, host) => {
      const path = memWStr(host, raw(ctx, 0));
      if (!path) return fail(E.ERROR_FILE_NOT_FOUND);
      const res = await host.fs.getFileAttributes(path);
      // Windows semantics: INVALID_FILE_ATTRIBUTES = -1 on failure. callers
      // (notepad's save flow, cmd's dir) test `== -1` to detect a missing
      // path — returning 0 makes them treat a non-existent file as an
      // existing file with no attribute bits.
      if (res.error !== E.NO_ERROR) return { returnValue: 0xffffffff, errorCode: res.error };
      return ok(res.attributes);
    },
    GetFileAttributesA: async (ctx, host) => {
      const path = memCStr(host, raw(ctx, 0));
      if (!path) return fail(E.ERROR_FILE_NOT_FOUND);
      const res = await host.fs.getFileAttributes(path);
      if (res.error !== E.NO_ERROR) return { returnValue: 0xffffffff, errorCode: res.error };
      return ok(res.attributes);
    },
    GetCommandLineA: () => ok(0),
    GetCommandLineW: () => ok(0),
    GetSystemInfo: (ctx, host) => writeSystemInfo(ctx, host),
    GetNativeSystemInfo: (ctx, host) => writeSystemInfo(ctx, host),
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
  return kernel32;
}
