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

import type { ImmOperand, Instruction, MemOperand, Operand, RegName, Size, XmmOperand } from './ir';
import { CTX_BASE, EFLAGS_OFFSET, EIP_OFFSET, FLAG_DF, FLAG_ZF, INT_VECTOR_OFFSET, REG_OFFSET, STATUS_CONTINUE, STATUS_FAULT, STATUS_TRAP, TSC_OFFSET, fpuAddr, xmmAddr } from './cpu';
import type { Cond } from './cpu';
import { WasmFunction } from './wasm-encoder';

// scratch local indices (all i32 unless noted)
const L_A = 0;
const L_B = 1;
const L_S = 2;
const L_TMP = 3;
const L_TMP2 = 4;
const L_ORIG = 5;
const L_I64 = 6; // i64 scratch for mul/div + 64-bit results
const L_I64A = 7; // i64 operand A (64-bit arithmetic)
const L_I64B = 8; // i64 operand B (64-bit arithmetic)
const L_I64HI = 9; // i64: high 64 bits of a 128-bit product
const L_I64C = 10; // i64: mul split temp (aL / lo)
const L_I64D = 11; // i64: mul split temp (aH)
const L_I64E = 12; // i64: mul split temp (bL)
const L_I64F = 13; // i64: mul split temp (bH)
const L_I64G = 14; // i64: mul split temp (t0 = aL*bL)
const L_I64H = 15; // i64: mul split temp (t1 = aL*bH)
const L_I64I = 16; // i64: mul split temp (t2 = aH*bL)

/** Active decode mode; set at the start of each block compile. */
let MODE: 'x86' | 'x64' = 'x86';

/** Stack slot width in bytes (4 on i386, 8 on x86-64). */
function stackWidth(): number {
  return MODE === 'x64' ? 8 : 4;
}

