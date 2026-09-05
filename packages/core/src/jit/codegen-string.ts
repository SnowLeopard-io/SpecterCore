/**
 * String instruction emitters (DF = 0 assumed unless the DF bit is set): stos/lods/movs/scas/cmps with REP/REPE/REPNE support.
 *
 * Split out of codegen.ts (design doc 4.1.5); pure code movement, no logic changes.
 */

import type { Instruction, Operand, RegName, Size } from './ir';
import { CTX_BASE, EFLAGS_OFFSET, FLAG_DF, FLAG_ZF } from './cpu';
import type { WasmFunction } from './wasm-encoder';
import { L_TMP, L_TMP2, loadWidth, regAddr } from './codegen-shared';
import { emitArith } from './codegen-arith';

// ---------------------------------------------------------------------------
// string ops (DF = 0 assumed unless the DF bit is set)
// ---------------------------------------------------------------------------

/** Pushes the per-element step: +size when DF clear, -size when DF set. */
export function emitStep(fn: WasmFunction, size: Size): void {
  // stack: [1, df] then (1 - df*2)*size
  fn.i32Const(1);
  fn.i32Const(EFLAGS_OFFSET + CTX_BASE);
  fn.i32Load();
  fn.i32Const(FLAG_DF);
  fn.i32And();
  fn.i32Const(0);
  fn.i32Ne(); // df: 0/1
  fn.i32Const(2);
  fn.i32Mul(); // 1, df*2
  fn.i32Sub(); // 1 - df*2  (+1 clear, -1 set)
  fn.i32Const(size === 8 ? 1 : size === 16 ? 2 : 4);
  fn.i32Mul();
}

export function emitStos(fn: WasmFunction, inst: Instruction, size: Size): void {
  const body = (): void => {
    // value = eax
    fn.i32Const(regAddr('eax'));
    loadWidth(fn, size);
    fn.localSet(L_TMP);
    // [edi] = value
    fn.i32Const(regAddr('edi'));
    fn.i32Load();
    fn.localSet(L_TMP2);
    fn.localGet(L_TMP2);
    fn.localGet(L_TMP);
    if (size === 8) fn.i32Store8();
    else if (size === 16) fn.i32Store16();
    else fn.i32Store();
    // edi += step
    emitStep(fn, size);
    fn.localSet(L_TMP);
    fn.i32Const(regAddr('edi'));
    fn.i32Load();
    fn.localGet(L_TMP);
    fn.i32Add();
    fn.localSet(L_TMP2);
    fn.i32Const(regAddr('edi'));
    fn.localGet(L_TMP2);
    fn.i32Store();
  };
  emitMaybeRep(fn, inst.rep ?? false, body);
}

export function emitLods(fn: WasmFunction, inst: Instruction, size: Size): void {
  const body = (): void => {
    // eax = [esi]
    fn.i32Const(regAddr('esi'));
    fn.i32Load();
    fn.localSet(L_TMP2);
    fn.localGet(L_TMP2);
    loadWidth(fn, size);
    fn.localSet(L_TMP);
    fn.i32Const(regAddr('eax'));
    fn.localGet(L_TMP);
    if (size === 8) fn.i32Store8();
    else if (size === 16) fn.i32Store16();
    else fn.i32Store();
    // esi += step
    emitStep(fn, size);
    fn.localSet(L_TMP);
    fn.i32Const(regAddr('esi'));
    fn.i32Load();
    fn.localGet(L_TMP);
    fn.i32Add();
    fn.localSet(L_TMP2);
    fn.i32Const(regAddr('esi'));
    fn.localGet(L_TMP2);
    fn.i32Store();
  };
  emitMaybeRep(fn, inst.rep ?? false, body);
}

export function emitMovs(fn: WasmFunction, inst: Instruction, size: Size): void {
  const body = (): void => {
    // value = [esi]
    fn.i32Const(regAddr('esi'));
    fn.i32Load();
    fn.localSet(L_TMP2);
    fn.localGet(L_TMP2);
    loadWidth(fn, size);
    fn.localSet(L_TMP);
    // [edi] = value
    fn.i32Const(regAddr('edi'));
    fn.i32Load();
    fn.localSet(L_TMP2);
    fn.localGet(L_TMP2);
    fn.localGet(L_TMP);
    if (size === 8) fn.i32Store8();
    else if (size === 16) fn.i32Store16();
    else fn.i32Store();
    // esi += step; edi += step
    emitStep(fn, size);
    fn.localSet(L_TMP);
    fn.i32Const(regAddr('esi'));
    fn.i32Load();
    fn.localGet(L_TMP);
    fn.i32Add();
    fn.localSet(L_TMP2);
    fn.i32Const(regAddr('esi'));
    fn.localGet(L_TMP2);
    fn.i32Store();
    emitStep(fn, size);
    fn.localSet(L_TMP);
    fn.i32Const(regAddr('edi'));
    fn.i32Load();
    fn.localGet(L_TMP);
    fn.i32Add();
    fn.localSet(L_TMP2);
    fn.i32Const(regAddr('edi'));
    fn.localGet(L_TMP2);
    fn.i32Store();
  };
  emitMaybeRep(fn, inst.rep ?? false, body);
}

