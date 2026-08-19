/**
 * x86 (i386) 32-bit protected-mode decoder (design doc 4.1.1).
 *
 * Decodes straight-line machine code into the IR defined in `ir.ts`. The
 * decoder stops at basic-block terminators (branches, calls, returns, traps),
 * so a block can be compiled as one WASM function. Unsupported opcodes raise
 * `UnsupportedError`; the JIT turns those into faulting blocks.
 */

import type { DecodeResult, DecodedInstruction, Instruction, MemOperand, Operand, RegName, Size } from './ir';
import { COND_BY_NIBBLE } from './cpu';

export class UnsupportedError extends Error {
  constructor(
    public readonly address: number,
    message: string,
  ) {
    super(message);
    this.name = 'UnsupportedError';
  }
}

const REG32: readonly RegName[] = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi'] as const;
const REG16: readonly RegName[] = ['ax', 'cx', 'dx', 'bx', 'sp', 'bp', 'si', 'di'] as const;
const REG8: readonly RegName[] = ['al', 'cl', 'dl', 'bl', 'ah', 'ch', 'dh', 'bh'] as const;
const REG64: readonly RegName[] = ['rax', 'rcx', 'rdx', 'rbx', 'rsp', 'rbp', 'rsi', 'rdi', 'r8', 'r9', 'r10', 'r11', 'r12', 'r13', 'r14', 'r15'] as const;
const REG32_EXT: readonly RegName[] = [...REG32, 'r8d', 'r9d', 'r10d', 'r11d', 'r12d', 'r13d', 'r14d', 'r15d'] as const;
const REG16_EXT: readonly RegName[] = [...REG16, 'r8w', 'r9w', 'r10w', 'r11w', 'r12w', 'r13w', 'r14w', 'r15w'] as const;
/** 8-bit regs with a REX prefix: AH/CH/DH/BH become SPL/BPL/SIL/DIL. */
const REG8_EXT: readonly RegName[] = ['al', 'cl', 'dl', 'bl', 'spl', 'bpl', 'sil', 'dil', 'r8b', 'r9b', 'r10b', 'r11b', 'r12b', 'r13b', 'r14b', 'r15b'] as const;

const GROUP1: readonly Op[] = ['add', 'or', 'adc', 'sbb', 'and', 'sub', 'xor', 'cmp'] as const;
const GROUP2: readonly Op[] = ['rol', 'ror', 'rcl', 'rcr', 'shl', 'shr', 'sar'] as const;
const GROUP3: readonly Op[] = ['test', 'test', 'not', 'neg', 'mul', 'imul', 'div', 'idiv'] as const;
const GROUP5: readonly Op[] = ['inc', 'dec', 'call', 'nop', 'jmp', 'nop', 'push', 'nop'] as const;

type Op = Instruction['op'];

interface RawRm {
  reg: RegName | null;
  modrmReg: number;
  mem: { base?: RegName; index?: RegName; scale: 1 | 2 | 4 | 8; disp: number } | null;
}

/** Raw ModRM fields for XMM ops: `reg` carries REX.R, `rmReg` carries REX.B. */
interface RawXmmRm {
  reg: number;
  rmReg: number;
  mem: { base?: RegName; index?: RegName; scale: 1 | 2 | 4 | 8; disp: number } | null;
}

export class X86Decoder {
  constructor(private readonly mode: 'x86' | 'x64' = 'x86') {}

  /** Decodes from `code` until a block terminator is hit. */
  decode(code: Uint8Array, baseAddress: number): DecodeResult {
    const state = new DecoderState(code, baseAddress, this.mode);
    const instructions: DecodedInstruction[] = [];
    let terminated = false;
    while (state.pos < code.length) {
      const start = state.pos;
      let next: OpResult;
      try {
        next = state.decodeOne();
      } catch (err) {
        if (err instanceof UnsupportedError && err.message === 'unexpected end of block') {
          // Ran off the end of the code buffer without a terminator — a
          // straight-line block longer than the executor's read-ahead window.
          // Stop at the start of the incomplete instruction; the executor
          // re-fetches code from the next address and compiles the rest.
          state.pos = start;
          break;
        }
        throw err;
      }
      const len = state.pos - start;
      const di: DecodedInstruction = {
        inst: next.inst,
        length: len,
        nextAddress: baseAddress + state.pos,
        terminator: next.terminator,
      };
      instructions.push(di);
      if (next.terminator) {
        terminated = true;
        break;
      }
    }
    if (instructions.length === 0) {
      // The buffer holds fewer bytes than even one instruction needs — treat
      // it as undecodable so the engine emits a faulting block instead of an
      // empty block that would re-execute at the same EIP forever.
      throw new UnsupportedError(baseAddress + state.pos, 'unexpected end of block');
    }
    return { instructions, length: state.pos, endAddress: baseAddress + state.pos, terminated };
  }
}

type OpResult = { inst: Instruction; terminator: boolean };

class DecoderState {
  constructor(
    private readonly code: Uint8Array,
    private readonly base: number,
    private readonly mode: 'x86' | 'x64',
  ) {}

  pos = 0;
  /** Active REX prefix (set by readPrefixes); all flags false on 32-bit mode. */
  private rex = { w: false, r: false, x: false, b: false };

  private readU8(): number {
    const v = this.code[this.pos];
    if (v === undefined) throw new UnsupportedError(this.abs(), 'unexpected end of block');
    this.pos += 1;
    return v;
  }

  private readS8(): number {
    const v = this.readU8();
    return v >= 0x80 ? v - 0x100 : v;
  }

  private readU16(): number {
    const a = this.readU8();
    const b = this.readU8();
    return (a | (b << 8)) >>> 0;
  }

  private readU32(): number {
    const a = this.readU8();
    const b = this.readU8();
    const c = this.readU8();
    const d = this.readU8();
    return (a | (b << 8) | (c << 16) | (d << 24)) >>> 0;
  }

  private readS32(): number {
    return this.readU32() | 0;
  }

