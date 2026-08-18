import type { Dispose } from './kernel';

/**
 * L1 浏览器宿主层契约。
 * 这些接口描述浏览器原生能力的通用形态，便于在测试/Node 环境中注入内存实现
 * （Ports & Adapters 模式：契约即端口，浏览器实现与测试实现都是适配器）。
 */

// ---------------------------------------------------------------------------
// 文件系统（OPFS / 虚拟硬盘）
// ---------------------------------------------------------------------------

export type DirEntryKind = 'file' | 'directory' | 'symlink';

export interface DirEntry {
  name: string;
  kind: DirEntryKind;
  size: number;
  modified: number;
}

export type FileStat = DirEntry;

export type FileOpenMode = 'read' | 'write' | 'readwrite' | 'create' | 'append';

export interface OpenedFile {
  readonly path: string;
  readonly mode: FileOpenMode;
  /** 随机读取 */
  read(offset: number, length: number): Promise<Uint8Array>;
  /** 随机写入，返回实际写入字节数 */
  write(offset: number, data: Uint8Array): Promise<number>;
  /** 截断/扩展到指定字节长度（对应 Win32 SetEndOfFile） */
  truncate(size: number): Promise<void>;
  size(): Promise<number>;
  close(): Promise<void>;
}

/**
 * 虚拟硬盘抽象。L1 提供 OPFS 实现，测试环境提供内存实现。
 * 每个 Windows 应用/游戏拥有独立的 FileStore 实例（隔离的虚拟硬盘）。
 */
export interface FileStore {
  readonly name: string;
  /** 当前容量（字节），可配置默认 2GB */
  capacity(): Promise<number>;
  /** 已用空间（字节） */
  usedBytes(): Promise<number>;
  openFile(path: string, mode: FileOpenMode): Promise<OpenedFile>;
  createDirectory(path: string): Promise<void>;
  removeDirectory(path: string): Promise<void>;
  deleteFile(path: string): Promise<void>;
  listDirectory(path: string): Promise<DirEntry[]>;
  stat(path: string): Promise<FileStat | null>;
  move(from: string, to: string): Promise<void>;
  /** 扩容（只允许增大） */
  resize(capacity: number): Promise<void>;
  /** 格式化/清空虚拟硬盘 */
  format(): Promise<void>;
}

// ---------------------------------------------------------------------------
// USB（WebUSB 适配器）
// ---------------------------------------------------------------------------

export interface UsbDeviceInfo {
  deviceId: number;
  vendorId: number;
  productId: number;
  name: string;
  serialNumber?: string;
}

export interface UsbEndpoint {
  endpointNumber: number;
  direction: 'in' | 'out';
  type: 'control' | 'bulk' | 'interrupt' | 'isochronous';
  maxPacketSize: number;
}

export interface UsbInterfaceInfo {
  interfaceNumber: number;
  alternate: number;
  classCode: number;
  subclass: number;
  protocol: number;
  endpoints: UsbEndpoint[];
}

export interface UsbConfigurationInfo {
  configurationValue: number;
  interfaces: UsbInterfaceInfo[];
}

export interface ControlTransferSetup {
  requestType: number;
  recipient: number;
  request: number;
  value: number;
  index: number;
  data?: Uint8Array;
}

export type TransferStatus = 'ok' | 'stall' | 'babble' | 'timeout';

export interface BulkTransferResult {
  status: TransferStatus;
  /** OUT 端点：实际写入字节数；IN 端点：0 */
  bytesWritten: number;
  /** IN 端点：读取的数据；OUT 端点：空 */
  data?: Uint8Array;
}

export interface UsbDeviceHandle {
  readonly info: UsbDeviceInfo;
  controlTransfer(setup: ControlTransferSetup): Promise<Uint8Array>;
  bulkTransfer(endpoint: number, data: Uint8Array, timeoutMs?: number): Promise<BulkTransferResult>;
  interruptTransfer(endpoint: number, data: Uint8Array, timeoutMs?: number): Promise<BulkTransferResult>;
  claimInterface(interfaceNumber: number): Promise<void>;
  releaseInterface(interfaceNumber: number): Promise<void>;
  close(): Promise<void>;
}

