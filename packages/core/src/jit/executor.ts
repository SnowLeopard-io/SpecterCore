/**
 * x86 block dispatcher / executor (design doc 4.1.6).
 *
 * Drives the JIT: reads x86 bytes at the current EIP, compiles (or reuses) the
 * basic block, runs it, and reacts to trap/fault statuses. On `Trap` the trap
 * handler (typically the API interceptor, design 4.2.4) is invoked with the
 * INT vector; it may rewrite EIP/registers before execution resumes.
 */

import type { JitEngine } from '@specter-core/contracts';
import { BlockStatus } from '@specter-core/contracts';
import { STATUS_FAULT, STATUS_TRAP } from './cpu';
import { IncompleteBlockError } from './engine';
import type { WasmRuntimeImpl } from './runtime';

export interface TrapHandler {
  handle(vector: number, runtime: WasmRuntimeImpl): void | Promise<void>;
}

export interface ExecutorResult {
  status: 'exit' | 'fault' | 'trap' | 'limit';
  eip: number;
  error?: unknown;
}

export interface ExecutorOptions {
  /** Max blocks executed before bailing (guards against endless loops). */
  maxSteps?: number;
  /** Bytes of x86 code fetched per block compile. */
  readAhead?: number;
  /**
   * Optional per-block callback (eip just before executing). Diagnostic use —
   * lets a runner trace the exact path a guest takes, e.g. to explain why a
   * process returned without calling ExitProcess.
   */
  onStep?: (eip: number, runtime: WasmRuntimeImpl) => void;
}

const DEFAULT_MAX_STEPS = 50_000_000;
const DEFAULT_READ_AHEAD = 1024;

export class Executor {
  private readonly maxSteps: number;
  private readonly readAhead: number;
  private readonly options: ExecutorOptions;

  constructor(
    private readonly runtime: WasmRuntimeImpl,
    private readonly jit: JitEngine,
    private readonly traps?: TrapHandler,
    options: ExecutorOptions = {},
  ) {
    this.options = options;
    this.maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
    this.readAhead = options.readAhead ?? DEFAULT_READ_AHEAD;
  }

  async run(entryPoint: number): Promise<ExecutorResult> {
    this.runtime.setEip(entryPoint);
    for (let step = 0; step < this.maxSteps; step++) {
      const address = this.runtime.getEip();
      if (address === 0 || address === 0xcccccccc) {
        return { status: 'exit', eip: address };
      }
      this.options?.onStep?.(address, this.runtime);
      const code = this.runtime.readBytes(address, this.readAhead);
      if (code.byteLength === 0) {
        return { status: 'exit', eip: address };
      }

      let block;
      try {
        block = await this.jit.compile({ startAddress: address, code, successorAddresses: [] });
      } catch (err) {
        return { status: 'fault', eip: address, error: err };
      }

      let status: number;
      try {
        status = block.entry!();
      } catch (err) {
        return { status: 'fault', eip: address, error: err };
      }

      if (status === STATUS_TRAP || status === BlockStatus.Trap) {
        const vector = this.runtime.getIntVector();
        if (this.traps) {
          await this.traps.handle(vector, this.runtime);
        }
        if (this.runtime.getEip() === 0) return { status: 'trap', eip: 0 };
      } else if (status === STATUS_FAULT || status === BlockStatus.Fault) {
        return { status: 'fault', eip: address };
      } else if (status === BlockStatus.Exit) {
        return { status: 'exit', eip: this.runtime.getEip() };
      } else if (status !== 0) {
        return { status: 'fault', eip: address, error: new Error(`unknown status ${status}`) };
      }
    }
    return { status: 'limit', eip: this.runtime.getEip() };
  }
}

export { IncompleteBlockError };
