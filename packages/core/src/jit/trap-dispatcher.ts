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
import type { ArchBackend } from '../arch/types';
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
    private readonly arch: ArchBackend,
  ) {}

  async handle(vector: number): Promise<void> {
    if (vector !== TRAP_VECTOR) return;
    const index = this.runtime.getReg('eax');
    const stub = this.stubs[index];
    if (!stub) return;
    this.lastCalled = stub;

    const rawArgs = this.arch.marshalTrapArgs(this.runtime, this.maxArgs);

    const result = await this.interceptor.dispatch({
      module: stub.module,
      proc: stub.proc,
      pid: 0,
      tid: 0,
      rawArgs,
      lastError: 0,
    });

    this.arch.writeTrapReturn(this.runtime, result);
  }
}
