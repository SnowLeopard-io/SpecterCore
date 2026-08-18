import type {
  BulkTransferResult,
  ControlTransferSetup,
  UsbDeviceInfo,
  UsbHostAdapter,
  UsbRequestFilter,
  WasmUsbHost,
} from '@bk/contracts';
import { nextId } from '@bk/shared';

/**
 * WASI-USB host bridge: maps the L3-facing handle-based API onto the
 * L1 WebUSB adapter. Each open device gets a numeric handle (wasi_usb_device_open).
 */
export class WasmUsbHostBridge implements WasmUsbHost {
  private readonly handles = new Map<number, Awaited<ReturnType<UsbHostAdapter['open']>>>();
  private readonly infoByHandle = new Map<number, UsbDeviceInfo>();

  constructor(private readonly adapter: UsbHostAdapter) {}

  get available(): boolean {
    return this.adapter.available;
  }

  async deviceList(): Promise<UsbDeviceInfo[]> {
    if (!this.adapter.available) return [];
    return this.adapter.listDevices();
  }

  async deviceOpen(info: UsbDeviceInfo): Promise<number> {
    const handle = await this.adapter.open(info);
    const id = nextId();
    this.handles.set(id, handle);
    this.infoByHandle.set(id, info);
    return id;
  }

  private requireHandle(handle: number): Awaited<ReturnType<UsbHostAdapter['open']>> {
    const device = this.handles.get(handle);
    if (!device) throw new Error(`Invalid USB handle: ${handle}`);
    return device;
  }

  async controlTransfer(handle: number, setup: ControlTransferSetup): Promise<Uint8Array> {
    return this.requireHandle(handle).controlTransfer(setup);
  }

  async bulkTransfer(
    handle: number,
    endpoint: number,
    data: Uint8Array,
    timeoutMs?: number,
  ): Promise<BulkTransferResult> {
    return this.requireHandle(handle).bulkTransfer(endpoint, data, timeoutMs);
  }

  async interruptTransfer(
    handle: number,
    endpoint: number,
    data: Uint8Array,
    timeoutMs?: number,
  ): Promise<BulkTransferResult> {
    return this.requireHandle(handle).interruptTransfer(endpoint, data, timeoutMs);
  }

  async claimInterface(handle: number, interfaceNumber: number): Promise<void> {
    await this.requireHandle(handle).claimInterface(interfaceNumber);
  }

  async releaseInterface(handle: number, interfaceNumber: number): Promise<void> {
    await this.requireHandle(handle).releaseInterface(interfaceNumber);
  }

  async deviceClose(handle: number): Promise<void> {
    const device = this.handles.get(handle);
    if (!device) return;
    await device.close();
    this.handles.delete(handle);
    this.infoByHandle.delete(handle);
  }

  async requestDevice(filters?: UsbRequestFilter[]): Promise<UsbDeviceInfo | null> {
    if (!this.adapter.available) return null;
    const handle = await this.adapter.requestDevice(filters);
    return handle?.info ?? null;
  }

  async releaseAll(): Promise<void> {
    const handles = [...this.handles.keys()];
    for (const handle of handles) {
      await this.deviceClose(handle);
    }
  }
}