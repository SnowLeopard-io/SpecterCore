/**
 * ucrtbase.dll handler table (design doc 4.2.x). Modern CRT code imports these through the api-ms-win-crt-* API-Set names (normalized to ucrtbase.dll by the interceptor). Without them, CRT init memory ops silently no-op.
 *
 * Split out of handlers.ts (design doc 4.2.x); pure code movement, no logic changes.
 */

import type { ApiHandler } from '@specter-core/contracts';
import { memCStr, ok, raw } from './handlers-shared';
import { randImpl, srandImpl, vswprintfImpl, wcsicmpImpl } from './handlers-crt';

export function ucrtbaseHandlers(): Record<string, ApiHandler> {
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
    wcschr: (ctx, host) => {
      const p = raw(ctx, 0);
      const target = raw(ctx, 1) & 0xffff;
      const bytes = host.memory.read(p, 0x100000);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (let i = 0; i + 1 < bytes.byteLength; i += 2) {
        const c = view.getUint16(i, true);
        if (c === target) return ok((p + i) >>> 0);
        if (c === 0) break;
      }
      return ok(0);
    },
    // wcsrchr: reverse scan — returns the address of the LAST occurrence of the
    // char, or 0 (NULL) if absent. cmd.exe needs this to strip the final path
    // component (parent-dir computation in the dir tree builder, 0x40a9e9 ->
    // 0x40aac4: wcsrchr(resolvedPath, L'\\')). Without a handler the interceptor
    // returns 0, the truncation is skipped, and dir enumerates
    // "C:\Windows\Windows" instead of "C:\Windows". Same class of bug as the
    // missing wcsicmp handlers (every comparison silently returning 0).
    wcsrchr: (ctx, host) => {
      const p = raw(ctx, 0);
      const target = raw(ctx, 1) & 0xffff;
      const bytes = host.memory.read(p, 0x100000);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      let last = 0;
      for (let i = 0; i + 1 < bytes.byteLength; i += 2) {
        const c = view.getUint16(i, true);
        if (c === 0) break;
        if (c === target) last = (p + i) >>> 0;
      }
      return ok(last);
    },
    _wcsrchr: (ctx, host) => {
      const p = raw(ctx, 0);
      const target = raw(ctx, 1) & 0xffff;
      const bytes = host.memory.read(p, 0x100000);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      let last = 0;
      for (let i = 0; i + 1 < bytes.byteLength; i += 2) {
        const c = view.getUint16(i, true);
        if (c === 0) break;
        if (c === target) last = (p + i) >>> 0;
      }
      return ok(last);
    },
    // _o__wcsicmp / _wcsicmp / wcsicmp / _stricmp: case-insensitive wide/narrow
    // compare. cmd.exe matches its internal variable names (KEYS/GOTO/DPATH…)
    // and environment names with these; returning 0 (the default for an
    // unimplemented handler) makes every comparison "equal" and cmd misroutes.
    _o__wcsicmp: (ctx, host) => ok(wcsicmpImpl(host, raw(ctx, 0), raw(ctx, 1), true)),
    _wcsicmp: (ctx, host) => ok(wcsicmpImpl(host, raw(ctx, 0), raw(ctx, 1), true)),
    wcsicmp: (ctx, host) => ok(wcsicmpImpl(host, raw(ctx, 0), raw(ctx, 1), true)),
    _o___stdio_common_vswprintf: (ctx, host) => vswprintfImpl(host, ctx),
    __stdio_common_vswprintf: (ctx, host) => vswprintfImpl(host, ctx),
    _o_iswspace: (ctx) => {
      const c = raw(ctx, 0) & 0xffff;
      return ok(c === 0x09 || c === 0x0a || c === 0x0b || c === 0x0c || c === 0x0d || c === 0x20 ? 1 : 0);
    },
    iswspace: (ctx) => {
      const c = raw(ctx, 0) & 0xffff;
      return ok(c === 0x09 || c === 0x0a || c === 0x0b || c === 0x0c || c === 0x0d || c === 0x20 ? 1 : 0);
    },
    _o_towupper: (ctx) => {
      const c = raw(ctx, 0) & 0xffff;
      return ok(c >= 0x61 && c <= 0x7a ? c - 0x20 : c);
    },
    towupper: (ctx) => {
      const c = raw(ctx, 0) & 0xffff;
      return ok(c >= 0x61 && c <= 0x7a ? c - 0x20 : c);
    },
    _o_towlower: (ctx) => {
      const c = raw(ctx, 0) & 0xffff;
      return ok(c >= 0x41 && c <= 0x5a ? c + 0x20 : c);
    },
    towlower: (ctx) => {
      const c = raw(ctx, 0) & 0xffff;
      return ok(c >= 0x41 && c <= 0x5a ? c + 0x20 : c);
    },
    _o_iswalpha: (ctx) => {
      const c = raw(ctx, 0) & 0xffff;
      return ok((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) ? 1 : 0);
    },
    iswalpha: (ctx) => {
      const c = raw(ctx, 0) & 0xffff;
      return ok((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) ? 1 : 0);
    },
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
    _o_srand: srandImpl,
    srand: srandImpl,
    _o_rand: randImpl,
    rand: randImpl,
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
  return ucrtbase;
}

