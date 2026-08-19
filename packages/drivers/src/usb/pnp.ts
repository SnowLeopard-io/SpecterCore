import type { Irp, IrpResult, UsbDeviceInfo, UsbDriver } from '@specter-core/contracts';
import { IrpMajorFunction } from '@specter-core/contracts';
import { WinError as E } from '@specter-core/contracts';

/**
 * PnP manager (design doc 5.1.4).
 * Subscribes to USB connect/disconnect events and drives the driver stack:
 * matching a driver, attaching it, and later detaching.
 */
export class PnPManagerImpl {
  private readonly binders = new Set<(device: UsbDeviceInfo) => UsbDriver | null>();
  private readonly attached = new Map<number, UsbDriver>();

  attachBinder(binder: (device: UsbDeviceInfo) => UsbDriver | null): void {
    this.binders.add(binder);
  }

  async notifyDeviceAdded(device: UsbDeviceInfo): Promise<void> {
    for (const binder of this.binders) {
      const driver = binder(device);
      if (driver) {
        this.attached.set(device.deviceId, driver);
        await driver.attach(device);
        return;
      }
    }
  }

  async notifyDeviceRemoved(device: UsbDeviceInfo): Promise<void> {
    const driver = this.attached.get(device.deviceId);
    if (!driver) return;
    await driver.detach();
    this.attached.delete(device.deviceId);
  }

  async forwardIrp(device: UsbDeviceInfo, irp: Irp): Promise<IrpResult> {
    const driver = this.attached.get(device.deviceId);
    if (!driver) return { status: 'error', errorCode: E.ERROR_INVALID_HANDLE };
    return driver.handleIrp(irp);
  }

  dispose(): void {
    this.binders.clear();
    for (const driver of this.attached.values()) driver.dispose();
    this.attached.clear();
  }
}

/**
 * Example HID class driver (classCode=3), design doc 3.4.9.
 * Transport-level transfers go through the WASI-USB bridge at P6.
 */
export class HidUsbDriver implements UsbDriver {
  readonly id = 'hid';
  readonly name = 'HID (Human Interface Device)';
  readonly classCode = 3;

  private attachedDevice: UsbDeviceInfo | null = null;

  matches(device: UsbDeviceInfo): boolean {
    // Device-level class (via configuration interfaces) is resolved by the PnP binder;
    // VID/PID overrides may be added here.
    return device.vendorId !== undefined;
  }

  async attach(device: UsbDeviceInfo): Promise<void> {
    this.attachedDevice = device;
  }

  async detach(): Promise<void> {
    this.attachedDevice = null;
  }

  async handleIrp(irp: Irp): Promise<IrpResult> {
    if (!this.attachedDevice) return { status: 'error', errorCode: E.ERROR_INVALID_HANDLE };
    if (irp.majorFunction === IrpMajorFunction.IRP_MJ_INTERNAL_DEVICE_CONTROL) {
      // TODO(P6): translate the URB -> WASI-USB transport call
      return { status: 'pending', errorCode: E.NO_ERROR };
    }
    return { status: 'error', errorCode: E.ERROR_NOT_IMPLEMENTED };
  }

  dispose(): void {
    this.attachedDevice = null;
  }
}

/**
 * Example mass storage class driver stub (classCode=8), design doc 3.4.10.
 */
export class MassStorageUsbDriver implements UsbDriver {
  readonly id = 'mass-storage';
  readonly name = 'USB Mass Storage';
  readonly classCode = 8;

  private attachedDevice: UsbDeviceInfo | null = null;

  matches(device: UsbDeviceInfo): boolean {
    return device.productId !== undefined;
  }

  async attach(device: UsbDeviceInfo): Promise<void> {
    this.attachedDevice = device;
  }

  async detach(): Promise<void> {
    this.attachedDevice = null;
  }

  async handleIrp(_irp: Irp): Promise<IrpResult> {
    if (!this.attachedDevice) return { status: 'error', errorCode: E.ERROR_INVALID_HANDLE };
    // TODO(P6): FAT32 read/write via bulk transfers
    return { status: 'pending', errorCode: E.NO_ERROR };
  }

  dispose(): void {
    this.attachedDevice = null;
  }
}