/**
 * Generic PE import-table dumper.
 *
 *   node imp-dump.mjs <exe> [--unique]
 *
 * Prints every imported DLL + function (by name or ordinal). With --unique,
 * prints the sorted unique function-name set (module-qualified) so it can be
 * diffed against the engine's handler/argCount tables.
 */
import { readFileSync } from 'node:fs';

const [exePath, flag] = process.argv.slice(2);
if (!exePath) {
  console.error('usage: imp-dump <exe> [--unique]');
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
const cstr = (rva: number): string => {
  let o = foff(rva);
  let s = '';
  while (image[o] && s.length < 128) s += String.fromCharCode(image[o++]!);
  return s;
};

const pe = d32(0x3c);
const opt = pe + 24;
const magic = d16(opt);
const is64 = magic === 0x20b;
// Data directories start at opt+96 (PE32) or opt+112 (PE32+); import dir = index 1.
const ddOff = opt + (is64 ? 112 : 96) + 1 * 8;
const idRva = d32(ddOff);
const idSize = d32(ddOff + 4);
console.log(`PE ${is64 ? 'PE32+' : 'PE32'} import dir rva=0x${idRva.toString(16)} size=0x${idSize.toString(16)}`);

const unique = new Set<string>();
const rows: Array<[string, string]> = [];
const maxDesc = idSize / 20;
for (let i = 0; i < maxDesc; i++) {
  const o = foff(idRva + i * 20);
  const oft = d32(o);
  const name = d32(o + 12);
  const ft = d32(o + 16);
  if (!name) break;
  const dll = cstr(name);
  for (const [label, rva] of [
    ['OFT', oft],
    ['FT', ft],
  ] as const) {
    if (!rva) continue;
    let j = 0;
    while (true) {
      if (j > 4096) break; // safety: no terminator
      const ent = is64 ? Number(view.getBigUint64(foff(rva + j * 8), true)) : d32(foff(rva + j * 4));
      if (ent === 0) break;
      let fn = '';
      if (ent & 0x80000000) {
        fn = `#${ent & 0xffff}`;
      } else {
        const nameRva = ent;
        fn = cstr(nameRva);
        if (!fn) fn = `?rva0x${nameRva.toString(16)}`;
      }
      if (label === 'FT') continue; // FT mirrors OFT in the file; avoid double rows
      rows.push([dll, fn]);
      unique.add(`${dll.toLowerCase()}!${fn.toLowerCase()}`);
      j++;
    }
  }
}

if (flag === '--unique') {
  for (const u of [...unique].sort()) console.log(u);
} else {
  for (const [dll, fn] of rows) console.log(`${dll}.${fn}`);
}
console.log(`\n[imp-dump] ${rows.length} imports, ${unique.size} unique (module!func)`);
