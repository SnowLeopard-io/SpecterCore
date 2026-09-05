/**
 * EFLAGS computation emitters: ZF/SF/PF/OF/AF/CF for 32-bit and 64-bit arithmetic.
 *
 * Split out of codegen.ts (design doc 4.1.5); pure code movement, no logic changes.
 */

import type { Instruction, Size } from './ir';
import { CTX_BASE, EFLAGS_OFFSET, FLAG_DF } from './cpu';
import type { WasmFunction } from './wasm-encoder';
import { L_A, L_B, L_I64, L_I64A, L_I64B, L_S, L_TMP } from './codegen-shared';

// ---------------------------------------------------------------------------
// flags
// ---------------------------------------------------------------------------

export function flagMask(size: Size): number {
  return size === 8 ? 0xff : size === 16 ? 0xffff : 0xffffffff;
}

/** Starts a flags accumulator with 0. */
export function beginFlags(fn: WasmFunction): void {
  fn.i32Const(0);
}

/** ORs `(bit ? 1 : 0) << pos` into the accumulator. */
export function orFlag(fn: WasmFunction, bitPos: number): void {
  fn.i32Const(1 << bitPos);
  fn.i32Mul();
  fn.i32Or();
}

/** Emits ZF/SF/PF from the result in local L_S for the given size. */
export function emitZspFlags(fn: WasmFunction, size: Size): void {
  const mask = flagMask(size);
  const shift = size - 1;
  // ZF
  fn.localGet(L_S);
  fn.i32Const(mask);
  fn.i32And();
  fn.i32Eqz();
  orFlag(fn, 6);
  // SF
  fn.localGet(L_S);
  fn.i32Const(mask);
  fn.i32And();
  fn.i32Const(shift);
  fn.i32ShrU();
  orFlag(fn, 7);
  // PF (parity of the low byte)
  fn.localGet(L_S);
  fn.i32Const(0xff);
  fn.i32And();
  fn.i32Popcnt();
  fn.i32Const(1);
  fn.i32And();
  fn.i32Eqz();
  orFlag(fn, 2);
}

/**
 * Emits OF for a binary op. ADD/XADD: OF = ((a^s) & (b^s)) >> (size-1)
 * (overflow only when a and b share a sign that the result flips).
 * SUB/SBB/CMP: OF = ((a^b) & (a^s)) >> (size-1) (borrow across the sign bit).
 * Logical ops: OF is always 0.
 */
export function emitOfBinary(fn: WasmFunction, size: Size, op: Instruction['op']): void {
  const mask = flagMask(size);
  if (op === 'add' || op === 'adc' || op === 'xadd') {
    fn.localGet(L_A);
    fn.localGet(L_S);
    fn.i32Xor();
    fn.localGet(L_B);
    fn.localGet(L_S);
    fn.i32Xor();
    fn.i32And();
  } else if (op === 'sub' || op === 'sbb' || op === 'cmp') {
    fn.localGet(L_A);
    fn.localGet(L_B);
    fn.i32Xor();
    fn.localGet(L_A);
    fn.localGet(L_S);
    fn.i32Xor();
    fn.i32And();
  } else {
    fn.i32Const(0);
  }
  fn.i32Const(mask);
  fn.i32And();
  fn.i32Const(size - 1);
  fn.i32ShrU();
  orFlag(fn, 11);
}

/** Emits AF for an add (carry out of bit 3). */
export function emitAfAdd(fn: WasmFunction): void {
  fn.localGet(L_A);
  fn.i32Const(0xf);
  fn.i32And();
  fn.localGet(L_B);
  fn.i32Const(0xf);
  fn.i32And();
  fn.i32Add();
  fn.i32Const(0xf);
  fn.i32GtU();
  orFlag(fn, 4);
}

/** Emits AF for a sub (borrow into bit 3). */
export function emitAfSub(fn: WasmFunction): void {
  fn.localGet(L_A);
  fn.i32Const(0xf);
  fn.i32And();
  fn.localGet(L_B);
  fn.i32Const(0xf);
  fn.i32And();
  fn.i32LtU();
  orFlag(fn, 4);
}

// ---- 64-bit flag helpers (result in L_I64, operands in L_I64A/L_I64B) ----

/** Emits ZF/SF/PF from the 64-bit result in local L_I64. */
export function emitZspFlags64(fn: WasmFunction): void {
  // ZF
  fn.localGet(L_I64);
  fn.i64Eqz();
  orFlag(fn, 6);
  // SF = sign bit 63
  fn.localGet(L_I64);
  fn.i64Const(63);
  fn.i64ShrU();
  fn.i32WrapI64();
  orFlag(fn, 7);
  // PF (parity of the low byte)
  fn.localGet(L_I64);
  fn.i32WrapI64();
  fn.i32Const(0xff);
  fn.i32And();
  fn.i32Popcnt();
  fn.i32Const(1);
  fn.i32And();
  fn.i32Eqz();
  orFlag(fn, 2);
}

/** Emits OF for a 64-bit binary op (same sign rules as emitOfBinary). */
export function emitOfBinary64(fn: WasmFunction, op: Instruction['op']): void {
  if (op === 'add' || op === 'adc' || op === 'xadd') {
    fn.localGet(L_I64A);
    fn.localGet(L_I64);
    fn.i64Xor();
    fn.localGet(L_I64B);
    fn.localGet(L_I64);
    fn.i64Xor();
    fn.i64And();
  } else if (op === 'sub' || op === 'sbb' || op === 'cmp') {
    fn.localGet(L_I64A);
    fn.localGet(L_I64B);
    fn.i64Xor();
    fn.localGet(L_I64A);
    fn.localGet(L_I64);
    fn.i64Xor();
    fn.i64And();
  } else {
    fn.i64Const(0);
  }
  fn.i64Const(63);
  fn.i64ShrU();
  fn.i32WrapI64();
  orFlag(fn, 11);
}

/** Emits AF for a 64-bit add (carry out of bit 3). */
export function emitAfAdd64(fn: WasmFunction): void {
  fn.localGet(L_I64A);
  fn.i32WrapI64();
  fn.i32Const(0xf);
  fn.i32And();
  fn.localGet(L_I64B);
  fn.i32WrapI64();
  fn.i32Const(0xf);
  fn.i32And();
  fn.i32Add();
  fn.i32Const(0xf);
  fn.i32GtU();
  orFlag(fn, 4);
}

/** Emits AF for a 64-bit sub (borrow into bit 3). */
export function emitAfSub64(fn: WasmFunction): void {
  fn.localGet(L_I64A);
  fn.i32WrapI64();
  fn.i32Const(0xf);
  fn.i32And();
  fn.localGet(L_I64B);
  fn.i32WrapI64();
  fn.i32Const(0xf);
  fn.i32And();
  fn.i32LtU();
  orFlag(fn, 4);
}

/** Finalizes the flags word, preserving the DF bit, and stores it. */
export function storeFlags(fn: WasmFunction): void {
  // preserve DF across arithmetic (string ops rely on it)
  fn.i32Const(EFLAGS_OFFSET + CTX_BASE);
  fn.i32Load();
  fn.i32Const(FLAG_DF);
  fn.i32And();
  fn.i32Or();
  fn.localSet(L_TMP);
  fn.i32Const(EFLAGS_OFFSET + CTX_BASE);
  fn.localGet(L_TMP);
  fn.i32Store();
}
