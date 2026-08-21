/**
 * Extract RT_STRING string-table entries from a PE's resource section.
 *
 *   node res-strings.mjs <exe>
 *
 * Prints id -> text for every string in the resource section.
 */
import { readFileSync } from 'node:fs';

const [exePath] = process.argv.slice(2);
if (!exePath) {
  console.error('usage: res-strings <exe>');
  process.exit(1);
}
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
const resSize = d32(ddOff + 2 * 8 + 4);
console.log(`resource dir rva=0x${resRva.toString(16)} size=0x${resSize.toString(16)}`);

// Parse the resource directory tree: root -> type(6=RT_STRING) -> id -> lang.
interface Node {
  id: number;
  nameIsId: boolean;
  offset: number;
  isDir: boolean;
}
const readDir = (off: number): { nodes: Node[]; named: boolean } => {
  const nNamed = d16(off + 12);
  const nId = d16(off + 14);
  const nodes: Node[] = [];
  for (let i = 0; i < nNamed + nId; i++) {
    const e = off + 16 + i * 8;
    const name = d32(e);
    const data = d32(e + 4);
    nodes.push({
      id: name & 0x7fffffff,
      nameIsId: (name & 0x80000000) === 0,
      offset: data & 0x7fffffff,
      isDir: (data & 0x80000000) !== 0,
    });
  }
  return { nodes, named: nNamed > 0 };
};

const rootOff = foff(resRva);
const root = readDir(rootOff);
for (const typeNode of root.nodes) {
  if (typeNode.id !== 6) continue; // RT_STRING only
  const typeOff = foff(resRva + typeNode.offset);
  const typeDir = readDir(typeOff);
  for (const idNode of typeDir.nodes) {
    const idOff = foff(resRva + idNode.offset);
    const langDir = readDir(idOff);
    for (const langNode of langDir.nodes) {
      const dataOff = foff(resRva + langNode.offset);
      const dataRva = d32(dataOff);
      const dataSize = d32(dataOff + 4);
      const strOff = foff(dataRva);
      // String block: 16 strings, each [WORD len][WCHAR text].
      // Convention: block id B holds strings (B-1)*16 .. (B-1)*16+15, i.e.
      // block 1 -> strings 1..15 (slot 0 = id 0 unused), block 2 -> 16..31.
      const blockBase = (idNode.id - 1) * 16;
      let p = strOff;
      for (let s = 0; s < 16; s++) {
        const len = d16(p);
        const id = blockBase + s;
        if (len > 0) {
          let text = '';
          for (let c = 0; c < len; c++) text += String.fromCharCode(d16(p + 2 + c * 2));
          console.log(`block=${idNode.id} string ${id}: "${text}" (${len} chars)`);
        }
        p += 2 + len * 2;
      }
      void dataSize;
    }
  }
}