  private readImm(size: Size): number {
    if (size === 64) return this.readU64();
    return size === 8 ? this.readU8() : size === 16 ? this.readU16() : this.readU32();
  }

  private readU64(): number {
    const lo = this.readU32();
    const hi = this.readU32();
    return lo + hi * 4294967296;
  }

  private abs(): number {
    return this.base + this.pos;
  }

  /** Consumes prefixes; returns the mode flags that matter to the decoder. */
  private readPrefixes(): { o66: boolean; f3: boolean; f2: boolean } {
    let o66 = false;
    let f3 = false;
    let f2 = false;
    this.rex = { w: false, r: false, x: false, b: false };
    for (;;) {
      const b = this.code[this.pos];
      if (b === undefined) break;
      if (b === 0x66) {
        o66 = true;
        this.pos += 1;
      } else if (b === 0x67) {
        // address-size override: ignored (flat model)
        this.pos += 1;
      } else if (b === 0xf3) {
        f3 = true;
        this.pos += 1;
      } else if (b === 0xf2) {
        f2 = true;
        this.pos += 1;
      } else if (b === 0xf0 || b === 0x2e || b === 0x36 || b === 0x3e || b === 0x26 || b === 0x64 || b === 0x65) {
        // LOCK or segment override — ignored in the flat model
        this.pos += 1;
      } else if (this.mode === 'x64' && b >= 0x40 && b <= 0x4f) {
        // REX prefix (64-bit mode only)
        this.rex = { w: (b & 8) !== 0, r: (b & 4) !== 0, x: (b & 2) !== 0, b: (b & 1) !== 0 };
        this.pos += 1;
      } else {
        break;
      }
    }
    return { o66, f3, f2 };
  }

  decodeOne(): OpResult {
    const { o66, f3, f2 } = this.readPrefixes();
    let opcode = this.readU8();
    if (opcode === 0x0f) {
      opcode = this.readU8();
      return this.decodeTwoByte(opcode, o66, f3, f2);
    }
    return this.decodeOneByte(opcode, o66, f3, f2);
  }

  private operandSize(o66: boolean): Size {
    if (this.rex.w) return 64;
    return o66 ? 16 : 32;
  }

  // -------------------------------------------------------------------------
  // ModRM / SIB
  // -------------------------------------------------------------------------

  private registerFor(field: number, size: Size): RegName {
    if (size === 64) return REG64[field] ?? 'rax';
    if (size === 8) {
      const t = this.rex.w || this.rex.r || this.rex.x || this.rex.b ? REG8_EXT : REG8;
      return t[field] ?? 'al';
    }
    if (size === 16) return (this.rex.w || this.rex.r || this.rex.x || this.rex.b ? REG16_EXT : REG16)[field] ?? 'ax';
    return (this.rex.w || this.rex.r || this.rex.x || this.rex.b ? REG32_EXT : REG32)[field] ?? 'eax';
  }

  /** True when a REX prefix is active (affects 8/16/32-bit register names). */
  private rexPresent(): boolean {
    return this.rex.w || this.rex.r || this.rex.x || this.rex.b;
  }

  /** Decodes ModRM/SIB; returns register operand, modrm reg field and mem spec. */
  private decodeRm(size: Size): RawRm {
    const modrm = this.readU8();
    const mod = (modrm >> 6) & 3;
    const modrmReg = ((modrm >> 3) & 7) + (this.rex.r ? 8 : 0);
    const rm = modrm & 7;
    if (mod === 3) {
      return { reg: this.registerFor(rm + (this.rex.b ? 8 : 0), size), modrmReg, mem: null };
    }
    let base: RegName | undefined;
    let index: RegName | undefined;
    let scale: 1 | 2 | 4 | 8 = 1;
    let disp = 0;
    let hasBase = true;
    if (rm === 4) {
      // SIB byte follows
      const sib = this.readU8();
      scale = (1 << ((sib >> 6) & 3)) as 1 | 2 | 4 | 8;
      const indexField = (sib >> 3) & 7;
      const baseField = sib & 7;
      const indexExt = indexField + (this.rex.x ? 8 : 0);
      if (indexExt !== 4) index = REG32_EXT[indexExt]; // index 4 = none (unless REX.X extends it)
      if (mod === 0 && baseField === 5 && !this.rex.b) {
        hasBase = false;
        disp = this.readS32();
      } else {
        base = REG32_EXT[baseField + (this.rex.b ? 8 : 0)];
      }
    } else if (mod === 0 && rm === 5) {
      hasBase = false;
      disp = this.readS32();
      if (this.mode === 'x64') {
        // RIP-relative: effective address = next instruction + disp32
        return { reg: null, modrmReg, mem: { base: undefined, index: undefined, scale: 1, disp: this.base + this.pos + disp } };
      }
    } else {
      base = REG32_EXT[rm + (this.rex.b ? 8 : 0)];
    }
    if (hasBase) {
      if (mod === 1) disp = this.readS8();
      else if (mod === 2) disp = this.readS32();
    }
    return { reg: null, modrmReg, mem: { base, index, scale, disp } };
  }

  private rmOperand(raw: RawRm, size: Size): Operand {
    if (raw.reg) return { kind: 'reg', reg: raw.reg, size };
    const m = raw.mem;
    if (!m) return { kind: 'reg', reg: 'eax', size };
    return { kind: 'mem', base: m.base, index: m.index, scale: m.scale, disp: m.disp, size };
  }

  /** XMM rm operand: either a mem spec (size used only for EA) or another XMM. */
  private xmmRmOperand(raw: RawXmmRm): Operand {
    if (raw.mem) return { kind: 'mem', base: raw.mem.base, index: raw.mem.index, scale: raw.mem.scale, disp: raw.mem.disp, size: 32 };
    return { kind: 'xmm', reg: raw.rmReg };
  }

  private xmmOperand(reg: number): Operand {
    return { kind: 'xmm', reg };
  }

