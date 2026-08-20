/**
 * Headless x64 decoder walk: decode instructions one at a time from `eip`,
 * printing every op, and stopping after a bounded number of instructions or
 * on the first unsupported opcode.
 *
 *   node scripts/diag-x64.mjs <exe> <eip-hex> [count]
 */
import { readFile } from 'node:fs/promises';
import {
  PeLoaderImpl,
  UnsupportedError,
  WasmRuntimeImpl,
  X86Decoder,
} from '@specter-core/core';

async function main(): Promise<void> {
  const [file, eipHex, countArg] = process.argv.slice(2);
  if (!file) {
    console.error('usage: diag-x64 <exe> <eip-hex> [count]');
    process.exit(2);
  }
  const image = new Uint8Array(await readFile(file));
  const runtime = new WasmRuntimeImpl();
  const loader = new PeLoaderImpl();
  const pe = await loader.load(image);

  // Map the image the same way the runner does so addresses line up.
  const base = pe.baseAddress > 0xf0000000 ? 0x01000000 : pe.baseAddress;
  const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
  const eLfanew = view.getUint32(0x3c, true);
  const coff = eLfanew + 4;
  const numSections = view.getUint16(coff + 2, true);
  const sizeOfOpt = view.getUint16(coff + 16, true);
  const sectionTable = coff + 20 + sizeOfOpt;
  for (const sec of pe.sections) {
    const dst = base + sec.virtualAddress;
    const span = Math.max(sec.virtualSize, sec.rawSize);
    runtime.writeBytes(dst, new Uint8Array(span));
    for (let i = 0; i < numSections; i++) {
      const s = sectionTable + i * 40;
      if (view.getUint32(s + 12, true) === sec.virtualAddress) {
        const rawOff = view.getUint32(s + 20, true);
        const rawSize = view.getUint32(s + 16, true);
        const n = Math.min(rawSize, Math.max(0, image.byteLength - rawOff));
        if (n > 0) runtime.writeBytes(dst, image.subarray(rawOff, rawOff + n));
        break;
      }
    }
  }

  const eip = eipHex ? parseInt(eipHex, 16) : pe.entryPoint - pe.baseAddress + base;
  const max = countArg ? parseInt(countArg, 10) : 400;
  console.error(`[diag-x64] ${file} base=0x${base.toString(16)} start=0x${eip.toString(16)}`);

  const decoder = new X86Decoder('x64');
  const bytes = runtime.readBytes(eip, 4096);
  let off = 0;
  let printed = 0;
  let lastInst: { inst: { op: string; dst?: { size?: number; kind?: string }; src?: { size?: number; kind?: string } } } | null = null;
  while (printed < max && off < bytes.byteLength) {
    let len = -1;
    let op: string | null = null;
    let dstReg: string | null = null;
    let found = false;
    // Grow the buffer until one complete instruction decodes (max 15 bytes).
    for (let want = 1; want <= 15 && !found; want++) {
      const chunk = bytes.subarray(off, off + want);
      if (chunk.byteLength === 0) break;
      try {
        const res = decoder.decode(chunk, eip + off);
        if (res.instructions.length > 0) {
          const di = res.instructions[0];
          len = di.length;
          op = di.inst.op;
          lastInst = di;
          if (di.inst.dst?.kind === 'reg') dstReg = di.inst.dst.reg ?? null;
          found = true;
          break;
        }
      } catch (err) {
        if (err instanceof UnsupportedError && err.message === 'unexpected end of block') {
          // need more bytes
          continue;
        }
        // Real unsupported opcode: report and advance past the offending byte.
        const at = err instanceof UnsupportedError ? err.address : eip + off;
        console.error(`  >>> unsupported @0x${at.toString(16)}: ${err instanceof UnsupportedError ? err.message : String(err)}`);
        // try to advance one byte past the failing opcode
        len = Math.max(1, at - (eip + off) + 1);
        found = true;
        op = null;
        break;
      }
    }
    if (!found) {
      console.error(`  >>> cannot make progress @0x${(eip + off).toString(16)}`);
      break;
    }
    if (op) {
      const di2 = lastInst?.inst as { op: string; dst?: { size?: number; kind?: string }; src?: { size?: number; kind?: string } } | undefined;
      const d = di2?.dst ? `${di2.dst.kind}:${di2.dst.size ?? '?'}` : '-';
      const s = di2?.src ? `${di2.src.kind}:${di2.src.size ?? '?'}` : '-';
      console.error(`  0x${(eip + off).toString(16).padStart(8, '0')}  ${op} dst=${d} src=${s}`);
      printed++;
    } else {
      printed++;
    }
    off += len;
  }
}

main().catch((error) => {
  console.error('[diag-x64] failed', error);
  process.exit(1);
});