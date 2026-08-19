import type {
  BulkTransferResult,
  ControlTransferSetup,
  Dispose,
  UsbDeviceHandle,
  UsbDeviceInfo,
  UsbHostAdapter,
  UsbRequestFilter,
} from '@specter-core/contracts';
import { toArrayBufferView } from '@specter-core/shared';

/**
 * WebUSB 宿主适配器：包装 navigator.usb。
 * 不模拟 USB 控制器，而是直通真实设备（设计文档 3.4）。
 */

declare global {
  interface Navigator {
    usb?: Usb;
  }
}

interface UsbEndpointRaw {
  endpointNumber: number;
  direction: 'in' | 'out';
  type: 'bulk' | 'control' | 'interrupt' | 'isochronous';
  packetSize: number;
}

interface UsbInterfaceRaw {
  interfaceNumber: number;
  alternate: number;
  classCode: number;
  subclassCode: number;
  protocolCode: number;
  endpoints: UsbEndpointRaw[];
}

interface UsbConfigurationRaw {
  configurationValue: number;
  interfaces: UsbInterfaceRaw[];
}

interface UsbDeviceRaw {
  deviceId: number;
  vendorId: number;
  productId: number;
  productName?: string;
  serialNumber?: string;
  configuration?: UsbConfigurationRaw | null;
  open(): Promise<void>;
  close(): Promise<void>;
  claimInterface(index: number): Promise<void>;
  releaseInterface(index: number): Promise<void>;
  selectConfiguration(index: number): Promise<void>;
  controlTransferIn(
    setup: { requestType: string; recipient: string; request: number; value: number; index: number },
    length: number,
  ): Promise<{ status: string; data?: DataView }>;
  controlTransferOut(
    setup: { requestType: string; recipient: string; request: number; value: number; index: number },
    data?: BufferSource,
  ): Promise<{ status: string; bytesWritten: number }>;
  transferIn(
    endpointNumber: number,
    length: number,
    options?: { timeout?: number },
  ): Promise<{ status: string; data?: DataView }>;
  transferOut(
    endpointNumber: number,
    data: BufferSource,
    options?: { timeout?: number },
  ): Promise<{ status: string; bytesWritten: number }>;
}

interface Usb {
  getDevices(): Promise<UsbDeviceRaw[]>;
  requestDevice(options: { filters: UsbRequestFilter[] }): Promise<UsbDeviceRaw>;
  addEventListener(type: 'connect' | 'disconnect', listener: (event: { device: UsbDeviceRaw }) => void): void;
  removeEventListener(type: 'connect' | 'disconnect', listener: (event: { device: UsbDeviceRaw }) => void): void;
}

const DIRECTION: Record<string, 'in' | 'out'> = { in: 'in', out: 'out' };

function toInfo(raw: UsbDeviceRaw): UsbDeviceInfo {
  return {
    deviceId: raw.deviceId,
    vendorId: raw.vendorId,
    productId: raw.productId,
    name: raw.productName ?? `USB Device (${raw.vendorId.toString(16)}:${raw.productId.toString(16)})`,
    serialNumber: raw.serialNumber,
  };
}

class WebUsbDeviceHandle implements UsbDeviceHandle {
  readonly info: UsbDeviceInfo;
  private opened = false;

  constructor(private readonly raw: UsbDeviceRaw) {
    this.info = toInfo(raw);
  }

  async controlTransfer(setup: ControlTransferSetup): Promise<Uint8Array> {
    const rt = setup.requestType ?? 0;
    const requestType = (rt & 0x60) === 0x00 ? 'standard' : (rt & 0x60) === 0x20 ? 'vendor' : 'class';
    const recipientRaw = rt & 0x03;
    const recipient =
      recipientRaw === 0x00 ? 'device' : recipientRaw === 0x01 ? 'interface' : 'endpoint';
    const inLength = setup.data?.byteLength ?? 64;
    if (setup.data) {
      const out = await this.raw.controlTransferOut(
        { requestType, recipient, request: setup.request, value: setup.value, index: setup.index },
        toArrayBufferView(setup.data),
      );
      if (out.status !== 'ok') throw new Error(`controlTransferOut failed: ${out.status}`);
      return setup.data;
    }
    const inResult = await this.raw.controlTransferIn(
      { requestType, recipient, request: setup.request, value: setup.value, index: setup.index },
      inLength,
    );
    if (inResult.status !== 'ok') throw new Error(`controlTransferIn failed: ${inResult.status}`);
    const raw = inResult.data;
    return new Uint8Array(raw ? raw.buffer : new ArrayBuffer(0));
  }

