import { readFile } from 'node:fs/promises';
import { PeLoaderImpl, WasmRuntimeImpl } from '@specter-core/core';
async function main() {
  const image = new Uint8Array(await readFile('apps/web/public/win/notepad-x64.exe'));
  const runtime = new WasmRuntimeImpl();
  const pe = await new PeLoaderImpl().load(image);
  const base = 0x1000000;
  const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
  const eLfanew = view.getUint32(0x3c, true); const coff = eLfanew + 4;
  const numSections = view.getUint16(coff + 2, true); const sizeOfOpt = view.getUint16(coff + 16, true);
  const sectionTable = coff + 20 + sizeOfOpt;
  for (const sec of pe.sections) {
    const dst = base + sec.virtualAddress; const span = Math.max(sec.virtualSize, sec.rawSize);
    runtime.writeBytes(dst, new Uint8Array(span));
    for (let i = 0; i < numSections; i++) {
      const s = sectionTable + i * 40;
      if (view.getUint32(s + 12, true) === sec.virtualAddress) {
        const rawOff = view.getUint32(s + 20, true); const rawSize = view.getUint32(s + 16, true);
        const n = Math.min(rawSize, Math.max(0, image.byteLength - rawOff));
        if (n > 0) runtime.writeBytes(dst, image.subarray(rawOff, rawOff + n)); break;
      }
    }
  }
  // dump delay-load IAT slots around 0x102a350-0x102a480 (already relocated in file? no — raw)
  for (const a of [0x102a370, 0x102a378, 0x102a440, 0x102a448, 0x102a450, 0x102a458]) {
    const dv = new DataView(runtime.readBytes(a, 8).buffer);
    console.log(`[slot 0x${a.toString(16)}] = 0x${dv.getBigUint64(0, true).toString(16)}`);
  }
}
main();
