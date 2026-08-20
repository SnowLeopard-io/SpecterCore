import { readFile } from 'node:fs/promises';

async function main(): Promise<void> {
  const exe = process.argv[2];
  const targets = process.argv.slice(3).map((s) => Number(s));
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
    secs.push({
      name,
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

  const found = new Map<number, Array<{ va: number; op: string }>>();
  for (const t of targets) found.set(t, []);
  for (const s of secs) {
    if (s.rsize === 0) continue;
    const start = s.raw;
    const end = s.raw + s.rsize;
    for (let off = start; off + 5 <= end; off++) {
      const b = buf[off];
      if (b === 0xe8 || b === 0xe9) {
        const rel = dv.getInt32(off + 1, true);
        const callVa = imgBase + s.va + (off - start);
        const nextVa = (callVa + 5) >>> 0;
        const target = (nextVa + rel) >>> 0;
        if (targets.includes(target)) {
          found.get(target)!.push({ va: callVa, op: b === 0xe8 ? 'call' : 'jmp' });
        }
      }
    }
  }
  for (const t of targets) {
    const list = found.get(t)!;
    console.error(
      `[scan] ${list.map((f) => `${f.op} 0x${f.va.toString(16)}`).join(', ') || 'NONE'} -> 0x${t.toString(16)}`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
