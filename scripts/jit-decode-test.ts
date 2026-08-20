/** Decode `8b 5d 08` (mov ebx,[ebp+8]) and the prologue snippet with the real decoder. */
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
const code = new Uint8Array([0x55, 0x8b, 0xec, 0x81, 0xec, 0x0c, 0x0d, 0x00, 0x00, 0x53, 0x8b, 0x5d, 0x08, 0x5b, 0x8b, 0xe5, 0x5d, 0xc3]);
const r = d.decode(code, 0x413261);
for (const di of r.instructions) {
  sync(`0x${di.nextAddress - di.length}..0x${di.nextAddress}: ${JSON.stringify(di.inst)} term=${di.terminator}`);
}
