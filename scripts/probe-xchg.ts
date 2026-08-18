import { X86Decoder, WasmRuntimeImpl } from '@bk/core';
import { buildBlockFunction } from '../packages/core/src/jit/codegen';
import { WasmModuleBuilder } from '../packages/core/src/jit/wasm-encoder';

const runtime = new WasmRuntimeImpl();
// bytes: 94 = xchg eax, esp ; c3 = ret
const code = new Uint8Array([0x94, 0xc3]);
const decoder = new X86Decoder('x86');
const decoded = decoder.decode(code, 0x1000);
console.error(
  'decoded:',
  decoded.instructions
    .map((d) => `${d.inst.op} dst=${JSON.stringify(d.inst.dst)} src=${JSON.stringify(d.inst.src)}`)
    .join(' | '),
);
const fn = buildBlockFunction(decoded.instructions, { terminated: decoded.terminated, endAddress: decoded.endAddress, mode: 'x86' });
const builder = new WasmModuleBuilder();
builder.addType([], ['i32']);
builder.addMemoryImport('env', 'memory', 1);
builder.defineFunction(0, fn);
builder.exportFunction('run', 0);
const bytes = builder.build();
console.log(Buffer.from(bytes).toString('hex').replace(/(..)/g, '$1 ').trim());
// execute: esp=0x2000, eax=0x100, [0x2000]=0xdeadbeef
runtime.ensure(0x3000);
runtime.writeInt32(0x2000, 0xdeadbeef);
runtime.setReg('esp', 0x2000);
runtime.setReg('eax', 0x100);
const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), { env: { memory: runtime.memory } });
const status = inst.exports.run();
console.log(
  `status=${status} eax=0x${(runtime.getReg('eax') >>> 0).toString(16)} esp=0x${(runtime.getReg('esp') >>> 0).toString(16)} eip=0x${(runtime.getEip() >>> 0).toString(16)}`,
);
