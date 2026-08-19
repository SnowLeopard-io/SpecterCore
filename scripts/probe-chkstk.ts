/**
 * Temporary probe: execute notepad's __chkstk (0x427330) in isolation to
 * verify the JIT's push/pop/xchg/ret stack handling across blocks.
 * Sets esp to a known stack with a fake return address, eax = 0x146c
 * (the stack size the caller at 0x40b3a9 requests), and runs the block.
 */
import { readFile } from 'node:fs/promises';
import { JitEngineImpl, PeLoaderImpl, WasmRuntimeImpl, REG32_LIST } from '@specter-core/core';

const image = new Uint8Array(await readFile('C:/Windows/SysWOW64/notepad.exe'));
const runtime = new WasmRuntimeImpl();
const loader = new PeLoaderImpl();
const pe = await loader.load(image);
// map manually (mirror of mapPeImage without stubs) — reuse via runner is
// simpler: construct runner without running, but mapPeImage is exported.
const { mapPeImage } = await import('@specter-core/core');
mapPeImage(runtime, image, pe);

// stack: top at 0x08000000; emulate "call 0x427330" -> [esp]=return address
const CALLER_RET = 0x413455;
const stackTop = 0x08000000;
runtime.ensure(stackTop + 0x1000);
runtime.writeInt32(stackTop - 4, CALLER_RET);
runtime.setReg('esp', stackTop - 4);
runtime.setReg('eax', 0x146c); // requested stack size (from 0x40b3a9)
runtime.setReg('ecx', 0x11111111); // a recognizable saved value

const jit = new JitEngineImpl(runtime);
const executor = new (await import('@specter-core/core')).Executor(runtime, jit, undefined, {
  onStep: (eip) => console.error(`[step] 0x${eip.toString(16)}`),
});
const bytes = runtime.readBytes(0x427330, 16);
console.error(`[code@427330] ${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);
const result = await executor.run(0x427330);
const dump = REG32_LIST.map((n) => `${n}=0x${(runtime.getReg(n) >>> 0).toString(16)}`).join(' ');
console.log(`status=${result.status} eip=0x${result.eip.toString(16)} | ${dump}`);
console.log(`[stackTop-4]=0x${(runtime.readInt32(stackTop - 4) >>> 0).toString(16)}`);
