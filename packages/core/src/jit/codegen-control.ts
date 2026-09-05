/**
 * Control-flow instruction emitters: jmp/jcc/call/ret/int/leave, setcc/cmov, and the EFLAGS condition evaluator.
 *
 * Split out of codegen.ts (design doc 4.1.5); pure code movement, no logic changes.
 */

import type { Cond } from './cpu';
import { CTX_BASE, EFLAGS_OFFSET, EIP_OFFSET, INT_VECTOR_OFFSET, STATUS_TRAP } from './cpu';
import type { Operand, Size } from './ir';
import type { WasmFunction } from './wasm-encoder';
import {
  L_TMP,
  L_TMP2,
  MODE,
  pushOperand,
  regAddr,
  stackWidth,
  storeOperand,
} from './codegen-shared';
import { emitPopRaw, emitPushRaw, espAddr } from './codegen-stack';

// ---------------------------------------------------------------------------
// control flow
// ---------------------------------------------------------------------------

export function storeEip(fn: WasmFunction): void {
  fn.localSet(L_TMP);
  fn.i32Const(EIP_OFFSET + CTX_BASE);
  fn.localGet(L_TMP);
  fn.i32Store();
}

export function resolveTarget(target: Operand, nextAddress: number): number {
  if (target.kind === 'rel') return nextAddress + target.delta;
  return 0;
}

export function emitJmp(fn: WasmFunction, target: Operand, nextAddress: number): void {
  if (target.kind === 'rel') {
    fn.i32Const(resolveTarget(target, nextAddress));
    storeEip(fn);
  } else {
    pushOperand(fn, target);
    if (target.size === 64) fn.i32WrapI64();
    storeEip(fn);
  }
}

export function emitJcc(fn: WasmFunction, cond: Cond, target: Operand, nextAddress: number): void {
  const taken = resolveTarget(target, nextAddress);
  const fallthrough = nextAddress;
  emitCond(fn, cond);
  fn.localSet(L_TMP);
  // eip = cond ? taken : fallthrough  (select: v1 when cond, else v2)
  fn.i32Const(taken);
  fn.i32Const(fallthrough);
  fn.localGet(L_TMP);
  fn.select();
  storeEip(fn);
}

export function emitCall(fn: WasmFunction, target: Operand, nextAddress: number): void {
  // push return address
  emitPushRaw(fn, stackWidth(), () => {
    if (MODE === 'x64') fn.i64Const(nextAddress);
    else fn.i32Const(nextAddress);
  });
  // eip = target
  if (target.kind === 'rel') {
    fn.i32Const(resolveTarget(target, nextAddress));
    storeEip(fn);
  } else {
    pushOperand(fn, target);
    if (target.size === 64) fn.i32WrapI64();
    storeEip(fn);
  }
}

export function emitRet(fn: WasmFunction, popBytes: number, size: Size): void {
  emitPopRaw(fn, stackWidth()); // value (return address) on stack
  if (MODE === 'x64') {
    // the popped return address is an i64; EIP is a 32-bit guest address
    fn.i32WrapI64();
  }
  fn.localSet(L_TMP);
  fn.i32Const(EIP_OFFSET + CTX_BASE);
  fn.localGet(L_TMP);
  fn.i32Store();
  if (popBytes > 0) {
    fn.i32Const(espAddr());
    fn.i32Load();
    fn.i32Const(popBytes);
    fn.i32Add();
    fn.localSet(L_TMP);
    fn.i32Const(espAddr());
    fn.localGet(L_TMP);
    fn.i32Store();
  }
  void size;
}

export function emitInt(fn: WasmFunction, vector: number, nextAddress: number): void {
  // record the vector for the dispatcher, continue after the int
  fn.i32Const(INT_VECTOR_OFFSET + CTX_BASE);
  fn.i32Const(vector);
  fn.i32Store();
  fn.i32Const(nextAddress);
  storeEip(fn);
  fn.i32Const(STATUS_TRAP);
  fn.return_();
}

