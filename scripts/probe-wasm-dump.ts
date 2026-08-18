/** Dump the compiled WASM for notepad's __chkstk finishing block (0x427348). */
import { readFile } from 'node:fs/promises';
import { PeLoaderImpl, WasmRuntimeImpl, X86Decoder } from '@bk/core';
import { buildBlockFunction } from '../packages/core/src/jit/codegen';
import { WasmModuleBuilder } from '../packages/core/src/jit/wasm-encoder';

const image = new Uint8Array(await readFile('C:/Windows/SysWOW64/notepad.exe'));
const runtime = new WasmRuntimeImpl();
const loader = new PeLoaderImpl();
const pe = await loader.load(image);
// map so readBytes works (needed only to read code)
const { mapPeImage } = await import('@bk/core');
mapPeImage(runtime, image, pe);

const decoder = new X86Decoder('x86');
for (const addr of [0x427348, 0x427330]) {
  const code = runtime.readBytes(addr, 64);
  const decoded = decoder.decode(code, addr);
  const fn = buildBlockFunction(decoded.instructions, { terminated: decoded.terminated, endAddress: decoded.endAddress, mode: 'x86' });
  const builder = new WasmModuleBuilder();
  const typeIdx = builder.addType([], ['i32']);
  builder.addMemoryImport('env', 'memory', 1);
  builder.defineFunction(typeIdx, fn);
  builder.exportFunction('run', 0);
  const bytes = builder.build();
  console.log(`=== block @ 0x${addr.toString(16)} (${decoded.instructions.length} insns, terminated=${decoded.terminated}, end=0x${decoded.endAddress.toString(16)}) ===`);
  console.log(Buffer.from(bytes).toString('hex').replace(/(..)/g, '$1 ').trim());
  console.log('');
}
