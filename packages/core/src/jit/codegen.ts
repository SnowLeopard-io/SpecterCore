/**
 * x86 IR -> WASM code generator (design doc 4.1.5).
 *
 * Loweres one decoded basic block into a single WASM function body. The guest
 * CPU state is stored in the CPU-context struct in linear memory (see `cpu.ts`),
 * so the generated function is self-contained: it reads registers, executes,
 * writes results/flags back, and returns a status code for the dispatcher.
 *
 * Flags are recomputed from the 32-bit operands and result for every
 * flag-affecting instruction, matching real x86 semantics (design 4.1.1).
 */

import { WasmFunction } from './wasm-encoder';
import type { Instruction, MemOperand, XmmOperand } from './ir';
import { CTX_BASE, EFLAGS_OFFSET, FLAG_DF, STATUS_CONTINUE, STATUS_FAULT, fpuAddr } from './cpu';
import {
  L_TMP,
  emitEa,
  operandSize,
  pushOperand,
  regAddr,
  setMode,
  storeOperand,
} from './codegen-shared';
import {
  emitArith,
  emitCmpXchg,
  emitIncDec,
  emitMov,
  emitNeg,
  emitTest,
  emitXadd,
  emitXchg,
} from './codegen-arith';
import { emitPop, emitPopRaw, emitPopa, emitPush, emitPushRaw, emitPusha } from './codegen-stack';
import {
  emitCall,
  emitCmov,
  emitInt,
  emitJcc,
  emitJmp,
  emitLeave,
  emitRet,
  emitSetcc,
  storeEip,
} from './codegen-control';
import { emitBitScan, emitBitTest } from './codegen-bits';
import { emitCpuid, emitFpuIntMove, emitFpuMove, emitRdtsc } from './codegen-misc';
import {
  emitXmmHalfMove,
  emitXmmMove,
  emitXmmMovd,
  emitXmmPshufd,
  emitXmmPxor,
  emitXmmShiftBytes,
} from './codegen-xmm';
import { emitRotateCarry, emitShift } from './codegen-shift';
import { emitDiv, emitMul } from './codegen-muldiv';
import { emitCmps, emitLods, emitMovs, emitScas, emitStos } from './codegen-string';

/** Compiles a decoded block into a WASM function body. */
export function buildBlockFunction(instructions: readonly { inst: Instruction; nextAddress: number }[], opts: { terminated: boolean; endAddress: number; mode?: 'x86' | 'x64' }): WasmFunction {
  setMode(opts.mode ?? 'x86');
  const fn = new WasmFunction();
  for (let i = 0; i <= 5; i++) fn.declareLocal('i32');
  fn.declareLocal('i64'); // L_I64
  fn.declareLocal('i64'); // L_I64A
  fn.declareLocal('i64'); // L_I64B
  fn.declareLocal('i64'); // L_I64HI
  fn.declareLocal('i64'); // L_I64C
  fn.declareLocal('i64'); // L_I64D
  fn.declareLocal('i64'); // L_I64E
  fn.declareLocal('i64'); // L_I64F
  fn.declareLocal('i64'); // L_I64G
  fn.declareLocal('i64'); // L_I64H
  fn.declareLocal('i64'); // L_I64I
  for (const di of instructions) emitInstruction(fn, di.inst, di.nextAddress);
  if (!opts.terminated) {
    // straight-line block: advance EIP past the block so the dispatcher continues
    fn.i32Const(opts.endAddress);
    storeEip(fn);
  }
  // default: continue to the next block
  fn.i32Const(STATUS_CONTINUE);
  fn.end();
  return fn;
}

// ---------------------------------------------------------------------------
// instruction lowering
// ---------------------------------------------------------------------------

