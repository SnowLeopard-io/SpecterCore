/**
 * Multiplication and division emitters: mul/imul (incl. imul-imm), div/idiv, and sign-extension helpers.
 *
 * Split out of codegen.ts (design doc 4.1.5); pure code movement, no logic changes.
 */

import type { ImmOperand, Instruction, Operand, Size } from './ir';
import type { WasmFunction } from './wasm-encoder';
import {
  L_A,
  L_B,
  L_I64,
  L_I64A,
  L_I64B,
  L_I64C,
  L_I64D,
  L_I64E,
  L_I64F,
  L_I64G,
  L_I64H,
  L_I64HI,
  L_I64I,
  L_S,
  L_TMP,
  L_TMP2,
  pushOperand,
  regAddr,
  storeOperand,
} from './codegen-shared';
import {
  beginFlags,
  emitZspFlags,
  emitZspFlags64,
  flagMask,
  orFlag,
  storeFlags,
} from './codegen-flags';

export function emitMul(fn: WasmFunction, inst: Instruction, size: Size): void {
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
export function emitMul64(fn: WasmFunction, inst: Instruction): void {
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
export function emitLoadSignExt(fn: WasmFunction, size: Size, local: number): void {
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
export function emitOverflowSigned(fn: WasmFunction, size: Size): void {
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

export function emitDiv(fn: WasmFunction, op: 'div' | 'idiv', size: Size, dst: Operand): void {
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