/** Compiles a decoded block into a WASM function body. */
export function buildBlockFunction(instructions: readonly { inst: Instruction; nextAddress: number }[], opts: { terminated: boolean; endAddress: number; mode?: 'x86' | 'x64' }): WasmFunction {
  MODE = opts.mode ?? 'x86';
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
// operand push/store
// ---------------------------------------------------------------------------

function regAddr(reg: RegName): number {
  return CTX_BASE + (REG_OFFSET[reg] ?? 0);
}

function storeWidth(fn: WasmFunction, size: Size): void {
  if (size === 8) fn.i32Store8();
  else if (size === 16) fn.i32Store16();
  else if (size === 64) fn.i64Store();
  else fn.i32Store();
}

function loadWidth(fn: WasmFunction, size: Size): void {
  if (size === 8) fn.i32Load8U();
  else if (size === 16) fn.i32Load16U();
  else if (size === 64) fn.i64Load();
  else fn.i32Load();
}

/** Pushes the effective address of a memory operand onto the stack. */
function emitEa(fn: WasmFunction, mem: MemOperand): void {
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
function pushOperand(fn: WasmFunction, op: Operand): void {
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
function storeOperand(fn: WasmFunction, op: Operand): void {
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

// ---------------------------------------------------------------------------
// flags
// ---------------------------------------------------------------------------

function flagMask(size: Size): number {
  return size === 8 ? 0xff : size === 16 ? 0xffff : 0xffffffff;
}

/** Starts a flags accumulator with 0. */
function beginFlags(fn: WasmFunction): void {
  fn.i32Const(0);
}

/** ORs `(bit ? 1 : 0) << pos` into the accumulator. */
function orFlag(fn: WasmFunction, bitPos: number): void {
  fn.i32Const(1 << bitPos);
  fn.i32Mul();
  fn.i32Or();
}

/** Emits ZF/SF/PF from the result in local L_S for the given size. */
function emitZspFlags(fn: WasmFunction, size: Size): void {
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
function emitOfBinary(fn: WasmFunction, size: Size, op: Instruction['op']): void {
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
function emitAfAdd(fn: WasmFunction): void {
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
function emitAfSub(fn: WasmFunction): void {
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
function emitZspFlags64(fn: WasmFunction): void {
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
function emitOfBinary64(fn: WasmFunction, op: Instruction['op']): void {
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
function emitAfAdd64(fn: WasmFunction): void {
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
function emitAfSub64(fn: WasmFunction): void {
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
function storeFlags(fn: WasmFunction): void {
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

function operandSize(inst: Instruction): Size {
  const dst = inst.dst;
  const src = inst.src;
  if (dst && dst.kind !== 'rel' && dst.kind !== 'xmm') return dst.size;
  if (src && src.kind !== 'rel' && src.kind !== 'xmm') return src.size;
  return 32;
}

// ---------------------------------------------------------------------------
// mov / movzx / movsx
// ---------------------------------------------------------------------------

function emitMov(fn: WasmFunction, inst: Instruction, size: Size): void {
  if (inst.op === 'mov') {
    pushOperand(fn, inst.src!);
    storeOperand(fn, inst.dst!);
    return;
  }
  // movzx / movsx: extend into the destination register
  const src = inst.src!;
  if (src.kind === 'mem') {
    emitEa(fn, src);
    if (inst.op === 'movzx') {
      if (src.size === 8) fn.i32Load8U();
      else if (src.size === 16) fn.i32Load16U();
      else fn.i32Load();
    } else if (src.size === 8) {
      fn.i32Load8S();
    } else if (src.size === 16) {
      fn.i32Load16S();
    } else {
      fn.i32Load();
    }
  } else if (src.kind === 'reg') {
    const addr = regAddr(src.reg);
    if (inst.op === 'movzx') {
      if (src.size === 8) {
        fn.i32Const(addr);
        fn.i32Load8U();
      } else if (src.size === 16) {
        fn.i32Const(addr);
        fn.i32Load16U();
      } else {
        fn.i32Const(addr);
        fn.i32Load();
      }
    } else if (src.size === 8) {
      fn.i32Const(addr);
      fn.i32Load8S();
    } else if (src.size === 16) {
      fn.i32Const(addr);
      fn.i32Load16S();
    } else {
      fn.i32Const(addr);
      fn.i32Load();
    }
  } else if (src.kind === 'imm') {
    if (src.size === 64) fn.i64Const(src.value);
    else fn.i32Const(src.value);
  } else {
    fn.i32Const(0);
  }
  // sign-extend a 32-bit source into a 64-bit destination (MOVSXD)
  if (inst.op === 'movsx' && src.size === 32 && inst.dst?.size === 64) {
    fn.i64ExtendI32S();
  }
  storeOperand(fn, inst.dst!);
  void size;
}

// ---------------------------------------------------------------------------
// binary arithmetic
// ---------------------------------------------------------------------------

function emitArith(fn: WasmFunction, op: Instruction['op'], size: Size, dst: Operand, src: Operand): void {
  if (size === 64) {
    emitArith64(fn, op, dst, src);
    return;
  }
  pushOperand(fn, dst);
  fn.localSet(L_A);
  pushOperand(fn, src);
  fn.localSet(L_B);

  if (op === 'adc' || op === 'sbb') {
    // carry-in from EFLAGS
    fn.i32Const(EFLAGS_OFFSET + CTX_BASE);
    fn.i32Load();
    fn.i32Const(1);
    fn.i32And();
    fn.localSet(L_TMP2);
    // s1 = a op b (local S), then s = s1 ± CF. The final assignment uses
    // localTee so the value stays on the stack for storeOperand below
    // (localSet would leave it empty -> "not enough arguments for local.set").
    if (op === 'adc') {
      fn.localGet(L_A);
      fn.localGet(L_B);
      fn.i32Add();
      fn.localSet(L_S);
      fn.localGet(L_S);
      fn.localGet(L_TMP2);
      fn.i32Add();
      fn.localTee(L_S);
    } else {
      fn.localGet(L_A);
      fn.localGet(L_B);
      fn.i32Sub();
      fn.localSet(L_S);
      fn.localGet(L_S);
      fn.localGet(L_TMP2);
      fn.i32Sub();
      fn.localTee(L_S);
    }
  } else {
    switch (op) {
      case 'add':
        fn.localGet(L_A);
        fn.localGet(L_B);
        fn.i32Add();
        fn.localTee(L_S);
        break;
      case 'sub':
        fn.localGet(L_A);
        fn.localGet(L_B);
        fn.i32Sub();
        fn.localTee(L_S);
        break;
      case 'cmp':
        fn.localGet(L_A);
        fn.localGet(L_B);
        fn.i32Sub();
        fn.localSet(L_S);
        break;
      case 'and':
        fn.localGet(L_A);
        fn.localGet(L_B);
        fn.i32And();
        fn.localTee(L_S);
        break;
      case 'or':
        fn.localGet(L_A);
        fn.localGet(L_B);
        fn.i32Or();
        fn.localTee(L_S);
        break;
      case 'xor':
        fn.localGet(L_A);
        fn.localGet(L_B);
        fn.i32Xor();
        fn.localTee(L_S);
        break;
      default:
        fn.unreachable();
    }
  }

  if (op !== 'cmp') {
    storeOperand(fn, dst);
  }

  // ---- flags ----
  beginFlags(fn);
  emitZspFlags(fn, size);
  emitOfBinary(fn, size, op);

  if (op === 'add' || op === 'adc') {
    // CF: (s <u a) | (s <u s1) for adc; for add just s <u a
    if (op === 'add') {
      fn.localGet(L_S);
      fn.localGet(L_A);
      fn.i32LtU();
    } else {
      // recompute s1 = a + b
      fn.localGet(L_A);
      fn.localGet(L_B);
      fn.i32Add();
      fn.localSet(L_TMP);
      fn.localGet(L_TMP);
      fn.localGet(L_A);
      fn.i32LtU();
      fn.localGet(L_S);
      fn.localGet(L_TMP);
      fn.i32LtU();
      fn.i32Or();
    }
    orFlag(fn, 0);
    emitAfAdd(fn);
  } else if (op === 'sub' || op === 'sbb' || op === 'cmp') {
    if (op === 'sub' || op === 'cmp') {
      fn.localGet(L_A);
      fn.localGet(L_B);
      fn.i32LtU();
    } else {
      // recompute s1 = a - b; CF = (a<b) | (s1<CF)
      fn.localGet(L_A);
      fn.localGet(L_B);
      fn.i32Sub();
      fn.localSet(L_TMP);
      fn.localGet(L_A);
      fn.localGet(L_B);
      fn.i32LtU();
      fn.localGet(L_TMP);
      fn.localGet(L_TMP2);
      fn.i32LtU();
      fn.i32Or();
    }
    orFlag(fn, 0);
    emitAfSub(fn);
  } else {
    // logical: CF=0, AF=0 (already zero in the accumulator)
  }

  storeFlags(fn);
}

function emitTest(fn: WasmFunction, size: Size, dst: Operand, src: Operand): void {
  if (size === 64) {
    emitTest64(fn, dst, src);
    return;
  }
  pushOperand(fn, dst);
  fn.localSet(L_A);
  pushOperand(fn, src);
  fn.localSet(L_B);
  fn.localGet(L_A);
  fn.localGet(L_B);
  fn.i32And();
  fn.localSet(L_S);
  beginFlags(fn);
  emitZspFlags(fn, size);
  storeFlags(fn);
}

function emitTest64(fn: WasmFunction, dst: Operand, src: Operand): void {
  pushOperand(fn, dst);
  fn.localSet(L_I64A);
  pushOperand(fn, src);
  fn.localSet(L_I64B);
  fn.localGet(L_I64A);
  fn.localGet(L_I64B);
  fn.i64And();
  fn.localSet(L_I64);
  beginFlags(fn);
  emitZspFlags64(fn);
  storeFlags(fn);
}

/** 64-bit arithmetic/logic/comparison. Uses L_I64A/L_I64B operands, L_I64 result. */
function emitArith64(fn: WasmFunction, op: Instruction['op'], dst: Operand, src: Operand): void {
  pushOperand(fn, dst);
  fn.localSet(L_I64A);
  pushOperand(fn, src);
  fn.localSet(L_I64B);
  switch (op) {
    case 'add':
      fn.localGet(L_I64A);
      fn.localGet(L_I64B);
      fn.i64Add();
      fn.localTee(L_I64);
      break;
    case 'sub':
      fn.localGet(L_I64A);
      fn.localGet(L_I64B);
      fn.i64Sub();
      fn.localTee(L_I64);
      break;
    case 'cmp':
      fn.localGet(L_I64A);
      fn.localGet(L_I64B);
      fn.i64Sub();
      fn.localSet(L_I64);
      break;
    case 'and':
      fn.localGet(L_I64A);
      fn.localGet(L_I64B);
      fn.i64And();
      fn.localTee(L_I64);
      break;
    case 'or':
      fn.localGet(L_I64A);
      fn.localGet(L_I64B);
      fn.i64Or();
      fn.localTee(L_I64);
      break;
    case 'xor':
      fn.localGet(L_I64A);
      fn.localGet(L_I64B);
      fn.i64Xor();
      fn.localTee(L_I64);
      break;
    case 'sbb':
      // s = a - b - CF
      fn.localGet(L_I64A);
      fn.localGet(L_I64B);
      fn.i64Sub();
      fn.i32Const(EFLAGS_OFFSET + CTX_BASE);
      fn.i32Load();
      fn.i32Const(1);
      fn.i32And();
      fn.i64ExtendI32U();
      fn.i64Sub();
      fn.localTee(L_I64);
      break;
    case 'adc':
      // s = a + b + CF
      fn.localGet(L_I64A);
      fn.localGet(L_I64B);
      fn.i64Add();
      fn.i32Const(EFLAGS_OFFSET + CTX_BASE);
      fn.i32Load();
      fn.i32Const(1);
      fn.i32And();
      fn.i64ExtendI32U();
      fn.i64Add();
      fn.localTee(L_I64);
      break;
    default:
      fn.unreachable();
  }
  if (op !== 'cmp') {
    // result is on the stack (localTee above) and storeOperand consumes it
    storeOperand(fn, dst);
  }
  // flags
  beginFlags(fn);
  emitZspFlags64(fn);
  emitOfBinary64(fn, op);
  if (op === 'add' || op === 'adc') {
    // CF: s1 = a + b; (s1 <u a) | (s <u s1)
    if (op === 'add') {
      fn.localGet(L_I64);
      fn.localGet(L_I64A);
      fn.i64LtU();
    } else {
      fn.localGet(L_I64A);
      fn.localGet(L_I64B);
      fn.i64Add();
      fn.localGet(L_I64A);
      fn.i64LtU();
      fn.localGet(L_I64A);
      fn.localGet(L_I64B);
      fn.i64Add();
      fn.localGet(L_I64);
      fn.i64LtU();
      fn.i32Or();
    }
    orFlag(fn, 0);
    emitAfAdd64(fn);
  } else if (op === 'sub' || op === 'sbb' || op === 'cmp') {
    if (op === 'sub' || op === 'cmp') {
      // CF: a <u b
      fn.localGet(L_I64A);
      fn.localGet(L_I64B);
      fn.i64LtU();
    } else {
      // s1 = a - b; CF: (a <u b) | (s1 <u CF)
      fn.localGet(L_I64A);
      fn.localGet(L_I64B);
      fn.i64LtU();
      fn.localGet(L_I64A);
      fn.localGet(L_I64B);
      fn.i64Sub();
      fn.i32Const(EFLAGS_OFFSET + CTX_BASE);
      fn.i32Load();
      fn.i32Const(1);
      fn.i32And();
      fn.i64ExtendI32U();
      fn.i64LtU();
      fn.i32Or();
    }
    orFlag(fn, 0);
    emitAfSub64(fn);
  }
  storeFlags(fn);
}

function emitIncDec(fn: WasmFunction, op: 'inc' | 'dec', size: Size, dst: Operand): void {
  if (size === 64) {
    emitIncDec64(fn, op, dst);
    return;
  }
  pushOperand(fn, dst);
  fn.localSet(L_A);
  // s = a ± 1
  fn.localGet(L_A);
  fn.i32Const(1);
  if (op === 'inc') fn.i32Add();
  else fn.i32Sub();
  fn.localSet(L_S);
  // store result
  fn.localGet(L_S);
  storeOperand(fn, dst);
  // flags (CF preserved)
  beginFlags(fn);
  emitZspFlags(fn, size);
  // OF: a == signbit
  fn.localGet(L_A);
  fn.i32Const(1 << (size - 1));
  fn.i32Eq();
  orFlag(fn, 11);
  emitAfAdd(fn);
  storeFlags(fn);
}

function emitIncDec64(fn: WasmFunction, op: 'inc' | 'dec', dst: Operand): void {
  pushOperand(fn, dst);
  fn.localSet(L_I64A);
  fn.localGet(L_I64A);
  fn.i64Const(1);
  if (op === 'inc') fn.i64Add();
  else fn.i64Sub();
  fn.localSet(L_I64);
  fn.localGet(L_I64);
  storeOperand(fn, dst);
  // flags (CF preserved)
  beginFlags(fn);
  emitZspFlags64(fn);
  // OF: a == signbit
  fn.localGet(L_I64A);
  fn.i64Const(63);
  fn.i64ShrU();
  fn.i32WrapI64();
  orFlag(fn, 11);
  emitAfAdd64(fn);
  storeFlags(fn);
}

function emitNeg(fn: WasmFunction, size: Size, dst: Operand): void {
  if (size === 64) {
    emitNeg64(fn, dst);
    return;
  }
  pushOperand(fn, dst);
  fn.localSet(L_A);
  fn.i32Const(0);
  fn.localGet(L_A);
  fn.i32Sub();
  fn.localSet(L_S);
  fn.localGet(L_S);
  storeOperand(fn, dst);
  beginFlags(fn);
  emitZspFlags(fn, size);
  // CF = a != 0
  fn.localGet(L_A);
  fn.i32Eqz();
  fn.i32Const(1);
  fn.i32Xor();
  orFlag(fn, 0);
  // OF = a == signbit
  fn.localGet(L_A);
  fn.i32Const(1 << (size - 1));
  fn.i32Eq();
  orFlag(fn, 11);
  // AF = (a & 0xf) != 0
  fn.localGet(L_A);
  fn.i32Const(0xf);
  fn.i32And();
  fn.i32Const(0);
  fn.i32Ne();
  orFlag(fn, 4);
  storeFlags(fn);
}

function emitNeg64(fn: WasmFunction, dst: Operand): void {
  pushOperand(fn, dst);
  fn.localSet(L_I64A);
  fn.i64Const(0);
  fn.localGet(L_I64A);
  fn.i64Sub();
  fn.localSet(L_I64);
  fn.localGet(L_I64);
  storeOperand(fn, dst);
  beginFlags(fn);
  emitZspFlags64(fn);
  // CF = a != 0
  fn.localGet(L_I64A);
  fn.i64Eqz();
  fn.i32Const(1);
  fn.i32Xor();
  orFlag(fn, 0);
  // OF = a == signbit
  fn.localGet(L_I64A);
  fn.i64Const(63);
  fn.i64ShrU();
  fn.i32WrapI64();
  orFlag(fn, 11);
  // AF = (a & 0xf) != 0
  fn.localGet(L_I64A);
  fn.i32WrapI64();
  fn.i32Const(0xf);
  fn.i32And();
  fn.i32Const(0);
  fn.i32Ne();
  orFlag(fn, 4);
  storeFlags(fn);
}

// ---------------------------------------------------------------------------
// stack
// ---------------------------------------------------------------------------

function espAddr(): number {
  return CTX_BASE + (REG_OFFSET['esp'] ?? 0);
}

function emitPush(fn: WasmFunction, op: Operand, size: Size): void {
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
function emitPushRaw(fn: WasmFunction, width: number, value?: () => void): void {
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

function emitPop(fn: WasmFunction, op: Operand, size: Size): void {
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
function emitPopRaw(fn: WasmFunction, width: number): void {
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

function emitPusha(fn: WasmFunction): void {
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

function emitPopa(fn: WasmFunction): void {
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

// ---------------------------------------------------------------------------
// control flow
// ---------------------------------------------------------------------------

function storeEip(fn: WasmFunction): void {
  fn.localSet(L_TMP);
  fn.i32Const(EIP_OFFSET + CTX_BASE);
  fn.localGet(L_TMP);
  fn.i32Store();
}

function resolveTarget(target: Operand, nextAddress: number): number {
  if (target.kind === 'rel') return nextAddress + target.delta;
  return 0;
}

function emitJmp(fn: WasmFunction, target: Operand, nextAddress: number): void {
  if (target.kind === 'rel') {
    fn.i32Const(resolveTarget(target, nextAddress));
    storeEip(fn);
  } else {
    pushOperand(fn, target);
    if (target.size === 64) fn.i32WrapI64();
    storeEip(fn);
  }
}

function emitJcc(fn: WasmFunction, cond: Cond, target: Operand, nextAddress: number): void {
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

function emitCall(fn: WasmFunction, target: Operand, nextAddress: number): void {
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

function emitRet(fn: WasmFunction, popBytes: number, size: Size): void {
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

function emitInt(fn: WasmFunction, vector: number, nextAddress: number): void {
  // record the vector for the dispatcher, continue after the int
  fn.i32Const(INT_VECTOR_OFFSET + CTX_BASE);
  fn.i32Const(vector);
  fn.i32Store();
  fn.i32Const(nextAddress);
  storeEip(fn);
  fn.i32Const(STATUS_TRAP);
  fn.return_();
}

function emitLeave(fn: WasmFunction): void {
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

// ---------------------------------------------------------------------------
// misc
// ---------------------------------------------------------------------------

function emitXchg(fn: WasmFunction, a: Operand, b: Operand, size: Size): void {
  // NOTE: storeOperand() clobbers L_TMP internally (its first step is
  // `local.set L_TMP`), so a's old value must be parked in L_TMP2, NOT
  // L_TMP. The previous version kept it in L_TMP: the second store then
  // wrote b back to b (swap silently lost) — e.g. cmd.exe's __chkstk
  // `xchg esp, eax` never moved esp, so the following `push ebx` wrote
  // over the caller's GS cookie copy at [ebp-4] -> __security_check_cookie
  // FAIL (0x40b4c8). This is the root cause of the last cmd.exe fail-fast.
  const [parkA, parkB] = size === 64 ? [L_I64A, L_I64B] : [L_TMP2, L_TMP];
  pushOperand(fn, a);
  fn.localSet(parkA); // keep a's old value here (safe from storeOperand)
  pushOperand(fn, b);
  fn.localSet(parkB);
  // store b -> a
  fn.localGet(parkB);
  storeOperand(fn, a);
  // store a -> b
  fn.localGet(parkA);
  storeOperand(fn, b);
}

/**
 * CPUID (0F A2): leaf in EAX, results in EAX/EBX/ECX/EDX. Emits a small
 * synthetic CPU. IMPORTANT: the JIT has no XMM/MMX support, so leaf 1
 * deliberately reports NO MMX/SSE/SSE2/SSE3+ (edx=0xb9ebfbff, ecx=0) — guests
 * (Delphi/Inno CRT, msvcrt) then pick scalar/REP fallbacks (rep stosb etc.)
 * that the JIT handles, instead of movups/movd paths that would fault.
 * Kept: CMOV (bit15) and CMPXCHG8B (bit8) — the MM relies on them.
 */
function emitCpuid(fn: WasmFunction): void {
  // capture the leaf once (eax gets overwritten below)
  fn.i32Const(regAddr('eax'));
  fn.i32Load();
  fn.localSet(L_TMP);
  const leaf = (): void => {
    fn.localGet(L_TMP);
  };
  // r = fallback; for each case (from last to first): r = leaf==cond ? val : r
  const chain = (cases: Array<[number, number]>, fallback: number): void => {
    fn.i32Const(fallback);
    fn.localSet(L_S);
    for (let i = cases.length - 1; i >= 0; i--) {
      const entry = cases[i]!;
      const [cond, val] = entry;
      fn.i32Const(val);
      fn.localGet(L_S);
      leaf();
      fn.i32Const(cond);
      fn.i32Eq();
      fn.select();
      fn.localSet(L_S);
    }
  };
  const storeReg = (reg: RegName): void => {
    fn.i32Const(regAddr(reg));
    fn.localGet(L_S);
    fn.i32Store();
  };
  chain(
    [
      [0x00000000, 0x00000001], // max standard leaf
      [0x00000001, 0x000506e3], // family 6, model 0x9e, stepping 3
      [0x80000000, 0x80000008], // max extended leaf
    ],
    0,
  );
  storeReg('eax');
  chain(
    [
      [0x00000000, 0x756e6547], // 'Genu'
      [0x00000001, 0x00040800],
    ],
    0,
  );
  storeReg('ebx');
  chain(
    [
      [0x00000000, 0x6c65746e], // 'ntel'
      [0x00000001, 0x00000000], // no SSE3/SSSE3/SSE4/POPCNT (JIT lacks XMM)
    ],
    0,
  );
  storeReg('ecx');
  chain(
    [
      [0x00000000, 0x49656e69], // 'ineI'
      [0x00000001, 0xb9ebfbff], // no MMX(23)/SSE(25)/SSE2(26); keeps CMOV(15)/CX8(8)
      [0x80000001, 0x20100800], // extended features
    ],
    0,
  );
  storeReg('edx');
}

/**
 * RDTSC (0F 31): EDX:EAX = monotonic 64-bit counter. Reads the CPU-ctx TSC
 * slots (low at TSC_OFFSET, high at TSC_OFFSET+4), advances the counter by
 * RDTSC_STEP (simulating ~16M cycles per read, giving the guest a steady
 * stream of distinct values), and writes the post-increment value to
 * EDX:EAX. Flags are unaffected. notepad reads this to seed its RNG.
 */
const RDTSC_STEP = 0x1000000;

function emitRdtsc(fn: WasmFunction): void {
  const tscLow = CTX_BASE + TSC_OFFSET;
  const tscHigh = tscLow + 4;
  // L_TMP = old low
  fn.i32Const(tscLow);
  fn.i32Load();
  fn.localSet(L_TMP);
  // L_TMP2 = low + STEP
  fn.localGet(L_TMP);
  fn.i32Const(RDTSC_STEP);
  fn.i32Add();
  fn.localSet(L_TMP2);
  // L_S = carry (low_new <u low, i.e. the low dword wrapped)
  fn.localGet(L_TMP2);
  fn.localGet(L_TMP);
  fn.i32LtU();
  fn.localSet(L_S);
  // store low_new
  fn.i32Const(tscLow);
  fn.localGet(L_TMP2);
  fn.i32Store();
  // L_TMP = high + carry
  fn.i32Const(tscHigh);
  fn.i32Load();
  fn.localGet(L_S);
  fn.i32Add();
  fn.localSet(L_TMP);
  // store high_new
  fn.i32Const(tscHigh);
  fn.localGet(L_TMP);
  fn.i32Store();
  // eax = low_new, edx = high_new
  fn.i32Const(regAddr('eax'));
  fn.localGet(L_TMP2);
  fn.i32Store();
  fn.i32Const(regAddr('edx'));
  fn.localGet(L_TMP);
  fn.i32Store();
}

// ---------------------------------------------------------------------------
// SSE (minimal XMM support)
// ---------------------------------------------------------------------------

/** Pushes source lane `lane` (0..3) of an XMM register or memory operand. */
function pushXmmLane(fn: WasmFunction, src: MemOperand | XmmOperand, lane: number): void {
  if (src.kind === 'xmm') {
    fn.i32Const(xmmAddr(src.reg) + lane * 4);
    fn.i32Load();
  } else {
    emitEa(fn, src);
    fn.localSet(L_TMP);
    fn.localGet(L_TMP);
    fn.i32Const(lane * 4);
    fn.i32Add();
    fn.i32Load();
  }
}

/**
 * 128-bit XMM move (MOVUPS/MOVUPD/MOVAPS/MOVAPD/MOVDQA/MOVDQU) plus the
 * scalar forms MOVSS/MOVSD selected by `lanes` (1/2/4 dwords). `xmm` is the
 * register side; when `load` the value flows other -> xmm, else xmm -> other.
 * Scalar semantics: a memory load zero-extends the upper lanes, a register
 * load leaves them untouched, and a scalar store only writes `lanes` dwords.
 */
function emitXmmMove(fn: WasmFunction, xmm: XmmOperand, other: MemOperand | XmmOperand, load: boolean, lanes: 1 | 2 | 4 = 4): void {
  for (let i = 0; i < 4; i++) {
    if (load) {
      if (i >= lanes) {
        // MOVSS/MOVSD memory loads clear the upper lanes.
        if (other.kind === 'mem') {
          fn.i32Const(xmmAddr(xmm.reg) + i * 4);
          fn.i32Const(0);
          fn.i32Store();
        }
        continue;
      }
      pushXmmLane(fn, other, i);
      fn.localSet(L_TMP);
      fn.i32Const(xmmAddr(xmm.reg) + i * 4);
      fn.localGet(L_TMP);
      fn.i32Store();
    } else if (i >= lanes) {
      // scalar store: only the low lanes are written
      continue;
    } else if (other.kind === 'xmm') {
      // xmm -> xmm move
      fn.i32Const(xmmAddr(xmm.reg) + i * 4);
      fn.i32Load();
      fn.localSet(L_TMP);
      fn.i32Const(xmmAddr(other.reg) + i * 4);
      fn.localGet(L_TMP);
      fn.i32Store();
    } else {
      fn.i32Const(xmmAddr(xmm.reg) + i * 4);
      fn.i32Load();
      fn.localSet(L_TMP);
      emitEa(fn, other);
      fn.localSet(L_TMP2);
      fn.localGet(L_TMP2);
      fn.i32Const(i * 4);
      fn.i32Add();
      fn.localGet(L_TMP);
      fn.i32Store();
    }
  }
}

/**
 * MOVLPS/MOVLPD/MOVHPS/MOVHPD: 8-byte half-register move between one half of
 * an XMM register (low pair when `high`=0, high pair when 1) and memory.
 */
function emitXmmHalfMove(fn: WasmFunction, xmm: XmmOperand, mem: MemOperand, high: 0 | 1, load: boolean): void {
  for (let i = 0; i < 2; i++) {
    const lane = high * 2 + i;
    if (load) {
      pushXmmLane(fn, mem, i);
      fn.localSet(L_TMP);
      fn.i32Const(xmmAddr(xmm.reg) + lane * 4);
      fn.localGet(L_TMP);
      fn.i32Store();
    } else {
      fn.i32Const(xmmAddr(xmm.reg) + lane * 4);
      fn.i32Load();
      fn.localSet(L_TMP);
      emitEa(fn, mem);
      fn.localSet(L_TMP2);
      fn.localGet(L_TMP2);
      fn.i32Const(i * 4);
      fn.i32Add();
      fn.localGet(L_TMP);
      fn.i32Store();
    }
  }
}

/** MOVD xmm, r/m32 / MOVD r/m32, xmm (66 0F 6E/7E). */
function emitXmmMovd(fn: WasmFunction, dst: Operand, src: Operand): void {  if (dst.kind === 'xmm') {
    // zero-extend the dword into lane 0; upper 96 bits are zeroed
    pushOperand(fn, src);
    fn.localSet(L_TMP);
    fn.i32Const(xmmAddr(dst.reg));
    fn.localGet(L_TMP);
    fn.i32Store();
    for (let i = 1; i < 4; i++) {
      fn.i32Const(xmmAddr(dst.reg) + i * 4);
      fn.i32Const(0);
      fn.i32Store();
    }
  } else if (src.kind === 'xmm') {
    // MOVD r/m32, xmm: lane 0 -> dst
    fn.i32Const(xmmAddr(src.reg));
    fn.i32Load();
    storeOperand(fn, dst);
  }
}

/** PSHUFD xmm, xmm/m128, imm8 (66 0F 70) — dword lane shuffle. */
function emitXmmPshufd(fn: WasmFunction, dst: XmmOperand, src: MemOperand | XmmOperand, imm: number): void {
  pushXmmLane(fn, src, 0);
  fn.localSet(L_A);
  pushXmmLane(fn, src, 1);
  fn.localSet(L_B);
  pushXmmLane(fn, src, 2);
  fn.localSet(L_S);
  pushXmmLane(fn, src, 3);
  fn.localSet(L_TMP);
  const laneVal = (f: number): void => {
    switch (f) {
      case 0:
        fn.localGet(L_A);
        break;
      case 1:
        fn.localGet(L_B);
        break;
      case 2:
        fn.localGet(L_S);
        break;
      default:
        fn.localGet(L_TMP);
        break;
    }
  };
  for (let i = 0; i < 4; i++) {
    const f = (imm >> (i * 2)) & 3;
    // r = f==0 ? A : f==1 ? B : f==2 ? S : T
    laneVal(0);
    laneVal(1);
    fn.i32Const(f);
    fn.i32Const(1);
    fn.i32Eq();
    fn.select();
    laneVal(2);
    fn.i32Const(f);
    fn.i32Const(2);
    fn.i32Eq();
    fn.select();
    laneVal(3);
    fn.i32Const(f);
    fn.i32Const(3);
    fn.i32Eq();
    fn.select();
    fn.localSet(L_ORIG);
    fn.i32Const(xmmAddr(dst.reg) + i * 4);
    fn.localGet(L_ORIG);
    fn.i32Store();
  }
}

/** PXOR xmm, xmm/m128 (66 0F EF) — dword lane XOR. */
function emitXmmPxor(fn: WasmFunction, dst: XmmOperand, src: MemOperand | XmmOperand): void {
  for (let i = 0; i < 4; i++) {
    fn.i32Const(xmmAddr(dst.reg) + i * 4);
    fn.i32Load();
    pushXmmLane(fn, src, i);
    fn.i32Xor();
    fn.localSet(L_TMP);
    fn.i32Const(xmmAddr(dst.reg) + i * 4);
    fn.localGet(L_TMP);
    fn.i32Store();
  }
}

/**
 * PSRLLDQ / PSLLDQ (66 0F 73 /3, /6 — also PSRLQ as /2 with the count scaled
 * to bytes): byte-shift the whole 128-bit XMM register right/left by `imm`.
 * Iterates in the direction that keeps an in-place (dst === src) shift safe.
 */
function emitXmmShiftBytes(fn: WasmFunction, dst: XmmOperand, src: MemOperand | XmmOperand, imm: number, left: boolean): void {
  const count = imm & 15;
  if (count === 0) {
    emitXmmMove(fn, dst, src, true, 4);
    return;
  }
  if (src.kind === 'xmm') {
    fn.i32Const(xmmAddr(src.reg));
  } else {
    emitEa(fn, src);
  }
  fn.localSet(L_TMP2);
  if (left) {
    for (let k = 15; k >= 0; k--) {
      const s = k - count;
      fn.i32Const(xmmAddr(dst.reg) + k);
      if (s >= 0) {
        fn.localGet(L_TMP2);
        fn.i32Const(s);
        fn.i32Add();
        fn.i32Load8U();
      } else {
        fn.i32Const(0);
      }
      fn.i32Store8();
    }
  } else {
    for (let k = 0; k < 16; k++) {
      const s = k + count;
      fn.i32Const(xmmAddr(dst.reg) + k);
      if (s < 16) {
        fn.localGet(L_TMP2);
        fn.i32Const(s);
        fn.i32Add();
        fn.i32Load8U();
      } else {
        fn.i32Const(0);
      }
      fn.i32Store8();
    }
  }
}

/**
 * BSF/BSR (0F BC/BD): dest = index of least/most significant set bit; ZF = 1
 * when the source is zero (dest then holds 0, matching the common convention).
 * Maps onto i32.ctz / 31 - i32.clz.
 */
function emitBitScan(fn: WasmFunction, op: 'bsf' | 'bsr', size: Size, dst: Operand, src: Operand): void {
  pushOperand(fn, src);
  fn.localSet(L_A);
  // dest = (L_A == 0) ? 0 : scan(L_A)
  fn.i32Const(0); // v1
  fn.localGet(L_A);
  if (op === 'bsf') {
    fn.i32Ctz();
  } else {
    fn.i32Clz();
    fn.i32Const(31);
    fn.i32Sub();
  }
  fn.localGet(L_A);
  fn.i32Eqz();
  fn.select();
  storeOperand(fn, dst);
  // flags: ZF = (L_A == 0); other status bits undefined (cleared)
  beginFlags(fn);
  fn.localGet(L_A);
  fn.i32Eqz();
  orFlag(fn, 6);
  storeFlags(fn);
}

/**
 * BT/BTS/BTR/BTC (0F A3/AB/B3/BB): CF = bit(index) of dst; BTS/BTR/BTC then
 * set/clear/toggle it. For memory operands the dword address is
 * dst + (index >> 5) * 4 (the high bits of the index select the word).
 */
function emitBitTest(fn: WasmFunction, op: 'bt' | 'bts' | 'btr' | 'btc', size: Size, dst: Operand, src: Operand): void {
  pushOperand(fn, src);
  fn.localSet(L_B); // bit index
  let wordAddr: number | null = null;
  if (dst.kind === 'mem') {
    emitEa(fn, dst);
    fn.localSet(L_TMP2); // base
    fn.localGet(L_TMP2);
    fn.localGet(L_B);
    fn.i32Const(5);
    fn.i32ShrU();
    fn.i32Const(4);
    fn.i32Mul();
    fn.i32Add();
    fn.localSet(L_TMP); // dword address (index >> 5 selects the word)
    fn.localGet(L_TMP);
    fn.i32Load();
    fn.localSet(L_A); // value
    wordAddr = L_TMP;
  } else {
    pushOperand(fn, dst);
    fn.localSet(L_A);
  }
  // mask = 1 << (index & 31)
  fn.i32Const(1);
  fn.localGet(L_B);
  fn.i32Const(31);
  fn.i32And();
  fn.i32Shl();
  fn.localSet(L_S); // mask
  // CF = (value & mask) != 0
  fn.localGet(L_A);
  fn.localGet(L_S);
  fn.i32And();
  fn.i32Const(0);
  fn.i32Ne();
  fn.localSet(L_ORIG); // CF bool
  // result (skipped for plain BT — it only reads the bit)
  if (op !== 'bt') {
    fn.localGet(L_A);
    fn.localGet(L_S);
    if (op === 'bts') {
      fn.i32Or();
    } else if (op === 'btr') {
      fn.i32Const(0xffffffff);
      fn.i32Xor();
      fn.i32And();
    } else if (op === 'btc') {
      fn.i32Xor();
    }
    if (dst.kind === 'mem') {
      fn.localSet(L_TMP2);
      fn.localGet(wordAddr!);
      fn.localGet(L_TMP2);
      storeWidth(fn, size);
    } else if (dst.kind === 'reg') {
      fn.localSet(L_TMP2);
      fn.i32Const(regAddr(dst.reg));
      fn.localGet(L_TMP2);
      storeWidth(fn, size);
    }
  }
  // flags: CF = the tested bit; the rest are undefined (cleared)
  beginFlags(fn);
  fn.localGet(L_ORIG);
  orFlag(fn, 0);
  storeFlags(fn);
}

/**
 * Minimal x87 FLD/FST/FSTP: raw 8-byte moves between ST(0) (slot 0 of the FPU
 * register file) and a memory operand. 32-bit forms copy one dword (zeroing
 * the upper half of the slot / writing only 4 bytes to memory). No real
 * float arithmetic — enough for CRT/init code.
 */
function emitFpuMove(fn: WasmFunction, op: 'fld' | 'fst' | 'fstp', dst: MemOperand | undefined, src: MemOperand | undefined, size: 32 | 64): void {
  if (op === 'fld' && src) {
    // ST(0) <- [src]
    emitEa(fn, src);
    fn.localSet(L_TMP);
    fn.i32Const(fpuAddr(0));
    fn.localGet(L_TMP);
    fn.i32Load();
    fn.i32Store();
    if (size === 32) {
      fn.i32Const(fpuAddr(0) + 4);
      fn.i32Const(0);
      fn.i32Store();
    } else {
      fn.i32Const(fpuAddr(0) + 4);
      fn.localGet(L_TMP);
      fn.i32Const(4);
      fn.i32Add();
      fn.i32Load();
      fn.i32Store();
    }
    return;
  }
  if ((op === 'fst' || op === 'fstp') && dst) {
    // [dst] <- ST(0)
    fn.i32Const(fpuAddr(0));
    fn.i32Load();
    fn.localSet(L_TMP);
    emitEa(fn, dst);
    fn.localSet(L_TMP2);
    fn.localGet(L_TMP2);
    fn.localGet(L_TMP);
    fn.i32Store();
    if (size === 64) {
      fn.i32Const(fpuAddr(0) + 4);
      fn.i32Load();
      fn.localSet(L_TMP);
      fn.localGet(L_TMP2);
      fn.i32Const(4);
      fn.i32Add();
      fn.localGet(L_TMP);
      fn.i32Store();
    }
    return;
  }
  // no operand (register forms we don't model) — no-op
}

/**
 * x87 FILD/FIST/FISTP integer <-> double conversions. m32 forms do a real
 * signed int<->f64 conversion through ST(0); m64 forms are raw 8-byte copies
 * (the Delphi move-through-FPU integer idiom, where the bits round-trip).
 */
function emitFpuIntMove(fn: WasmFunction, op: 'fild' | 'fist' | 'fistp', dst: MemOperand | undefined, src: MemOperand | undefined, size: 32 | 64): void {
  if (op === 'fild' && src) {
    if (size === 64) {
      emitFpuMove(fn, 'fld', undefined, src, 64);
      return;
    }
    // ST(0) <- (double)(int32)[src]
    fn.i32Const(fpuAddr(0));
    emitEa(fn, src);
    fn.i32Load();
    fn.f64ConvertI32S();
    fn.f64Store();
    return;
  }
  if ((op === 'fist' || op === 'fistp') && dst) {
    if (size === 64) {
      emitFpuMove(fn, 'fstp', dst, undefined, 64);
      return;
    }
    // [dst] <- (int32)ST(0)
    emitEa(fn, dst);
    fn.i32Const(fpuAddr(0));
    fn.f64Load();
    fn.i32TruncF64S();
    fn.i32Store();
    return;
  }
}

function emitShift(fn: WasmFunction, op: 'shl' | 'shr' | 'sar' | 'rol' | 'ror', size: Size, dst: Operand, count: Operand): void {
  if (size === 64) {
    emitShift64(fn, op, dst, count);
    return;
  }
  pushOperand(fn, dst);
  fn.localSet(L_A);
  // count (CL or imm), masked to 5 bits
  pushOperand(fn, count);
  fn.i32Const(0x1f);
  fn.i32And();
  fn.localSet(L_B);

  // shifted = a op count (masked to operand width)
  const mask = flagMask(size);
  fn.localGet(L_A);
  switch (op) {
    case 'shl':
      fn.localGet(L_B);
      fn.i32Shl();
      break;
    case 'shr':
      fn.localGet(L_B);
      fn.i32ShrU();
      break;
    case 'sar':
      fn.localGet(L_B);
      fn.i32ShrS();
      break;
    case 'rol':
      fn.localGet(L_B);
      fn.i32Rotl();
      break;
    case 'ror':
      fn.localGet(L_B);
      fn.i32Rotr();
      break;
    default:
      fn.unreachable();
  }
  fn.i32Const(mask);
  fn.i32And();
  fn.localSet(L_S);
  // s = (count != 0) ? shifted : a
  fn.localGet(L_A);
  fn.localGet(L_S);
  fn.localGet(L_B);
  fn.i32Eqz();
  fn.select();
  fn.localSet(L_S);

  // store result
  fn.localGet(L_S);
  storeOperand(fn, dst);

  // flags: compute new flags, then choose old when count == 0
  fn.i32Const(EFLAGS_OFFSET + CTX_BASE);
  fn.i32Load();
  fn.localSet(L_TMP); // old flags
  beginFlags(fn);
  emitZspFlags(fn, size);

  // CF
  if (op === 'shl') {
    // CF = bit(32 - count) of a  =>  (a >>> (32 - count)) & 1
    fn.localGet(L_A);
    fn.i32Const(0x20);
    fn.localGet(L_B);
    fn.i32Sub();
    fn.i32ShrU();
    fn.i32Const(1);
    fn.i32And();
  } else if (op === 'shr' || op === 'sar') {
    // CF = bit(count - 1) of a  =>  (a >>> (count - 1)) & 1
    fn.localGet(L_A);
    fn.localGet(L_B);
    fn.i32Const(1);
    fn.i32Sub();
    fn.i32ShrU();
    fn.i32Const(1);
    fn.i32And();
  } else if (op === 'rol') {
    // CF = bit0 of s
    fn.localGet(L_S);
    fn.i32Const(1);
    fn.i32And();
  } else {
    // ror: CF = bit31 of s
    fn.localGet(L_S);
    fn.i32Const(31);
    fn.i32ShrU();
  }
  orFlag(fn, 0);

  // OF (approximation beyond count == 1)
  if (op === 'shl' || op === 'rol') {
    fn.localGet(L_S);
    fn.i32Const(31);
    fn.i32ShrU();
    fn.localGet(L_A);
    fn.i32Const(31);
    fn.i32ShrU();
    fn.i32Xor();
  } else {
    fn.localGet(L_A);
    fn.i32Const(31);
    fn.i32ShrU();
  }
  orFlag(fn, 11);

  // preserve DF in the new flags
  fn.i32Const(EFLAGS_OFFSET + CTX_BASE);
  fn.i32Load();
  fn.i32Const(FLAG_DF);
  fn.i32And();
  fn.i32Or();
  fn.localSet(L_TMP2); // new flags
  // final = count == 0 ? old : new
  fn.localGet(L_TMP);
  fn.localGet(L_TMP2);
  fn.localGet(L_B);
  fn.i32Eqz();
  fn.select();
  fn.localSet(L_TMP2);
  fn.i32Const(EFLAGS_OFFSET + CTX_BASE);
  fn.localGet(L_TMP2);
  fn.i32Store();
}

/** 64-bit shift/rotate. Count masked to 6 bits; flags chosen old when count==0. */
function emitShift64(fn: WasmFunction, op: 'shl' | 'shr' | 'sar' | 'rol' | 'ror', dst: Operand, count: Operand): void {
  pushOperand(fn, dst);
  fn.localSet(L_I64A);
  // count (CL or imm), masked to 6 bits
  pushOperand(fn, count);
  fn.i32Const(0x3f);
  fn.i32And();
  fn.localSet(L_B);

  // shifted = a op count (i64); count extended from i32
  fn.localGet(L_I64A);
  fn.localGet(L_B);
  fn.i64ExtendI32U();
  switch (op) {
    case 'shl':
      fn.i64Shl();
      break;
    case 'shr':
      fn.i64ShrU();
      break;
    case 'sar':
      fn.i64ShrS();
      break;
    case 'rol':
      fn.i64Rotl();
      break;
    case 'ror':
      fn.i64Rotr();
      break;
    default:
      fn.unreachable();
  }
  fn.localSet(L_I64); // shifted
  // s = (count != 0) ? shifted : a
  fn.localGet(L_I64A);
  fn.localGet(L_I64);
  fn.localGet(L_B);
  fn.i32Eqz();
  fn.select();
  fn.localSet(L_I64);

  // store result
  fn.localGet(L_I64);
  storeOperand(fn, dst);

  // flags: compute new flags, then choose old when count == 0
  fn.i32Const(EFLAGS_OFFSET + CTX_BASE);
  fn.i32Load();
  fn.localSet(L_TMP); // old flags
  beginFlags(fn);
  emitZspFlags64(fn);

  // CF
  if (op === 'shl') {
    // CF = bit(64 - count) of a  =>  (a >>> (64 - count)) & 1
    fn.localGet(L_I64A);
    fn.i32Const(64);
    fn.localGet(L_B);
    fn.i32Sub();
    fn.i64ExtendI32U();
    fn.i64ShrU();
    fn.i32WrapI64();
    fn.i32Const(1);
    fn.i32And();
  } else if (op === 'shr' || op === 'sar') {
    // CF = bit(count - 1) of a  =>  (a >>> (count - 1)) & 1
    fn.localGet(L_I64A);
    fn.localGet(L_B);
    fn.i32Const(1);
    fn.i32Sub();
    fn.i64ExtendI32U();
    fn.i64ShrU();
    fn.i32WrapI64();
    fn.i32Const(1);
    fn.i32And();
  } else if (op === 'rol') {
    // CF = bit0 of s
    fn.localGet(L_I64);
    fn.i32WrapI64();
    fn.i32Const(1);
    fn.i32And();
  } else {
    // ror: CF = bit63 of s
    fn.localGet(L_I64);
    fn.i64Const(63);
    fn.i64ShrU();
    fn.i32WrapI64();
  }
  orFlag(fn, 0);

  // OF (approximation beyond count == 1)
  if (op === 'shl' || op === 'rol') {
    fn.localGet(L_I64);
    fn.i64Const(63);
    fn.i64ShrU();
    fn.i32WrapI64();
    fn.localGet(L_I64A);
    fn.i64Const(63);
    fn.i64ShrU();
    fn.i32WrapI64();
    fn.i32Xor();
  } else {
    fn.localGet(L_I64A);
    fn.i64Const(63);
    fn.i64ShrU();
    fn.i32WrapI64();
  }
  orFlag(fn, 11);

  // preserve DF in the new flags
  fn.i32Const(EFLAGS_OFFSET + CTX_BASE);
  fn.i32Load();
  fn.i32Const(FLAG_DF);
  fn.i32And();
  fn.i32Or();
  fn.localSet(L_TMP2); // new flags
  // final = count == 0 ? old : new
  fn.localGet(L_TMP);
  fn.localGet(L_TMP2);
  fn.localGet(L_B);
  fn.i32Eqz();
  fn.select();
  fn.localSet(L_TMP2);
  fn.i32Const(EFLAGS_OFFSET + CTX_BASE);
  fn.localGet(L_TMP2);
  fn.i32Store();
}

/**
 * RCL/RCR: rotate through the carry flag. The operand + CF form an (N+1)-bit
 * rotating value; the count is masked to 5 bits (6 in 64-bit mode) and the
 * effective rotation is count mod (N+1). Flags are kept from before when the
 * masked count is 0 (matching the other shifts).
 */
function emitRotateCarry(fn: WasmFunction, op: 'rcl' | 'rcr', size: Size, dst: Operand, count: Operand): void {
  if (size === 64) {
    emitRotateCarry64(fn, op, dst, count);
    return;
  }
  const mask = flagMask(size);
  pushOperand(fn, dst);
  fn.localSet(L_A); // a = operand
  pushOperand(fn, count);
  fn.i32Const(0x1f);
  fn.i32And();
  fn.localSet(L_B); // b = count & 31
  fn.i32Const(EFLAGS_OFFSET + CTX_BASE);
  fn.i32Load();
  fn.i32Const(1);
  fn.i32And();
  fn.localSet(L_TMP); // old CF

  // V (i64) = (cf << N) | a
  fn.localGet(L_TMP);
  fn.i64ExtendI32U();
  fn.i64Const(size);
  fn.i64Shl();
  fn.localGet(L_A);
  fn.i64ExtendI32U();
  fn.i64Or();
  fn.localSet(L_I64A); // V

  // c2 = b % (N+1)
  fn.localGet(L_B);
  fn.i32Const(size + 1);
  fn.i32RemU();
  fn.localSet(L_TMP2); // c2

  // rot = rotate V by c2 within (N+1) bits
  fn.localGet(L_I64A);
  fn.localGet(L_TMP2);
  fn.i64ExtendI32U();
  if (op === 'rcl') fn.i64Shl();
  else fn.i64ShrU();
  fn.localGet(L_I64A);
  fn.i64Const(size + 1);
  fn.localGet(L_TMP2);
  fn.i64ExtendI32U();
  fn.i64Sub();
  if (op === 'rcl') fn.i64ShrU();
  else fn.i64Shl();
  fn.i64Or();
  fn.i64Const(2 ** (size + 1) - 1);
  fn.i64And();
  fn.localSet(L_I64B); // rot

  // result = (i32)(rot & mask)
  fn.localGet(L_I64B);
  fn.i64Const(mask);
  fn.i64And();
  fn.i32WrapI64();
  fn.localSet(L_S);
  // new CF = (i32)((rot >> N) & 1)
  fn.localGet(L_I64B);
  fn.i64Const(size);
  fn.i64ShrU();
  fn.i32WrapI64();
  fn.i32Const(1);
  fn.i32And();
  fn.localSet(L_TMP); // new CF

  fn.localGet(L_S);
  storeOperand(fn, dst);

  // flags: compute new, then keep old when masked count == 0
  fn.i32Const(EFLAGS_OFFSET + CTX_BASE);
  fn.i32Load();
  fn.localSet(L_ORIG); // old flags
  beginFlags(fn);
  emitZspFlags(fn, size);
  fn.localGet(L_TMP);
  orFlag(fn, 0); // CF
  if (op === 'rcl') {
    // OF = new_CF XOR MSB(result)
    fn.localGet(L_TMP);
    fn.localGet(L_S);
    fn.i32Const(size - 1);
    fn.i32ShrU();
    fn.i32Xor();
  } else {
    // OF = MSB(result) XOR MSB(operand)
    fn.localGet(L_S);
    fn.i32Const(size - 1);
    fn.i32ShrU();
    fn.localGet(L_A);
    fn.i32Const(size - 1);
    fn.i32ShrU();
    fn.i32Xor();
  }
  orFlag(fn, 11);
  fn.i32Const(EFLAGS_OFFSET + CTX_BASE);
  fn.i32Load();
  fn.i32Const(FLAG_DF);
  fn.i32And();
  fn.i32Or();
  fn.localSet(L_TMP2); // new flags
  fn.localGet(L_ORIG);
  fn.localGet(L_TMP2);
  fn.localGet(L_B);
  fn.i32Eqz();
  fn.select();
  fn.localSet(L_TMP2);
  fn.i32Const(EFLAGS_OFFSET + CTX_BASE);
  fn.localGet(L_TMP2);
  fn.i32Store();
}

/** 64-bit RCL/RCR. The 65-bit (CF, operand) value is rotated by b in [1, 63];
 * the a<<64 / a>>>64 terms are avoided by folding the extra step into a second
 * shift (a>>>64 == (a>>>63)>>>1 == 0). */
function emitRotateCarry64(fn: WasmFunction, op: 'rcl' | 'rcr', dst: Operand, count: Operand): void {
  pushOperand(fn, dst);
  fn.localSet(L_I64A); // a
  pushOperand(fn, count);
  fn.i32Const(0x3f);
  fn.i32And();
  fn.localSet(L_B); // b = count & 63
  fn.i32Const(EFLAGS_OFFSET + CTX_BASE);
  fn.i32Load();
  fn.i32Const(1);
  fn.i32And();
  fn.localSet(L_TMP); // old CF

  // term1 = a << b (rcl) / a >>> b (rcr)
  fn.localGet(L_I64A);
  fn.localGet(L_B);
  fn.i64ExtendI32U();
  if (op === 'rcl') fn.i64Shl();
  else fn.i64ShrU();
  // term2 = (a >>> (64-b)) >>> 1 (rcl) / (a << (64-b)) << 1 (rcr)
  fn.localGet(L_I64A);
  fn.i64Const(64);
  fn.localGet(L_B);
  fn.i64ExtendI32U();
  fn.i64Sub();
  if (op === 'rcl') fn.i64ShrU();
  else fn.i64Shl();
  fn.i64Const(1);
  if (op === 'rcl') fn.i64ShrU();
  else fn.i64Shl();
  fn.i64Or();
  // term3 = cf << (b-1) (rcl) / cf << (64-b) (rcr)
  fn.localGet(L_TMP);
  fn.i64ExtendI32U();
  fn.localGet(L_B);
  fn.i64ExtendI32U();
  if (op === 'rcl') {
    fn.i64Const(1);
    fn.i64Sub();
  } else {
    fn.i64Const(64);
    fn.i64Sub();
  }
  fn.i64Shl();
  fn.i64Or();
  fn.localSet(L_I64); // result

  fn.localGet(L_I64);
  storeOperand(fn, dst);

  // new CF = a[64-b] (rcl) / a[b-1] (rcr)
  fn.localGet(L_I64A);
  fn.localGet(L_B);
  fn.i64ExtendI32U();
  if (op === 'rcl') {
    fn.i64Const(64);
    fn.i64Sub();
  } else {
    fn.i64Const(1);
    fn.i64Sub();
  }
  fn.i64ShrU();
  fn.i32WrapI64();
  fn.i32Const(1);
  fn.i32And();
  fn.localSet(L_TMP); // new CF

  // flags: compute new, then keep old when masked count == 0
  fn.i32Const(EFLAGS_OFFSET + CTX_BASE);
  fn.i32Load();
  fn.localSet(L_ORIG); // old flags
  beginFlags(fn);
  emitZspFlags64(fn);
  fn.localGet(L_TMP);
  orFlag(fn, 0); // CF
  if (op === 'rcl') {
    // OF = new_CF XOR MSB(result)
    fn.localGet(L_TMP);
    fn.localGet(L_I64);
    fn.i64Const(63);
    fn.i64ShrU();
    fn.i32WrapI64();
    fn.i32Xor();
  } else {
    // OF = MSB(result) XOR MSB(operand)
    fn.localGet(L_I64);
    fn.i64Const(63);
    fn.i64ShrU();
    fn.i32WrapI64();
    fn.localGet(L_I64A);
    fn.i64Const(63);
    fn.i64ShrU();
    fn.i32WrapI64();
    fn.i32Xor();
  }
  orFlag(fn, 11);
  fn.i32Const(EFLAGS_OFFSET + CTX_BASE);
  fn.i32Load();
  fn.i32Const(FLAG_DF);
  fn.i32And();
  fn.i32Or();
  fn.localSet(L_TMP2); // new flags
  fn.localGet(L_ORIG);
  fn.localGet(L_TMP2);
  fn.localGet(L_B);
  fn.i32Eqz();
  fn.select();
  fn.localSet(L_TMP2);
  fn.i32Const(EFLAGS_OFFSET + CTX_BASE);
  fn.localGet(L_TMP2);
  fn.i32Store();
}

function emitMul(fn: WasmFunction, inst: Instruction, size: Size): void {
  if (size === 64) {
    emitMul64(fn, inst);
    return;
  }
  const signed = inst.op === 'imul';
  const isImulImm = inst.target !== undefined;
  if (isImulImm && inst.target!.kind === 'imm') {
    // imul dst, src, imm
    pushOperand(fn, inst.src!);
    fn.localSet(L_A);
    fn.i32Const(inst.target!.value);
    fn.localSet(L_B);
    // sign-extend sub-32 sources before multiplying (signed product)
    emitLoadSignExt(fn, size, L_A);
    emitLoadSignExt(fn, size, L_B);
    fn.localGet(L_A);
    fn.localGet(L_B);
    fn.i32Mul();
    fn.localSet(L_S);
    fn.localGet(L_S);
    storeOperand(fn, inst.dst!);
    beginFlags(fn);
    emitZspFlags(fn, size);
    emitOverflowSigned(fn, size);
    storeFlags(fn);
    return;
  }
  if (!signed) {
    // MUL rm — EDX:EAX = EAX * rm. The decoder emits a single-operand IR
    // { op: 'mul', dst: rm }; the multiplier is the implicit EAX operand.
    // (Previously this read inst.src — undefined for the single-operand
    // form — and crashed with "reading 'kind'".)
    if (size !== 32) {
      fn.unreachable();
      return;
    }
    fn.i32Const(regAddr('eax'));
    fn.i32Load();
    fn.localSet(L_A);
    pushOperand(fn, inst.dst!);
    fn.localSet(L_B);
    fn.localGet(L_A);
    fn.i64ExtendI32U();
    fn.localGet(L_B);
    fn.i64ExtendI32U();
    fn.i64Mul();
    fn.localSet(L_I64);
    // low -> EAX
    fn.localGet(L_I64);
    fn.i32WrapI64();
    fn.localSet(L_TMP);
    fn.i32Const(regAddr('eax'));
    fn.localGet(L_TMP);
    fn.i32Store();
    // high -> EDX
    fn.localGet(L_I64);
    fn.i64Const(32);
    fn.i64ShrU();
    fn.i32WrapI64();
    fn.localSet(L_TMP2);
    fn.i32Const(regAddr('edx'));
    fn.localGet(L_TMP2);
    fn.i32Store();
    // CF = OF = (high != 0)
    beginFlags(fn);
    fn.localGet(L_TMP2);
    fn.i32Eqz();
    fn.i32Const(1);
    fn.i32Xor();
    orFlag(fn, 0);
    fn.localGet(L_TMP2);
    fn.i32Eqz();
    fn.i32Const(1);
    fn.i32Xor();
    orFlag(fn, 11);
    storeFlags(fn);
    return;
  }
  // IMUL r, r/m
  pushOperand(fn, inst.dst!);
  fn.localSet(L_A);
  pushOperand(fn, inst.src!);
  fn.localSet(L_B);
  emitLoadSignExt(fn, size, L_A);
  emitLoadSignExt(fn, size, L_B);
  fn.localGet(L_A);
  fn.i64ExtendI32S();
  fn.localGet(L_B);
  fn.i64ExtendI32S();
  fn.i64Mul();
  fn.localSet(L_I64);
  fn.localGet(L_I64);
  fn.i32WrapI64();
  fn.localSet(L_S);
  fn.localGet(L_S);
  storeOperand(fn, inst.dst!);
  beginFlags(fn);
  emitZspFlags(fn, size);
  emitOverflowSigned(fn, size);
  storeFlags(fn);
}

/** 64-bit multiply forms. */
function emitMul64(fn: WasmFunction, inst: Instruction): void {
  const signed = inst.op === 'imul';
  const isImulImm = inst.target !== undefined && inst.target!.kind === 'imm';
  if (isImulImm) {
    // imul r64, r/m64, imm
    const imm = inst.target! as ImmOperand;
    pushOperand(fn, inst.src!);
    fn.localSet(L_I64A);
    fn.i64Const(imm.value);
    fn.localSet(L_I64B);
    fn.localGet(L_I64A);
    fn.localGet(L_I64B);
    fn.i64Mul();
    fn.localSet(L_I64);
    fn.localGet(L_I64);
    storeOperand(fn, inst.dst!);
    beginFlags(fn);
    emitZspFlags64(fn);
    storeFlags(fn);
    return;
  }
  // Single-operand forms: the implicit multiplier is RAX.
  //   MUL  r/m64 : RDX:RAX = RAX * r/m64  (unsigned, 128-bit product)
  //   IMUL r/m64 : RAX     = RAX * r/m64  (signed, low 64; RDX = sign-ext)
  // The decoder emits { op:'mul'/'imul', dst: r/m64 } with no src/target, so we
  // must read RAX ourselves and write RDX:RAX (not dst).
  fn.i32Const(regAddr('rax'));
  fn.i64Load();
  fn.localSet(L_I64A); // a
  pushOperand(fn, inst.dst!);
  fn.localSet(L_I64B); // b

  if (!signed) {
    // low 64 bits of the product (RAX = a*b, truncated to 64 bits)
    fn.localGet(L_I64A);
    fn.localGet(L_I64B);
    fn.i64Mul();
    fn.localSet(L_I64);
    // high 64 bits via 32-bit half products of (aH:aL) * (bH:bL):
    //   product = aL*bL + (aL*bH + aH*bL)<<32 + aH*bH<<64
    fn.localGet(L_I64A);
    fn.i64Const(0xffffffff);
    fn.i64And();
    fn.localSet(L_I64C); // aL
    fn.localGet(L_I64A);
    fn.i64Const(32);
    fn.i64ShrU();
    fn.localSet(L_I64D); // aH
    fn.localGet(L_I64B);
    fn.i64Const(0xffffffff);
    fn.i64And();
    fn.localSet(L_I64E); // bL
    fn.localGet(L_I64B);
    fn.i64Const(32);
    fn.i64ShrU();
    fn.localSet(L_I64F); // bH
    fn.localGet(L_I64C);
    fn.localGet(L_I64E);
    fn.i64Mul();
    fn.localSet(L_I64G); // t0 = aL*bL
    fn.localGet(L_I64C);
    fn.localGet(L_I64F);
    fn.i64Mul();
    fn.localSet(L_I64H); // t1 = aL*bH
    fn.localGet(L_I64D);
    fn.localGet(L_I64E);
    fn.i64Mul();
    fn.localSet(L_I64I); // t2 = aH*bL
    // lo = t0 & 0xffffffff
    fn.localGet(L_I64G);
    fn.i64Const(0xffffffff);
    fn.i64And();
    fn.localSet(L_I64C); // lo (reuses aL slot)
    // mid = t1 + t2 + (t0 >>> 32)
    fn.localGet(L_I64H);
    fn.localGet(L_I64I);
    fn.i64Add();
    fn.localGet(L_I64G);
    fn.i64Const(32);
    fn.i64ShrU();
    fn.i64Add(); // mid
    fn.localSet(L_I64H); // mid
    fn.localGet(L_I64H);
    fn.i64Const(0xffffffff);
    fn.i64And();
    fn.localSet(L_I64E); // mid_lo
    fn.localGet(L_I64H);
    fn.i64Const(32);
    fn.i64ShrU();
    fn.localSet(L_I64F); // mid_hi
    // hi = aH*bH + mid_hi
    fn.localGet(L_I64D);
    fn.localGet(L_I64F);
    fn.i64Mul(); // t3 = aH*bH
    fn.localGet(L_I64F); // mid_hi
    fn.i64Add();
    fn.localSet(L_I64HI); // high 64 bits
    // low64 = (mid_lo << 32) | lo
    fn.localGet(L_I64E);
    fn.i64Const(32);
    fn.i64Shl();
    fn.localGet(L_I64C);
    fn.i64Const(0xffffffff);
    fn.i64And();
    fn.i64Or();
    fn.localSet(L_I64); // low 64 bits
    // RAX = low, RDX = high
    fn.i32Const(regAddr('rax'));
    fn.localGet(L_I64);
    fn.i64Store();
    fn.i32Const(regAddr('rdx'));
    fn.localGet(L_I64HI);
    fn.i64Store();
    // CF = OF = (high != 0)
    beginFlags(fn);
    fn.localGet(L_I64HI);
    fn.i64Eqz();
    fn.i32Eqz();
    orFlag(fn, 0);
    fn.localGet(L_I64HI);
    fn.i64Eqz();
    fn.i32Eqz();
    orFlag(fn, 11);
    storeFlags(fn);
    return;
  }

  // signed IMUL r/m64: RAX = RAX * r/m64 (low 64); RDX = sign-extend(low)
  fn.localGet(L_I64A);
  fn.localGet(L_I64B);
  fn.i64Mul();
  fn.localSet(L_I64);
  fn.i32Const(regAddr('rax'));
  fn.localGet(L_I64);
  fn.i64Store();
  fn.localGet(L_I64);
  fn.i64Const(63);
  fn.i64ShrS();
  fn.localSet(L_I64HI); // sign-extended high
  fn.i32Const(regAddr('rdx'));
  fn.localGet(L_I64HI);
  fn.i64Store();
  // OF = CF = (RDX != sign-extend(RAX))
  beginFlags(fn);
  fn.localGet(L_I64HI);
  fn.localGet(L_I64);
  fn.i64Const(63);
  fn.i64ShrS();
  fn.i64Ne();
  fn.i32WrapI64();
  orFlag(fn, 0);
  fn.localGet(L_I64HI);
  fn.localGet(L_I64);
  fn.i64Const(63);
  fn.i64ShrS();
  fn.i64Ne();
  fn.i32WrapI64();
  orFlag(fn, 11);
  storeFlags(fn);
}

/** Sign-extends a sub-32-bit value held in `local` to a full 32-bit value. */
function emitLoadSignExt(fn: WasmFunction, size: Size, local: number): void {
  if (size === 32) return;
  const mask = flagMask(size);
  const signBit = 1 << (size - 1);
  const sub = 1 << size;
  // v = local & mask  (drop garbage high bits)
  fn.localGet(local);
  fn.i32Const(mask);
  fn.i32And();
  fn.localSet(L_TMP);
  // select sign-extended: (v & signBit) ? v - sub : v
  // stack must be [v-sub, v, cond] for select (missing the `v` operand made
  // every sub-32 sign-extension emit an invalid "select need 3, got 2")
  fn.localGet(L_TMP);
  fn.i32Const(sub);
  fn.i32Sub();
  fn.localGet(L_TMP);
  fn.localGet(L_TMP);
  fn.i32Const(signBit);
  fn.i32And();
  fn.i32Const(0);
  fn.i32Ne();
  fn.select();
  fn.localSet(local);
}

/** Emits OF for signed overflow of the size-width product in local L_S. */
function emitOverflowSigned(fn: WasmFunction, size: Size): void {
  // overflow = (product >> 32) != sign-extend(bit(size-1) of result)
  fn.localGet(L_A);
  fn.i64ExtendI32S();
  fn.localGet(L_B);
  fn.i64ExtendI32S();
  fn.i64Mul();
  fn.i64Const(32);
  fn.i64ShrS();
  fn.i32WrapI64();
  fn.localGet(L_S);
  fn.i32Const(flagMask(size));
  fn.i32And();
  fn.i32Const(size - 1);
  fn.i32ShrU();
  fn.i32Const(0xffffffff);
  fn.i32Mul();
  fn.i32Ne();
  orFlag(fn, 11);
}

function emitDiv(fn: WasmFunction, op: 'div' | 'idiv', size: Size, dst: Operand): void {
  // 32-bit forms only in this milestone (EDX:EAX = EAX / r/m32)
  if (size !== 32) {
    fn.unreachable();
    return;
  }
  // divisor
  pushOperand(fn, dst);
  fn.localSet(L_B);
  // dividend = EDX:EAX
  fn.i32Const(regAddr('edx'));
  fn.i32Load();
  fn.localSet(L_A); // high
  fn.i32Const(regAddr('eax'));
  fn.i32Load();
  fn.localSet(L_S); // low
  // build i64 dividend
  fn.localGet(L_A);
  if (op === 'idiv') fn.i64ExtendI32S();
  else fn.i64ExtendI32U();
  fn.i64Const(32);
  fn.i64Shl();
  fn.localGet(L_S);
  fn.i64ExtendI32U();
  fn.i64Or();
  fn.localSet(L_I64);

  // guard divisor != 0
  fn.localGet(L_B);
  fn.i32Eqz();
  fn.ifBlock();
  fn.unreachable();
  fn.end();

  // quotient / remainder
  fn.localGet(L_I64);
  fn.localGet(L_B);
  if (op === 'idiv') fn.i64ExtendI32S();
  else fn.i64ExtendI32U();
  if (op === 'idiv') fn.i64DivS();
  else fn.i64DivU();
  fn.i32WrapI64();
  fn.localSet(L_TMP); // quotient
  fn.localGet(L_I64);
  fn.localGet(L_B);
  if (op === 'idiv') fn.i64ExtendI32S();
  else fn.i64ExtendI32U();
  if (op === 'idiv') fn.i64RemS();
  else fn.i64RemU();
  fn.i32WrapI64();
  fn.localSet(L_TMP2); // remainder
  // eax = quotient
  fn.i32Const(regAddr('eax'));
  fn.localGet(L_TMP);
  fn.i32Store();
  // edx = remainder
  fn.i32Const(regAddr('edx'));
  fn.localGet(L_TMP2);
  fn.i32Store();
  // flags undefined after div — leave as-is
}

function emitSetcc(fn: WasmFunction, cond: Cond, dst: Operand): void {
  emitCond(fn, cond);
  if (dst.kind !== 'rel' && dst.size === 64) fn.i64ExtendI32U();
  storeOperand(fn, dst);
}

/** CMOVcc dst, src: dst = cond ? src : dst. */
function emitCmov(fn: WasmFunction, cond: Cond, dst: Operand, src: Operand): void {
  pushOperand(fn, src);
  pushOperand(fn, dst);
  emitCond(fn, cond);
  // select(v1=src, v2=dst, c) -> c ? src : dst
  fn.select();
  storeOperand(fn, dst);
}

/**
 * CMPXCHG r/m, reg: if r/m == accumulator then r/m = reg, ZF=1 else
 * accumulator = r/m, ZF=0. Only ZF matters for the classic lock loops.
 */
function emitCmpXchg(fn: WasmFunction, size: Size, dst: Operand, src: Operand): void {
  if (size === 64) {
    emitCmpXchg64(fn, dst, src);
    return;
  }
  const accReg: RegName = size === 8 ? 'al' : size === 16 ? 'ax' : MODE === 'x64' ? 'rax' : 'eax';
  pushOperand(fn, dst);
  fn.localSet(L_A); // m
  pushOperand(fn, src);
  fn.localSet(L_B); // b
  fn.i32Const(regAddr(accReg));
  loadWidth(fn, size);
  fn.localSet(L_ORIG); // a
  // s = m - a (compare result)
  fn.localGet(L_A);
  fn.localGet(L_ORIG);
  fn.i32Sub();
  fn.localSet(L_S);
  // eq = (m == a)
  fn.localGet(L_A);
  fn.localGet(L_ORIG);
  fn.i32Eq();
  fn.localSet(L_TMP2);
  // r/m = eq ? b : a
  fn.localGet(L_B);
  fn.localGet(L_ORIG);
  fn.localGet(L_TMP2);
  fn.select();
  storeOperand(fn, dst);
  // accumulator = a (no-op when equal)
  fn.localGet(L_ORIG);
  storeOperand(fn, { kind: 'reg', reg: accReg, size });
  // flags: ZF = eq, SF = sign(m - a), CF = (m < a)
  beginFlags(fn);
  fn.localGet(L_TMP2);
  orFlag(fn, 6);
  fn.localGet(L_S);
  fn.i32Const(flagMask(size));
  fn.i32And();
  fn.i32Const(size - 1);
  fn.i32ShrU();
  orFlag(fn, 7);
  fn.localGet(L_A);
  fn.localGet(L_ORIG);
  fn.i32LtU();
  orFlag(fn, 0);
  storeFlags(fn);
}

/** 64-bit CMPXCHG r/m, r64 (accumulator = rax). */
function emitCmpXchg64(fn: WasmFunction, dst: Operand, src: Operand): void {
  const accReg: RegName = 'rax';
  pushOperand(fn, dst);
  fn.localSet(L_I64A); // m
  pushOperand(fn, src);
  fn.localSet(L_I64B); // b
  fn.i32Const(regAddr(accReg));
  fn.i64Load();
  fn.localSet(L_I64); // a
  // eq = (m == a)
  fn.localGet(L_I64A);
  fn.localGet(L_I64);
  fn.i64Eq();
  fn.localSet(L_TMP2);
  // r/m = eq ? b : a
  fn.localGet(L_I64B);
  fn.localGet(L_I64);
  fn.localGet(L_TMP2);
  fn.select();
  storeOperand(fn, dst);
  // accumulator = a
  fn.localGet(L_I64);
  storeOperand(fn, { kind: 'reg', reg: accReg, size: 64 });
  // flags: ZF = eq, SF = sign(m - a), CF = (m < a)
  beginFlags(fn);
  fn.localGet(L_TMP2);
  orFlag(fn, 6);
  fn.localGet(L_I64A);
  fn.localGet(L_I64);
  fn.i64Sub();
  fn.i64Const(63);
  fn.i64ShrU();
  fn.i32WrapI64();
  orFlag(fn, 7);
  fn.localGet(L_I64A);
  fn.localGet(L_I64);
  fn.i64LtU();
  orFlag(fn, 0);
  storeFlags(fn);
}

/**
 * XADD r/m, reg (0F C0/C1): tmp = dst + src; dst = src; src = tmp.
 * Flags are set exactly as for ADD (OF/SF/ZF/AF/PF/CF). Used by atomic
 * Interlocked style / refcount primitives (notepad's `lock xadd` counters).
 */
function emitXadd(fn: WasmFunction, size: Size, dst: Operand, src: Operand): void {
  if (size === 64) {
    emitXadd64(fn, dst, src);
    return;
  }
  pushOperand(fn, dst);
  fn.localSet(L_A);
  pushOperand(fn, src);
  fn.localSet(L_B);
  // L_S = L_A + L_B
  fn.localGet(L_A);
  fn.localGet(L_B);
  fn.i32Add();
  fn.localSet(L_S);
  // dst = src (the old register value)
  fn.localGet(L_B);
  storeOperand(fn, dst);
  // src = result (old dst + src)
  fn.localGet(L_S);
  storeOperand(fn, src);
  // flags: same as ADD
  beginFlags(fn);
  emitZspFlags(fn, size);
  emitOfBinary(fn, size, 'add');
  fn.localGet(L_S);
  fn.localGet(L_A);
  fn.i32LtU();
  orFlag(fn, 0);
  emitAfAdd(fn);
  storeFlags(fn);
}

/** 64-bit XADD r/m, r64. */
function emitXadd64(fn: WasmFunction, dst: Operand, src: Operand): void {
  pushOperand(fn, dst);
  fn.localSet(L_I64A);
  pushOperand(fn, src);
  fn.localSet(L_I64B);
  fn.localGet(L_I64A);
  fn.localGet(L_I64B);
  fn.i64Add();
  fn.localSet(L_I64);
  // dst = src (the old register value)
  fn.localGet(L_I64B);
  storeOperand(fn, dst);
  // src = result (old dst + src)
  fn.localGet(L_I64);
  storeOperand(fn, src);
  // flags: same as ADD
  beginFlags(fn);
  emitZspFlags64(fn);
  emitOfBinary64(fn, 'add');
  fn.localGet(L_I64);
  fn.localGet(L_I64A);
  fn.i64LtU();
  orFlag(fn, 0);
  emitAfAdd64(fn);
  storeFlags(fn);
}

// ---------------------------------------------------------------------------
// condition code
// ---------------------------------------------------------------------------

/** Pushes 1 if `cond` holds against the current EFLAGS, else 0. */
function emitCond(fn: WasmFunction, cond: Cond): void {
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

// ---------------------------------------------------------------------------
// string ops (DF = 0 assumed unless the DF bit is set)
// ---------------------------------------------------------------------------

/** Pushes the per-element step: +size when DF clear, -size when DF set. */
function emitStep(fn: WasmFunction, size: Size): void {
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

function emitStos(fn: WasmFunction, inst: Instruction, size: Size): void {
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

function emitLods(fn: WasmFunction, inst: Instruction, size: Size): void {
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

function emitMovs(fn: WasmFunction, inst: Instruction, size: Size): void {
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
function emitMaybeRep(fn: WasmFunction, rep: boolean, body: () => void): void {
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
function emitAdvance(fn: WasmFunction, reg: RegName, size: Size): void {
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
function emitRepCond(fn: WasmFunction, rep: boolean, repne: boolean, body: () => void): void {
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
function emitScas(fn: WasmFunction, inst: Instruction, size: Size): void {
  const acc: Operand = { kind: 'reg', reg: 'eax', size };
  const mem: Operand = { kind: 'mem', base: 'edi', scale: 1, disp: 0, size };
  const body = (): void => {
    emitArith(fn, 'cmp', size, acc, mem);
    emitAdvance(fn, 'edi', size);
  };
  emitRepCond(fn, inst.rep ?? false, inst.repne ?? false, body);
}

/** CMPS: compares [ESI] with [EDI] (sets flags like CMP), then advances both. */
function emitCmps(fn: WasmFunction, inst: Instruction, size: Size): void {
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
