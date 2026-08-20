/**
 * 反汇编 VSCode 安装器的 entry 函数体（静态），看控制流结构。
 * 仅依赖项目自带的 X86Decoder，不修改任何核心文件。
 */
import { readFileSync } from 'node:fs';
import { X86Decoder } from '@specter-core/core';

const blob = readFileSync('node_modules/.cache/entry.bin');
// entry.bin 是从 entry 文件偏移 0xb4aec 开始 dump 的，所以 blob[0] 就是 entry 第一条指令。
const entryVa = 0x4b5eec;
const bytes = blob; // 从 entry 开始的字节

const dec = new X86Decoder('x86');
// decode 一次性解码整个 buffer；我们只看前若干条
const decoded = dec.decode(bytes as unknown as Uint8Array, entryVa);
const insts = (decoded as unknown as { instructions: Array<{ inst: any; length: number }> }).instructions;

let va = entryVa;
const limit = 260;
const lines: string[] = [];
for (let i = 0; i < Math.min(insts.length, limit); i++) {
  const di = insts[i];
  const op = di.inst?.op ?? '?';
  const ops = di.inst?.operands ?? di.inst?.args ?? '';
  const opStr = Array.isArray(ops) ? ops.join(', ') : String(ops ?? '');
  lines.push(`  ${va.toString(16).padStart(8, '0')}: ${op} ${opStr}`.trimEnd());
  va += di.length;
}
console.error(`[probe] decoded ${insts.length} instructions, showing first ${Math.min(insts.length, limit)}`);
console.error(lines.join('\n'));
