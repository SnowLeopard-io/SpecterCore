/**
 * x86 instruction intermediate representation (IR).
 *
 * The decoder lowers i386 machine code into a flat list of these nodes; the
 * code generator emits one WASM function per basic block from the list. The IR
 * is intentionally small (a subset of i386, design doc 4.1.1) and mirrors real
 * x86 semantics: two-operand forms, explicit sizes, and a `cond` on branches.
 */

export type RegName =
  | 'rax'
  | 'rcx'
  | 'rdx'
  | 'rbx'
  | 'rsp'
  | 'rbp'
  | 'rsi'
  | 'rdi'
  | 'r8'
  | 'r9'
  | 'r10'
  | 'r11'
  | 'r12'
  | 'r13'
  | 'r14'
  | 'r15'
  | 'eax'
  | 'ecx'
  | 'edx'
  | 'ebx'
  | 'esp'
  | 'ebp'
  | 'esi'
  | 'edi'
  | 'ax'
  | 'cx'
  | 'dx'
  | 'bx'
  | 'sp'
  | 'bp'
  | 'si'
  | 'di'
  | 'r8d'
  | 'r9d'
  | 'r10d'
  | 'r11d'
  | 'r12d'
  | 'r13d'
  | 'r14d'
  | 'r15d'
  | 'r8w'
  | 'r9w'
  | 'r10w'
  | 'r11w'
  | 'r12w'
  | 'r13w'
  | 'r14w'
  | 'r15w'
  | 'r8b'
  | 'r9b'
  | 'r10b'
  | 'r11b'
  | 'r12b'
  | 'r13b'
  | 'r14b'
  | 'r15b'
  | 'spl'
  | 'bpl'
  | 'sil'
  | 'dil'
  | 'al'
  | 'cl'
  | 'dl'
  | 'bl'
  | 'ah'
  | 'ch'
  | 'dh'
  | 'bh';

export type Size = 8 | 16 | 32 | 64;

/** Condition codes shared by Jcc / SETcc / CMOVcc. */
export type Cond = 'o' | 'no' | 'b' | 'ae' | 'e' | 'ne' | 'be' | 'a' | 's' | 'ns' | 'p' | 'np' | 'l' | 'ge' | 'le' | 'g';

// ---------------------------------------------------------------------------
// Operands
// ---------------------------------------------------------------------------

export interface RegOperand {
  kind: 'reg';
  reg: RegName;
  size: Size;
}

/** Memory operand. Address = base + index*scale + disp (all signed 32-bit). */
export interface MemOperand {
  kind: 'mem';
  base?: RegName;
  index?: RegName;
  scale: 1 | 2 | 4 | 8;
  disp: number;
  size: Size;
}

/** XMM register operand (SSE 128-bit lane). reg: 0..15 (xmm0..xmm15). */
export interface XmmOperand {
  kind: 'xmm';
  reg: number;
  size: Size;
}

export interface ImmOperand {
  kind: 'imm';
  value: number;
  size: Size;
}

/** Relative branch target: `target = endOfInstruction + delta`. */
export interface RelOperand {
  kind: 'rel';
  delta: number;
  size: Size;
}

export type Operand = RegOperand | MemOperand | XmmOperand | ImmOperand | RelOperand;

// ---------------------------------------------------------------------------
// Instructions
// ---------------------------------------------------------------------------

export type Op =
  | 'mov'
  | 'add'
  | 'adc'
  | 'sub'
  | 'sbb'
  | 'and'
  | 'or'
  | 'xor'
  | 'cmp'
  | 'test'
  | 'inc'
  | 'dec'
  | 'neg'
  | 'not'
  | 'lea'
  | 'mov-sreg'
  | 'push'
  | 'pop'
  | 'jmp'
  | 'jcc'
  | 'call'
  | 'ret'
  | 'movzx'
  | 'movsx'
  | 'xchg'
  | 'shl'
  | 'shr'
  | 'sar'
  | 'rol'
  | 'ror'
  | 'rcl'
  | 'rcr'
  | 'mul'
  | 'imul'
  | 'div'
  | 'idiv'
  | 'setcc'
  | 'cmov'
  | 'cmpxchg'
  | 'xadd'
  | 'int'
  | 'pushfd'
  | 'popfd'
  | 'cwde'
  | 'cdq'
  | 'nop'
  | 'pusha'
  | 'popa'
  | 'cpuid'
  | 'rdtsc'
  | 'xmm-load'
  | 'xmm-store'
  | 'xmm-movd'
  | 'xmm-movlps-load'
  | 'xmm-movlps-store'
  | 'xmm-movhps-load'
  | 'xmm-movhps-store'
  | 'xmm-pshufd'
  | 'xmm-pxor'
  | 'xmm-psrldq'
  | 'xmm-pslldq'
  | 'bsf'
  | 'bsr'
  | 'bt'
  | 'bts'
  | 'btr'
  | 'btc'
  | 'finit'
  | 'fldcw'
  | 'fstcw'
  | 'fld'
  | 'fst'
  | 'fstp'
  | 'fild'
  | 'fist'
  | 'fistp'
  | 'fld1'
  | 'fldz'
  // x87 stack-housekeeping ops. With the flat ST(0)-only FPU model these carry
  // no observable state change, but they are decoded explicitly so traces stay
  // readable and so real stack tracking can be added later without a re-decode.
  | 'ffree'
  | 'fincstp'
  | 'fdecstp'
  | 'fnop'
  | 'stos'
  | 'movs'
  | 'lods'
  | 'scas'
  | 'cmps'
  | 'clc'
  | 'stc'
  | 'cld'
  | 'std'
  | 'leave'
  | 'hlt'
  | 'enter';

export interface Instruction {
  op: Op;
  dst?: Operand;
  src?: Operand;
  target?: Operand;
  cond?: Cond;
  /** For `int`: interrupt vector number. */
  vector?: number;
  /** For `ret`: bytes to pop off the stack after the return address. */
  popBytes?: number;
  /** For `enter`: stack frame size / nesting level. */
  frameBytes?: number;
  nesting?: number;
  /** REP (F3) prefix on string ops. */
  rep?: boolean;
  /**
   * REPNE (F2) prefix on string ops. Only meaningful for the comparing string
   * ops (`scas`/`cmps`), where F3 means REPE (repeat while ZF=1) and F2 means
   * REPNE (repeat while ZF=0). For the non-comparing ops (`movs`/`stos`/`lods`)
   * both prefixes are plain REP, so only `rep` is set.
   */
  repne?: boolean;
  /** Operand width for string ops (8/16/32). */
  size?: Size;
  /**
   * For `xmm-load`/`xmm-store`: number of 32-bit lanes moved. 4 = full 128-bit
   * (MOVUPS/MOVUPD/MOVDQA/MOVDQU), 2 = MOVSD (64-bit scalar), 1 = MOVSS
   * (32-bit scalar). Upper lanes are zeroed on a scalar memory load and left
   * untouched on a scalar register load.
   */
  lanes?: 1 | 2 | 4;
}

/** A single instruction as decoded, with its byte length. */
export interface DecodedInstruction {
  inst: Instruction;
  length: number;
  /** Absolute EIP of the next instruction (this one's end). */
  nextAddress: number;
  /** True when this instruction terminates a basic block. */
  terminator: boolean;
}

/** Result of decoding a straight-line block of machine code. */
export interface DecodeResult {
  instructions: DecodedInstruction[];
  /** Total bytes consumed. */
  length: number;
  /** Address one past the last decoded instruction. */
  endAddress: number;
  terminated: boolean;
}
