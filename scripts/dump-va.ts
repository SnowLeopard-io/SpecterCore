import { readFile } from 'node:fs/promises';

async function main(): Promise<void> {
  const exe = process.argv[2];
  const va = Number(process.argv[3]);
  const count = Number(process.argv[4] ?? 32);
  const buf = await readFile(exe);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const peOff = dv.getUint32(0x3c, true);
  const numSections = dv.getUint16(peOff + 6, true);
  const optSize = dv.getUint16(peOff + 20, true);
  const imgBase = dv.getUint32(peOff + 24 + 28, true);
  const secTab = peOff + 24 + optSize;
  const secs: Array<{ name: string; va: number; vsize: number; raw: number; rsize: number }> = [];
  for (let i = 0; i < numSections; i++) {
    const off = secTab + i * 40;
    const name = String.fromCharCode(...buf.subarray(off, off + 8)).replace(/\0+$/, '');
    secs.push({ name, va: dv.getUint32(off + 12, true), vsize: dv.getUint32(off + 8, true), raw: dv.getUint32(off + 20, true), rsize: dv.getUint32(off + 16, true) });
  }
  const rva = va - imgBase;
  let off = -1;
  for (const s of secs) {
    if (rva >= s.va && rva < s.va + Math.max(s.vsize, s.rsize)) {
      off = s.raw + (rva - s.va);
      break;
    }
  }
  if (off < 0) {
    console.error('VA not in any section');
    process.exit(2);
  }
  for (let i = 0; i < count; i++) {
    const a = va + i * 4;
    const v = dv.getUint32(off + i * 4, true);
    console.error(`0x${a.toString(16)}: 0x${v.toString(16)}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
