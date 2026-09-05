/**
 * Data-movement and arithmetic instruction emitters: mov/movzx/movsx, add/sub/adc/sbb/and/or/xor/cmp, test, inc/dec, neg, xchg, cmpxchg, xadd.
 *
 * Split out of codegen.ts (design doc 4.1.5); pure code movement, no logic changes.
 */

import type { Instruction, Operand, RegName, Size } from './ir';
import { CTX_BASE, EFLAGS_OFFSET } from './cpu';
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
  MODE,
  emitEa,
  loadWidth,
  pushOperand,
  regAddr,
  storeOperand,
} from './codegen-shared';
import {
  beginFlags,
  emitAfAdd,
  emitAfAdd64,
  emitAfSub,
  emitAfSub64,
  emitOfBinary,
  emitOfBinary64,
  emitZspFlags,
  emitZspFlags64,
  flagMask,
  orFlag,
  storeFlags,
} from './codegen-flags';

// ---------------------------------------------------------------------------
// mov / movzx / movsx
// ---------------------------------------------------------------------------

export function emitMov(fn: WasmFunction, inst: Instruction, size: Size): void {
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

export function emitArith(
  fn: WasmFunction,
  op: Instruction['op'],
  size: Size,
  dst: Operand,
  src: Operand,
): void {
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

export function emitTest(fn: WasmFunction, size: Size, dst: Operand, src: Operand): void {
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

export function emitTest64(fn: WasmFunction, dst: Operand, src: Operand): void {
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
export function emitArith64(
  fn: WasmFunction,
  op: Instruction['op'],
  dst: Operand,
  src: Operand,
): void {
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

export function emitIncDec(fn: WasmFunction, op: 'inc' | 'dec', size: Size, dst: Operand): void {
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

export function emitIncDec64(fn: WasmFunction, op: 'inc' | 'dec', dst: Operand): void {
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

export function emitNeg(fn: WasmFunction, size: Size, dst: Operand): void {
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

export function emitNeg64(fn: WasmFunction, dst: Operand): void {
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

export function emitXchg(fn: WasmFunction, a: Operand, b: Operand, size: Size): void {
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
 * CMPXCHG r/m, reg: if r/m == accumulator then r/m = reg, ZF=1 else
 * accumulator = r/m, ZF=0. Only ZF matters for the classic lock loops.
 */
export function emitCmpXchg(fn: WasmFunction, size: Size, dst: Operand, src: Operand): void {
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
export function emitCmpXchg64(fn: WasmFunction, dst: Operand, src: Operand): void {
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
export function emitXadd(fn: WasmFunction, size: Size, dst: Operand, src: Operand): void {
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
export function emitXadd64(fn: WasmFunction, dst: Operand, src: Operand): void {
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
