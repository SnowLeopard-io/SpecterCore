/** Targeted decode tests for the suspicious instructions in notepad's 0x40cbe6
 * scan loop:
 *   a) b8 ff ff ff 7f        mov eax, 0x7fffffff
 *   b) 66 83 3e 00           cmp word ptr [esi], 0
 *   c) 66 83 3e 00 74 08     cmp + je (as a block)
 *   d) 2b f3 d1 fe           sub esi, ebx; sar esi, 1
 */
import { X86Decoder } from '../packages/core/src/jit/x86-decoder';

const sync = (line: string): void => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('node:fs').writeSync(2, `${line}\n`);
  } catch {
    console.error(line);
  }
};

const d = new X86Decoder('x86');
const cases: Array<{ name: string; va: number; bytes: number[] }> = [
  { name: 'a) mov eax,0x7fffffff', va: 0x40cc07, bytes: [0xb8, 0xff, 0xff, 0xff, 0x7f] },
  { name: 'b) cmp word ptr [esi],0', va: 0x40cc17, bytes: [0x66, 0x83, 0x3e, 0x00] },
  { name: 'c) cmp+je block', va: 0x40cc17, bytes: [0x66, 0x83, 0x3e, 0x00, 0x74, 0x08, 0x83, 0xc6, 0x02, 0x83, 0xe8, 0x01, 0x75, 0xf2] },
  { name: 'd) sub esi,ebx; sar esi,1', va: 0x40cc25, bytes: [0x2b, 0xf3, 0xd1, 0xfe] },
];
for (const c of cases) {
  sync(`--- ${c.name} @0x${c.va.toString(16)} ---`);
  const r = d.decode(new Uint8Array(c.bytes), c.va);
  for (const di of r.instructions) {
    sync(`  va=0x${(c.va + (di.nextAddress - c.va - di.length)).toString(16)}: ${JSON.stringify(di.inst)} term=${di.terminator}`);
  }
  sync(`  total=${r.instructions.length}`);
}
