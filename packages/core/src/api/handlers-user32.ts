/**
 * user32.dll handler table (design doc 4.2.x).
 *
 * Split out of handlers.ts (design doc 4.2.x); pure code movement, no logic changes.
 */

import type { ApiHandler } from '@specter-core/contracts';
import { ok, raw } from './handlers-shared';

export function user32Handlers(): Record<string, ApiHandler> {
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
    // CharUpperW/A: if HIWORD(arg) == 0 the arg is a single character (LOWORD
    // is the wchar/char); otherwise it is a NUL-terminated buffer to uppercase
    // in place (returns the pointer). notepad's command-line switch compare
    // (0x412807) uses the CHARACTER form — returning 0 for every input made
    // every case-insensitive compare "match" (0 == 0), so notepad thought the
    // file argument was the "/A" switch and skipped opening the file.
    CharUpperW: (ctx, host) => {
      const v = raw(ctx, 0);
      if ((v & 0xffff0000) === 0) {
        const c = v & 0xffff;
        return ok(c >= 0x61 && c <= 0x7a ? c - 0x20 : c);
      }
      const p = v >>> 0;
      for (let i = 0; i < 4096; i++) {
        const b = host.memory.read(p + i * 2, 2);
        if (b.byteLength < 2) break;
        const c = new DataView(b.buffer, b.byteOffset, 2).getUint16(0, true);
        if (c === 0) break;
        const up = c >= 0x61 && c <= 0x7a ? c - 0x20 : c;
        const out = new Uint8Array(2);
        new DataView(out.buffer).setUint16(0, up, true);
        host.memory.write(p + i * 2, out);
      }
      return ok(p);
    },
    CharUpperA: (ctx, host) => {
      const v = raw(ctx, 0);
      if ((v & 0xffff0000) === 0) {
        const c = v & 0xff;
        return ok(c >= 0x61 && c <= 0x7a ? c - 0x20 : c);
      }
      const p = v >>> 0;
      for (let i = 0; i < 4096; i++) {
        const b = host.memory.read(p + i, 1);
        if (b.byteLength < 1) break;
        const c = b[0]!;
        if (c === 0) break;
        host.memory.write(p + i, new Uint8Array([c >= 0x61 && c <= 0x7a ? c - 0x20 : c]));
      }
      return ok(p);
    },
    CharUpperBuffW: (ctx, host) => {
      const p = raw(ctx, 0);
      const n = raw(ctx, 1);
      for (let i = 0; i < n && i < 4096; i++) {
        const b = host.memory.read(p + i * 2, 2);
        if (b.byteLength < 2) break;
        const c = new DataView(b.buffer, b.byteOffset, 2).getUint16(0, true);
        const up = c >= 0x61 && c <= 0x7a ? c - 0x20 : c;
        const out = new Uint8Array(2);
        new DataView(out.buffer).setUint16(0, up, true);
        host.memory.write(p + i * 2, out);
      }
      return ok(n);
    },
    CharUpperBuffA: (ctx, host) => {
      const p = raw(ctx, 0);
      const n = raw(ctx, 1);
      for (let i = 0; i < n && i < 4096; i++) {
        const b = host.memory.read(p + i, 1);
        if (b.byteLength < 1) break;
        const c = b[0]!;
        host.memory.write(p + i, new Uint8Array([c >= 0x61 && c <= 0x7a ? c - 0x20 : c]));
      }
      return ok(n);
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
  return user32;
}

