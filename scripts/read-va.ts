/**
 * Read dwords at guest VAs from the exe file (image base 0x400000).
 *   node read-va.mjs <exe> <va> [count]
 */
import { readFileSync } from 'node:fs';

const [exePath, vaArg, countArg] = process.argv.slice(2);
const exe = readFileSync(exePath);
const peOff = exe.readUInt32LE(0x3c);
const nsec = exe.readUInt16LE(peOff + 6);
const opt = exe.readUInt16LE(peOff + 20);
const imageBase = exe.readUInt32LE(peOff + 24 + 28);
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
const va2off = (va: number): number | undefined => {
  const rva = va - imageBase;
  for (const s of secs) if (rva >= s.va && rva < s.va + Math.max(s.vs, s.rs)) return s.raw + (rva - s.va);
  return undefined;
};

const start = Number.parseInt(vaArg, 16);
const count = countArg ? Number.parseInt(countArg, 16) : 8;
for (let i = 0; i < count; i++) {
  const va = start + i * 4;
  const off = va2off(va);
  const v = off === undefined ? 0 : exe.readUInt32LE(off);
  console.log(`0x${va.toString(16)} = 0x${(v >>> 0).toString(16)}`);
}
