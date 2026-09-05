/**
 * Shift and rotate instruction emitters: shl/shr/sar/rol/ror and rcl/rcr, 32-bit and 64-bit.
 *
 * Split out of codegen.ts (design doc 4.1.5); pure code movement, no logic changes.
 */

import type { Operand, Size } from './ir';
import { CTX_BASE, EFLAGS_OFFSET, FLAG_DF } from './cpu';
import type { WasmFunction } from './wasm-encoder';
import {
  L_A,
  L_B,
  L_I64,
  L_I64A,
  L_I64B,
  L_ORIG,
  L_S,
  L_TMP,
  L_TMP2,
  pushOperand,
  storeOperand,
} from './codegen-shared';
import { beginFlags, emitZspFlags, emitZspFlags64, flagMask, orFlag } from './codegen-flags';

export function emitShift(
  fn: WasmFunction,
  op: 'shl' | 'shr' | 'sar' | 'rol' | 'ror',
  size: Size,
  dst: Operand,
  count: Operand,
): void {
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
export function emitShift64(
  fn: WasmFunction,
  op: 'shl' | 'shr' | 'sar' | 'rol' | 'ror',
  dst: Operand,
  count: Operand,
): void {
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
export function emitRotateCarry(
  fn: WasmFunction,
  op: 'rcl' | 'rcr',
  size: Size,
  dst: Operand,
  count: Operand,
): void {
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
export function emitRotateCarry64(
  fn: WasmFunction,
  op: 'rcl' | 'rcr',
  dst: Operand,
  count: Operand,
): void {
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