export interface UsbRequestFilter {
  vendorId?: number;
  productId?: number;
  classCode?: number;
  subclassCode?: number;
  protocolCode?: number;
  serialNumber?: string;
}

/** L1 USB 宿主适配器：包装 navigator.usb */
export interface UsbHostAdapter {
  readonly available: boolean;
  listDevices(): Promise<UsbDeviceInfo[]>;
  requestDevice(filters?: UsbRequestFilter[]): Promise<UsbDeviceHandle | null>;
  open(info: UsbDeviceInfo): Promise<UsbDeviceHandle>;
  onConnect(listener: (device: UsbDeviceInfo) => void): Dispose;
  onDisconnect(listener: (device: UsbDeviceInfo) => void): Dispose;
}

// ---------------------------------------------------------------------------
// GPU（WebGPU 适配器）
// ---------------------------------------------------------------------------

export interface GpuAdapterInfo {
  vendor: string;
  architecture: string;
  device: string;
  description: string;
  limits: {
    maxTextureDimension2D: number;
    maxBufferSize: number;
  };
}

export interface GpuAdapter {
  readonly available: boolean;
  readonly adapterInfo: GpuAdapterInfo | null;
  init(): Promise<void>;
  /** 未来：原生 GPU 命令缓冲提交 */
  submit(commandBuffer: unknown): void;
  onFrame(listener: (frame: number) => void): Dispose;
  destroy(): Promise<void>;
}

// ---------------------------------------------------------------------------
// 音频（AudioWorklet 适配器）
// ---------------------------------------------------------------------------

export interface AudioHostConfig {
  sampleRate?: number;
  channels?: number;
  latencyHint?: 'balanced' | 'interactive' | 'playback';
}

export interface AudioPcm {
  /** 交错 PCM 样本 */
  data: Float32Array;
  sampleRate: number;
  channels: number;
}

export interface AudioHostAdapter {
  readonly available: boolean;
  readonly sampleRate: number;
  readonly outputLatencyMs: number;
  init(config?: AudioHostConfig): Promise<void>;
  play(buffer: AudioPcm): Promise<void>;
  setVolume(channel: string | null, volume: number): void;
  destroy(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Worker 池（进程隔离）
// ---------------------------------------------------------------------------

export interface WorkerMessage {
  /** 请求 ID，用于关联回复 */
  id?: number;
  type: string;
  payload?: unknown;
}

export interface WorkerReply {
  id?: number;
  ok: boolean;
  payload?: unknown;
  error?: string;
}

export interface WorkerHandle {
  readonly id: number;
  readonly state: 'idle' | 'busy' | 'terminated';
  post(message: WorkerMessage): Promise<WorkerReply>;
  onMessage(listener: (message: WorkerMessage) => void): Dispose;
  terminate(): Promise<void>;
}

export interface WorkerPoolOptions {
  maxWorkers?: number;
  workerUrl?: string | URL;
}

/**
 * 进程隔离池：每个 Windows 进程对应一个 Web Worker。
 * 通过 SharedArrayBuffer 可实现跨 Worker 共享内存通信（设计文档 1.6）。
 */
export interface WorkerPool {
  readonly available: boolean;
  readonly maxWorkers: number;
  readonly activeWorkers: number;
  spawn(): Promise<WorkerHandle>;
  terminateAll(): Promise<void>;
}

// ---------------------------------------------------------------------------
// 环境能力探测
// ---------------------------------------------------------------------------

export interface BrowserCapabilities {
  secureContext: boolean;
  crossOriginIsolated: boolean;
  opfs: boolean;
  webgpu: boolean;
  webusb: boolean;
  audioWorklet: boolean;
  webWorker: boolean;
  sharedArrayBuffer: boolean;
}

export interface EnvironmentProbe {
  capabilities: BrowserCapabilities;
  missing: readonly string[];
  assertSatisfied(): void;
}