function emitInstruction(fn: WasmFunction, inst: Instruction, nextAddress: number): void {
  const size = operandSize(inst);
  switch (inst.op) {
    case 'mov':
    case 'movzx':
    case 'movsx':
      emitMov(fn, inst, size);
      return;
    case 'add':
    case 'sub':
    case 'adc':
    case 'sbb':
    case 'and':
    case 'or':
    case 'xor':
    case 'cmp':
      emitArith(fn, inst.op, size, inst.dst!, inst.src!);
      return;
    case 'test':
      emitTest(fn, size, inst.dst!, inst.src!);
      return;
    case 'inc':
    case 'dec':
      emitIncDec(fn, inst.op, size, inst.dst!);
      return;
    case 'neg':
      emitNeg(fn, size, inst.dst!);
      return;
    case 'not':
      if (size === 64) {
        pushOperand(fn, inst.dst!);
        fn.i64Const(-1);
        fn.i64Xor();
        storeOperand(fn, inst.dst!);
        return;
      }
      pushOperand(fn, inst.dst!);
      fn.i32Const(0xffffffff);
      fn.i32Xor();
      storeOperand(fn, inst.dst!);
      return;
    case 'lea':
      if (inst.src && inst.src.kind === 'mem') {
        emitEa(fn, inst.src);
        if (inst.dst?.size === 64) fn.i64ExtendI32U();
        storeOperand(fn, inst.dst!);
      }
      return;
    case 'mov-sreg': {
      // MOV r/m16, Sreg — flat model: segment selectors are all 0, so this
      // stores a 16-bit zero to the destination.
      const dst = inst.dst;
      if (dst && dst.kind === 'mem') {
        emitEa(fn, dst);
        fn.i32Const(0);
        fn.i32Store16();
      } else if (dst && dst.kind === 'reg') {
        fn.i32Const(0);
        storeOperand(fn, dst);
      }
      return;
    }
    case 'push':
      emitPush(fn, inst.src!, size);
      return;
    case 'pop':
      emitPop(fn, inst.dst!, size);
      return;
    case 'pusha':
      emitPusha(fn);
      return;
    case 'popa':
      emitPopa(fn);
      return;
    case 'jmp':
      emitJmp(fn, inst.target!, nextAddress);
      return;
    case 'jcc':
      emitJcc(fn, inst.cond!, inst.target!, nextAddress);
      return;
    case 'call':
      emitCall(fn, inst.target!, nextAddress);
      return;
    case 'ret':
      emitRet(fn, inst.popBytes ?? 0, size);
      return;
    case 'int':
      emitInt(fn, inst.vector ?? 0, nextAddress);
      return;
    case 'xchg':
      emitXchg(fn, inst.dst!, inst.src!, size);
      return;
    case 'cpuid':
      emitCpuid(fn);
      return;
    case 'rdtsc':
      emitRdtsc(fn);
      return;
    case 'xmm-load':
      emitXmmMove(fn, inst.dst as XmmOperand, inst.src as MemOperand | XmmOperand, true, inst.lanes ?? 4);
      return;
    case 'xmm-store':
      emitXmmMove(fn, inst.src as XmmOperand, inst.dst as MemOperand | XmmOperand, false, inst.lanes ?? 4);
      return;
    case 'xmm-movd':
      emitXmmMovd(fn, inst.dst!, inst.src!);
      return;
    case 'xmm-movlps-load':
    case 'xmm-movhps-load':
      emitXmmHalfMove(fn, inst.dst as XmmOperand, inst.src as MemOperand, inst.op === 'xmm-movhps-load' ? 1 : 0, true);
      return;
    case 'xmm-movlps-store':
    case 'xmm-movhps-store':
      emitXmmHalfMove(fn, inst.src as XmmOperand, inst.dst as MemOperand, inst.op === 'xmm-movhps-store' ? 1 : 0, false);
      return;
    case 'xmm-pshufd':
      emitXmmPshufd(fn, inst.dst as XmmOperand, inst.src as MemOperand | XmmOperand, (inst.target as { value: number }).value);
      return;
    case 'xmm-pxor':
      emitXmmPxor(fn, inst.dst as XmmOperand, inst.src as MemOperand | XmmOperand);
      return;
    case 'xmm-psrldq':
      emitXmmShiftBytes(fn, inst.dst as XmmOperand, inst.src as MemOperand | XmmOperand, (inst.target as { value: number }).value, false);
      return;
    case 'xmm-pslldq':
      emitXmmShiftBytes(fn, inst.dst as XmmOperand, inst.src as MemOperand | XmmOperand, (inst.target as { value: number }).value, true);
      return;
    case 'finit':
    case 'fldcw':
      // FPU emulated as idle: FNINIT and FLDCW are no-ops.
      return;
    case 'ffree':
    case 'fincstp':
    case 'fdecstp':
    case 'fnop':
      // Stack housekeeping only. ST(0) lives in a fixed slot and FSTP already
      // does not pop, so rotating/freeing the (unmodelled) stack is a no-op.
      return;
    case 'fstcw': {
      // write the standard default control word (0x037F) as a 16-bit value
      const dst = inst.dst as MemOperand | undefined;
      if (dst) {
        emitEa(fn, dst);
        fn.i32Const(0x037f);
        fn.i32Store16();
      }
      return;
    }
    case 'fld':
    case 'fst':
    case 'fstp':
      emitFpuMove(fn, inst.op as 'fld' | 'fst' | 'fstp', inst.dst as MemOperand | undefined, inst.src as MemOperand | undefined, inst.size === 32 ? 32 : 64);
      return;
    case 'fild':
    case 'fist':
    case 'fistp':
      emitFpuIntMove(fn, inst.op as 'fild' | 'fist' | 'fistp', inst.dst as MemOperand | undefined, inst.src as MemOperand | undefined, inst.size === 32 ? 32 : 64);
      return;
    case 'fld1':
    case 'fldz': {
      const hi = inst.op === 'fld1' ? 0x3ff00000 : 0; // 1.0 / 0.0 (f64 high dword)
      fn.i32Const(fpuAddr(0));
      fn.i32Const(0);
      fn.i32Store();
      fn.i32Const(fpuAddr(0) + 4);
      fn.i32Const(hi);
      fn.i32Store();
      return;
    }
    case 'shl':
    case 'shr':
    case 'sar':
    case 'rol':
    case 'ror':
      emitShift(fn, inst.op, size, inst.dst!, inst.src!);
      return;
    case 'rcl':
    case 'rcr':
      emitRotateCarry(fn, inst.op, size, inst.dst!, inst.src!);
      return;
    case 'mul':
    case 'imul':
      emitMul(fn, inst, size);
      return;
    case 'div':
    case 'idiv':
      emitDiv(fn, inst.op, size, inst.dst!);
      return;
    case 'setcc':
      emitSetcc(fn, inst.cond!, inst.dst!);
      return;
    case 'cmov':
      emitCmov(fn, inst.cond!, inst.dst!, inst.src!);
      return;
    case 'cmpxchg':
      emitCmpXchg(fn, size, inst.dst!, inst.src!);
      return;
    case 'xadd':
      emitXadd(fn, size, inst.dst!, inst.src!);
      return;
    case 'bsf':
    case 'bsr':
      emitBitScan(fn, inst.op === 'bsf' ? 'bsf' : 'bsr', size, inst.dst!, inst.src!);
      return;
    case 'bt':
    case 'bts':
    case 'btr':
    case 'btc':
      emitBitTest(fn, inst.op as 'bt' | 'bts' | 'btr' | 'btc', size, inst.dst!, inst.src!);
      return;
    case 'pushfd':
      fn.i32Const(EFLAGS_OFFSET + CTX_BASE);
      fn.i32Load();
      emitPushRaw(fn, 4);
      return;
    case 'popfd':
      emitPopRaw(fn, 4);
      fn.localSet(L_TMP);
      fn.i32Const(EFLAGS_OFFSET + CTX_BASE);
      fn.localGet(L_TMP);
      fn.i32Store();
      return;
    case 'cwde':
      fn.i32Const(regAddr('eax'));
      fn.i32Load16S();
      fn.localSet(L_TMP);
      fn.i32Const(regAddr('eax'));
      fn.localGet(L_TMP);
      fn.i32Store();
      return;
    case 'cdq':
      fn.i32Const(regAddr('eax'));
      fn.i32Load();
      fn.i32Const(31);
      fn.i32ShrS();
      fn.localSet(L_TMP);
      fn.i32Const(regAddr('edx'));
      fn.localGet(L_TMP);
      fn.i32Store();
      return;
    case 'nop':
      return;
    case 'stos':
      emitStos(fn, inst, size);
      return;
    case 'lods':
      emitLods(fn, inst, size);
      return;
    case 'movs':
      emitMovs(fn, inst, size);
      return;
    case 'scas':
      emitScas(fn, inst, size);
      return;
    case 'cmps':
      emitCmps(fn, inst, size);
      return;
    case 'clc':
      fn.i32Const(EFLAGS_OFFSET + CTX_BASE);
      fn.i32Load();
      fn.i32Const(0xfffffffe);
      fn.i32And();
      fn.localSet(L_TMP);
      fn.i32Const(EFLAGS_OFFSET + CTX_BASE);
      fn.localGet(L_TMP);
      fn.i32Store();
      return;
    case 'stc':
      fn.i32Const(EFLAGS_OFFSET + CTX_BASE);
      fn.i32Load();
      fn.i32Const(1);
      fn.i32Or();
      fn.localSet(L_TMP);
      fn.i32Const(EFLAGS_OFFSET + CTX_BASE);
      fn.localGet(L_TMP);
      fn.i32Store();
      return;
    case 'cld':
      fn.i32Const(EFLAGS_OFFSET + CTX_BASE);
      fn.i32Load();
      fn.i32Const(0xfffffbff);
      fn.i32And();
      fn.localSet(L_TMP);
      fn.i32Const(EFLAGS_OFFSET + CTX_BASE);
      fn.localGet(L_TMP);
      fn.i32Store();
      return;
    case 'std':
      fn.i32Const(EFLAGS_OFFSET + CTX_BASE);
      fn.i32Load();
      fn.i32Const(FLAG_DF);
      fn.i32Or();
      fn.localSet(L_TMP);
      fn.i32Const(EFLAGS_OFFSET + CTX_BASE);
      fn.localGet(L_TMP);
      fn.i32Store();
      return;
    case 'leave':
      emitLeave(fn);
      return;
    case 'hlt':
      fn.i32Const(STATUS_FAULT);
      fn.return_();
      return;
    case 'enter':
      fn.unreachable();
      return;
    default:
      fn.unreachable();
  }
}

