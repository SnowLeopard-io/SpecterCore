/**
 * Miscellaneous instruction emitters: cpuid, rdtsc, and the minimal x87 FPU moves.
 *
 * Split out of codegen.ts (design doc 4.1.5); pure code movement, no logic changes.
 */

import type { MemOperand, RegName } from './ir';
import { CTX_BASE, TSC_OFFSET, fpuAddr } from './cpu';
import type { WasmFunction } from './wasm-encoder';
import { L_S, L_TMP, L_TMP2, emitEa, regAddr } from './codegen-shared';

// ---------------------------------------------------------------------------
// misc
// ---------------------------------------------------------------------------


/**
 * CPUID (0F A2): leaf in EAX, results in EAX/EBX/ECX/EDX. Emits a small
 * synthetic CPU. IMPORTANT: the JIT has no XMM/MMX support, so leaf 1
 * deliberately reports NO MMX/SSE/SSE2/SSE3+ (edx=0xb9ebfbff, ecx=0) — guests
 * (Delphi/Inno CRT, msvcrt) then pick scalar/REP fallbacks (rep stosb etc.)
 * that the JIT handles, instead of movups/movd paths that would fault.
 * Kept: CMOV (bit15) and CMPXCHG8B (bit8) — the MM relies on them.
 */
export function emitCpuid(fn: WasmFunction): void {
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

export function emitRdtsc(fn: WasmFunction): void {
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

/**
 * Minimal x87 FLD/FST/FSTP: raw 8-byte moves between ST(0) (slot 0 of the FPU
 * register file) and a memory operand. 32-bit forms copy one dword (zeroing
 * the upper half of the slot / writing only 4 bytes to memory). No real
 * float arithmetic — enough for CRT/init code.
 */
export function emitFpuMove(fn: WasmFunction, op: 'fld' | 'fst' | 'fstp', dst: MemOperand | undefined, src: MemOperand | undefined, size: 32 | 64): void {
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
export function emitFpuIntMove(fn: WasmFunction, op: 'fild' | 'fist' | 'fistp', dst: MemOperand | undefined, src: MemOperand | undefined, size: 32 | 64): void {
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

