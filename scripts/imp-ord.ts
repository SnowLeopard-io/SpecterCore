/**
 * Dump winmine's GDI32 ordinal imports (raw OFT entries) so we can resolve
 * which functions are actually called (BitBlt? StretchBlt?).
 */
import { readFileSync } from 'node:fs';

const exe = process.argv[2] ?? 'C:/Users/HUAWEI/Desktop/windows/apps/web/public/win/winmine.exe';
const image = readFileSync(exe);
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

const pe = d32(0x3c);
const opt = pe + 24;
const ddOff = opt + 96 + 1 * 8;
const idRva = d32(ddOff);
const idSize = d32(ddOff + 4);
const maxDesc = idSize / 20;
for (let i = 0; i < maxDesc; i++) {
  const o = foff(idRva + i * 20);
  const oft = d32(o);
  const name = d32(o + 12);
  if (!name) break;
  const dll = cstr(name);
  if (!/gdi32/i.test(dll)) continue;
  console.log(`=== ${dll} (OFT rva=0x${oft.toString(16)}) ===`);
  let j = 0;
  while (true) {
    if (j > 4096) break;
    const ent = d32(foff(oft + j * 4));
    if (ent === 0) break;
    if (ent & 0x80000000) {
      console.log(`  ordinal #${ent & 0xffff}`);
    } else {
      console.log(`  ${impName(ent)}`);
    }
    j++;
  }
}
