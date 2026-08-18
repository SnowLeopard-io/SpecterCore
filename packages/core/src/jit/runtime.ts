/**
 * WASM runtime for the x86 JIT (design doc 4.3.5 / contract `WasmRuntime`).
 *
 * Owns the shared linear memory that holds the guest address space, the CPU
 * context struct, and the mapped PE image. `WasmRuntimeImpl` grows the memory
 * on demand and exposes a small DataView-based register/byte API for the
 * dispatcher and for loading images.
 */

import type { WasmRuntime } from '@bk/contracts';
import { DEFAULT_LINEAR_MEMORY } from '@bk/contracts';
import { CTX_BASE, CTX_SIZE, EFLAGS_OFFSET, EIP_OFFSET, INT_VECTOR_OFFSET, REG_OFFSET } from './cpu';
import type { RegName } from './ir';

const PAGE = 64 * 1024;

export class WasmRuntimeImpl implements WasmRuntime {
  readonly memory: WebAssembly.Memory;
  module: WebAssembly.Module | null = null;

  constructor(initialPages = 512) {
    this.memory = new WebAssembly.Memory({
      initial: initialPages,
      maximum: Math.ceil(DEFAULT_LINEAR_MEMORY / PAGE),
    });
    this.resetCpu();
  }

  async loadModule(source: Uint8Array | ArrayBuffer): Promise<void> {
    this.module = await WebAssembly.compile(source as unknown as BufferSource);
  }

  call<T>(fnName: string, ...args: unknown[]): T {
    if (!this.module) throw new Error('no WASM module loaded');
    const instance = new WebAssembly.Instance(this.module, {});
    const fn = instance.exports[fnName] as (...a: unknown[]) => T;
    if (typeof fn !== 'function') throw new Error(`export ${fnName} is not a function`);
    return fn(...args);
  }

  destroy(): void {
    this.module = null;
  }

  // -------------------------------------------------------------------------
  // guest state access
  // -------------------------------------------------------------------------

  /** Fresh DataView — created per access because grow() invalidates buffers. */
  private view(): DataView {
    return new DataView(this.memory.buffer);
  }

  resetCpu(): void {
    const view = this.view();
    for (let i = 0; i < CTX_SIZE; i++) view.setUint8(CTX_BASE + i, 0);
  }

  getReg(reg: RegName): number {
    return this.view().getInt32(CTX_BASE + (REG_OFFSET[reg] ?? 0), true);
  }

  setReg(reg: RegName, value: number): void {
    this.view().setInt32(CTX_BASE + (REG_OFFSET[reg] ?? 0), value, true);
  }

  /** Full 64-bit register value (low 32 bits are zero-extended on 32-bit sets). */
  getReg64(reg: RegName): number {
    return Number(this.view().getBigInt64(CTX_BASE + (REG_OFFSET[reg] ?? 0), true));
  }

  setReg64(reg: RegName, value: number): void {
    this.view().setBigInt64(CTX_BASE + (REG_OFFSET[reg] ?? 0), BigInt(Math.trunc(value)), true);
  }

  getEip(): number {
    return this.view().getInt32(CTX_BASE + EIP_OFFSET, true);
  }

  setEip(value: number): void {
    this.view().setInt32(CTX_BASE + EIP_OFFSET, value, true);
  }

  getEflags(): number {
    return this.view().getInt32(CTX_BASE + EFLAGS_OFFSET, true);
  }

  setEflags(value: number): void {
    this.view().setInt32(CTX_BASE + EFLAGS_OFFSET, value, true);
  }

  getIntVector(): number {
    return this.view().getInt32(CTX_BASE + INT_VECTOR_OFFSET, true);
  }

  /** Reads `length` bytes at `address` (clamped to the current memory size). */
  readBytes(address: number, length: number): Uint8Array {
    if (address < 0 || address >= this.memory.buffer.byteLength) return new Uint8Array(0);
    const n = Math.min(length, this.memory.buffer.byteLength - address);
    return new Uint8Array(this.memory.buffer, address, n);
  }

  /** Writes bytes, growing the memory if necessary. */
  writeBytes(address: number, data: Uint8Array): void {
    if (data.byteLength === 0) return;
    this.ensure(address + data.byteLength);
    new Uint8Array(this.memory.buffer, address, data.byteLength).set(data);
  }

  readInt32(address: number): number {
    this.ensure(address + 4);
    return this.view().getInt32(address, true);
  }

  writeInt32(address: number, value: number): void {
    this.ensure(address + 4);
    this.view().setInt32(address, value, true);
  }

  /** Grows the linear memory so `end` fits (rounded up to pages). */
  ensure(end: number): void {
    const needed = Math.ceil(end / PAGE);
    const current = this.memory.buffer.byteLength / PAGE;
    if (needed > current) this.memory.grow(needed - current);
  }
}
