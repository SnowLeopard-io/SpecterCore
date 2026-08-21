/**
 * Resolve an IAT address to DLL!Function via the PE import directory.
 */
import { readFile } from 'node:fs/promises';

async function main(): Promise<void> {
  const exe = process.argv[2] ?? 'C:/Windows/SysWOW64/notepad.exe';
  const target = parseInt(process.argv[3] ?? '42a208', 16);
  const buf = await readFile(exe);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const peOff = dv.getUint32(0x3c, true);
  const numSections = dv.getUint16(peOff + 6, true);
  const optSize = dv.getUint16(peOff + 20, true);
  const imgBase = dv.getUint32(peOff + 24 + 28, true);
  const secTab = peOff + 24 + optSize;
  const impDirRva = dv.getUint32(peOff + 24 + 104, true); // import table RVA

  const rvaToOff = (rva: number): number | null => {
    for (let i = 0; i < numSections; i++) {
      const off = secTab + i * 40;
      const vaddr = dv.getUint32(off + 12, true);
      const vsize = dv.getUint32(off + 8, true);
      const rawPtr = dv.getUint32(off + 20, true);
      const rsize = dv.getUint32(off + 16, true);
      if (rva >= vaddr && rva < vaddr + Math.max(vsize, rsize)) return rawPtr + (rva - vaddr);
    }
    return null;
  };

  const impOff = rvaToOff(impDirRva);
  if (impOff === null) {
    console.error('no import dir');
    process.exit(2);
  }
  for (let d = 0; d < 64; d++) {
    const desc = impOff + d * 20;
    const nameRva = dv.getUint32(desc + 12, true);
    const iatRva = dv.getUint32(desc + 16, true);
    if (!nameRva || !iatRva) break;
    const nameOff = rvaToOff(nameRva);
    const iatOff = rvaToOff(iatRva);
    if (nameOff === null || iatOff === null) continue;
    let dllName = '';
    for (let i = nameOff; buf[i]; i++) dllName += String.fromCharCode(buf[i]);
    // Walk the IAT looking for the target VA.
    let idx = 0;
    for (;;) {
      const entry = dv.getUint32(iatOff + idx * 4, true);
      if (!entry) break;
      const iatVa = imgBase + iatRva + idx * 4;
      if (iatVa === target) {
        // Resolve function name from the hint/name entry.
        const hintOff = rvaToOff(entry & 0x7fffffff);
        let fnName = '';
        if (hintOff !== null) {
          for (let i = hintOff + 2; buf[i]; i++) fnName += String.fromCharCode(buf[i]);
        }
        console.log(`0x${target.toString(16)} = ${dllName}!${fnName}`);
        process.exit(0);
      }
      idx += 1;
    }
  }
  console.error(`0x${target.toString(16)} not found in imports`);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
