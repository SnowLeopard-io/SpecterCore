/**
 * Linear disassembler over a guest address window, reusing the JIT's own
 * X86Decoder (so it matches exactly what the JIT would decode at runtime).
 *
 *   node disasm-range.mjs <exe> <startVA> <length>
 *
 * Prints one instruction per line with its VA.
 */
import { readFileSync } from 'node:fs';
import { X86Decoder } from '@specter-core/core';

const [exePath, startArg, lenArg] = process.argv.slice(2);
if (!exePath || !startArg) {
  console.error('usage: disasm-range <exe> <startVA> <length>');
  process.exit(1);
}
const start = Number.parseInt(startArg, 16);
const len = Number.parseInt(lenArg, 16) || 0x100;

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

const dec = new X86Decoder('x86');
let va = start;
const end = start + len;
while (va < end) {
  const off = va2off(va);
  if (off === undefined) {
    console.log(`0x${va.toString(16)}  <unmapped>`);
    break;
  }
  const bytes = new Uint8Array(exe.subarray(off, Math.min(off + 80, exe.length)));
  let decoded: { instructions: Array<{ inst: { op: string; rep?: boolean; repne?: boolean; cond?: string; disp?: number; size?: number } }>; endAddress: number };
  try {
    decoded = dec.decode(bytes, va);
  } catch (e) {
    console.log(`0x${va.toString(16)}  !! decode error: ${(e as Error).message}`);
    break;
  }
  for (const d of decoded.instructions) {
    const i = d.inst;
    const iaddr = d.nextAddress - d.length;
    let line = `0x${iaddr.toString(16)}  ${i.op}`;
    if (i.rep) line += ' rep';
    if (i.repne) line += ' repne';
    if (i.cond !== undefined) line += ` ${i.cond}`;
    if ((i.op === 'call' || i.op === 'jmp') && i.disp !== undefined) line += ` rel=${i.disp}`;
    if (i.size !== undefined) line += ` size=${i.size}`;
    console.log(line);
    va = decoded.endAddress;
  }
}