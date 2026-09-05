/**
 * CRT runtime handlers: rand/srand state, __stdio_common_vswprintf formatting, and wcsicmp comparison.
 *
 * Split out of handlers.ts (design doc 4.2.x); pure code movement, no logic changes.
 */

import type { ApiCallContext, ApiHost, ApiResult } from '@specter-core/contracts';
import { memCStr, memWStr, ok, raw } from './handlers-shared';

/**
 * MSVCRT rand()/srand() state. The guest only touches it through these two
 * calls, so a JS-side LCG is enough. winmine's mine-placement loop is
 * `do { x=rand()%w; y=rand()%h } while (cell already mined)` — a constant
 * rand() (the old no-op srand + missing rand) spins that loop forever.
 */
let randState = 1;
export const randImpl = (): ApiResult => {
  randState = (Math.imul(randState, 1103515245) + 12345) >>> 0;
  return ok((randState >>> 16) & 0x7fff);
};
export const srandImpl = (ctx: ApiCallContext): ApiResult => {
  randState = raw(ctx, 0) >>> 0 || 1;
  return ok(0);
};

/**
 * Minimal but correct __stdio_common_vswprintf for cmd.exe's formatting.
 *
 * cmd.exe formats every `dir` listing row through this CRT universal formatter
 * ("%s  " date, "%s" time, "%s" size, "%s" name, "%04X-%04X" volume serial,
 * "%s" header lines). Without a handler the interceptor returns 0 and every
 * row comes out blank. Handles the specifiers cmd uses: %s/%S/%c/%d/%i/%u/
 * %o/%x/%X/%p/%% with flags, width and precision (including the * forms).
 *
 * x86 va_list: __stdio_common_vswprintf(options:8, buffer, count, format,
 * locale, va_list) — va_list is a guest-stack pointer; args are 4 bytes each
 * (64-bit args occupy 8).
 */
