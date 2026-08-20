/**
 * 探测含 scas/cmps 的基本块能否被解码 + 编译。
 * 0x40858c 是 Delphi 的宽字符 StrLen，核心是 `f2 66 af` = repnz scasw。
 * 只读探测，不改任何核心文件。
 */
import { readFileSync } from 'node:fs';
import { JitEngineImpl, WasmRuntimeImpl, X86Decoder } from '@specter-core/core';

// VA -> 文件偏移（.text: va=0x1000 raw=0x400, image_base=0x400000）
const va2off = (va: number): number => 0x400 + (va - 0x400000 - 0x1000);

const exe = readFileSync('D:/Downloads/VSCodeSetup-ia32-1.83.1.exe');

// .text 中 scas/cmps 的 7 处（外加块首 0x40858c / 0x408560 作为入口）
const targets = [0x40858c, 0x408560, 0x405fb4, 0x41a6c3, 0x41a6d4, 0x41a6e6, 0x41a6f0, 0x44f62d];

let decodeFail = 0;
let compileFail = 0;

for (const va of targets) {
  const off = va2off(va);
  const bytes = new Uint8Array(exe.subarray(off, off + 64));
  console.log(`\n=== VA 0x${va.toString(16)} (off 0x${off.toString(16)}) ===`);
  console.log('bytes:', [...bytes.slice(0, 20)].map((b) => b.toString(16).padStart(2, '0')).join(' '));

  const dec = new X86Decoder('x86');
  try {
    const r = dec.decode(bytes, va);
    console.log(`decode OK: terminated=${r.terminated} end=0x${(r.endAddress >>> 0).toString(16)}`);
    for (const d of r.instructions) {
      const i = d.inst;
      const flags =
        (i.rep ? ' rep' : '') + (i.repne ? ' repne' : '') + (i.size !== undefined ? ` size=${i.size}` : '');
      console.log(`  -> ${i.op}${flags} (next=0x${(d.nextAddress >>> 0).toString(16)})`);
    }
  } catch (e) {
    const err = e as Error & { address?: number };
    console.log(
      `DECODE ERROR: ${err.message}` + (err.address !== undefined ? ` @0x${(err.address >>> 0).toString(16)}` : ''),
    );
    decodeFail++;
    continue;
  }

  // 解码通过再看能否编译成 WASM 并实例化
  try {
    const rt = new WasmRuntimeImpl();
    rt.ensure(0x500000);
    rt.writeBytes(va, bytes);
    const jit = new JitEngineImpl(rt, 'x86');
    const blk = jit.compile(va);
    console.log(`compile OK: ${blk ? 'block produced' : 'no block'}`);
  } catch (e) {
    console.log(`COMPILE ERROR: ${(e as Error).message}`);
    compileFail++;
  }
}

console.log(`\n=== summary: ${targets.length} targets, decodeFail=${decodeFail} compileFail=${compileFail} ===`);
