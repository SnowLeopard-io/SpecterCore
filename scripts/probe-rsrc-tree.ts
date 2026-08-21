/**
 * Probe: parse winmine's PE resource tree directly and dump every RT_BITMAP
 * (type 2) entry: name id, DataRVA, size, and the BITMAPINFOHEADER it points
 * to. Compares against what the engine's resource walk should produce.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

async function main(): Promise<void> {
  const file = resolve(process.argv[2] ?? 'C:/Users/HUAWEI/Desktop/windows/apps/web/public/win/winmine.exe');
  const buf = await readFile(file);
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const u16 = (o: number): number => v.getUint16(o, true);
  const u32 = (o: number): number => v.getUint32(o, true);
  const pe = u32(0x3c);
  const nsec = u16(pe + 6);
  const opt = pe + 24;
  const magic = u16(opt);
  const is64 = magic === 0x20b;
  const numRva = is64 ? u16(opt + 108) : u16(opt + 92);
  const secTab = opt + (is64 ? 240 : 224);
  const dirOff = opt + (is64 ? 112 : 96);
  const resRva = u32(dirOff + 2 * 8);
  const resSize = u32(dirOff + 2 * 8 + 4);
  const r2o = (rva: number): number => {
    for (let i = 0; i < nsec; i++) {
      const s = secTab + i * 40;
      const va = u32(s + 12);
      const vs = u32(s + 8);
      const raw = u32(s + 20);
      if (va <= rva && rva < va + vs) return raw + (rva - va);
    }
    return -1;
  };
  console.log(`resRva=0x${resRva.toString(16)} size=0x${resSize.toString(16)}`);
  const walk = (rva: number, depth: number, typeId: number, nameId: number): void => {
    const off = r2o(rva);
    if (off < 0) return;
    const named = u16(off + 12);
    const ids = u16(off + 14);
    for (let k = 0; k < named + ids; k++) {
      const e = off + 16 + k * 8;
      const name = u32(e);
      const data = u32(e + 4);
      const isDir = (data & 0x80000000) !== 0;
      if (depth === 0) {
        walk(resRva + (data & 0x7fffffff), 1, name & 0xffff, 0);
      } else if (depth === 1) {
        walk(resRva + (data & 0x7fffffff), 2, typeId, name & 0xffff);
      } else {
        const de = r2o(resRva + data);
        if (de < 0) continue;
        const dataRva = u32(de);
        const size = u32(de + 4);
        const fo = r2o(dataRva);
        let hdr = '';
        if (fo >= 0) {
          const w = u32(fo + 4);
          const h = u32(fo + 8);
          const bpp = u16(fo + 14);
          hdr = ` w=${w} h=${h} bpp=${bpp}`;
        }
        console.log(
          `type=${typeId} name=0x${nameId.toString(16)} lang=0x${(name & 0xffff).toString(16)} ` +
            `dataRva=0x${dataRva.toString(16)} size=0x${size.toString(16)}${hdr}`,
        );
      }
    }
  };
  walk(resRva, 0, 0, 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
