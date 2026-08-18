/** What IR does the decoder produce for `3b fb` (cmp edi,ebx)? */
import { buildBlockFunction, X86Decoder } from '@bk/core';
import type { Operand } from '@bk/core';

function fmt(op: Operand | undefined): string {
  if (!op) return '-';
  if (op.kind === 'reg') return `${op.reg}:${op.size}`;
  if (op.kind === 'mem') return `[${op.base ?? ''}+${op.index ?? ''}*${op.scale}+${op.disp}]:${op.size}`;
  if (op.kind === 'imm') return `imm${op.value}`;
  if (op.kind === 'rel') return `rel${op.delta}`;
  return op.kind;
}

function main(): void {
  const decoder = new X86Decoder('x86');
  const code = new Uint8Array([0x3b, 0xfb, 0xb8, 0x11, 0x11, 0x11, 0x11, 0xc3]);
  const decoded = decoder.decode(code, 0x300000);
  for (const di of decoded.instructions) {
    console.error(`IR: op=${di.inst.op} dst=${fmt(di.inst.dst)} src=${fmt(di.inst.src)} len=${di.length} term=${di.terminator}`);
  }
  const fn = buildBlockFunction(
    decoded.instructions.map((d) => ({ inst: d.inst, nextAddress: d.nextAddress })),
    { terminated: decoded.terminated, endAddress: decoded.endAddress, mode: 'x86' },
  );
  const { body } = fn.codeSectionEntry();
  console.error('body:', body.map((b) => b.toString(16).padStart(2, '0')).join(' '));
}

main();
