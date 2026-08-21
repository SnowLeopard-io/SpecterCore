/**
 * Extract RT_BITMAP resources from a PE and render each as ASCII art
 * (4bpp palette) to reveal the actual sprite-sheet layout of winmine.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const CHARS = ' .:-=+*#%@';

function u16(v: DataView, o: number): number {
  return v.getUint16(o, true);
}
function u32(v: DataView, o: number): number {
  return v.getUint32(o, true);
}

async function main(): Promise<void> {
  const file = resolve(process.argv[2] ?? 'C:/Users/HUAWEI/Desktop/windows/apps/web/public/win/winmine.exe');
  const buf = await readFile(file);
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (u16(v, 0) !== 0x5a4d) throw new Error('not a PE');
  const pe = u32(v, 0x3c);
  const nsec = u16(v, pe + 6);
  const opt = pe + 24;
  const magic = u16(v, opt);
  const is64 = magic === 0x20b;
  const numRva = is64 ? u16(v, opt + 108) : u16(v, opt + 92);
  const secTab = opt + (is64 ? 240 : 224);
  const dirOff = opt + (is64 ? 112 : 96);
  const rsrcRva = u32(v, dirOff + 2 * 8);
  const rsrcSize = u32(v, dirOff + 2 * 8 + 4);
  if (!rsrcRva) throw new Error('no resource dir');
  // Map RVA -> file offset
  let rsrcFile = 0;
  for (let i = 0; i < nsec; i++) {
    const s = secTab + i * 40;
    const va = u32(v, s + 12);
    const vsize = u32(v, s + 8);
    const raw = u32(v, s + 20);
    if (va <= rsrcRva && rsrcRva < va + vsize) {
      rsrcFile = raw + (rsrcRva - va);
      break;
    }
  }
  const rvaToOff = (rva: number): number => {
    for (let i = 0; i < nsec; i++) {
      const s = secTab + i * 40;
      const va = u32(v, s + 12);
      const vsize = u32(v, s + 8);
      const raw = u32(v, s + 20);
      if (va <= rva && rva < va + vsize) return raw + (rva - va);
    }
    return -1;
  };
  // Walk resource tree: type -> name -> lang -> data entry
  const walk = (off: number, depth: number): void => {
    const named = u16(v, off + 12);
    const idCount = u16(v, off + 14);
    const entries = u16(v, off + 16);
    for (let i = 0; i < named + idCount; i++) {
      const e = off + 16 + i * 8;
      const name = u32(v, e);
      const data = u32(v, e + 4);
      const isDir = (data & 0x80000000) !== 0;
      const id = name & 0xffff;
      if (depth === 0 && id !== 2) continue; // only RT_BITMAP (type 2)
      if (isDir) {
        walk(rsrcFile + (data & 0x7fffffff), depth + 1);
      } else {
        const de = rsrcFile + data;
        const dataRva = u32(v, de);
        const size = u32(v, de + 4);
        const fo = rvaToOff(dataRva);
        if (fo < 0) continue;
        const bm = new DataView(buf.buffer, buf.byteOffset + fo, size);
        const hdr = u32(bm, 0);
        const w = u32(bm, 4);
        const h = u32(bm, 8);
        const planes = u16(bm, 12);
        const bpp = u16(bm, 14);
        const comp = u32(bm, 16);
        const imgSize = u32(bm, 20);
        console.log(`BITMAP id=${id} size=${hdr} ${w}x${h} planes=${planes} bpp=${bpp} comp=${comp} imgSize=${imgSize} fileOff=${fo}`);
        if (bpp === 4 && w > 0 && h > 0) {
          const stride = Math.floor((w * 4 + 31) / 32) * 4;
          const palOff = 40;
          const pal: number[] = [];
          for (let c = 0; c < 16; c++) {
            const b = bm.getUint8(palOff + c * 4);
            const g = bm.getUint8(palOff + c * 4 + 1);
            const r = bm.getUint8(palOff + c * 4 + 2);
            pal.push(r, g, b);
          }
          const px = palOff + 16 * 4;
          // Render bottom-up (DIB rows are bottom-up when biHeight>0)
          for (let row = h - 1; row >= 0; row--) {
            const base = px + row * stride;
            let line = '';
            for (let c = 0; c < w; c++) {
              const byte = bm.getUint8(base + ((c / 2) | 0));
              const idx = c % 2 === 0 ? (byte >> 4) & 0xf : byte & 0xf;
              line += CHARS[Math.min(idx, CHARS.length - 1)] ?? '?';
            }
            console.log(`  ${line}`);
          }
        }
      }
    }
  };
  walk(rsrcFile, 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
