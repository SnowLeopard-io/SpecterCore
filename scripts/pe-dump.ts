/**
 * Dump raw bytes around a VA in a PE file, mapping VA -> file offset via the
 * section table. Used to hand-decode notepad's command-line tokenizer.
 *
 *   node scripts/pe-dump.ts <exe> <va> <length>
 */
import { readFile } from 'node:fs/promises';

async function main(): Promise<void> {
  const [exe, vaStr, lenStr] = process.argv.slice(2);
  if (!exe || !vaStr) {
    console.error('usage: pe-dump <exe> <va-hex> [len-hex]');
    process.exit(2);
  }
  const va = parseInt(vaStr, 16);
  const len = parseInt(lenStr ?? '100', 16);
  const buf = await readFile(exe);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const peOff = dv.getUint32(0x3c, true);
  const numSections = dv.getUint16(peOff + 6, true);
  const optSize = dv.getUint16(peOff + 20, true);
  const imgBase = dv.getUint32(peOff + 24 + 28, true); // ImageBase
  const secTab = peOff + 24 + optSize;
  let mapped = false;
  for (let i = 0; i < numSections; i++) {
    const off = secTab + i * 40;
    const vaddr = dv.getUint32(off + 12, true);
    const vsize = dv.getUint32(off + 8, true);
    const rawPtr = dv.getUint32(off + 20, true);
    const rawSize = dv.getUint32(off + 16, true);
    const rva = va - imgBase;
    if (rva >= vaddr && rva < vaddr + Math.max(vsize, rawSize)) {
      const fileOff = rawPtr + (rva - vaddr);
      const bytes = buf.subarray(fileOff, fileOff + len);
      console.error(`[pe] section #${i} vaddr=0x${vaddr.toString(16)} file=0x${fileOff.toString(16)} len=${bytes.length}`);
      const lines: string[] = [];
      for (let j = 0; j < bytes.length; j += 16) {
        const addr = va + j;
        const hex = [...bytes.subarray(j, j + 16)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
        lines.push(`${addr.toString(16).padStart(8, '0')}: ${hex}`);
      }
      console.log(lines.join('\n'));
      mapped = true;
      break;
    }
  }
  if (!mapped) console.error(`[pe] VA 0x${va.toString(16)} not in any section (imgBase=0x${imgBase.toString(16)})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
