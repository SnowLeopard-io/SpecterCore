import { describe, expect, it, vi } from 'vitest';
import type { Irp, UsbDeviceInfo, UsbDriver } from '@specter-core/contracts';
import { WinError as E } from '@specter-core/contracts';
import { DriverRegistryImpl } from './registry';
import { PnPManagerImpl, HidUsbDriver, MassStorageUsbDriver } from './pnp';

const HID_DEVICE: UsbDeviceInfo = { deviceId: 1, vendorId: 0x046d, productId: 0xc077, name: 'Logitech Mouse' };

describe('DriverRegistryImpl', () => {
  it('registers, lists and matches drivers', () => {
    const registry = new DriverRegistryImpl();
    registry.register(new HidUsbDriver());
    registry.register(new MassStorageUsbDriver());
    expect(registry.list()).toHaveLength(2);
    expect(registry.findFor(HID_DEVICE)?.id).toBe('hid');
  });

  it('rejects duplicate driver ids', () => {
    const registry = new DriverRegistryImpl();
    registry.register(new HidUsbDriver());
    expect(() => registry.register(new HidUsbDriver())).toThrow(/already registered/);
  });

  it('unregister disposes and removes', () => {
    const registry = new DriverRegistryImpl();
    const dispose = vi.fn();
    const driver = {
      id: 'x',
      name: 'X',
      matches: () => false,
      attach: async () => {},
      detach: async () => {},
      handleIrp: async () => ({ status: 'error' as const, errorCode: E.NO_ERROR }),
      dispose,
    } satisfies UsbDriver;
    registry.register(driver);
    expect(registry.unregister('x')).toBe(true);
    expect(dispose).toHaveBeenCalled();
    expect(registry.findFor(HID_DEVICE)).toBeNull();
  });
});

describe('PnPManagerImpl', () => {
  it('binds and attaches a driver on device add', async () => {
    const pnp = new PnPManagerImpl();
    pnp.attachBinder((device) => {
      void device;
      return new HidUsbDriver();
    });
    await pnp.notifyDeviceAdded(HID_DEVICE);
    const result = await pnp.forwardIrp(HID_DEVICE, {
      majorFunction: 0x0f,
      device: HID_DEVICE,
      length: 0,
    } as Irp);
    expect(result.status).toBe('pending');
  });

  it('detaches on device removal', async () => {
    const pnp = new PnPManagerImpl();
    pnp.attachBinder(() => new HidUsbDriver());
    await pnp.notifyDeviceAdded(HID_DEVICE);
    await pnp.notifyDeviceRemoved(HID_DEVICE);
    const result = await pnp.forwardIrp(HID_DEVICE, { majorFunction: 0x0f, device: HID_DEVICE, length: 0 } as Irp);
    expect(result.status).toBe('error');
    expect(result.errorCode).toBe(E.ERROR_INVALID_HANDLE);
  });

  it('no driver matched -> IRP fails', async () => {
    const pnp = new PnPManagerImpl();
    pnp.attachBinder(() => null);
    await pnp.notifyDeviceAdded(HID_DEVICE);
    const result = await pnp.forwardIrp(HID_DEVICE, { majorFunction: 0x03, device: HID_DEVICE, length: 0 } as Irp);
    expect(result.status).toBe('error');
    expect(result.errorCode).toBe(E.ERROR_INVALID_HANDLE);
  });
});

describe('MassStorageUsbDriver', () => {
  it('matches by productId', () => {
    const driver = new MassStorageUsbDriver();
    expect(driver.matches(HID_DEVICE)).toBe(true);
  });
});