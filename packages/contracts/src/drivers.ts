/**
 * L4 设备驱动抽象层契约：USB 驱动模型（IRP/URB）+ 图形显示驱动。
 */

import type { Dispose } from './kernel';
import type { UsbDeviceInfo } from './host';
import type { WinError } from './bridge/fs';

// ---------------------------------------------------------------------------
// USB 驱动模型（IRP / URB）
// ---------------------------------------------------------------------------

export enum UrbFunction {
  CONTROL_TRANSFER = 0x0001,
  BULK_OR_INTERRUPT_TRANSFER = 0x0002,
  GET_DESCRIPTOR = 0x0003,
  SET_CONFIGURATION = 0x0004,
  SELECT_INTERFACE = 0x0005,
}

export interface Urb {
  function: UrbFunction;
  timeoutMs?: number;
  endpoint?: number;
  setup?: {
    requestType: number;
    request: number;
    value: number;
    index: number;
  };
  data?: Uint8Array;
}

export enum IrpMajorFunction {
  IRP_MJ_CREATE = 0x00,
  IRP_MJ_READ = 0x03,
  IRP_MJ_WRITE = 0x04,
  IRP_MJ_DEVICE_CONTROL = 0x0e,
  IRP_MJ_INTERNAL_DEVICE_CONTROL = 0x0f,
  IRP_MJ_PNP = 0x1b,
}

export interface Irp {
  majorFunction: IrpMajorFunction;
  minorFunction?: number;
  device: UsbDeviceInfo;
  urb?: Urb;
  buffer?: Uint8Array;
  length: number;
  ioStatus?: number;
}

export interface IrpResult {
  status: 'success' | 'pending' | 'error';
  errorCode: WinError;
  data?: Uint8Array;
}

/** USB 类驱动：如 HID（classCode=3）、大容量存储（classCode=8）、CDC（classCode=2） */
export interface UsbDriver {
  readonly id: string;
  readonly name: string;
  readonly classCode?: number;
  readonly subclassCode?: number;
  readonly vendorId?: number;
  readonly productId?: number;
  matches(device: UsbDeviceInfo): boolean;
  attach(device: UsbDeviceInfo): Promise<void>;
  detach(): Promise<void>;
  handleIrp(irp: Irp): Promise<IrpResult>;
  dispose(): void;
}

export interface DriverRegistry {
  register(driver: UsbDriver): void;
  unregister(id: string): boolean;
  findFor(device: UsbDeviceInfo): UsbDriver | null;
  list(): UsbDriver[];
}

export interface PnPManager {
  notifyDeviceAdded(device: UsbDeviceInfo): Promise<void>;
  notifyDeviceRemoved(device: UsbDeviceInfo): Promise<void>;
  attachBinder(binder: (device: UsbDeviceInfo) => UsbDriver | null): void;
  dispose(): void;
}

// ---------------------------------------------------------------------------
// 图形显示驱动（DXGKRNL miniport）
// ---------------------------------------------------------------------------

export interface DisplayMode {
  width: number;
  height: number;
  refreshRate: number;
  colorDepth: number;
}

export interface DisplayDriver {
  readonly id: string;
  readonly name: string;
  enumerateModes(): Promise<DisplayMode[]>;
  setMode(mode: DisplayMode): Promise<void>;
  getCurrentMode(): DisplayMode;
  /** 帧回调（VSync） */
  onVsync(listener: (frame: number) => void): Dispose;
  /** 呈现一帧（未来接入 WebGPU 交换链） */
  present(frameBuffer: Uint8Array): Promise<void>;
  dispose(): void;
}