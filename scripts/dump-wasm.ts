/**
 * Debug: compile the block starting at `eip` and dump the generated WASM bytes.
 *   node scripts/dump-wasm.mjs <exe> <eip-hex> [count-bytes]
 */
import { readFile } from 'node:fs/promises';
import {
  PeLoaderImpl,
  WasmRuntimeImpl,
  X86Decoder,
} from '@specter-core/core';
import { buildBlockFunction } from '../packages/core/src/jit/codegen';
import { WasmModuleBuilder } from '../packages/core/src/jit/wasm-encoder';

async function main(): Promise<void> {
  const [file, eipHex, nbytes] = process.argv.slice(2);
  const image = new Uint8Array(await readFile(file));
  const runtime = new WasmRuntimeImpl();
  const loader = new PeLoaderImpl();
  const pe = await loader.load(image);
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
  const eip = parseInt(eipHex, 16);
  const len = nbytes ? parseInt(nbytes, 10) : 64;
  const code = runtime.readBytes(eip, len);
  const decoder = new X86Decoder('x64');
  const decoded = decoder.decode(code, eip);
  const fn = buildBlockFunction(decoded.instructions, {
    terminated: decoded.terminated,
    endAddress: decoded.endAddress,
    mode: 'x64',
  });
  const builder = new WasmModuleBuilder();
  const typeIdx = builder.addType([], ['i32']);
  builder.addMemoryImport('env', 'memory', 1);
  builder.defineFunction(typeIdx, fn);
  builder.exportFunction('run', 0);
  const bytes = builder.build();
  console.log(`[dump-wasm] eip=0x${eip.toString(16)} decodedLen=${decoded.length} terminated=${decoded.terminated} bytes=${bytes.byteLength}`);
  try {
    const mod = new WebAssembly.Module(bytes as unknown as ArrayBuffer);
    console.log('[dump-wasm] WebAssembly.Module: OK');
  } catch (err) {
    console.log(`[dump-wasm] WebAssembly.Module: ${String(err)}`);
  }
  let line = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    line += bytes[i].toString(16).padStart(2, '0') + ' ';
    if ((i + 1) % 16 === 0) {
      console.log(`  ${(i + 1 - 16).toString(16).padStart(4, '0')}: ${line}`);
      line = '';
    }
  }
  if (line) console.log(`  ${(bytes.byteLength - (bytes.byteLength % 16 || 16)).toString(16).padStart(4, '0')}: ${line}`);
}

main().catch((error) => {
  console.error('[dump-wasm] failed', error);
  process.exit(1);
});