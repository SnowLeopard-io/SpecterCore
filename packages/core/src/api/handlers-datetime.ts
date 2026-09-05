/**
 * Date/time helpers for the API handlers: SYSTEMTIME reading, GetDateFormatW/GetTimeFormatW formatting, and en-US locale strings.
 *
 * Split out of handlers.ts (design doc 4.2.x); pure code movement, no logic changes.
 */

import type { ApiHost, ApiResult } from '@specter-core/contracts';
import { ok } from './handlers-shared';

/** Reads an 8-word SYSTEMTIME structure at `address`. */
export function readSysTime(host: ApiHost, address: number): { y: number; mo: number; d: number; h: number; mi: number; s: number } {
  const b = host.memory.read(address, 16);
  const v = new DataView(b.buffer, b.byteOffset, 16);
  return {
    y: v.getUint16(0, true),
    mo: v.getUint16(2, true),
    d: v.getUint16(6, true),
    h: v.getUint16(8, true),
    mi: v.getUint16(10, true),
    s: v.getUint16(12, true),
  };
}

/** Writes a UTF-16 result string; returns chars INCLUDING the NUL (like the API). */
export function writeDateStr(host: ApiHost, out: number, cch: number, s: string): ApiResult {
  const n = Math.min(s.length, Math.max(0, cch - 1));
  const w = new Uint8Array(n * 2 + 2);
  for (let i = 0; i < n; i++) {
    w[i * 2] = s.charCodeAt(i) & 0xff;
    w[i * 2 + 1] = (s.charCodeAt(i) >> 8) & 0xff;
  }
  host.memory.write(out, w);
  return ok(n + 1);
}

const DAYS_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAYS_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS_FULL = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const MONTHS_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Minimal GetDateFormatW/GetTimeFormatW format engine (M/d/yyyy, h:mm:ss tt...). */
export function formatDateTime(st: { y: number; mo: number; d: number; h: number; mi: number; s: number }, fmt: string, isTime: boolean): string {
  const dow = new Date(Date.UTC(st.y, st.mo - 1, st.d)).getUTCDay();
  const h12 = st.h % 12 === 0 ? 12 : st.h % 12;
  const ampm = st.h < 12 ? 'AM' : 'PM';
  const pad2 = (n: number): string => (n < 10 ? `0${n}` : `${n}`);
  let out = '';
  let i = 0;
  while (i < fmt.length) {
    const c = fmt[i];
    if (c === "'") {
      // literal run
      i += 1;
      let lit = '';
      while (i < fmt.length && fmt[i] !== "'") {
        if (fmt[i] === '\\' && i + 1 < fmt.length) {
          lit += fmt[i + 1];
          i += 2;
        } else {
          lit += fmt[i];
          i += 1;
        }
      }
      if (i < fmt.length) i += 1; // closing quote
      out += lit;
      continue;
    }
    // count run of the same token char
    let j = i;
    while (j < fmt.length && fmt[j] === c) j += 1;
    const run = j - i;
    const token = fmt.slice(i, j);
    i = j;
    if (isTime) {
      if (c === 'h') out += run >= 2 ? pad2(h12) : `${h12}`;
      else if (c === 'H') out += run >= 2 ? pad2(st.h) : `${st.h}`;
      else if (c === 'm') out += run >= 2 ? pad2(st.mi) : `${st.mi}`;
      else if (c === 's') out += run >= 2 ? pad2(st.s) : `${st.s}`;
      else if (c === 't') out += run >= 2 ? ampm : ampm[0];
      else out += token;
    } else {
      if (c === 'd') {
        if (run >= 4) out += DAYS_FULL[dow];
        else if (run === 3) out += DAYS_ABBR[dow];
        else if (run === 2) out += pad2(st.d);
        else out += `${st.d}`;
      } else if (c === 'M') {
        if (run >= 4) out += MONTHS_FULL[st.mo - 1];
        else if (run === 3) out += MONTHS_ABBR[st.mo - 1];
        else if (run === 2) out += pad2(st.mo);
        else out += `${st.mo}`;
      } else if (c === 'y') {
        if (run >= 4) out += `${st.y}`;
        else if (run === 2) out += pad2(st.y % 100);
        else out += `${st.y % 100}`;
      } else if (c === 'g') {
        out += run >= 2 ? 'A.D.' : 'AD';
      } else {
        out += token;
      }
    }
  }
  return out;
}

/** en-US locale strings keyed by LCType (winnt.h); only what cmd/notepad read. */
export const LOCALE_STRINGS: Record<number, string> = {
  0x1: '0409', // ILANGUAGE
  0x2: 'English (United States)', // SLANGUAGE
  0x3: 'ENU', // SABBREVLANGNAME
  0x4: 'English', // SNATIVELANGNAME
  0x5: '1', // ICOUNTRY
  0x6: 'United States', // SCOUNTRY
  0x7: '$', // SINTLSYMBOL
  0x8: '2', // SINTLFRACDIGITS
  0xd: '$', // SCURRENCY
  0xe: '.', // SMONDECIMALSEP
  0xf: ',', // SMONTHOUSANDSEP
  0x10: '3;0', // SMONGROUPING
  0x11: '0', // IMEASURE
  0x12: '.', // SDECIMALSEP
  0x13: ',', // STHOUSANDSEP
  0x14: '3;0', // IGROUPING
  0x15: '1', // IZERO
  0x19: '0123456789', // SNATIVEDIGITS
  0x1d: '/', // SDATE
  0x1f: 'M/d/yyyy', // SSHORTDATE
  0x20: 'dddd, MMMM dd, yyyy', // SLONGDATE
  0x21: '0', // ILDATE (MDY)
  0x23: ':', // STIME
  0x24: '0', // ITIME (24h)
  0x25: '0', // ITLZERO
  0x28: 'AM', // S1159
  0x29: 'PM', // S2359
  0x2a: 'AM', // SS1159 (sounds)
  0x2b: 'PM', // SS2359
  0x31: 'h:mm tt', // SSHORTTIME
  0x1003: 'h:mm:ss tt', // STIMEFORMAT
};