  /** Decodes ModRM/SIB for XMM/MMX ops, keeping the raw reg/rm numbers. */
  private decodeXmmRm(): RawXmmRm {
    const modrm = this.readU8();
    const mod = (modrm >> 6) & 3;
    const reg = ((modrm >> 3) & 7) + (this.rex.r ? 8 : 0);
    const rm = modrm & 7;
    if (mod === 3) {
      return { reg, rmReg: rm + (this.rex.b ? 8 : 0), mem: null };
    }
    let base: RegName | undefined;
    let index: RegName | undefined;
    let scale: 1 | 2 | 4 | 8 = 1;
    let disp = 0;
    let hasBase = true;
    if (rm === 4) {
      const sib = this.readU8();
      scale = (1 << ((sib >> 6) & 3)) as 1 | 2 | 4 | 8;
      const indexField = (sib >> 3) & 7;
      const baseField = sib & 7;
      const indexExt = indexField + (this.rex.x ? 8 : 0);
      if (indexExt !== 4) index = REG32_EXT[indexExt]; // index 4 = none (unless REX.X extends it)
      if (mod === 0 && baseField === 5 && !this.rex.b) {
        hasBase = false;
        disp = this.readS32();
      } else {
        base = REG32_EXT[baseField + (this.rex.b ? 8 : 0)];
      }
    } else if (mod === 0 && rm === 5) {
      hasBase = false;
      disp = this.readS32();
      if (this.mode === 'x64') {
        // RIP-relative: effective address = next instruction + disp32
        return { reg, rmReg: rm + (this.rex.b ? 8 : 0), mem: { base: undefined, index: undefined, scale: 1, disp: this.base + this.pos + disp } };
      }
    } else {
      base = REG32_EXT[rm + (this.rex.b ? 8 : 0)];
    }
    if (hasBase) {
      if (mod === 1) disp = this.readS8();
      else if (mod === 2) disp = this.readS32();
    }
    return { reg, rmReg: rm + (this.rex.b ? 8 : 0), mem: { base, index, scale, disp } };
  }

  private regOperand(name: RegName, size: Size): Operand {
    return { kind: 'reg', reg: name, size };
  }

  private immOperand(value: number, size: Size): Operand {
    return { kind: 'imm', value, size };
  }

  private relOperand(delta: number, size: Size): Operand {
    return { kind: 'rel', delta, size };
  }

  // -------------------------------------------------------------------------
  // One-byte opcode map
  // -------------------------------------------------------------------------

