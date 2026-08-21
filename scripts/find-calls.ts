/**
 * Find all relative `call <target>` sites in a PE's .text section.
 *   node find-calls.mjs <exe> <targetVA>
 */
import { readFileSync } from 'node:fs';

const [exePath, targetArg] = process.argv.slice(2);
if (!exePath || !targetArg) {
  console.error('usage: find-calls <exe> <targetVA>');
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

let count = 0;
for (let off = 0; off + 5 <= exe.length; off++) {
  if (exe[off] !== 0xe8) continue;
  const disp = exe.readInt32LE(off + 1);
  const va = off2va(off);
  if (va === undefined) continue;
  const nextVa = va + 5;
  if ((nextVa + disp) >>> 0 === target >>> 0) {
    const s = secs.find((x) => va >= imageBase + x.va && va < imageBase + x.va + Math.max(x.vs, x.rs));
    console.log(`0x${va.toString(16)}  (${s?.name ?? '?'})`);
    count++;
  }
}
console.error(`total call 0x${target.toString(16)} sites: ${count}`);
