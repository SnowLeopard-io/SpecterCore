/**
 * L3 x86 JIT 翻译器与 WASM 运行时契约（P1 里程碑实现）。
 * 本包只定义接口；具体翻译器实现位于 @specter-core/core 的 jit/（当前为 TS 生成
 * WASM 字节码，未来可替换为 wasi-sdk / Emscripten 编译产物，见 wasm/README.md）。
 */

export interface BasicBlock {
  startAddress: number;
  /** x86 机器码 */
  code: Uint8Array;
  successorAddresses: readonly number[];
}

/** Status codes returned by a compiled block function. */
export enum BlockStatus {
  /** Continue: next EIP is stored in the CPU context. */
  Continue = 0,
  /** Return to the dispatcher (INT / syscall trap, design 4.2.4). */
  Trap = 1,
  /** Unsupported instruction or fault. */
  Fault = 2,
  /** Program requested exit. */
  Exit = 3,
}

export interface CompiledBlock {
  address: number;
  /** Executes the block inside the shared WASM memory; returns a BlockStatus. */
  entry: (() => number) | null;
  /** Bytes of x86 machine code this block consumed. */
  size: number;
}

export interface JitStats {
  cacheHits: number;
  cacheMisses: number;
  cacheBytes: number;
  compiledBlocks: number;
  totalCompileMs: number;
}

export interface JitEngine {
  readonly supportedFeatures: readonly string[];
  compile(block: BasicBlock): Promise<CompiledBlock>;
  invalidate(startAddress: number): void;
  clearCache(): void;
  getStats(): JitStats;
}

export interface WasmRuntime {
  memory: WebAssembly.Memory;
  /** 已加载的 WASM 模块（占位） */
  module: WebAssembly.Module | null;
  loadModule(source: Uint8Array | ArrayBuffer): Promise<void>;
  call<T>(fnName: string, ...args: unknown[]): T;
  destroy(): void;
}

export const WASM_PAGE_SIZE = 64 * 1024;
export const DEFAULT_LINEAR_MEMORY = 4 * 1024 * 1024 * 1024; // 4GB 地址空间