  private decodeOneByte(opcode: number, o66: boolean, f3: boolean, f2: boolean): OpResult {
    const size = this.operandSize(o66);

    // 00-0B / 10-1B / 20-2B / 30-3B: group1 r/m <-> reg (imm forms excluded)
    const ARITH_RM_REG = [
      0x00, 0x01, 0x02, 0x03, 0x08, 0x09, 0x0a, 0x0b, 0x10, 0x11, 0x12, 0x13, 0x18, 0x19, 0x1a, 0x1b, 0x20, 0x21, 0x22, 0x23, 0x28, 0x29, 0x2a, 0x2b, 0x30, 0x31, 0x32, 0x33, 0x38, 0x39, 0x3a, 0x3b,
    ];
    if (ARITH_RM_REG.includes(opcode)) {
      return this.arithRmReg(opcode, size);
    }

    switch (opcode) {
      case 0x40:
      case 0x41:
      case 0x42:
      case 0x43:
      case 0x44:
      case 0x45:
      case 0x46:
      case 0x47:
        return { inst: { op: 'inc', dst: this.regOperand(REG32[opcode - 0x40] ?? 'eax', size) }, terminator: false };
      case 0x48:
      case 0x49:
      case 0x4a:
      case 0x4b:
      case 0x4c:
      case 0x4d:
      case 0x4e:
      case 0x4f:
        return { inst: { op: 'dec', dst: this.regOperand(REG32[opcode - 0x48] ?? 'eax', size) }, terminator: false };

      case 0x50:
      case 0x51:
      case 0x52:
      case 0x53:
      case 0x54:
      case 0x55:
      case 0x56:
      case 0x57: {
        const ss = this.mode === 'x64' ? 64 : size;
        const reg = this.mode === 'x64' ? (REG64[opcode - 0x50 + (this.rex.b ? 8 : 0)] ?? 'rax') : (REG32[opcode - 0x50] ?? 'eax');
        return { inst: { op: 'push', src: this.regOperand(reg, ss) }, terminator: false };
      }
      case 0x58:
      case 0x59:
      case 0x5a:
      case 0x5b:
      case 0x5c:
      case 0x5d:
      case 0x5e:
      case 0x5f: {
        const ss = this.mode === 'x64' ? 64 : size;
        const reg = this.mode === 'x64' ? (REG64[opcode - 0x58 + (this.rex.b ? 8 : 0)] ?? 'rax') : (REG32[opcode - 0x58] ?? 'eax');
        return { inst: { op: 'pop', dst: this.regOperand(reg, ss) }, terminator: false };
      }

      case 0x60:
        return { inst: { op: 'pusha' }, terminator: false };
      case 0x61:
        return { inst: { op: 'popa' }, terminator: false };

      case 0x04:
      case 0x05:
      case 0x0c:
      case 0x0d:
      case 0x14:
      case 0x15:
      case 0x1c:
      case 0x1d:
      case 0x24:
      case 0x25:
      case 0x2c:
      case 0x2d:
      case 0x34:
      case 0x35:
      case 0x3c:
      case 0x3d: {
        // group1 with accumulator: add/or/adc/sbb/and/sub/xor/cmp <acc>, imm
        const s = (opcode & 1) === 0 ? 8 : this.rex.w ? 64 : size;
        const acc = s === 8 ? 'al' : this.rex.w ? (REG64[this.rex.r ? 8 : 0] ?? 'rax') : 'eax';
        const op = GROUP1[(opcode >> 3) & 7] ?? 'add';
        return { inst: { op, dst: this.regOperand(acc, s), src: this.immOperand(this.readImm(s), s) }, terminator: false };
      }

      case 0x68: {
        const ss = this.mode === 'x64' ? 64 : 32;
        return { inst: { op: 'push', src: this.immOperand(this.readU32(), ss) }, terminator: false };
      }
      case 0x6a: {
        const ss = this.mode === 'x64' ? 64 : 32;
        return { inst: { op: 'push', src: this.immOperand(this.readS8(), ss) }, terminator: false };
      }
      case 0x69:
      case 0x6b: {
        // IMUL r32, r/m, imm
        const raw = this.decodeRm(size);
        const src = this.rmOperand(raw, size);
        const dst = this.regOperand(this.registerFor(raw.modrmReg, size), size);
        const imm = opcode === 0x6b ? this.readS8() : this.readImm(size);
        return { inst: { op: 'imul', dst, src, target: this.immOperand(imm, size) }, terminator: false };
      }

      case 0x70:
      case 0x71:
      case 0x72:
      case 0x73:
      case 0x74:
      case 0x75:
      case 0x76:
      case 0x77:
      case 0x78:
      case 0x79:
      case 0x7a:
      case 0x7b:
      case 0x7c:
      case 0x7d:
      case 0x7e:
      case 0x7f: {
        const delta = this.readS8();
        return { inst: { op: 'jcc', cond: COND_BY_NIBBLE[opcode - 0x70], target: this.relOperand(delta, 8) }, terminator: true };
      }

      case 0x80:
      case 0x81:
      case 0x83: {
        const s = opcode === 0x80 ? 8 : size;
        const raw = this.decodeRm(s);
        const dst = this.rmOperand(raw, s);
        const op = GROUP1[raw.modrmReg] ?? 'add';
        const imm = opcode === 0x83 ? this.readS8() : this.readImm(s);
        return { inst: { op, dst, src: this.immOperand(imm, s) }, terminator: false };
      }

      case 0x84:
      case 0x85: {
        const s = opcode === 0x84 ? 8 : size;
        const raw = this.decodeRm(s);
        const dst = this.rmOperand(raw, s);
        const src = this.regOperand(this.registerFor(raw.modrmReg, s), s);
        return { inst: { op: 'test', dst, src }, terminator: false };
      }

      case 0x86:
      case 0x87: {
        const s = opcode === 0x86 ? 8 : size;
        const raw = this.decodeRm(s);
        const a = this.rmOperand(raw, s);
        const b = this.regOperand(this.registerFor(raw.modrmReg, s), s);
        return { inst: { op: 'xchg', dst: a, src: b }, terminator: false };
      }

      case 0x88:
      case 0x89:
      case 0x8a:
      case 0x8b: {
        const s = opcode === 0x88 || opcode === 0x8a ? 8 : size;
        const raw = this.decodeRm(s);
        const reg = this.regOperand(this.registerFor(raw.modrmReg, s), s);
        const rm = this.rmOperand(raw, s);
        if (opcode === 0x88 || opcode === 0x89) {
          return { inst: { op: 'mov', dst: rm, src: reg }, terminator: false };
        }
        return { inst: { op: 'mov', dst: reg, src: rm }, terminator: false };
      }

      case 0x8d: {
        // LEA reg, m
        const raw = this.decodeRm(size);
        const dst = this.regOperand(this.registerFor(raw.modrmReg, size), size);
        const m = raw.mem;
        if (!m) return { inst: { op: 'nop' }, terminator: false };
        const src: MemOperand = { kind: 'mem', base: m.base, index: m.index, scale: m.scale, disp: m.disp, size };
        return { inst: { op: 'lea', dst, src }, terminator: false };
      }

      case 0x8c: {
        // MOV r/m16, Sreg — store a segment register. Flat model: all
        // segment selectors are 0 (the decoder ignores segment prefixes and
        // the guest TEB lives at address 0), so this is a 16-bit zero store.
        const raw = this.decodeRm(16);
        const dst: Operand = raw.mem
          ? ({ kind: 'mem', base: raw.mem.base, index: raw.mem.index, scale: raw.mem.scale, disp: raw.mem.disp, size: 16 } as Operand)
          : this.regOperand(raw.reg ?? 'ax', 16);
        return { inst: { op: 'mov-sreg', dst, src: this.immOperand(raw.modrmReg, 8) }, terminator: false };
      }

      case 0x8f: {
        // POP r/m
        const raw = this.decodeRm(size);
        const dst = this.rmOperand(raw, size);
        return { inst: { op: 'pop', dst }, terminator: false };
      }

      case 0x90:
        return { inst: { op: 'nop' }, terminator: false };
      case 0x91:
      case 0x92:
      case 0x93:
      case 0x94:
      case 0x95:
      case 0x96:
      case 0x97:
        // XCHG eax, r32: 0x91..0x97 map to the modrm-reg field 1..7
        // (ecx..edi), so the REG32 index is opcode - 0x90 — NOT opcode - 0x91,
        // which shifted everything by one (0x94 xchg eax,esp decoded as
        // xchg eax,ebx — a silent corruption of any guest code that swaps
        // esp with eax, e.g. MSVC __chkstk's `xchg esp, eax`).
        return { inst: { op: 'xchg', dst: this.regOperand('eax', size), src: this.regOperand(REG32[opcode - 0x90] ?? 'esp', size) }, terminator: false };

      case 0x98:
        return { inst: { op: 'cwde' }, terminator: false };
      case 0x99:
        return { inst: { op: 'cdq' }, terminator: false };
      case 0x9b:
        // FWAIT / WAIT — the FPU is emulated as always idle, so this is a nop.
        return { inst: { op: 'nop' }, terminator: false };
      case 0x9c:
        return { inst: { op: 'pushfd' }, terminator: false };
      case 0x9d:
        return { inst: { op: 'popfd' }, terminator: false };

      case 0xa0: {
        const off = this.readU32();
        return { inst: { op: 'mov', dst: this.regOperand('al', 8), src: this.flatMem(off, 8) }, terminator: false };
      }
      case 0xa1: {
        const off = this.rex.w ? this.readU64() : this.readU32();
        const ss = this.rex.w ? 64 : size;
        const reg = this.rex.w ? (this.rex.r ? 'r8' : 'rax') : 'eax';
        return { inst: { op: 'mov', dst: this.regOperand(reg, ss), src: this.flatMem(off, ss) }, terminator: false };
      }
      case 0xa2: {
        const off = this.readU32();
        return { inst: { op: 'mov', dst: this.flatMem(off, 8), src: this.regOperand('al', 8) }, terminator: false };
      }
      case 0xa3: {
        const off = this.rex.w ? this.readU64() : this.readU32();
        const ss = this.rex.w ? 64 : size;
        const reg = this.rex.w ? (this.rex.r ? 'r8' : 'rax') : 'eax';
        return { inst: { op: 'mov', dst: this.flatMem(off, ss), src: this.regOperand(reg, ss) }, terminator: false };
      }

      case 0xa8:
        return { inst: { op: 'test', dst: this.regOperand('al', 8), src: this.immOperand(this.readU8(), 8) }, terminator: false };
      case 0xa9:
        return { inst: { op: 'test', dst: this.regOperand('eax', size), src: this.immOperand(this.readImm(size), size) }, terminator: false };

      case 0xa4:
        return { inst: { op: 'movs', rep: f3, size: 8 }, terminator: false };
      case 0xa5:
        return { inst: { op: 'movs', rep: f3, size }, terminator: false };
      case 0xa6:
      case 0xa7:
      case 0xae:
      case 0xaf:
        throw new UnsupportedError(this.abs(), `string op 0x${opcode.toString(16)} not implemented`);
      case 0xaa:
        return { inst: { op: 'stos', rep: f3, size: 8 }, terminator: false };
      case 0xab:
        return { inst: { op: 'stos', rep: f3, size }, terminator: false };
      case 0xac:
        return { inst: { op: 'lods', rep: f3, size: 8 }, terminator: false };
      case 0xad:
        return { inst: { op: 'lods', rep: f3, size }, terminator: false };
      void f2;

      case 0xb0:
      case 0xb1:
      case 0xb2:
      case 0xb3:
      case 0xb4:
      case 0xb5:
      case 0xb6:
      case 0xb7:
        return { inst: { op: 'mov', dst: this.regOperand(REG8[opcode - 0xb0] ?? 'al', 8), src: this.immOperand(this.readU8(), 8) }, terminator: false };
      case 0xb8:
      case 0xb9:
      case 0xba:
      case 0xbb:
      case 0xbc:
      case 0xbd:
      case 0xbe:
      case 0xbf: {
        const ss = this.rex.w ? 64 : size;
        const field = opcode - 0xb8 + (this.rex.b ? 8 : 0);
        const reg = this.registerFor(field, ss);
        return { inst: { op: 'mov', dst: this.regOperand(reg, ss), src: this.immOperand(this.readImm(ss), ss) }, terminator: false };
      }

      case 0xc0:
      case 0xc1: {
        const s = opcode === 0xc0 ? 8 : size;
        const raw = this.decodeRm(s);
        const dst = this.rmOperand(raw, s);
        const count = this.readU8();
        return { inst: { op: GROUP2[raw.modrmReg] ?? 'shl', dst, src: this.immOperand(count, 8) }, terminator: false };
      }

      case 0xc2: {
        const popBytes = this.readU16();
        return { inst: { op: 'ret', popBytes }, terminator: true };
      }
      case 0xc3:
        return { inst: { op: 'ret' }, terminator: true };

      case 0xc6:
      case 0xc7: {
        // C6: mov r/m8, imm8; C7: mov r/m, imm32 (sign-extended to 64 when REX.W)
        const immSize = opcode === 0xc6 ? 8 : size === 64 ? 32 : size;
        const raw = this.decodeRm(size);
        const dst = this.rmOperand(raw, size);
        const imm = this.readImm(immSize);
        return { inst: { op: 'mov', dst, src: this.immOperand(imm, size) }, terminator: false };
      }

      case 0xc8: {
        const frameBytes = this.readU16();
        const nesting = this.readU8();
        return { inst: { op: 'enter', frameBytes, nesting }, terminator: false };
      }
      case 0xc9:
        return { inst: { op: 'leave' }, terminator: false };
      case 0xcc:
        return { inst: { op: 'int', vector: 3 }, terminator: true };
      case 0xcd: {
        const vector = this.readU8();
        return { inst: { op: 'int', vector }, terminator: true };
      }

      case 0xd0:
      case 0xd1: {
        const s = opcode === 0xd0 ? 8 : size;
        const raw = this.decodeRm(s);
        const dst = this.rmOperand(raw, s);
        return { inst: { op: GROUP2[raw.modrmReg] ?? 'shl', dst, src: this.immOperand(1, 8) }, terminator: false };
      }

      case 0xd2:
      case 0xd3: {
        const s = opcode === 0xd2 ? 8 : size;
        const raw = this.decodeRm(s);
        const dst = this.rmOperand(raw, s);
        return { inst: { op: GROUP2[raw.modrmReg] ?? 'shl', dst, src: this.regOperand('cl', 8) }, terminator: false };
      }

      case 0xe8: {
        const rel = this.readS32();
        return { inst: { op: 'call', target: this.relOperand(rel, 32) }, terminator: true };
      }
      case 0xe9: {
        const rel = this.readS32();
        return { inst: { op: 'jmp', target: this.relOperand(rel, 32) }, terminator: true };
      }
      case 0xeb: {
        const rel = this.readS8();
        return { inst: { op: 'jmp', target: this.relOperand(rel, 8) }, terminator: true };
      }

      case 0xf6:
      case 0xf7: {
        const s = opcode === 0xf6 ? 8 : size;
        const raw = this.decodeRm(s);
        const rm = this.rmOperand(raw, s);
        const g3 = raw.modrmReg;
        if (g3 === 0 || g3 === 1) {
          const imm = this.readImm(s);
          return { inst: { op: 'test', dst: rm, src: this.immOperand(imm, s) }, terminator: false };
        }
        return { inst: { op: GROUP3[g3] ?? 'test', dst: rm }, terminator: false };
      }

      case 0xf4:
        return { inst: { op: 'hlt' }, terminator: true };
      case 0xf8:
        return { inst: { op: 'clc' }, terminator: false };
      case 0xf9:
        return { inst: { op: 'stc' }, terminator: false };
      case 0xfc:
        return { inst: { op: 'cld' }, terminator: false };
      case 0xfd:
        return { inst: { op: 'std' }, terminator: false };

      case 0xff: {
        const raw = this.decodeRm(size);
        const rm = this.rmOperand(raw, size);
        switch (GROUP5[raw.modrmReg]) {
          case 'inc':
            return { inst: { op: 'inc', dst: rm }, terminator: false };
          case 'dec':
            return { inst: { op: 'dec', dst: rm }, terminator: false };
          case 'call':
            return { inst: { op: 'call', target: rm }, terminator: true };
          case 'jmp':
            return { inst: { op: 'jmp', target: rm }, terminator: true };
          case 'push':
            return { inst: { op: 'push', src: rm }, terminator: false };
          default:
            throw new UnsupportedError(this.abs(), `group5 modrm reg=${raw.modrmReg} not implemented`);
        }
      }

      case 0xd8:
      case 0xdb:
      case 0xdc:
      case 0xd9:
      case 0xdd:
      case 0xde:
      case 0xdf: {
        // x87 FPU. The FPU is emulated as idle/empty: FNINIT/FLDCW are no-ops,
        // FSTCW writes the standard default control word, and the plain
        // memory <-> ST(0) moves (FLD/FST/FSTP) are raw 8-byte copies through
        // an 8-slot register file. Arithmetic (FADD/FMUL/...) is unsupported.
        if (opcode === 0xdb && this.code[this.pos] === 0xe3) {
          this.pos += 1; // FNINIT
          return { inst: { op: 'finit' }, terminator: false };
        }
        const raw = this.decodeXmmRm();
        const mem: Operand | undefined = raw.mem
          ? ({ kind: 'mem', base: raw.mem.base, index: raw.mem.index, scale: raw.mem.scale, disp: raw.mem.disp, size: 32 } as Operand)
          : undefined;
        switch (opcode) {
          case 0xd9:
            if (!raw.mem) {
              // register-direct forms (mod=11): D9 E8=FLD1, D9 EE=FLDZ, others ST(i) ops
              if (raw.rmReg === 0) return { inst: { op: 'fld1' }, terminator: false };
              if (raw.rmReg === 6) return { inst: { op: 'fldz' }, terminator: false };
              throw new UnsupportedError(this.abs(), `unsupported x87 d9 reg-direct rm=${raw.rmReg}`);
            }
            switch (raw.reg) {
              case 5:
                return { inst: { op: 'fldcw', src: mem }, terminator: false }; // FLDCW m16
              case 7:
                return { inst: { op: 'fstcw', dst: mem }, terminator: false }; // FSTCW m16
              case 0:
                return { inst: { op: 'fld', src: mem, size: 32 }, terminator: false }; // FLD m32
              case 2:
                return { inst: { op: 'fst', dst: mem, size: 32 }, terminator: false }; // FST m32
              case 3:
                return { inst: { op: 'fstp', dst: mem, size: 32 }, terminator: false }; // FSTP m32
              default:
                throw new UnsupportedError(this.abs(), `unsupported x87 d9 modrm reg=${raw.reg}`);
            }
          case 0xdd:
            switch (raw.reg) {
              case 0:
                return { inst: { op: 'fld', src: mem, size: 64 }, terminator: false }; // FLD m64
              case 2:
                return { inst: { op: 'fst', dst: mem, size: 64 }, terminator: false }; // FST m64
              case 3:
                return { inst: { op: 'fstp', dst: mem, size: 64 }, terminator: false }; // FSTP m64
              default:
                throw new UnsupportedError(this.abs(), `unsupported x87 dd modrm reg=${raw.reg}`);
            }
          case 0xdf:
            // FILD/FISTP integer loads/stores through the FPU. Our FPU is a
            // raw 8-byte copy device, which is exactly right for the
            // move-through-FPU integer copies Delphi emits (fild [src] /
            // fistp [dst] round-trips the bits unchanged). Encodings per the
            // Intel/AMD manuals: DF /5 = FILD m64, DF /7 = FISTP m64.
            switch (raw.reg) {
              case 5:
                return { inst: { op: 'fld', src: mem, size: 64 }, terminator: false }; // FILD m64
              case 7:
                return { inst: { op: 'fstp', dst: mem, size: 64 }, terminator: false }; // FISTP m64
              default:
                throw new UnsupportedError(this.abs(), `unsupported x87 df modrm reg=${raw.reg}`);
            }
          default:
            throw new UnsupportedError(this.abs(), `unsupported x87 opcode 0x${opcode.toString(16)}`);
        }
      }

      default:
        throw new UnsupportedError(this.abs(), `unsupported opcode 0x${opcode.toString(16)}`);
    }
  }

