/**
 * Architecture backend contract.
 *
 * SpecterCore runs both 32-bit (PE32) and 64-bit (PE32+) guests through one
 * JIT, one IR and one CPU-context layout — those are *unified* on purpose (the
 * x64 ISA is the i386 ISA plus REX prefixes and eight extra registers, so the
 * decoder/codegen stay shared). What genuinely differs between the two guests
 * is **mode-specific policy**: stack framing, the import-stub shape, the Win32
 * calling convention, vtable/COM layouts, and SEH. All of that is concentrated
 * behind this interface so a guest run only ever says `arch.<method>()` instead
 * of spraying `if (pe.is64)` branches across the runner.
 *
 * The backends are stateless (every method that touches guest memory takes the
 * `WasmRuntimeImpl` as an argument), so the two singletons in `index.ts` are
 * safe to share across every `GuestProcessRunner` instance.
 */

import type { ApiResult } from '@specter-core/contracts';
import type { RegName } from '../jit/ir';
import type { WasmRuntimeImpl } from '../jit/runtime';

export type ArchMode = 'x86' | 'x64';

export interface OpenFileNameOffsets {
  lpstrFilter: number;
  lpstrFile: number;
  nMaxFile: number;
  lpstrFileTitle: number;
  lpstrInitialDir: number;
  lpstrTitle: number;
  nFileOffset: number;
  nFileExtension: number;
}

export interface WndClassExOffsets {
  menuName: number;
  name: number;
}

export interface ArchBackend {
  /** The guest bitness this backend serves. */
  readonly mode: ArchMode;

  /** Width of a guest pointer / GPR slot in bytes (4 for x86, 8 for x64). */
  readonly pointerSize: 4 | 8;

  /** Stride between IAT/INT thunk entries in bytes. */
  readonly thunkStride: 4 | 8;

  /** IMAGE_ORDINAL_FLAG for this bitness (bit 31 on x86, bit 63 on x64). */
  readonly ordinalFlag: bigint;

  /** Whether structured exception handling is implemented for this bitness. */
  readonly supportsSeh: boolean;

  /** Register that carries the high 32 bits of a 64-bit return value. */
  readonly highReturnReg: 'edx' | 'rdx';

  /**
   * Number of stdcall stack arguments a given imported API pops. 0 means the
   * stub must use a plain `ret` (cdecl CRT functions, and every x64 import —
   * the Microsoft x64 convention lets the *caller* clean the stack).
   */
  importArgCount(proc: string, module?: string): number;

  /** Bytes for a trap stub: `mov eax,<idx>; int 0x2E; ret [<args*4>]`. */
  emitImportStub(index: number, argCount: number): Uint8Array;

  /** Write a guest pointer (low dword always; high dword zeroed on x64). */
  writePointer(runtime: WasmRuntimeImpl, address: number, value: number): void;

  /** Read a guest pointer (4 bytes on x86, 8 bytes on x64) as a 32-bit address. */
  readPointer(runtime: WasmRuntimeImpl, address: number): number;

  /** Read an IAT/INT thunk entry as a 64-bit value (4 or 8 bytes). */
  readThunkEntry(runtime: WasmRuntimeImpl, address: number): bigint;

  /**
   * Write an IAT slot. The low dword is always the stub address; on x64 the
   * high dword is zeroed. On x86 the high dword is only zeroed when `dllName`
   * is present, preserving the existing delay-load behavior.
   */
  writeIatSlot(runtime: WasmRuntimeImpl, address: number, value: number, dllName?: string): void;

  /** Seed the initial guest stack (sentinel return address + stack pointer). */
  setupStack(runtime: WasmRuntimeImpl, stackTop: number): void;

  /**
   * Build a WndProc call frame for the guest calling convention: x86 pushes a
   * 4-arg stdcall frame under a sentinel return address; x64 loads
   * rcx/rdx/r8/r9 and a 16-byte-aligned `rsp` pointing at a sentinel.
   */
  setupWndProcCall(
    runtime: WasmRuntimeImpl,
    wndProc: number,
    hwnd: number,
    message: number,
    wParam: number,
    lParam: number,
    returnAddr: number,
  ): void;

  /** Marshal up to `maxArgs` trap arguments from guest registers / stack. */
  marshalTrapArgs(runtime: WasmRuntimeImpl, maxArgs: number): number[];

  /** Write an API handler's return value back into the guest registers. */
  writeTrapReturn(runtime: WasmRuntimeImpl, result: ApiResult): void;

  /** Slots in a synthesized vtable (16 for x86, 32 for x64). */
  vtableSlotCount(): number;

  /** Slots in a synthesized COM vtable (32 for x86, 64 for x64). */
  comVtableSlotCount(): number;

  /** Full GP register file, low-to-high, used for snapshot/restore. */
  gpRegisterNames(): RegName[];

  /** Field offsets inside a WNDCLASSEXW structure. */
  wndClassExOffsets(): WndClassExOffsets;

  /** Field offsets inside an OPENFILENAMEW structure. */
  openFileNameOffsets(): OpenFileNameOffsets;
}