export function vswprintfImpl(host: ApiHost, ctx: ApiCallContext): ApiResult {
  const buf = raw(ctx, 2) >>> 0;
  const count = raw(ctx, 3) >>> 0;
  const fmt = raw(ctx, 4) >>> 0;
  let va = (raw(ctx, 6) ?? 0) >>> 0;

  const rd32 = (a: number): number => {
    const b = host.memory.read(a >>> 0, 4);
    return b.byteLength < 4 ? 0 : new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true);
  };
  const nextArg = (): number => {
    const v = rd32(va);
    va = (va + 4) >>> 0;
    return v;
  };
  const nextArg64 = (): bigint => {
    const lo = nextArg();
    const hi = nextArg();
    return BigInt(lo) | (BigInt(hi) << 32n);
  };

  const out: number[] = [];
  // If buffer is NULL the call is a length query: format without a limit.
  const limit = buf === 0 ? Number.MAX_SAFE_INTEGER : count > 0 ? count - 1 : 0;
  const put = (c: number): void => {
    if (out.length < limit) out.push(c & 0xffff);
  };
  const putStr = (s: string): void => {
    for (const ch of s) put(ch.charCodeAt(0));
  };

  const f = memWStr(host, fmt, 4096);
  const isDigit = (ch: string): boolean => ch >= '0' && ch <= '9';
  let i = 0;
  while (i < f.length) {
    const ch = f[i] ?? '';
    if (ch !== '%') {
      put(ch.charCodeAt(0));
      i += 1;
      continue;
    }
    i += 1;
    if (i >= f.length) break;

    // flags
    let minus = false;
    let zero = false;
    let plus = false;
    let space = false;
    for (; i < f.length; i++) {
      const fl = f[i];
      if (fl === '-') minus = true;
      else if (fl === '0') zero = true;
      else if (fl === '+') plus = true;
      else if (fl === ' ') space = true;
      else break;
    }

    // width
    let width = 0;
    if (i < f.length && f[i] === '*') {
      width = nextArg();
      i += 1;
    } else {
      while (i < f.length && isDigit(f[i] ?? '')) {
        width = width * 10 + (f.charCodeAt(i) - 48);
        i += 1;
      }
    }
    if (width < 0) {
      minus = true;
      width = -width;
    }

    // precision
    let precision = -1;
    if (i < f.length && f[i] === '.') {
      i += 1;
      if (i < f.length && f[i] === '*') {
        precision = nextArg();
        i += 1;
      } else {
        precision = 0;
        while (i < f.length && isDigit(f[i] ?? '')) {
          precision = precision * 10 + (f.charCodeAt(i) - 48);
          i += 1;
        }
      }
    }

    // length modifier
    let long64 = false;
    for (;;) {
      const l = f[i];
      if (l === 'l') {
        long64 = false;
        i += 1;
      } else if (l === 'h') {
        i += 1;
      } else if (l === 'I') {
        if (f[i + 1] === '6' && f[i + 2] === '4') {
          long64 = true;
          i += 3;
        } else if (f[i + 1] === '3' && f[i + 2] === '2') {
          i += 3;
        } else {
          i += 1;
        }
      } else if (l === 'w' || l === 'z' || l === 'j' || l === 't') {
        i += 1;
      } else {
        break;
      }
    }
    if (i >= f.length) break;
    const conv = f[i] ?? '';
    i += 1;

    if (conv === '%') {
      put(0x25);
      continue;
    }
    if (conv === 'c') {
      put(nextArg());
      continue;
    }
    if (conv === 'n') {
      // Write the output count into the given pointer; cmd doesn't rely on it.
      nextArg();
      continue;
    }

    let text = '';
    if (conv === 's') {
      const p = nextArg();
      text = memWStr(host, p, 4096);
      if (precision >= 0) text = text.slice(0, precision);
    } else if (conv === 'S' || conv === 'hs') {
      const p = nextArg();
      text = memCStr(host, p, 4096);
      if (precision >= 0) text = text.slice(0, precision);
    } else if (conv === 'p') {
      text = `0x${nextArg().toString(16)}`;
    } else if (
      conv === 'd' ||
      conv === 'i' ||
      conv === 'u' ||
      conv === 'o' ||
      conv === 'x' ||
      conv === 'X'
    ) {
      let v: bigint;
      if (long64) {
        v = nextArg64();
      } else {
        v = BigInt(nextArg() >>> 0);
      }
      const isSigned = conv === 'd' || conv === 'i';
      let neg = false;
      if (isSigned) {
        const s = long64 ? BigInt.asIntN(64, v) : BigInt.asIntN(32, v);
        if (s < 0n) {
          neg = true;
          v = -s;
        } else {
          v = s;
        }
      }
      let digits = '';
      if (conv === 'd' || conv === 'i' || conv === 'u') {
        digits = v.toString(10);
      } else if (conv === 'o') {
        digits = v.toString(8);
      } else {
        digits = v.toString(16);
        if (conv === 'X') digits = digits.toUpperCase();
      }
      if (precision > digits.length) digits = '0'.repeat(precision - digits.length) + digits;
      text = (neg ? '-' : plus ? '+' : space && !neg ? ' ' : '') + digits;
    } else {
      // Unknown conversion: emit it literally (matches CRT's lenient fallback).
      put(0x25);
      put(conv.charCodeAt(0));
      continue;
    }

    const padChar = zero ? 0x30 : 0x20;
    const pad = Math.max(0, width - text.length);
    if (pad > 0 && !minus) {
      for (let k = 0; k < pad; k++) put(padChar);
    }
    putStr(text);
    if (pad > 0 && minus) {
      for (let k = 0; k < pad; k++) put(0x20);
    }
  }

  if (buf !== 0 && count > 0) {
    const bytes = new Uint8Array(out.length * 2 + 2);
    for (let k = 0; k < out.length; k++) {
      bytes[k * 2] = (out[k] ?? 0) & 0xff;
      bytes[k * 2 + 1] = ((out[k] ?? 0) >> 8) & 0xff;
    }
    host.memory.write(buf, bytes);
  }
  return ok(out.length);
}

/** Case-insensitive wide string compare (returns -1/0/1 like wcsicmp). */
export function wcsicmpImpl(host: ApiHost, aPtr: number, bPtr: number, wide: boolean): number {
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