  private flatMem(disp: number, size: Size): MemOperand {
    return { kind: 'mem', base: undefined, index: undefined, scale: 1, disp, size };
  }

  private arithRmReg(opcode: number, size: Size): OpResult {
    // byte/dword forms are split on bit0: even opcodes (0x00/0x02/0x08/0x0a/...)
    // are 8-bit, odd opcodes (0x01/0x03/0x09/0x0b/...) are size-sized. Using
    // bit3 here mis-decoded every odd dword opcode (0x09 or, 0x0b or, 0x11
    // adc, ..., 0x3b cmp) as its 8-bit high-register form (e.g. `cmp edi,ebx`
    // became `cmp bh,bl`, silently zeroing the operands).
    const isByte = (opcode & 0x01) === 0;
    const isReverse = (opcode & 0x02) !== 0;
    const op = GROUP1[(opcode >> 3) & 7] ?? 'add';
    const s = isByte ? 8 : size;
    const raw = this.decodeRm(s);
    const rm = this.rmOperand(raw, s);
    const reg = this.regOperand(this.registerFor(raw.modrmReg, s), s);
    return isReverse ? { inst: { op, dst: reg, src: rm }, terminator: false } : { inst: { op, dst: rm, src: reg }, terminator: false };
  }

  // -------------------------------------------------------------------------
  // Two-byte (0F) opcode map
  // -------------------------------------------------------------------------

