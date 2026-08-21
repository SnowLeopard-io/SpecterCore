/**
 * Dump winmine's IAT thunk region (0x1001000..0x10011xx) with resolved names
 * (ordinals resolved against local GDI32.dll / USER32.dll export tables).
 */
import { readFileSync } from 'node:fs';

const exePath = process.argv[2] ?? 'C:/Users/HUAWEI/Desktop/windows/apps/web/public/win/winmine.exe';
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

function loadOrdinals(dllPath: string): Map<number, string> {
  const map = new Map<number, string>();
  try {
    const g = readFileSync(dllPath);
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
    const nNames = gv.getUint32(expOff + 24, true);
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
    console.error(`[ord] ${dllPath}: ${(e as Error).message}`);
  }
  return map;
}

const gdiOrd = loadOrdinals('C:/Windows/System32/GDI32.dll');
const userOrd = loadOrdinals('C:/Windows/System32/USER32.dll');
const kernOrd = loadOrdinals('C:/Windows/System32/KERNEL32.dll');

const pe = d32(0x3c);
const opt = pe + 24;
const imgBase = d32(opt + 28);
const ddOff = opt + 96 + 1 * 8;
const idRva = d32(ddOff);
const idSize = d32(ddOff + 4);

const iatName = new Map<number, string>();
const maxDesc = idSize / 20;
for (let i = 0; i < maxDesc; i++) {
  const o = foff(idRva + i * 20);
  const oft = d32(o);
  const name = d32(o + 12);
  const ft = d32(o + 16);
  if (!name) break;
  const dll = cstr(name);
  const ordMap = /gdi32/i.test(dll) ? gdiOrd : /user32/i.test(dll) ? userOrd : /kernel32/i.test(dll) ? kernOrd : null;
  // OFT holds hint/name or ordinal; FT is the bound IAT. Same index order.
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

// Dump the IAT region 0x1001000..0x1001200.
const start = 0x1001000;
const end = 0x1001200;
for (let va = start; va < end; va += 4) {
  const name = iatName.get(va);
  if (name) {
    console.log(`0x${va.toString(16)}  ${name}`);
  }
}
// Also dump raw IAT entries with resolved ordinal hints.
console.log('--- raw IAT (va -> file ent -> name) ---');
for (let va = start; va < end; va += 4) {
  const rva = va - imgBase;
  const off = foff(rva);
  const ent = d32(off);
  if (ent === 0) continue;
  let fn = '';
  if (ent & 0x80000000) {
    const ord = ent & 0xffff;
    fn = `ord#${ord} -> ${gdiOrd.get(ord) ?? userOrd.get(ord) ?? kernOrd.get(ord) ?? '?'}`;
  } else {
    fn = impName(ent);
  }
  console.log(`0x${va.toString(16)}  ent=0x${ent.toString(16)}  ${fn}`);
}