/** Wraps a single string-op body in a REP loop when `rep` is set. */
export function emitMaybeRep(fn: WasmFunction, rep: boolean, body: () => void): void {
  if (!rep) {
    body();
    return;
  }
  const outer = fn.block(); // break target
  const inner = fn.loop(); // continue target
  // ecx == 0 -> break
  fn.i32Const(regAddr('ecx'));
  fn.i32Load();
  fn.i32Eqz();
  fn.brIf(outer);
  body();
  // ecx--
  fn.i32Const(regAddr('ecx'));
  fn.i32Load();
  fn.i32Const(1);
  fn.i32Sub();
  fn.localSet(L_TMP);
  fn.i32Const(regAddr('ecx'));
  fn.localGet(L_TMP);
  fn.i32Store();
  fn.br(inner);
  fn.end(); // inner loop
  fn.end(); // outer block
}

/** Advances a pointer register (`esi`/`edi`) by the DF-adjusted element step. */
export function emitAdvance(fn: WasmFunction, reg: RegName, size: Size): void {
  emitStep(fn, size);
  fn.localSet(L_TMP);
  fn.i32Const(regAddr(reg));
  fn.i32Load();
  fn.localGet(L_TMP);
  fn.i32Add();
  fn.localSet(L_TMP2);
  fn.i32Const(regAddr(reg));
  fn.localGet(L_TMP2);
  fn.i32Store();
}

/**
 * Wraps a comparing string-op body (`scas`/`cmps`) in a conditional REP loop.
 * F3 = REPE (repeat while ZF=1), F2 = REPNE (repeat while ZF=0). The body must
 * set ZF (via a `cmp`) before this checks the termination condition.
 */
export function emitRepCond(fn: WasmFunction, rep: boolean, repne: boolean, body: () => void): void {
  if (!rep) {
    body();
    return;
  }
  const outer = fn.block(); // break target
  const inner = fn.loop(); // continue target
  // ecx == 0 -> break
  fn.i32Const(regAddr('ecx'));
  fn.i32Load();
  fn.i32Eqz();
  fn.brIf(outer);
  body(); // performs the compare and sets ZF
  // ecx--
  fn.i32Const(regAddr('ecx'));
  fn.i32Load();
  fn.i32Const(1);
  fn.i32Sub();
  fn.localSet(L_TMP);
  fn.i32Const(regAddr('ecx'));
  fn.localGet(L_TMP);
  fn.i32Store();
  // ZF-based early exit: REPNE breaks on ZF=1, REPE breaks on ZF=0
  fn.i32Const(EFLAGS_OFFSET + CTX_BASE);
  fn.i32Load();
  fn.i32Const(FLAG_ZF);
  fn.i32And();
  if (repne) {
    // (eflags & ZF) != 0 -> break
    fn.brIf(outer);
  } else {
    // (eflags & ZF) == 0 -> break
    fn.i32Eqz();
    fn.brIf(outer);
  }
  fn.br(inner);
  fn.end(); // inner loop
  fn.end(); // outer block
}

/** SCAS: compares AL/AX/EAX with [EDI] (sets flags like CMP), then advances EDI. */
export function emitScas(fn: WasmFunction, inst: Instruction, size: Size): void {
  const acc: Operand = { kind: 'reg', reg: 'eax', size };
  const mem: Operand = { kind: 'mem', base: 'edi', scale: 1, disp: 0, size };
  const body = (): void => {
    emitArith(fn, 'cmp', size, acc, mem);
    emitAdvance(fn, 'edi', size);
  };
  emitRepCond(fn, inst.rep ?? false, inst.repne ?? false, body);
}

/** CMPS: compares [ESI] with [EDI] (sets flags like CMP), then advances both. */
export function emitCmps(fn: WasmFunction, inst: Instruction, size: Size): void {
  const srcEsi: Operand = { kind: 'mem', base: 'esi', scale: 1, disp: 0, size };
  const srcEdi: Operand = { kind: 'mem', base: 'edi', scale: 1, disp: 0, size };
  const body = (): void => {
    // CMPS computes [ESI] - [EDI]; only flags matter (no write-back for cmp).
    emitArith(fn, 'cmp', size, srcEsi, srcEdi);
    emitAdvance(fn, 'esi', size);
    emitAdvance(fn, 'edi', size);
  };
  emitRepCond(fn, inst.rep ?? false, inst.repne ?? false, body);
}

