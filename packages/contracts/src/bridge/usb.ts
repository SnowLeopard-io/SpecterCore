/**
 * L2 USB 桥接契约：WASI-USB Host 接口。
 * 提供对 WASM 侧（L3）暴露的 USB 直通能力，底层由 L1 WebUSB 适配器实现。
 */

import type {
  BulkTransferResult,
  ControlTransferSetup,
  UsbDeviceInfo,
  UsbRequestFilter,
} from '../host';

export interface WasmUsbHost {
  /** wasi_usb_device_list */
  deviceList(): Promise<UsbDeviceInfo[]>;
  /** wasi_usb_device_open：返回设备句柄 id */
  deviceOpen(info: UsbDeviceInfo): Promise<number>;
  /** wasi_usb_control_transfer */
  controlTransfer(handle: number, setup: ControlTransferSetup): Promise<Uint8Array>;
  /** wasi_usb_bulk_transfer */
  bulkTransfer(handle: number, endpoint: number, data: Uint8Array, timeoutMs?: number): Promise<BulkTransferResult>;
  /** wasi_usb_interrupt_transfer */
  interruptTransfer(handle: number, endpoint: number, data: Uint8Array, timeoutMs?: number): Promise<BulkTransferResult>;
  claimInterface(handle: number, interfaceNumber: number): Promise<void>;
  releaseInterface(handle: number, interfaceNumber: number): Promise<void>;
  /** wasi_usb_device_close */
  deviceClose(handle: number): Promise<void>;
  /** 用户授权弹窗入口 */
  requestDevice(filters?: UsbRequestFilter[]): Promise<UsbDeviceInfo | null>;
}