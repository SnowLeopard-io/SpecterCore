/**
 * L3 Windows 兼容核心：进程 / 线程 / 内存 / 内核对象。
 */

import type { WinError } from '../bridge/fs';

// ---------------------------------------------------------------------------
// 进程
// ---------------------------------------------------------------------------

export type ProcessState = 'running' | 'suspended' | 'exited';

export interface ProcessInfo {
  pid: number;
  name: string;
  state: ProcessState;
  imagePath: string;
  args: readonly string[];
  memoryBytes: number;
  threadCount: number;
  startTime: number;
}

export interface ProcessHandle {
  pid: number;
}

export interface CreateProcessOptions {
  suspended?: boolean;
  cwd?: string;
  args?: readonly string[];
  env?: Record<string, string>;
  /** 独立虚拟硬盘（默认与系统盘隔离） */
  diskName?: string;
}

// ---------------------------------------------------------------------------
// 线程
// ---------------------------------------------------------------------------

export type ThreadState = 'running' | 'suspended' | 'waiting' | 'exited';

export interface ThreadInfo {
  tid: number;
  pid: number;
  state: ThreadState;
  stackBytes: number;
  entryPoint: number;
}

// ---------------------------------------------------------------------------
// 内存
// ---------------------------------------------------------------------------

export enum MemoryProtection {
  PAGE_NOACCESS = 0x01,
  PAGE_READONLY = 0x02,
  PAGE_READWRITE = 0x04,
  PAGE_WRITECOPY = 0x08,
  PAGE_EXECUTE = 0x10,
  PAGE_EXECUTE_READ = 0x20,
  PAGE_EXECUTE_READWRITE = 0x40,
  PAGE_EXECUTE_WRITECOPY = 0x80,
}

export enum AllocationType {
  MEM_COMMIT = 0x1000,
  MEM_RESERVE = 0x2000,
  MEM_RELEASE = 0x8000,
  MEM_RESET = 0x80000,
}

export enum MemoryState {
  MEM_COMMITTED = 0x1000,
  MEM_RESERVED = 0x2000,
  MEM_FREE = 0x10000,
}

export interface MemoryRegion {
  baseAddress: number;
  size: number;
  protection: MemoryProtection;
  state: MemoryState;
  /** 是否已提交物理页（预分配） */
  committed: boolean;
}

// ---------------------------------------------------------------------------
// 同步对象
// ---------------------------------------------------------------------------

export type SyncObjectKind = 'mutex' | 'event' | 'semaphore';

export interface KernelObject<T = unknown> {
  handle: number;
  kind: SyncObjectKind;
  name?: string;
  refCount: number;
  data: T;
}

export interface MutexData {
  ownerPid: number | null;
  recursion: number;
}

export interface EventData {
  manualReset: boolean;
  signaled: boolean;
}

export interface SemaphoreData {
  count: number;
  maxCount: number;
}

export type WaitResult = 'object' | 'timeout' | 'abandoned' | 'failed';

// ---------------------------------------------------------------------------
// 管理器接口
// ---------------------------------------------------------------------------

export interface KernelObjectManager {
  createObject<T>(kind: SyncObjectKind, name: string | undefined, data: T): number;
  lookup(handle: number): KernelObject<unknown> | null;
  retain(handle: number): boolean;
  release(handle: number): boolean;
  /** DuplicateHandle：跨进程共享 */
  duplicate(handle: number, targetProcessPid: number): number;
  delete(handle: number): boolean;
  getNamed(name: string): KernelObject<unknown> | null;
  putNamed(obj: KernelObject<unknown>): void;
  list(): KernelObject<unknown>[];
}

export interface MemoryManager {
  virtualAlloc(size: number, allocationType: number, protection: number): number;
  virtualFree(baseAddress: number, size: number, freeType: number): boolean;
  virtualProtect(baseAddress: number, size: number, protection: number): number;
  queryRegions(): MemoryRegion[];
  heapCreate(): number;
  heapAlloc(heap: number, size: number): number;
  heapFree(heap: number, address: number): boolean;
  /** 从 WASM 线性内存读取（占位：由 JIT 提供） */
  read(address: number, length: number): Uint8Array;
  write(address: number, data: Uint8Array): void;
}

export interface ProcessManager {
  createProcess(imagePath: string, options?: CreateProcessOptions): Promise<ProcessHandle>;
  terminateProcess(pid: number, exitCode?: number): Promise<void>;
  getProcess(pid: number): ProcessInfo | null;
  listProcesses(): ProcessInfo[];
  createThread(pid: number, entryPoint: number, arg?: number): Promise<number>;
  suspendThread(tid: number): Promise<void>;
  resumeThread(tid: number): Promise<void>;
  terminateThread(tid: number, exitCode?: number): Promise<void>;
  /** 简单轮转调度（骨架） */
  tick(): void;
  // ---- 同步对象（转发至 KernelObjectManager） ----
  createMutex(pid: number, name?: string): Promise<number>;
  createEvent(pid: number, manualReset: boolean, initialState: boolean, name?: string): Promise<number>;
  createSemaphore(pid: number, initialCount: number, maxCount: number, name?: string): Promise<number>;
  waitForSingleObject(handle: number, timeoutMs?: number): Promise<WaitResult>;
  releaseMutex(handle: number): Promise<WinError>;
  setEvent(handle: number): Promise<void>;
  resetEvent(handle: number): Promise<void>;
  releaseSemaphore(handle: number, releaseCount: number): Promise<WinError>;
  closeObject(handle: number): Promise<void>;
}