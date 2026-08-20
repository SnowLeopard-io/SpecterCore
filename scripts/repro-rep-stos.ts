/**
 * Isolate the CF bug further: dump EFLAGS right after `shr ecx,1`.
 */
import { JitEngineImpl, WasmRuntimeImpl } from '@specter-core/core';
import { Executor } from '../packages/core/src/jit/executor';

async function main(): Promise<void> {
  const hex = (...b: number[]): Uint8Array => new Uint8Array(b);

  // mov ecx, 13; shr ecx, 1; hlt  -> CF should be 1
  {
    const runtime = new WasmRuntimeImpl(64);
    const jit = new JitEngineImpl(runtime);
    const executor = new Executor(runtime, jit);
    const base = 0x100000;
    runtime.writeBytes(base, hex(0xb9, 0x0d, 0x00, 0x00, 0x00, 0xd1, 0xe9, 0xf4));
    runtime.setEip(base);
    runtime.setReg('eflags', 0x2);
    await executor.run(base);
    const ecx = runtime.getReg('ecx') >>> 0;
    const eflags = runtime.getReg('eflags') >>> 0;
    console.error(`[shr1] ecx=${ecx} eflags=0x${eflags.toString(16)} CF=${eflags & 1} (expect ecx=6 CF=1)`);
  }

  // mov ecx, 13; shr ecx, 2; hlt -> CF should be bit1 of 13 = 0
  {
    const runtime = new WasmRuntimeImpl(64);
    const jit = new JitEngineImpl(runtime);
    const executor = new Executor(runtime, jit);
    const base = 0x100000;
    runtime.writeBytes(base, hex(0xb9, 0x0d, 0x00, 0x00, 0x00, 0xc1, 0xe9, 0x02, 0xf4));
    runtime.setEip(base);
    runtime.setReg('eflags', 0x2);
    await executor.run(base);
    const ecx = runtime.getReg('ecx') >>> 0;
    const eflags = runtime.getReg('eflags') >>> 0;
    console.error(`[shr2] ecx=${ecx} eflags=0x${eflags.toString(16)} CF=${eflags & 1} (expect ecx=3 CF=0)`);
  }

  // mov ecx, 13; shl ecx, 1; hlt -> CF = bit31? no: shl 1 -> CF = bit(32-1)=31 of a = 0
  {
    const runtime = new WasmRuntimeImpl(64);
    const jit = new JitEngineImpl(runtime);
    const executor = new Executor(runtime, jit);
    const base = 0x100000;
    runtime.writeBytes(base, hex(0xb9, 0x0d, 0x00, 0x00, 0x00, 0xd1, 0xe1, 0xf4));
    runtime.setEip(base);
    runtime.setReg('eflags', 0x2);
    await executor.run(base);
    const ecx = runtime.getReg('ecx') >>> 0;
    const eflags = runtime.getReg('eflags') >>> 0;
    console.error(`[shl1] ecx=${ecx} eflags=0x${eflags.toString(16)} CF=${eflags & 1} (expect ecx=26 CF=0)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
