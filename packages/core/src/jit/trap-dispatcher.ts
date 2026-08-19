/**
 * API trap dispatcher (design doc 4.2.4/4.2.5/4.2.6).
 *
 * Bridges the JIT's `int 0x2E` trap back into the TypeScript `ApiInterceptor`.
 * The stub injected by `pe/mapper.ts` loads its API index into EAX before
 * trapping; this dispatcher reads EAX, resolves the import, marshals a bounded
 * set of stack arguments, awaits the handler and writes the return value back
 * into EAX (design 4.2.6).
 */

import type { ApiInterceptor } from '@specter-core/contracts';
import type { ApiStub } from '../pe/mapper';
import type { TrapHandler } from './executor';
import type { WasmRuntimeImpl } from './runtime';

const TRAP_VECTOR = 0x2e;

export class ApiTrapDispatcher implements TrapHandler {
  /** The stub resolved by the most recent trap (null before the first one). */
  lastCalled: ApiStub | null = null;

  constructor(
    private readonly interceptor: ApiInterceptor,
    private readonly runtime: WasmRuntimeImpl,
    private readonly stubs: readonly ApiStub[],
    private readonly maxArgs = 8,
    private readonly mode: 'x86' | 'x64' = 'x86',
  ) {}

  async handle(vector: number): Promise<void> {
    if (vector !== TRAP_VECTOR) return;
    const index = this.runtime.getReg('eax');
    const stub = this.stubs[index];
    if (!stub) return;
    this.lastCalled = stub;

    const rawArgs: number[] = [];
    if (this.mode === 'x64') {
      // x86-64 calling convention: rcx, rdx, r8, r9, then the stack.
      // At trap time rsp = caller-rsp - 8 (the CALL pushed a return address),
      // so the 5th+ args live at [rsp + 0x28 + (i-4)*8].
      const regArgs = ['rcx', 'rdx', 'r8', 'r9'] as const;
      const rsp = this.runtime.getReg('rsp');
      for (let i = 0; i < this.maxArgs; i++) {
        if (i < 4) {
          rawArgs.push(this.runtime.getReg(regArgs[i] as 'rcx' | 'rdx' | 'r8' | 'r9'));
        } else {
          rawArgs.push(this.runtime.readInt32(rsp + 0x28 + (i - 4) * 8));
        }
      }
    } else {
      const esp = this.runtime.getReg('esp');
      // Read a fixed number of stdcall stack slots (arg0 at [esp+4], design 4.2.5).
      // Zero-valued arguments are meaningful (NULL pointers/handles), so every
      // slot is read; handlers index the ones they need.
      for (let i = 0; i < this.maxArgs; i++) {
        rawArgs.push(this.runtime.readInt32(esp + 4 + i * 4));
      }
    }

    const result = await this.interceptor.dispatch({
      module: stub.module,
      proc: stub.proc,
      pid: 0,
      tid: 0,
      rawArgs,
      lastError: 0,
    });

    this.runtime.setReg('eax', result.returnValue);
    if (result.returnValueHigh !== undefined) {
      // 64-bit return (edx:eax / rdx:rax)
      this.runtime.setReg(this.mode === 'x64' ? 'rdx' : 'edx', result.returnValueHigh >>> 0);
    }
  }
}
