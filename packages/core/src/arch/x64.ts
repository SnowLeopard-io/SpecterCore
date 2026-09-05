/**
 * 64-bit (PE32+ / x86-64) architecture backend.
 *
 * The x64 ISA is the i386 ISA plus REX prefixes and eight extra registers, so
 * the JIT decoder/codegen stay unified with the 32-bit path. What this backend
 * owns is the x64-specific *policy*: an 8-byte import stub (CALLER cleans the
 * stack, so always a plain `ret`), 8-byte pointers, the Microsoft x64 calling
 * convention (rcx/rdx/r8/r9 + shadow space), and the wider vtable/COM/struct
 * layouts. SEH is not yet implemented for x64 (`supportsSeh = false`).
 */

import type { ApiResult } from '@specter-core/contracts';
import type { RegName } from '../jit/ir';
import type { WasmRuntimeImpl } from '../jit/runtime';
import type { ArchBackend, OpenFileNameOffsets, WndClassExOffsets } from './types';

export class X64Backend implements ArchBackend {
  readonly mode = 'x64' as const;
  readonly pointerSize = 8 as const;
  readonly thunkStride = 8 as const;
  readonly ordinalFlag = 0x8000000000000000n;
  readonly supportsSeh = false;
  readonly highReturnReg = 'rdx' as const;

  // The Microsoft x64 convention is caller-cleaned, so every import stub is a
  // plain `ret` (argCount is always 0 here).
  importArgCount(): number {
    return 0;
  }

  emitImportStub(index: number): Uint8Array {
    const stub = new Uint8Array(8);
    stub[0] = 0xb8;
    stub[1] = index & 0xff;
    stub[2] = (index >> 8) & 0xff;
    stub[3] = (index >> 16) & 0xff;
    stub[4] = (index >> 24) & 0xff;
    stub[5] = 0xcd;
    stub[6] = 0x2e;
    stub[7] = 0xc3;
    return stub;
  }

  writePointer(runtime: WasmRuntimeImpl, address: number, value: number): void {
    runtime.writeInt32(address, value | 0);
    runtime.writeInt32(address + 4, 0); // guest addresses stay < 4GB
  }

  readPointer(runtime: WasmRuntimeImpl, address: number): number {
    const b = runtime.readBytes(address >>> 0, 8);
    if (b.byteLength < 8) return 0;
    return Number(new DataView(b.buffer, b.byteOffset, b.byteLength).getBigUint64(0, true));
  }

  readThunkEntry(runtime: WasmRuntimeImpl, address: number): bigint {
    const lo = runtime.readInt32(address) >>> 0;
    const hi = runtime.readInt32(address + 4) >>> 0;
    return (BigInt(hi) << 32n) | BigInt(lo);
  }

  writeIatSlot(runtime: WasmRuntimeImpl, address: number, value: number): void {
    runtime.writeInt32(address, value | 0);
    runtime.writeInt32(address + 4, 0);
  }

  setupStack(runtime: WasmRuntimeImpl, stackTop: number): void {
    runtime.writeInt32(stackTop - 4, 0);
    runtime.writeInt32(stackTop - 8, 0); // 8-byte aligned, slots are 8 bytes wide
    runtime.setReg('rsp', stackTop - 8);
  }

  setupWndProcCall(
    runtime: WasmRuntimeImpl,
    wndProc: number,
    hwnd: number,
    message: number,
    wParam: number,
    lParam: number,
    returnAddr: number,
  ): void {
    // Place the 8-byte sentinel return address at frameR; set rsp = frameR so
    // the prologue `sub rsp,0x28` leaves [rsp+0x28] = sentinel. rcx/rdx/r8/r9
    // carry the four args. The WndProc's `ret` pops the sentinel into rip.
    const rsp = runtime.getReg('rsp') >>> 0;
    let frameR = (rsp & ~0xf) - 0x40;
    if ((frameR & 0xf) === 0) frameR -= 8; // ensure frameR % 16 == 8 (post-call alignment)
    const dv = new DataView(new ArrayBuffer(8));
    dv.setBigUint64(0, BigInt(returnAddr >>> 0), true);
    runtime.writeBytes(frameR, new Uint8Array(dv.buffer));
    runtime.setReg('rcx', hwnd);
    runtime.setReg('rdx', message);
    runtime.setReg('r8', wParam);
    runtime.setReg('r9', lParam);
    runtime.setReg('rsp', frameR);
    runtime.setEip(wndProc);
  }

  marshalTrapArgs(runtime: WasmRuntimeImpl, maxArgs: number): number[] {
    const regArgs = ['rcx', 'rdx', 'r8', 'r9'] as const;
    const rsp = runtime.getReg('rsp');
    const rawArgs: number[] = [];
    for (let i = 0; i < maxArgs; i++) {
      if (i < 4) {
        rawArgs.push(runtime.getReg(regArgs[i]!));
      } else {
        // At trap time rsp = caller-rsp - 8 (CALL pushed a return address), so
        // the 5th+ args live at [rsp + 0x28 + (i-4)*8].
        rawArgs.push(runtime.readInt32(rsp + 0x28 + (i - 4) * 8));
      }
    }
    return rawArgs;
  }

  writeTrapReturn(runtime: WasmRuntimeImpl, result: ApiResult): void {
    runtime.setReg('eax', result.returnValue);
    if (result.returnValueHigh !== undefined) {
      runtime.setReg(this.highReturnReg, result.returnValueHigh >>> 0);
    }
  }

  vtableSlotCount(): number {
    return 32;
  }

  comVtableSlotCount(): number {
    return 64;
  }

  gpRegisterNames(): RegName[] {
    return [
      'rax', 'rcx', 'rdx', 'rbx', 'rsp', 'rbp', 'rsi', 'rdi',
      'r8', 'r9', 'r10', 'r11', 'r12', 'r13', 'r14', 'r15',
    ];
  }

  wndClassExOffsets(): WndClassExOffsets {
    return { menuName: 56, name: 64 };
  }

  openFileNameOffsets(): OpenFileNameOffsets {
    return {
      lpstrFilter: 0x18,
      lpstrFile: 0x30,
      nMaxFile: 0x38,
      lpstrFileTitle: 0x40,
      lpstrInitialDir: 0x50,
      lpstrTitle: 0x58,
      nFileOffset: 0x64,
      nFileExtension: 0x66,
    };
  }
}
