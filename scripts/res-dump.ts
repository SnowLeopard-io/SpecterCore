/**
 * Dump the raw RT_STRING block bytes for a given block id, replicating the
 * engine's LoadStringW iteration (1-byte len reads) vs the correct 2-byte len.
 *
 *   node res-dump.mjs <exe> <blockId>
 */
import { readFileSync } from 'node:fs';

const [exePath, blockArg] = process.argv.slice(2);
if (!exePath) {
  console.error('usage: res-dump <exe> <blockId>');
  process.exit(1);
}
const blockId = Number(blockArg ?? 1);
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

const pe = d32(0x3c);
const opt = pe + 24;
const magic = d16(opt);
const ddOff = opt + (magic === 0x20b ? 112 : 96);
const resRva = d32(ddOff + 2 * 8);

const readDir = (off: number): { nodes: Array<{ id: number; offset: number; isDir: boolean }> } => {
  const nNamed = d16(off + 12);
  const nId = d16(off + 14);
  const nodes = [];
  for (let i = 0; i < nNamed + nId; i++) {
    const e = off + 16 + i * 8;
    const name = d32(e);
    const data = d32(e + 4);
    nodes.push({ id: name & 0x7fffffff, offset: data & 0x7fffffff, isDir: (data & 0x80000000) !== 0 });
  }
  return { nodes };
};

const root = readDir(foff(resRva));
for (const typeNode of root.nodes) {
  if (typeNode.id !== 6) continue;
  const typeDir = readDir(foff(resRva + typeNode.offset));
  for (const idNode of typeDir.nodes) {
    if (idNode.id !== blockId) continue;
    const langDir = readDir(foff(resRva + idNode.offset));
    for (const langNode of langDir.nodes) {
      const dataOff = foff(resRva + langNode.offset);
      const dataRva = d32(dataOff);
      const dataSize = d32(dataOff + 4);
      const strOff = foff(dataRva);
      console.log(`block ${blockId}: dataRva=0x${dataRva.toString(16)} size=0x${dataSize.toString(16)} fileOff=0x${strOff.toString(16)}`);
      // Correct parse (2-byte len)
      let p = strOff;
      console.log('--- correct (2-byte len) ---');
      for (let s = 0; s < 16; s++) {
        const len = d16(p);
        let text = '';
        for (let c = 0; c < len; c++) text += String.fromCharCode(d16(p + 2 + c * 2));
        console.log(`  slot ${s}: len=${len} "${text}"`);
        p += 2 + len * 2;
      }
      // Engine parse (1-byte len)
      p = strOff;
      console.log('--- engine (1-byte len) ---');
      for (let s = 0; s < 16; s++) {
        const len = image[p] ?? 0;
        let text = '';
        for (let c = 0; c < len; c++) text += String.fromCharCode(d16(p + 1 + c * 2));
        console.log(`  slot ${s}: len=${len} "${text}"`);
        p += 1 + len * 2;
      }
    }
  }
}