  async bulkTransfer(endpoint: number, data: Uint8Array, timeoutMs?: number): Promise<BulkTransferResult> {
    const isIn = endpoint & 0x80;
    const ep = endpoint & 0x0f;
    if (isIn) {
      const result = await this.raw.transferIn(
        ep,
        data.byteLength || 4096,
        timeoutMs !== undefined ? { timeout: timeoutMs } : undefined,
      );
      return {
        status: this.mapStatus(result.status),
        bytesWritten: 0,
        data: result.data ? new Uint8Array(result.data.buffer) : undefined,
      };
    }
    const result = await this.raw.transferOut(
      ep,
      toArrayBufferView(data),
      timeoutMs !== undefined ? { timeout: timeoutMs } : undefined,
    );
    return { status: this.mapStatus(result.status), bytesWritten: result.bytesWritten };
  }

  async interruptTransfer(endpoint: number, data: Uint8Array, timeoutMs?: number): Promise<BulkTransferResult> {
    return this.bulkTransfer(endpoint, data, timeoutMs);
  }

  async claimInterface(interfaceNumber: number): Promise<void> {
    await this.raw.claimInterface(interfaceNumber);
  }

  async releaseInterface(interfaceNumber: number): Promise<void> {
    await this.raw.releaseInterface(interfaceNumber);
  }

  async close(): Promise<void> {
    if (this.opened) {
      await this.raw.close();
      this.opened = false;
    }
  }

  private mapStatus(status: string): 'ok' | 'stall' | 'babble' | 'timeout' {
    switch (status) {
      case 'ok':
        return 'ok';
      case 'stall':
        return 'stall';
      case 'babble':
        return 'babble';
      default:
        return 'timeout';
    }
  }
}

export class WebUsbAdapter implements UsbHostAdapter {
  readonly available = typeof navigator !== 'undefined' && Boolean(navigator.usb);

  private get usb(): Usb {
    if (!navigator.usb) throw new Error('WebUSB is not available (requires HTTPS)');
    return navigator.usb;
  }

  async listDevices(): Promise<UsbDeviceInfo[]> {
    const devices = await this.usb.getDevices();
    return devices.map(toInfo);
  }

  async requestDevice(filters?: UsbRequestFilter[]): Promise<UsbDeviceHandle | null> {
    const device = await this.usb.requestDevice({ filters: filters ?? [] });
    if (!device) return null;
    await device.open();
    return new WebUsbDeviceHandle(device);
  }

  async open(info: UsbDeviceInfo): Promise<UsbDeviceHandle> {
    const devices = await this.usb.getDevices();
    const raw = devices.find(
      (d) =>
        d.vendorId === info.vendorId &&
        d.productId === info.productId &&
        (info.serialNumber === undefined || d.serialNumber === info.serialNumber),
    );
    if (!raw) throw new Error(`USB device not found: ${info.name}`);
    await raw.open();
    return new WebUsbDeviceHandle(raw);
  }

  onConnect(listener: (device: UsbDeviceInfo) => void): Dispose {
    const handler = (event: { device: UsbDeviceRaw }) => listener(toInfo(event.device));
    this.usb.addEventListener('connect', handler);
    return () => this.usb.removeEventListener('connect', handler);
  }

  onDisconnect(listener: (device: UsbDeviceInfo) => void): Dispose {
    const handler = (event: { device: UsbDeviceRaw }) => listener(toInfo(event.device));
    this.usb.addEventListener('disconnect', handler);
    return () => this.usb.removeEventListener('disconnect', handler);
  }
}

export { DIRECTION };