/**
 * Resolve winmine's IAT (including ordinal imports) to find the VA of each
 * imported function's thunk, then scan .text for `FF 15 <thunk>` call sites.
 * GDI32 ordinals are resolved against the local GDI32.dll export table.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const exePath = process.argv[2] ?? 'C:/Users/HUAWEI/Desktop/windows/apps/web/public/win/winmine.exe';
const filter = process.argv[3] ? new RegExp(process.argv[3], 'i') : null;
const image = readFileSync(exePath);
const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
const d16 = (o: number) => view.getUint16(o, true);
const d32 = (o: number) => view.getUint32(o, true);
const foff = (rva: number): number => {
  const pe = d32(0x3c);
  const nsec = d16(pe + 6);
  const opt = pe + 24;
  const sec = opt + d16(pe + 20);
  for (let i = 0; i < nsec; i++) {
    const s = sec + i * 40;
    const va = d32(s + 12);
    const vs = d32(s + 8);
    const raw = d32(s + 20);
    const rs = d32(s + 16);
    if (rva >= va && rva < va + Math.max(vs, rs)) return raw + (rva - va);
  }
  return rva;
};
const cstr = (rva: number): string => {
  let o = foff(rva);
  let s = '';
  while (image[o] && s.length < 128) s += String.fromCharCode(image[o++]!);
  return s;
};
const impName = (rva: number): string => {
  let o = foff(rva) + 2;
  let s = '';
  while (image[o] && s.length < 128) s += String.fromCharCode(image[o++]!);
  return s;
};

// Load GDI32.dll export table to resolve ordinals.
function loadGdiOrdinals(): Map<number, string> {
  const map = new Map<number, string>();
  const gdiPath = 'C:/Windows/System32/GDI32.dll';
  try {
    const g = readFileSync(gdiPath);
    const gv = new DataView(g.buffer, g.byteOffset, g.byteLength);
    const gpe = gv.getUint32(0x3c, true);
    const gnsec = gv.getUint16(gpe + 6, true);
    const gopt = gv.getUint16(gpe + 20, true);
    const gmagic = gv.getUint16(gpe + 24, true);
    const gis64 = gmagic === 0x20b;
    const gsec = gpe + 24 + gopt;
    const secs: Array<{ va: number; vs: number; raw: number; rs: number }> = [];
    for (let i = 0; i < gnsec; i++) {
      const o = gsec + i * 40;
      secs.push({ va: gv.getUint32(o + 12, true), vs: gv.getUint32(o + 8, true), raw: gv.getUint32(o + 20, true), rs: gv.getUint32(o + 16, true) });
    }
    const gfoff = (rva: number): number => {
      for (const s of secs) if (rva >= s.va && rva < s.va + Math.max(s.vs, s.rs)) return s.raw + (rva - s.va);
      return rva;
    };
    const expRva = gv.getUint32(gpe + 24 + (gis64 ? 112 : 96) + 0 * 8, true);
    const expOff = gfoff(expRva);
    if (!expOff) return map;
    const nFuncs = gv.getUint32(expOff + 20, true);
    const nNames = gv.getUint32(expOff + 24, true);
    const addrOfFuncs = gv.getUint32(expOff + 28, true);
    const addrOfNames = gv.getUint32(expOff + 32, true);
    const addrOfOrd = gv.getUint32(expOff + 36, true);
    for (let i = 0; i < nNames; i++) {
      const nameRva = gv.getUint32(gfoff(addrOfNames) + i * 4, true);
      let o = gfoff(nameRva);
      let s = '';
      while (g[o] && s.length < 128) s += String.fromCharCode(g[o++]!);
      const ord = gv.getUint16(gfoff(addrOfOrd) + i * 2, true);
      map.set(ord, s);
    }
  } catch (e) {
    console.error(`[gdi] load failed: ${(e as Error).message}`);
  }
  return map;
}

const gdiOrd = loadGdiOrdinals();

const pe = d32(0x3c);
const opt = pe + 24;
const imgBase = d32(opt + 28);
const ddOff = opt + 96 + 1 * 8;
const idRva = d32(ddOff);
const idSize = d32(ddOff + 4);

// Build IAT VA -> function name (OFT holds hint/name or ordinal; FT is bound IAT).
const iatName = new Map<number, string>();
const maxDesc = idSize / 20;
for (let i = 0; i < maxDesc; i++) {
  const o = foff(idRva + i * 20);
  const oft = d32(o);
  const name = d32(o + 12);
  const ft = d32(o + 16);
  if (!name) break;
  const dll = cstr(name);
  const ordMap = /gdi32/i.test(dll) ? gdiOrd : null;
  let j = 0;
  while (true) {
    if (j > 4096) break;
    const ent = d32(foff(oft + j * 4));
    if (ent === 0) break;
    const iatVa = imgBase + ft + j * 4;
    let fn = '';
    if (ent & 0x80000000) {
      const ord = ent & 0xffff;
      fn = ordMap?.get(ord) ?? `#${ord}`;
    } else {
      fn = impName(ent);
    }
    iatName.set(iatVa, `${dll}!${fn}`);
    j++;
  }
}

// Scan .text for FF 15 (call dword ptr [abs]).
const nsec = d16(pe + 6);
const secTab = pe + 24 + d16(pe + 20);
for (let i = 0; i < nsec; i++) {
  const o = secTab + i * 40;
  const name = String.fromCharCode(...image.subarray(o, o + 8)).replace(/\0/g, '');
  if (name !== '.text') continue;
  const va = d32(o + 12);
  const raw = d32(o + 20);
  const rs = d32(o + 16);
  for (let off = raw; off < raw + rs - 6; off++) {
    if (image[off] === 0xff && image[off + 1] === 0x15) {
      const iatVa = d32(off + 2);
      const fn = iatName.get(iatVa);
      if (!fn) continue;
      if (!filter || filter.test(fn)) {
        console.log(`0x${(imgBase + va + (off - raw)).toString(16)}  ${fn}`);
      }
    }
  }
}
