/**
 * Guest stack operations: push/pop (incl. raw forms used by pushfd/popfd/ret) and pusha/popa.
 *
 * Split out of codegen.ts (design doc 4.1.5); pure code movement, no logic changes.
 */

import type { Operand, RegName, Size } from './ir';
import { CTX_BASE, REG_OFFSET } from './cpu';
import type { WasmFunction } from './wasm-encoder';
import { L_I64, L_ORIG, L_TMP, L_TMP2, loadWidth, pushOperand, regAddr, stackWidth, storeOperand } from './codegen-shared';

export function espAddr(): number {
  return CTX_BASE + (REG_OFFSET['esp'] ?? 0);
}

export function emitPush(fn: WasmFunction, op: Operand, size: Size): void {
  const width = size === 8 ? 1 : size === 16 ? 2 : stackWidth();
  if (op.kind === 'imm') {
    emitPushRaw(fn, width, () => {
      if (op.size === 64) fn.i64Const(op.value);
      else fn.i32Const(op.value);
    });
  } else {
    emitPushRaw(fn, width, () => pushOperand(fn, op));
  }
}

/** Pushes the value produced by `value` (top of stack after callback). */
export function emitPushRaw(fn: WasmFunction, width: number, value?: () => void): void {
  if (value) value();
  if (width === 8) {
    // 64-bit push: keep the i64 value in L_I64 (the callback leaves an i64)
    fn.localSet(L_I64);
  } else {
    fn.localSet(L_TMP); // value
  }
  // esp -= width
  fn.i32Const(espAddr());
  fn.i32Load();
  fn.i32Const(width);
  fn.i32Sub();
  fn.localSet(L_TMP2); // new esp
  fn.i32Const(espAddr());
  fn.localGet(L_TMP2);
  fn.i32Store();
  // [esp] = value
  fn.localGet(L_TMP2);
  if (width === 1) {
    fn.localGet(L_TMP);
    fn.i32Store8();
  } else if (width === 2) {
    fn.localGet(L_TMP);
    fn.i32Store16();
  } else if (width === 8) {
    fn.localGet(L_I64);
    fn.i64Store();
  } else {
    fn.localGet(L_TMP);
    fn.i32Store();
  }
}

export function emitPop(fn: WasmFunction, op: Operand, size: Size): void {
  const width = size === 8 ? 1 : size === 16 ? 2 : stackWidth();
  // value = [esp]
  fn.i32Const(espAddr());
  fn.i32Load();
  fn.localSet(L_TMP2); // esp
  fn.localGet(L_TMP2);
  if (size === 64) {
    fn.i64Load();
    fn.localSet(L_I64);
  } else {
    loadWidth(fn, size);
    fn.localSet(L_TMP);
  }
  // store value into the operand
  if (size === 64) {
    fn.localGet(L_I64);
    storeOperand(fn, op);
  } else {
    fn.localGet(L_TMP);
    storeOperand(fn, op);
  }
  // esp += width
  fn.localGet(L_TMP2);
  fn.i32Const(width);
  fn.i32Add();
  fn.localSet(L_TMP);
  fn.i32Const(espAddr());
  fn.localGet(L_TMP);
  fn.i32Store();
}

/** Pops a value leaving it on the stack; used by popfd/ret. */
export function emitPopRaw(fn: WasmFunction, width: number): void {
  fn.i32Const(espAddr());
  fn.i32Load();
  fn.localSet(L_TMP2); // esp
  fn.localGet(L_TMP2);
  if (width === 8) fn.i64Load();
  else loadWidth(fn, width === 1 ? 8 : width === 2 ? 16 : 32);
  // esp += width
  fn.localGet(L_TMP2);
  fn.i32Const(width);
  fn.i32Add();
  fn.localSet(L_TMP);
  fn.i32Const(espAddr());
  fn.localGet(L_TMP);
  fn.i32Store();
}

export function emitPusha(fn: WasmFunction): void {
  // save original esp
  fn.i32Const(espAddr());
  fn.i32Load();
  fn.localSet(L_ORIG);
  const order: RegName[] = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi'];
  for (const reg of order) {
    if (reg === 'esp') {
      emitPushRaw(fn, 4, () => fn.localGet(L_ORIG));
    } else {
      emitPushRaw(fn, 4, () => {
        fn.i32Const(regAddr(reg));
        fn.i32Load();
      });
    }
  }
}

export function emitPopa(fn: WasmFunction): void {
  const order: RegName[] = ['edi', 'esi', 'ebp', 'esp', 'ebx', 'edx', 'ecx', 'eax'];
  for (const reg of order) {
    if (reg === 'esp') {
      // skip (esp is adjusted by the pops themselves)
      fn.i32Const(espAddr());
      fn.i32Load();
      fn.i32Const(4);
      fn.i32Add();
      fn.localSet(L_TMP);
      fn.i32Const(espAddr());
      fn.localGet(L_TMP);
      fn.i32Store();
    } else {
      emitPopRaw(fn, 4);
      fn.localSet(L_TMP);
      fn.i32Const(regAddr(reg));
      fn.localGet(L_TMP);
      fn.i32Store();
    }
  }
}

