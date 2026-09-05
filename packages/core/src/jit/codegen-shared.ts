/**
 * Shared low-level helpers for the x86 code generator: scratch local indices, decode mode, and operand load/store emitters.
 *
 * Split out of codegen.ts (design doc 4.1.5); pure code movement, no logic changes.
 */

import type { Instruction, MemOperand, Operand, RegName, Size } from './ir';
import { CTX_BASE, EIP_OFFSET, REG_OFFSET } from './cpu';
import type { WasmFunction } from './wasm-encoder';

// scratch local indices (all i32 unless noted)
export const L_A = 0;
export const L_B = 1;
export const L_S = 2;
export const L_TMP = 3;
export const L_TMP2 = 4;
export const L_ORIG = 5;
export const L_I64 = 6; // i64 scratch for mul/div + 64-bit results
export const L_I64A = 7; // i64 operand A (64-bit arithmetic)
export const L_I64B = 8; // i64 operand B (64-bit arithmetic)
export const L_I64HI = 9; // i64: high 64 bits of a 128-bit product
export const L_I64C = 10; // i64: mul split temp (aL / lo)
export const L_I64D = 11; // i64: mul split temp (aH)
export const L_I64E = 12; // i64: mul split temp (bL)
export const L_I64F = 13; // i64: mul split temp (bH)
export const L_I64G = 14; // i64: mul split temp (t0 = aL*bL)
export const L_I64H = 15; // i64: mul split temp (t1 = aL*bH)
export const L_I64I = 16; // i64: mul split temp (t2 = aH*bL)

/** Active decode mode; set at the start of each block compile. */
export let MODE: 'x86' | 'x64' = 'x86';

/** Sets the active decode mode (called at the start of each block compile). */
export function setMode(mode: 'x86' | 'x64'): void {
  MODE = mode;
}

/** Stack slot width in bytes (4 on i386, 8 on x86-64). */
export function stackWidth(): number {
  return MODE === 'x64' ? 8 : 4;
}

export function regAddr(reg: RegName): number {
  return CTX_BASE + (REG_OFFSET[reg] ?? 0);
}

export function storeWidth(fn: WasmFunction, size: Size): void {
  if (size === 8) fn.i32Store8();
  else if (size === 16) fn.i32Store16();
  else if (size === 64) fn.i64Store();
  else fn.i32Store();
}

export function loadWidth(fn: WasmFunction, size: Size): void {
  if (size === 8) fn.i32Load8U();
  else if (size === 16) fn.i32Load16U();
  else if (size === 64) fn.i64Load();
  else fn.i32Load();
}

/** Pushes the effective address of a memory operand onto the stack. */
export function emitEa(fn: WasmFunction, mem: MemOperand): void {
  fn.i32Const(mem.disp);
  if (mem.base) {
    fn.i32Const(regAddr(mem.base));
    fn.i32Load();
    fn.i32Add();
  }
  if (mem.index) {
    fn.i32Const(regAddr(mem.index));
    fn.i32Load();
    fn.i32Const(mem.scale);
    fn.i32Mul();
    fn.i32Add();
  }
}

/** Pushes an operand's value onto the stack (i64 for 64-bit operands). */
export function pushOperand(fn: WasmFunction, op: Operand): void {
  if (op.kind === 'imm') {
    if (op.size === 64) fn.i64Const(op.value);
    else fn.i32Const(op.value);
  } else if (op.kind === 'reg') {
    fn.i32Const(regAddr(op.reg));
    loadWidth(fn, op.size);
  } else if (op.kind === 'mem') {
    emitEa(fn, op);
    loadWidth(fn, op.size);
  } else {
    // relative targets are resolved before reaching here
    fn.i32Const(0);
  }
}

/** Stores the value on top of the stack into an operand (i64 for 64-bit). */
export function storeOperand(fn: WasmFunction, op: Operand): void {
  if (op.kind === 'reg') {
    if (op.size === 64) {
      fn.localSet(L_I64);
      fn.i32Const(regAddr(op.reg));
      fn.localGet(L_I64);
      fn.i64Store();
    } else {
      fn.localSet(L_TMP);
      fn.i32Const(regAddr(op.reg));
      fn.localGet(L_TMP);
      storeWidth(fn, op.size);
      if (MODE === 'x64' && op.size === 32) {
        // writing a 32-bit register zero-extends the upper 32 bits
        fn.i32Const(regAddr(op.reg) + 4);
        fn.i32Const(0);
        fn.i32Store();
      }
    }
  } else if (op.kind === 'mem') {
    const slot = op.size === 64 ? L_I64 : L_TMP;
    fn.localSet(slot);
    emitEa(fn, op);
    fn.localGet(slot);
    storeWidth(fn, op.size);
  } else {
    fn.drop();
  }
}

export function operandSize(inst: Instruction): Size {
  const dst = inst.dst;
  const src = inst.src;
  if (dst && dst.kind !== 'rel' && dst.kind !== 'xmm') return dst.size;
  if (src && src.kind !== 'rel' && src.kind !== 'xmm') return src.size;
  return 32;
}

