import { describe, expect, it } from 'vitest';
import { X86Decoder, UnsupportedError } from './x86-decoder';

const dec = new X86Decoder();

function decode(code: number[], address = 0x1000) {
  return dec.decode(new Uint8Array(code), address);
}

function first(code: number[], address = 0x1000) {
  return decode(code, address).instructions[0]!;
}

describe('X86Decoder', () => {
  it('decodes mov r32, imm32', () => {
    const r = decode([0xb8, 0x2a, 0x00, 0x00, 0x00]);
    expect(r.instructions).toHaveLength(1);
    const { inst, length } = r.instructions[0]!;
    expect(inst.op).toBe('mov');
    expect(inst.dst).toMatchObject({ kind: 'reg', reg: 'eax', size: 32 });
    expect(inst.src).toMatchObject({ kind: 'imm', value: 0x2a });
    expect(length).toBe(5);
  });

  it('decodes 16-bit registers with 66 prefix', () => {
    const { inst } = first([0x66, 0xb8, 0x34, 0x12]);
    expect(inst.dst).toMatchObject({ kind: 'reg', reg: 'ax', size: 16 });
    expect(inst.src).toMatchObject({ kind: 'imm', value: 0x1234 });
  });

  it('decodes 8-bit register writes', () => {
    const { inst } = first([0xb0, 0xff]);
    expect(inst.dst).toMatchObject({ kind: 'reg', reg: 'al', size: 8 });
    expect(inst.src).toMatchObject({ kind: 'imm', value: 0xff });
  });

  it('decodes add r/m32, r32 with ModRM', () => {
    // add [ebp-4], ebx
    const { inst, length } = first([0x01, 0x5d, 0xfc]);
    expect(inst.op).toBe('add');
    expect(inst.dst).toMatchObject({ kind: 'mem', size: 32 });
    expect(inst.src).toMatchObject({ kind: 'reg', reg: 'ebx' });
    expect(length).toBe(3);
  });

  it('decodes SIB addressing', () => {
    // mov eax, [esi*4 + 0x10]
    const { inst, length } = first([0x8b, 0x04, 0xb5, 0x10, 0x00, 0x00, 0x00]);
    expect(inst.op).toBe('mov');
    expect(inst.src!.kind).toBe('mem');
    expect(length).toBe(7);
  });

  it('decodes push/pop', () => {
    expect(first([0x55]).inst.op).toBe('push');
    expect(first([0x5d]).inst.op).toBe('pop');
  });

  it('decodes conditional jump with relative offset', () => {
    const { inst, length } = first([0x75, 0x03]);
    expect(inst.op).toBe('jcc');
    expect(inst.cond).toBe('ne');
    expect(inst.target).toMatchObject({ kind: 'rel', delta: 3, size: 8 });
    expect(length).toBe(2);
  });

  it('decodes call rel32 with target', () => {
    const { inst, terminator } = first([0xe8, 0x10, 0x00, 0x00, 0x00]);
    expect(inst.op).toBe('call');
    expect(inst.target).toMatchObject({ kind: 'rel', delta: 0x10, size: 32 });
    expect(terminator).toBe(true);
  });

  it('decodes REP string instructions', () => {
    const { inst } = first([0xf3, 0xab]);
    expect(inst.op).toBe('stos');
    expect(inst.rep).toBe(true);
  });

  it('decodes movzx/movsx', () => {
    expect(first([0x0f, 0xb6, 0xc0]).inst.op).toBe('movzx');
    expect(first([0x0f, 0xbe, 0xc0]).inst.op).toBe('movsx');
  });

  it('decodes group opcodes', () => {
    // imul eax, eax, 5 (69 /r)
    const imul = first([0x69, 0xc0, 0x05, 0x00, 0x00, 0x00]);
    expect(imul.inst.op).toBe('imul');
    expect(imul.inst.target).toMatchObject({ kind: 'imm', value: 5 });
    expect(first([0xf7, 0xd0]).inst.op).toBe('not');
    expect(first([0xf7, 0xd8]).inst.op).toBe('neg');
    expect(first([0xf7, 0xe0]).inst.op).toBe('mul');
    expect(first([0xf7, 0xf1]).inst.op).toBe('div');
  });

  it('marks terminators', () => {
    expect(first([0xc3]).terminator).toBe(true);
    expect(first([0xeb, 0x00]).terminator).toBe(true);
    expect(first([0xcd, 0x2e]).terminator).toBe(true);
    expect(first([0xf4]).terminator).toBe(true);
    expect(first([0x90]).terminator).toBe(false);
  });

  it('decodes RDTSC (0F 31) as a no-operand op', () => {
    const { inst, length } = first([0x0f, 0x31]);
    expect(inst.op).toBe('rdtsc');
    expect(length).toBe(2);
  });

  it('decodes CPUID (0F A2) as a no-operand op', () => {
    const { inst, length } = first([0x0f, 0xa2]);
    expect(inst.op).toBe('cpuid');
    expect(length).toBe(2);
  });

  it('throws on unsupported opcodes', () => {
    expect(() => decode([0x0f, 0x2e, 0xc0])).toThrow(UnsupportedError); // ucomiss (sse)
    expect(() => decode([0xd9, 0x24, 0x24])).toThrow(UnsupportedError); // fldcw with reg=4 (x87 group)
    expect(() => decode([0x0f, 0xc8])).toThrow(UnsupportedError); // 0F C8 = BSWAP (unsupported)
  });

  it('reports unterminated blocks instead of throwing', () => {
    // 128 bytes of 0x90 (nop) never terminates
    const r = dec.decode(new Uint8Array(128).fill(0x90), 0x1000);
    expect(r.terminated).toBe(false);
    expect(r.instructions).toHaveLength(128);
    expect(r.endAddress).toBe(0x1080);
  });
});