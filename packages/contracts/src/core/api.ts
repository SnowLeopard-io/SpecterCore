/**
 * L3 Windows API 拦截器契约：IAT 重写后，被拦截的 API 调用在此分派。
 */

import type { WinError } from '../bridge/fs';
import type { FileSystemBridge } from '../bridge/fs';
import type { GdiBridge } from '../bridge/graphics';
import type { AudioBridge } from '../bridge/audio';
import type { WasmUsbHost } from '../bridge/usb';
import type { ProcessManager } from './process';

/**
 * 一次被拦截的 API 调用的现场。
 * 参数以“原始指针参数 + 已编组参数”两种形态提供：
 *  - rawArgs：从 WASM 栈上读取的原始参数（P1 里程碑后由 JIT 填充）；
 *  - marshalled：由参数编组器解析后的高层形态。
 */
export interface ApiCallContext {
  module: string;
  proc: string;
  pid: number;
  tid: number;
  rawArgs: readonly number[];
  marshalled?: Record<string, unknown>;
  /** 捕获 GetLastError 值 */
  lastError: number;
}

export interface ApiResult {
  returnValue: number;
  errorCode: WinError;
  /**
   * Optional high dword for 64-bit return values (e.g. ULONGLONG
   * VerSetConditionMask). When set, the trap dispatcher also writes EDX/RDX,
   * so edx:eax carries the full value.
   */
  returnValueHigh?: number;
}

export interface ApiHandler {
  (ctx: ApiCallContext, host: ApiHost): Promise<ApiResult> | ApiResult;
}

/**
 * API 处理程序可访问的桥接服务（组装自 DI 容器）。
 * 扩展新的 API 即新增 handler 并注入依赖。
 * `memory` 允许 handler 直接读写客户机线性内存（参数编组/返回值编组的基础）。
 */
export interface ApiHost {
  fs: FileSystemBridge;
  gdi: GdiBridge;
  audio: AudioBridge;
  usb: WasmUsbHost;
  process: ProcessManager;
  /** 客户机线性内存访问：按地址读取/写入字节 */
  memory: {
    read(address: number, length: number): Uint8Array;
    write(address: number, data: Uint8Array): void;
  };
}

export interface ApiInterceptor {
  /** 注册指定模块导出函数的拦截处理程序 */
  hook(module: string, proc: string, handler: ApiHandler): void;
  hookBatch(module: string, handlers: Record<string, ApiHandler>): void;
  unHook(module: string, proc: string): boolean;
  getHandler(module: string, proc: string): ApiHandler | null;
  /** 分派一次被拦截的调用 */
  dispatch(ctx: ApiCallContext): Promise<ApiResult>;
  listHooks(): readonly string[];
  setLastError(pid: number, error: WinError): void;
  getLastError(pid: number): number;
}

export type ApiModule = 'kernel32.dll' | 'user32.dll' | 'gdi32.dll' | 'ntdll.dll' | 'winmm.dll';
