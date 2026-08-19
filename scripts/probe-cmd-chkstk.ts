/**
 * Temporary probe: execute cmd.exe's __chkstk (0x424c80) in isolation.
 * cmd's big init fn (0x40af19) requests 0x1040 bytes of stack via
 * `mov eax, 0x1040; call 0x424c80`. This variant has the cross-page
 * probe loop (jb 0x424ca2 -> sub eax,0x1000; test; jmp 0x424c94),
 * unlike notepad's 0x427330. Verifies the JIT handles the loop +
 * `xchg esp, eax` + ret-to-relocated-return-address correctly.
 */
import { readFile } from 'node:fs/promises';
import { JitEngineImpl, PeLoaderImpl, WasmRuntimeImpl, REG32_LIST } from '@bk/core';

const image = new Uint8Array(await readFile('C:/Windows/SysWOW64/cmd.exe'));
const runtime = new WasmRuntimeImpl();
const loader = new PeLoaderImpl();
const pe = await loader.load(image);
const { mapPeImage } = await import('@bk/core');
mapPeImage(runtime, image, pe);

// stack: top at 0x08000000; emulate "call 0x424c80" -> [esp]=return address
const CALLER_RET = 0x40af26;
const stackTop = 0x08000000;
runtime.ensure(stackTop + 0x1000);
runtime.writeInt32(stackTop - 4, CALLER_RET);
runtime.setReg('esp', stackTop - 4);
runtime.setReg('eax', 0x1040); // requested stack size (from 0x40af19)
runtime.setReg('ecx', 0x11111111); // a recognizable saved value

const jit = new JitEngineImpl(runtime);
const executor = new (await import('@bk/core')).Executor(runtime, jit, undefined, {
  onStep: (eip) => {
    const e = runtime.getReg('esp');
    const a = runtime.getReg('eax');
    const c = runtime.getReg('ecx');
    console.error(`[step] 0x${eip.toString(16)} esp=0x${(e >>> 0).toString(16)} eax=0x${(a >>> 0).toString(16)} ecx=0x${(c >>> 0).toString(16)}`);
  },
});
const bytes = runtime.readBytes(0x424c80, 44);
console.error(`[code@424c80] ${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);
const result = await executor.run(0x424c80);
const dump = REG32_LIST.map((n) => `${n}=0x${(runtime.getReg(n) >>> 0).toString(16)}`).join(' ');
console.log(`status=${result.status} eip=0x${result.eip.toString(16)} | ${dump}`);
console.log(`[stackTop-4]=0x${(runtime.readInt32(stackTop - 4) >>> 0).toString(16)} (ret addr)`);
console.log(`[esp]=0x${(runtime.readInt32(runtime.getReg('esp')) >>> 0).toString(16)} (should be 0x${CALLER_RET.toString(16)})`);
console.log(`esp now=0x${(runtime.getReg('esp') >>> 0).toString(16)} expected=0x${((stackTop - 4 - 0x1040 + 4) >>> 0).toString(16)}`);