  private decodeTwoByte(opcode: number, o66: boolean, f3 = false, f2 = false): OpResult {
    const size = this.operandSize(o66);
    switch (opcode) {
      case 0x1e:
      case 0x1f: {
        // Multi-byte NOP (0F 1F /r — "nop r/m"). The ModRM (and SIB/disp)
        // bytes MUST be consumed, otherwise the following instruction is
        // decoded from the middle of the NOP and the whole block desyncs
        // (cmd.exe 0x40eb20 faulted on a stray modrm byte 0x06 = "push es"
        // after `0f 1f 40 00` was treated as a 2-byte nop).
        this.decodeRm(32);
        return { inst: { op: 'nop' }, terminator: false };
      }

      case 0xa2:
        // CPUID — no operands; eax selects the leaf, results go to eax/ebx/ecx/edx.
        return { inst: { op: 'cpuid' }, terminator: false };

      case 0x31:
        // RDTSC — no operands; EDX:EAX = 64-bit monotonic counter. Used by
        // notepad's random-seed init (`rdtsc` right after reading the
        // seed state at 0x414472). Flags are unaffected.
        return { inst: { op: 'rdtsc' }, terminator: false };

      // ---- SSE2 128-bit moves / shuffles (minimal XMM set) ----
      case 0x10:
      case 0x11: {
        // MOVUPS/MOVUPD xmm, xmm/m128 (load/store). f3/f2 forms are scalar
        // MOVSS/MOVSD — not implemented; fault loudly instead of mis-decoding.
        if (f3 || f2) throw new UnsupportedError(this.abs(), `unsupported scalar sse opcode 0f ${opcode.toString(16)}`);
        const raw = this.decodeXmmRm();
        const x = this.xmmOperand(raw.reg);
        const rm = this.xmmRmOperand(raw);
        return opcode === 0x10
          ? { inst: { op: 'xmm-load', dst: x, src: rm }, terminator: false }
          : { inst: { op: 'xmm-store', dst: rm, src: x }, terminator: false };
      }
      case 0x12:
      case 0x13:
      case 0x16:
      case 0x17: {
        // MOVLPS/MOVHPS (66: MOVLPD/MOVHPD): 64-bit half-register moves
        // between XMM and memory. The 66-prefixed PD forms behave identically
        // for memory operands; register forms (MOVHLPS etc.) are not needed
        // by the CRT/init code we emulate.
        const raw = this.decodeXmmRm();
        const x = this.xmmOperand(raw.reg);
        const rm = this.xmmRmOperand(raw);
        if (rm.kind !== 'mem') throw new UnsupportedError(this.abs(), `unsupported sse reg form 0f ${opcode.toString(16)}`);
        if (opcode === 0x12) return { inst: { op: 'xmm-movlps-load', dst: x, src: rm }, terminator: false };
        if (opcode === 0x13) return { inst: { op: 'xmm-movlps-store', dst: rm, src: x }, terminator: false };
        if (opcode === 0x16) return { inst: { op: 'xmm-movhps-load', dst: x, src: rm }, terminator: false };
        return { inst: { op: 'xmm-movhps-store', dst: rm, src: x }, terminator: false };
      }
      case 0x57: {
        // XORPS (66: XORPD) xmm, xmm/m128 — bitwise xor, same as PXOR.
        const raw = this.decodeXmmRm();
        const dst = this.xmmOperand(raw.reg);
        const src = this.xmmRmOperand(raw);
        return { inst: { op: 'xmm-pxor', dst, src }, terminator: false };
      }
      case 0x28:
      case 0x29: {
        // MOVAPS/MOVAPD xmm, xmm/m128 (aligned; same 128-bit move semantics here)
        if (f3 || f2) throw new UnsupportedError(this.abs(), `unsupported scalar sse opcode 0f ${opcode.toString(16)}`);
        const raw = this.decodeXmmRm();
        const x = this.xmmOperand(raw.reg);
        const rm = this.xmmRmOperand(raw);
        return opcode === 0x28
          ? { inst: { op: 'xmm-load', dst: x, src: rm }, terminator: false }
          : { inst: { op: 'xmm-store', dst: rm, src: x }, terminator: false };
      }
      case 0x6f:
      case 0x7f: {
        // MOVDQA xmm, xmm/m128 (66); without 66 these are MMX MOVQ — unsupported.
        if (!o66 || f3 || f2) throw new UnsupportedError(this.abs(), `unsupported mmx opcode 0f ${opcode.toString(16)}`);
        const raw = this.decodeXmmRm();
        const x = this.xmmOperand(raw.reg);
        const rm = this.xmmRmOperand(raw);
        return opcode === 0x6f
          ? { inst: { op: 'xmm-load', dst: x, src: rm }, terminator: false }
          : { inst: { op: 'xmm-store', dst: rm, src: x }, terminator: false };
      }
      case 0x6e:
      case 0x7e: {
        // MOVD xmm, r/m32 (66) / MOVD r/m32, xmm (66). Without 66: MMX — unsupported.
        if (!o66 || f3 || f2) throw new UnsupportedError(this.abs(), `unsupported mmx opcode 0f ${opcode.toString(16)}`);
        const raw = this.decodeXmmRm();
        const x = this.xmmOperand(raw.reg);
        const rm = raw.mem
          ? ({ kind: 'mem', base: raw.mem.base, index: raw.mem.index, scale: raw.mem.scale, disp: raw.mem.disp, size: 32 } as Operand)
          : this.regOperand(REG32_EXT[raw.rmReg] ?? 'eax', 32);
        return opcode === 0x6e
          ? { inst: { op: 'xmm-movd', dst: x, src: rm }, terminator: false }
          : { inst: { op: 'xmm-movd', dst: rm, src: x }, terminator: false };
      }
      case 0x70: {
        // PSHUFD xmm, xmm/m128, imm8 (66). Without 66: MMX PSHUFW — unsupported.
        if (!o66 || f3 || f2) throw new UnsupportedError(this.abs(), `unsupported mmx opcode 0f 70`);
        const raw = this.decodeXmmRm();
        const dst = this.xmmOperand(raw.reg);
        const src = this.xmmRmOperand(raw);
        const imm = this.readU8();
        return { inst: { op: 'xmm-pshufd', dst, src, target: this.immOperand(imm, 8) }, terminator: false };
      }
      case 0xef: {
        // PXOR xmm, xmm/m128 (66). Without 66: MMX PXOR — unsupported.
        if (!o66 || f3 || f2) throw new UnsupportedError(this.abs(), `unsupported mmx opcode 0f ef`);
        const raw = this.decodeXmmRm();
        const dst = this.xmmOperand(raw.reg);
        const src = this.xmmRmOperand(raw);
        return { inst: { op: 'xmm-pxor', dst, src }, terminator: false };
      }

      case 0x40:
      case 0x41:
      case 0x42:
      case 0x43:
      case 0x44:
      case 0x45:
      case 0x46:
      case 0x47:
      case 0x48:
      case 0x49:
      case 0x4a:
      case 0x4b:
      case 0x4c:
      case 0x4d:
      case 0x4e:
      case 0x4f: {
        // CMOVcc r, r/m
        const raw = this.decodeRm(size);
        const src = this.rmOperand(raw, size);
        const dst = this.regOperand(this.registerFor(raw.modrmReg, size), size);
        return { inst: { op: 'cmov', cond: COND_BY_NIBBLE[opcode - 0x40], dst, src }, terminator: false };
      }

      case 0x63: {
        // MOVSXD r64, r/m32 (sign-extend dword to qword)
        const raw = this.decodeRm(32);
        const src = this.rmOperand(raw, 32);
        const dst = this.regOperand(this.registerFor(raw.modrmReg, 64), 64);
        return { inst: { op: 'movsx', dst, src }, terminator: false };
      }

      case 0x80:
      case 0x81:
      case 0x82:
      case 0x83:
      case 0x84:
      case 0x85:
      case 0x86:
      case 0x87:
      case 0x88:
      case 0x89:
      case 0x8a:
      case 0x8b:
      case 0x8c:
      case 0x8d:
      case 0x8e:
      case 0x8f: {
        const delta = this.readS32();
        return { inst: { op: 'jcc', cond: COND_BY_NIBBLE[opcode - 0x80], target: this.relOperand(delta, 32) }, terminator: true };
      }

      case 0x90:
      case 0x91:
      case 0x92:
      case 0x93:
      case 0x94:
      case 0x95:
      case 0x96:
      case 0x97:
      case 0x98:
      case 0x99:
      case 0x9a:
      case 0x9b:
      case 0x9c:
      case 0x9d:
      case 0x9e:
      case 0x9f: {
        const raw = this.decodeRm(8);
        const dst = this.rmOperand(raw, 8);
        return { inst: { op: 'setcc', cond: COND_BY_NIBBLE[opcode - 0x90], dst }, terminator: false };
      }

      case 0xaf: {
        const raw = this.decodeRm(size);
        const src = this.rmOperand(raw, size);
        const dst = this.regOperand(this.registerFor(raw.modrmReg, size), size);
        return { inst: { op: 'imul', dst, src }, terminator: false };
      }

      case 0xbc:
      case 0xbd: {
        // BSF/BSR r, r/m — bit scan; ZF set when the source is zero.
        const raw = this.decodeRm(size);
        const src = this.rmOperand(raw, size);
        const dst = this.regOperand(this.registerFor(raw.modrmReg, size), size);
        return { inst: { op: opcode === 0xbc ? 'bsf' : 'bsr', dst, src }, terminator: false };
      }

      case 0xa3:
      case 0xab:
      case 0xb3:
      case 0xbb: {
        // BT/BTS/BTR/BTC r/m, r — bit test (CF = bit); BTS sets, BTR clears, BTC toggles.
        const raw = this.decodeRm(size);
        const dst = this.rmOperand(raw, size);
        const src = this.regOperand(this.registerFor(raw.modrmReg, size), size);
        const op = opcode === 0xa3 ? 'bt' : opcode === 0xab ? 'bts' : opcode === 0xb3 ? 'btr' : 'btc';
        return { inst: { op, dst, src }, terminator: false };
      }

      case 0xb0:
      case 0xb1: {
        // CMPXCHG r/m, reg
        const s = opcode === 0xb0 ? 8 : size;
        const raw = this.decodeRm(s);
        const dst = this.rmOperand(raw, s);
        const src = this.regOperand(this.registerFor(raw.modrmReg, s), s);
        return { inst: { op: 'cmpxchg', dst, src }, terminator: false };
      }

      case 0xc0:
      case 0xc1: {
        // XADD r/m, reg (0F C0/C1) — atomic exchange-add, used by
        // Interlocked style / refcount primitives (notepad's
        // `lock xadd [0x428d3c], eax` counter increments).
        const s = opcode === 0xc0 ? 8 : size;
        const raw = this.decodeRm(s);
        const dst = this.rmOperand(raw, s);
        const src = this.regOperand(this.registerFor(raw.modrmReg, s), s);
        return { inst: { op: 'xadd', dst, src }, terminator: false };
      }

      case 0xb6:
      case 0xb7:
      case 0xbe:
      case 0xbf: {
        const s = opcode === 0xb6 || opcode === 0xbe ? 8 : 16;
        const raw = this.decodeRm(s);
        const src = this.rmOperand(raw, s);
        const dst = this.regOperand(this.registerFor(raw.modrmReg, size), size);
        const op = opcode === 0xb6 || opcode === 0xb7 ? 'movzx' : 'movsx';
        return { inst: { op, dst, src }, terminator: false };
      }

      default:
        throw new UnsupportedError(this.abs(), `unsupported two-byte opcode 0f ${opcode.toString(16)}`);
    }
  }
}

export type { DecodeResult, DecodedInstruction, Instruction };
