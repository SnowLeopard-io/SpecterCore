/**
 * SSE (minimal XMM support) emitters: 128-bit moves, movd, pshufd, pxor, and byte shifts.
 *
 * Split out of codegen.ts (design doc 4.1.5); pure code movement, no logic changes.
 */

import type { MemOperand, Operand, XmmOperand } from './ir';
import { xmmAddr } from './cpu';
import type { WasmFunction } from './wasm-encoder';
import {
  L_A,
  L_B,
  L_ORIG,
  L_S,
  L_TMP,
  L_TMP2,
  emitEa,
  pushOperand,
  storeOperand,
} from './codegen-shared';

// ---------------------------------------------------------------------------
// SSE (minimal XMM support)
// ---------------------------------------------------------------------------

/** Pushes source lane `lane` (0..3) of an XMM register or memory operand. */
export function pushXmmLane(fn: WasmFunction, src: MemOperand | XmmOperand, lane: number): void {
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
export function emitXmmMove(
  fn: WasmFunction,
  xmm: XmmOperand,
  other: MemOperand | XmmOperand,
  load: boolean,
  lanes: 1 | 2 | 4 = 4,
): void {
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
export function emitXmmHalfMove(
  fn: WasmFunction,
  xmm: XmmOperand,
  mem: MemOperand,
  high: 0 | 1,
  load: boolean,
): void {
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
export function emitXmmMovd(fn: WasmFunction, dst: Operand, src: Operand): void {
  if (dst.kind === 'xmm') {
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
export function emitXmmPshufd(
  fn: WasmFunction,
  dst: XmmOperand,
  src: MemOperand | XmmOperand,
  imm: number,
): void {
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
export function emitXmmPxor(fn: WasmFunction, dst: XmmOperand, src: MemOperand | XmmOperand): void {
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
export function emitXmmShiftBytes(
  fn: WasmFunction,
  dst: XmmOperand,
  src: MemOperand | XmmOperand,
  imm: number,
  left: boolean,
): void {
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
