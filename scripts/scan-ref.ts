/**
 * Scan the exe for all references to a 4-byte VA pattern (little-endian).
 *   node scan-ref.mjs <exe> <va-hex>
 */
import { readFileSync } from 'node:fs';

const [exePath, vaArg] = process.argv.slice(2);
if (!exePath || !vaArg) {
  console.error('usage: scan-ref <exe> <va-hex>');
  process.exit(1);
}
const exe = readFileSync(exePath);
const peOff = exe.readUInt32LE(0x3c);
const nsec = exe.readUInt16LE(peOff + 6);
const opt = exe.readUInt16LE(peOff + 20);
const st = peOff + 24 + opt;
const secs: Array<{ va: number; vs: number; raw: number; rs: number }> = [];
for (let i = 0; i < nsec; i++) {
  const o = st + i * 40;
  secs.push({
    va: exe.readUInt32LE(o + 12),
    vs: exe.readUInt32LE(o + 8),
    raw: exe.readUInt32LE(o + 20),
    rs: exe.readUInt32LE(o + 16),
  });
}
const off2va = (off: number): string => {
  for (const s of secs) {
    if (off >= s.raw && off < s.raw + s.rs) {
      return `0x${(0x400000 + s.va + (off - s.raw)).toString(16)}`;
    }
  }
  return '?';
};

const target = Number.parseInt(vaArg, 16) >>> 0;
const pat = Buffer.from([target & 0xff, (target >>> 8) & 0xff, (target >>> 16) & 0xff, (target >>> 24) & 0xff]);
let off = 0;
let count = 0;
while ((off = exe.indexOf(pat, off)) !== -1) {
  count++;
  console.log(`fileoff 0x${off.toString(16)}  va ${off2va(off)}`);
  off += 4;
}
console.log(`total refs: ${count}`);
