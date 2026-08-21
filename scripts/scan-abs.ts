/**
 * Scan a PE's .text for instructions referencing a given 32-bit absolute
 * address (as a modrm disp32 or immediate). Prints the VA of each hit.
 *   node scan-abs.mjs <exe> <targetVA>
 */
import { readFileSync } from 'node:fs';

const [exePath, targetArg] = process.argv.slice(2);
if (!exePath || !targetArg) {
  console.error('usage: scan-abs <exe> <targetVA>');
  process.exit(1);
}
const target = Number.parseInt(targetArg, 16);
const exe = readFileSync(exePath);
const peOff = exe.readUInt32LE(0x3c);
const nsec = exe.readUInt16LE(peOff + 6);
const opt = exe.readUInt16LE(peOff + 20);
const imageBase = exe.readUInt32LE(peOff + 24 + 28);
const st = peOff + 24 + opt;
const secs: Array<{ va: number; vs: number; raw: number; rs: number; name: string }> = [];
for (let i = 0; i < nsec; i++) {
  const o = st + i * 40;
  secs.push({
    va: exe.readUInt32LE(o + 12),
    vs: exe.readUInt32LE(o + 8),
    raw: exe.readUInt32LE(o + 20),
    rs: exe.readUInt32LE(o + 16),
    name: exe.toString('latin1', o, o + 8).replace(/\0/g, ''),
  });
}
const off2va = (off: number): number | undefined => {
  for (const s of secs) {
    if (off >= s.raw && off < s.raw + s.rs) return imageBase + s.va + (off - s.raw);
  }
  return undefined;
};
const tle = Buffer.alloc(4);
tle.writeUInt32LE(target, 0);
let count = 0;
for (let off = 0; off + 4 <= exe.length; off++) {
  if (exe[off] !== tle[0] || exe[off + 1] !== tle[1] || exe[off + 2] !== tle[2] || exe[off + 3] !== tle[3]) continue;
  const va = off2va(off);
  if (va === undefined) continue;
  // Only report hits inside code sections.
  const s = secs.find((x) => va >= imageBase + x.va && va < imageBase + x.va + Math.max(x.vs, x.rs));
  if (!s || (s.name !== '.text' && s.name !== '.itext')) continue;
  // The disp32 is usually at instruction offset 1..6; report the byte before
  // as a hint of the opcode.
  const prev = off > 0 ? exe[off - 1].toString(16).padStart(2, '0') : '??';
  console.log(`0x${(va - 4).toString(16)} (disp ends here, prev byte 0x${prev})  ${s.name}`);
  count++;
}
console.error(`total hits: ${count}`);
