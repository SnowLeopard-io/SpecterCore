/**
 * 32-bit (PE32 / i386) architecture backend.
 *
 * Encapsulates every mode-specific policy for a 32-bit guest: the stdcall
 * import stub (`ret <args*4>`), 4-byte pointers, the stdcall WndProc frame,
 * and the vtable/COM/OPENFILENAME/WNDCLASSEXW layouts. The arg-count table
 * (`X86_API_ARG_COUNT`) lives in `pe/mapper.ts` because it is curated together
 * with the import machinery; it is imported here as the single source of truth.
 */

import type { ApiResult } from '@specter-core/contracts';
import type { RegName } from '../jit/ir';
import type { WasmRuntimeImpl } from '../jit/runtime';
import { X86_API_ARG_COUNT } from '../pe/mapper';
import type { ArchBackend, OpenFileNameOffsets, WndClassExOffsets } from './types';

export class X86Backend implements ArchBackend {
  readonly mode = 'x86' as const;
  readonly pointerSize = 4 as const;
  readonly thunkStride = 4 as const;
  readonly ordinalFlag = 0x80000000n;
  readonly supportsSeh = true;
  readonly highReturnReg = 'edx' as const;

  importArgCount(proc: string, module?: string): number {
    if (module) {
      const qualified = X86_API_ARG_COUNT[`${module.toLowerCase()}!${proc.toLowerCase()}`];
      if (qualified !== undefined) return qualified;
    }
    return X86_API_ARG_COUNT[proc.toLowerCase()] ?? 0;
  }

  emitImportStub(index: number, argCount: number): Uint8Array {
    // 32-bit APIs are stdcall: the stub must pop the caller's arguments or the
    // guest stack drifts and the next `ret` pops a garbage address.
    const stubLen = argCount > 0 ? 10 : 8;
    const stub = new Uint8Array(stubLen);
    stub[0] = 0xb8;
    stub[1] = index & 0xff;
    stub[2] = (index >> 8) & 0xff;
    stub[3] = (index >> 16) & 0xff;
    stub[4] = (index >> 24) & 0xff;
    stub[5] = 0xcd;
    stub[6] = 0x2e;
    if (argCount > 0) {
      const popBytes = argCount * 4;
      stub[7] = 0xc2;
      stub[8] = popBytes & 0xff;
      stub[9] = (popBytes >> 8) & 0xff;
    } else {
      stub[7] = 0xc3;
    }
    return stub;
  }

  writePointer(runtime: WasmRuntimeImpl, address: number, value: number): void {
    runtime.writeInt32(address, value | 0);
  }

  readPointer(runtime: WasmRuntimeImpl, address: number): number {
    return runtime.readInt32(address) >>> 0;
  }

  readThunkEntry(runtime: WasmRuntimeImpl, address: number): bigint {
    return BigInt(runtime.readInt32(address) >>> 0);
  }

  writeIatSlot(runtime: WasmRuntimeImpl, address: number, value: number, dllName?: string): void {
    runtime.writeInt32(address, value | 0);
    if (dllName) runtime.writeInt32(address + 4, 0);
  }

  setupStack(runtime: WasmRuntimeImpl, stackTop: number): void {
    // Null return address: a bare `ret` out of the entry point looks like a
    // clean exit (eip -> 0).
    runtime.writeInt32(stackTop - 4, 0);
    runtime.setReg('esp', stackTop - 4);
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
    const esp = runtime.getReg('esp') >>> 0;
    const frame = (esp - 20) >>> 0; // 4 stdcall args + sentinel return addr
    runtime.writeInt32(frame + 0, returnAddr); // sentinel return addr
    runtime.writeInt32(frame + 4, hwnd);
    runtime.writeInt32(frame + 8, message);
    runtime.writeInt32(frame + 12, wParam);
    runtime.writeInt32(frame + 16, lParam);
    runtime.setReg('esp', frame);
    runtime.setEip(wndProc);
  }

  marshalTrapArgs(runtime: WasmRuntimeImpl, maxArgs: number): number[] {
    const esp = runtime.getReg('esp');
    // Read a fixed number of stdcall stack slots (arg0 at [esp+4]). Zero-valued
    // arguments are meaningful (NULL pointers/handles), so every slot is read.
    const rawArgs: number[] = [];
    for (let i = 0; i < maxArgs; i++) {
      rawArgs.push(runtime.readInt32(esp + 4 + i * 4));
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
    return 16;
  }

  comVtableSlotCount(): number {
    return 32;
  }

  gpRegisterNames(): RegName[] {
    return ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi'];
  }

  wndClassExOffsets(): WndClassExOffsets {
    return { menuName: 36, name: 40 };
  }

  openFileNameOffsets(): OpenFileNameOffsets {
    return {
      lpstrFilter: 0x0c,
      lpstrFile: 0x1c,
      nMaxFile: 0x20,
      lpstrFileTitle: 0x24,
      lpstrInitialDir: 0x2c,
      lpstrTitle: 0x30,
      nFileOffset: 0x38,
      nFileExtension: 0x3a,
    };
  }
}
