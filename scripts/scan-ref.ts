import { readFile } from 'node:fs/promises';

async function main(): Promise<void> {
  const exe = process.argv[2];
  const targets = process.argv.slice(3).map((s) => Number(s) >>> 0);
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

  for (const t of targets) {
    const needle = Buffer.from([t & 0xff, (t >>> 8) & 0xff, (t >>> 16) & 0xff, (t >>> 24) & 0xff]);
    const hits: string[] = [];
    for (const s of secs) {
      if (s.rsize === 0) continue;
      let idx = -1;
      const start = s.raw;
      const end = s.raw + s.rsize;
      while (true) {
        idx = buf.indexOf(needle, start + idx + 1);
        if (idx === -1 || idx >= end) break;
        const va = imgBase + s.va + (idx - start);
        hits.push(`0x${va.toString(16)} (${s.name})`);
      }
    }
    console.error(`[ref] 0x${t.toString(16)} referenced at: ${hits.join(', ') || 'NONE'}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