export function emitLeave(fn: WasmFunction): void {
  // esp = ebp/rbp; pop ebp/rbp
  fn.i32Const(regAddr('ebp'));
  fn.i32Load();
  fn.localSet(L_TMP);
  fn.i32Const(espAddr());
  fn.localGet(L_TMP);
  fn.i32Store();
  emitPopRaw(fn, stackWidth());
  if (MODE === 'x64') fn.i32WrapI64();
  fn.localSet(L_TMP);
  fn.i32Const(regAddr('ebp'));
  fn.localGet(L_TMP);
  fn.i32Store();
}

export function emitSetcc(fn: WasmFunction, cond: Cond, dst: Operand): void {
  emitCond(fn, cond);
  if (dst.kind !== 'rel' && dst.size === 64) fn.i64ExtendI32U();
  storeOperand(fn, dst);
}

/** CMOVcc dst, src: dst = cond ? src : dst. */
export function emitCmov(fn: WasmFunction, cond: Cond, dst: Operand, src: Operand): void {
  pushOperand(fn, src);
  pushOperand(fn, dst);
  emitCond(fn, cond);
  // select(v1=src, v2=dst, c) -> c ? src : dst
  fn.select();
  storeOperand(fn, dst);
}

/** Pushes 1 if `cond` holds against the current EFLAGS, else 0. */
export function emitCond(fn: WasmFunction, cond: Cond): void {
  const load = (): void => {
    fn.i32Const(EFLAGS_OFFSET + CTX_BASE);
    fn.i32Load();
  };
  const bit = (pos: number): void => {
    fn.i32Const(pos);
    fn.i32ShrU();
    fn.i32Const(1);
    fn.i32And();
  };
  const not = (): void => {
    fn.i32Const(1);
    fn.i32Xor();
  };
  switch (cond) {
    case 'o':
      load();
      bit(11);
      break;
    case 'no':
      load();
      bit(11);
      not();
      break;
    case 'b':
      load();
      fn.i32Const(1);
      fn.i32And();
      break;
    case 'ae':
      load();
      fn.i32Const(1);
      fn.i32And();
      not();
      break;
    case 'e':
      load();
      bit(6);
      break;
    case 'ne':
      load();
      bit(6);
      not();
      break;
    case 'be':
      load();
      fn.i32Const(1);
      fn.i32And();
      fn.localSet(L_TMP);
      load();
      bit(6);
      fn.localGet(L_TMP);
      fn.i32Or();
      break;
    case 'a':
      load();
      fn.i32Const(1);
      fn.i32And();
      fn.localSet(L_TMP);
      load();
      bit(6);
      fn.localGet(L_TMP);
      fn.i32Or();
      not();
      break;
    case 's':
      load();
      bit(7);
      break;
    case 'ns':
      load();
      bit(7);
      not();
      break;
    case 'p':
      load();
      bit(2);
      break;
    case 'np':
      load();
      bit(2);
      not();
      break;
    case 'l':
      load();
      bit(7);
      fn.localSet(L_TMP);
      load();
      bit(11);
      fn.localGet(L_TMP);
      fn.i32Xor();
      break;
    case 'ge':
      load();
      bit(7);
      fn.localSet(L_TMP);
      load();
      bit(11);
      fn.localGet(L_TMP);
      fn.i32Xor();
      not();
      break;
    case 'le':
      load();
      bit(6);
      fn.localSet(L_TMP);
      load();
      bit(7);
      fn.localSet(L_TMP2);
      load();
      bit(11);
      fn.localGet(L_TMP2);
      fn.i32Xor();
      fn.localGet(L_TMP);
      fn.i32Or();
      break;
    case 'g':
      load();
      bit(6);
      fn.localSet(L_TMP);
      load();
      bit(7);
      fn.localSet(L_TMP2);
      load();
      bit(11);
      fn.localGet(L_TMP2);
      fn.i32Xor();
      fn.localGet(L_TMP);
      fn.i32Or();
      not();
      break;
  }
}
