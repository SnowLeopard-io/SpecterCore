/**
 * Minimal JIT reproduction: compile & run the notepad prologue snippet
 *   55 8b ec 81 ec 0c 0d 00 00 53 8b 5d 08 5b 8b e5 5d c3
 * (push ebp; mov ebp,esp; sub esp,0xd0c; push ebx; mov ebx,[ebp+8];
 *  pop ebx; mov esp,ebp; pop ebp; ret)
 * and report the ebx value the JIT loads — notepad at 0x413277 ends up
 * with ebx=0x60 while [ebp+8] holds 0x20003b0, so this must reproduce 0x60.
 */
import { WasmRuntimeImpl } from '../packages/core/src/jit/runtime';
import { JitEngineImpl } from '../packages/core/src/jit/engine';
import { Executor } from '../packages/core/src/jit/executor';

const sync = (line: string): void => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('node:fs').writeSync(2, `${line}\n`);
  } catch {
    console.error(line);
  }
};

async function main(): Promise<void> {
  const rt = new WasmRuntimeImpl();
  const engine = new JitEngineImpl(rt);
  const SP = 0x7ffff00;
  // stack: [SP+0]=retaddr, [SP+4]=arg1=0x20003b0, [SP+8]=arg2=0xa
  rt.writeInt32(SP + 0, 0x12345678);
  rt.writeInt32(SP + 4, 0x20003b0);
  rt.writeInt32(SP + 8, 0xa);
  rt.writeInt32(SP + 12, 0xdeadbeef);
  rt.setReg('esp', SP);
  rt.setReg('ebp', SP);
  // bytes: 55 8b ec 81 ec 0c 0d 00 00 53 8b 5d 08 8b e5 5d c3
  // (push ebp; mov ebp,esp; sub esp,0xd0c; push ebx; mov ebx,[ebp+8];
  //  mov esp,ebp; pop ebp; ret) — NO pop ebx before the mov so ebx stays live.
  const code = new Uint8Array([
    0x55, 0x8b, 0xec, // push ebp; mov ebp, esp
    0x81, 0xec, 0x0c, 0x0d, 0x00, 0x00, // sub esp, 0xd0c
    0x53, 0x8b, 0x5d, 0x08, // push ebx; mov ebx, [ebp+8]
    0x8b, 0xe5, 0x5d, 0xc3, // mov esp, ebp; pop ebp; ret
  ]);
  const base = 0x400000;
  rt.writeBytes(base, code);
  const executor = new Executor(rt, engine);
  const steps: number[] = [];
  const r = await executor.run(base);
  const ebx = rt.getReg('ebx') >>> 0;
  sync(`[jit-test] status=${r.status} eip=0x${r.eip.toString(16)} ebx=0x${ebx.toString(16)} ${ebx === 0x20003b0 ? 'OK' : 'MISMATCH (expect 0x20003b0)'}`);
  sync(`[jit-test] esp=0x${(rt.getReg('esp') >>> 0).toString(16)} ebp=0x${(rt.getReg('ebp') >>> 0).toString(16)}`);
  process.exit(ebx === 0x20003b0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
