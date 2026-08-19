/**
 * Temporary diagnostic: compile the block at a given address to surface
 * codegen errors (TypeError: reading 'kind' etc.) with instruction detail.
 *   node codegen-check.mjs <exe> <addrHex>
 */
import { readFile } from 'node:fs/promises';
import { PeLoaderImpl, mapPeImage, WasmRuntimeImpl, X86Decoder, buildBlockFunction } from '@specter-core/core';

async function main(): Promise<void> {
  const file = process.argv[2];
  const addr = Number.parseInt(process.argv[3] ?? '0', 16);
  const image = new Uint8Array(await readFile(file));
  const runtime = new WasmRuntimeImpl();
  const loader = new PeLoaderImpl();
  const pe = await loader.load(image);
  mapPeImage(runtime, image, pe);
  const decoder = new X86Decoder(pe.is64 ? 'x64' : 'x86');
  const code = runtime.readBytes(addr, 1024);
  const decoded = decoder.decode(code, addr);
  console.error(`decoded ${decoded.instructions.length} instructions, terminated=${decoded.terminated}`);
  for (const di of decoded.instructions) {
    console.error(`  0x${di.nextAddress.toString(16).padStart(8, '0')}: ${di.inst.op} (len ${di.length})`);
  }
  try {
    const fn = buildBlockFunction(decoded.instructions, {
      terminated: decoded.terminated,
      endAddress: decoded.endAddress,
      mode: pe.is64 ? 'x64' : 'x86',
    });
    console.error(`codegen OK (${fn.instrs} wasm instrs)`);
  } catch (err) {
    console.error(`codegen FAILED: ${String(err)}`);
    // find the failing instruction by bisecting
    for (let n = 1; n <= decoded.instructions.length; n++) {
      try {
        buildBlockFunction(decoded.instructions.slice(0, n), {
          terminated: false,
          endAddress: decoded.instructions[n - 1]!.nextAddress,
          mode: pe.is64 ? 'x64' : 'x86',
        });
      } catch (e2) {
        console.error(`  first failing at instruction #${n}: 0x${decoded.instructions[n - 1]!.nextAddress.toString(16)} ${decoded.instructions[n - 1]!.inst.op} -> ${String(e2)}`);
        break;
      }
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
