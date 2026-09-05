/**
 * Bit instruction emitters: bsf/bsr and bt/bts/btr/btc.
 *
 * Split out of codegen.ts (design doc 4.1.5); pure code movement, no logic changes.
 */

import type { Operand, Size } from './ir';
import type { WasmFunction } from './wasm-encoder';
import { L_A, L_B, L_ORIG, L_S, L_TMP, L_TMP2, emitEa, pushOperand, regAddr, storeOperand, storeWidth } from './codegen-shared';
import { beginFlags, orFlag, storeFlags } from './codegen-flags';

/**
 * BSF/BSR (0F BC/BD): dest = index of least/most significant set bit; ZF = 1
 * when the source is zero (dest then holds 0, matching the common convention).
 * Maps onto i32.ctz / 31 - i32.clz.
 */
export function emitBitScan(fn: WasmFunction, op: 'bsf' | 'bsr', size: Size, dst: Operand, src: Operand): void {
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
export function emitBitTest(fn: WasmFunction, op: 'bt' | 'bts' | 'btr' | 'btc', size: Size, dst: Operand, src: Operand): void {
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

