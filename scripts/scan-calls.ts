/**
 * Scan .text for `call 0x40f04c` (notepad's argv-skipping tokenizer) and dump
 * IAT entries for a few addresses so we can map 0x42a370 etc. to API names.
 */
import { readFile } from 'node:fs/promises';

async function main(): Promise<void> {
  const exe = 'C:/Windows/SysWOW64/notepad.exe';
  const buf = await readFile(exe);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const peOff = dv.getUint32(0x3c, true);
  const numSections = dv.getUint16(peOff + 6, true);
  const optSize = dv.getUint16(peOff + 20, true);
  const imgBase = dv.getUint32(peOff + 24 + 28, true);
  const secTab = peOff + 24 + optSize;

  const secs: Array<{ va: number; vsize: number; raw: number; rsize: number }> = [];
  for (let i = 0; i < numSections; i++) {
    const off = secTab + i * 40;
    secs.push({
      va: dv.getUint32(off + 12, true),
      vsize: dv.getUint32(off + 8, true),
      raw: dv.getUint32(off + 20, true),
      rsize: dv.getUint32(off + 16, true),
    });
  }
  const rvaToOff = (rva: number): number | null => {
    for (const s of secs) {
      if (rva >= s.va && rva < s.va + Math.max(s.vsize, s.rsize)) return s.raw + (rva - s.va);
    }
    return null;
  };
  const vaToOff = (va: number): number | null => rvaToOff(va - imgBase);

  // Find the .text section bounds.
  const text = secs.find((s) => s.rsize > 0x1000 && s.raw > 0 && s.vsize > 0x1000);
  if (!text) {
    console.error('no .text section found');
    process.exit(2);
  }
  console.error(`[text] va=0x${(imgBase + text.va).toString(16)} size=0x${text.rsize.toString(16)}`);

  // Scan for call rel32 -> targets
  const targets = [0x40f04c, 0x40f054, 0x40f10b, 0x40f0b1];
  const found = new Map<number, number[]>();
  const start = text.raw;
  const end = text.raw + text.rsize;
  for (let off = start; off + 5 <= end; off++) {
    if (buf[off] === 0xe8) {
      const rel = dv.getInt32(off + 1, true);
      const callVa = imgBase + text.va + (off - start);
      const nextVa = callVa + 5;
      const target = (nextVa + rel) >>> 0;
      if (targets.includes(target)) {
        const list = found.get(target) ?? [];
        list.push(callVa);
        found.set(target, list);
      }
    }
  }
  for (const t of targets) {
    console.error(`[scan] call 0x${t.toString(16)} at: ${(found.get(t) ?? []).map((f) => '0x' + f.toString(16)).join(', ') || 'NONE'}`);
  }

  // Dump IAT entries for interesting addresses.
  for (const iat of [0x42a370, 0x42a374, 0x42a584, 0x42a2a4, 0x42a370 + 0x100]) {
    const off = vaToOff(iat);
    if (off === null) continue;
    const fn = dv.getUint32(off, true);
    console.error(`[iat] 0x${iat.toString(16)} -> fn rva 0x${fn.toString(16)}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
