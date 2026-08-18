/**
 * CPU context layout and x86 flags helpers for the JIT.
 *
 * The guest CPU state (32 general registers, EIP, EFLAGS) lives in a small
 * struct at the head of the shared WASM linear memory. JIT-compiled block
 * functions read/write this struct through ordinary memory loads/stores, which
 * keeps the generated WASM self-contained (no imported globals) and lets JS
 * (the executor) inspect or mutate state through a DataView on the same bytes.
 */

import type { Cond, RegName } from './ir';

/** Base address of the CPU context struct inside the linear memory. */
export const CTX_BASE = 0x1000;

/**
 * Register file layout: 16 x 64-bit slots (RAX..R15). The 32/16/8-bit register
 * names map to the low bytes of the matching slot, so both the legacy i386
 * codegen and the x64 codegen share one struct.
 */
export const REG64_OFFSET: Partial<Record<RegName, number>> = {
  rax: 0,
  rcx: 8,
  rdx: 16,
  rbx: 24,
  rsp: 32,
  rbp: 40,
  rsi: 48,
  rdi: 56,
  r8: 64,
  r9: 72,
  r10: 80,
  r11: 88,
  r12: 96,
  r13: 104,
  r14: 112,
  r15: 120,
};

export const REG_OFFSET: Record<RegName, number> = {
  ...(REG64_OFFSET as Record<RegName, number>),
  eax: 0,
  ecx: 8,
  edx: 16,
  ebx: 24,
  esp: 32,
  ebp: 40,
  esi: 48,
  edi: 56,
  ax: 0,
  cx: 8,
  dx: 16,
  bx: 24,
  sp: 32,
  bp: 40,
  si: 48,
  di: 56,
  al: 0,
  cl: 8,
  dl: 16,
  bl: 24,
  ah: 1,
  ch: 9,
  dh: 17,
  bh: 25,
  r8d: 64,
  r9d: 72,
  r10d: 80,
  r11d: 88,
  r12d: 96,
  r13d: 104,
  r14d: 112,
  r15d: 120,
  r8w: 64,
  r9w: 72,
  r10w: 80,
  r11w: 88,
  r12w: 96,
  r13w: 104,
  r14w: 112,
  r15w: 120,
  r8b: 64,
  r9b: 72,
  r10b: 80,
  r11b: 88,
  r12b: 96,
  r13b: 104,
  r14b: 112,
  r15b: 120,
  spl: 32,
  bpl: 40,
  sil: 48,
  dil: 56,
};

export const RIP_OFFSET = 128;
export const EIP_OFFSET = RIP_OFFSET;
export const EFLAGS_OFFSET = 132;
/** Scratch slot where the JIT records the INT vector on a trap (design 4.2.4). */
export const INT_VECTOR_OFFSET = 136;
/**
 * Monotonic TSC counter for RDTSC (0F 31): a 64-bit value split across two
 * i32 slots (low at TSC_OFFSET, high at TSC_OFFSET+4). It lives in the CPU
 * ctx so JIT-compiled blocks can read/increment it with plain memory ops and
 * it survives across block executions. Notepad uses RDTSC to seed its random
 * number generator during startup.
 */
export const TSC_OFFSET = 140;
export const CTX_SIZE = 148;

/**
 * XMM register file: 16 x 16 bytes, placed right after the CPU context struct
 * (kept clear of it). Indexed by `XMM_BASE + reg*16 + lane*4`.
 */
export const XMM_BASE = CTX_BASE + 0x100;

export function xmmAddr(reg: number): number {
  return XMM_BASE + reg * 16;
}

/**
 * Minimal x87 FPU state: 8 x 8-byte slots (ST(0) at the base). The FPU is
 * emulated as a raw memory-copy device (FLD/FST/FSTP), enough for CRT/init
 * code that only touches the control word or moves values around.
 */
export const FPU_BASE = CTX_BASE + 0x200;

export function fpuAddr(slot: number): number {
  return FPU_BASE + slot * 8;
}

// Block execution status codes returned by JIT-compiled block functions.
export const STATUS_CONTINUE = 0;
export const STATUS_TRAP = 1;
export const STATUS_FAULT = 2;
export const STATUS_EXIT = 3;

// EFLAGS bit positions (design doc 4.1.1 flag semantics)
export const FLAG_CF = 0x0001;
export const FLAG_PF = 0x0004;
export const FLAG_AF = 0x0010;
export const FLAG_ZF = 0x0040;
export const FLAG_SF = 0x0080;
export const FLAG_DF = 0x0400;
export const FLAG_OF = 0x0800;

export const REG32_LIST: readonly RegName[] = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi'] as const;

/**
 * Evaluates a condition code against an EFLAGS value. `result` is 1 (taken)
 * or 0 (not taken) — mirrors the Jcc/SETcc semantics.
 */
export function evalCond(cond: Cond, eflags: number): number {
  const bit = (flag: number): number => (eflags & flag) !== 0 ? 1 : 0;
  const cf = bit(FLAG_CF);
  const zf = bit(FLAG_ZF);
  const sf = bit(FLAG_SF);
  const of = bit(FLAG_OF);
  const pf = bit(FLAG_PF);
  switch (cond) {
    case 'o':
      return of;
    case 'no':
      return of ^ 1;
    case 'b':
      return cf;
    case 'ae':
      return cf ^ 1;
    case 'e':
      return zf;
    case 'ne':
      return zf ^ 1;
    case 'be':
      return cf | zf;
    case 'a':
      return (cf | zf) ^ 1;
    case 's':
      return sf;
    case 'ns':
      return sf ^ 1;
    case 'p':
      return pf;
    case 'np':
      return pf ^ 1;
    case 'l':
      return sf ^ of;
    case 'ge':
      return (sf ^ of) ^ 1;
    case 'le':
      return zf | (sf ^ of);
    case 'g':
      return (zf | (sf ^ of)) ^ 1;
    default:
      return 0;
  }
}

/** Condition codes used by Jcc / SETcc / CMOVcc. */
export type { Cond } from './ir';

/** Conditional opcode nibble -> mnemonic (0x70+rel8 / 0x0F 0x80+rel32). */
export const COND_BY_NIBBLE: readonly Cond[] = ['o', 'no', 'b', 'ae', 'e', 'ne', 'be', 'a', 's', 'ns', 'p', 'np', 'l', 'ge', 'le', 'g'] as const;
