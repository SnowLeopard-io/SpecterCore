import { describe, expect, it, vi } from 'vitest';
import type { BulkTransferResult, Dispose, UsbDeviceHandle, UsbDeviceInfo, UsbHostAdapter } from '@bk/contracts';
import { WasmUsbHostBridge } from './usb';

const DEVICE: UsbDeviceInfo = { deviceId: 1, vendorId: 0x1234, productId: 0x5678, name: 'Test Device' };

function makeFakeAdapter(): UsbHostAdapter & { opened: UsbDeviceHandle[]; closed: boolean[] } {
  const opened: UsbDeviceHandle[] = [];
  const closed: boolean[] = [];
  const adapter: UsbHostAdapter = {
    available: true,
    listDevices: vi.fn(async () => [DEVICE]),
    requestDevice: vi.fn(async () => null),
    open: vi.fn(async (info: UsbDeviceInfo) => {
      const handle: UsbDeviceHandle = {
        info,
        controlTransfer: vi.fn(async () => new Uint8Array([0, 1])),
        bulkTransfer: vi.fn(
          async (endpoint: number, _data: Uint8Array): Promise<BulkTransferResult> => ({
            status: 'ok',
            bytesWritten: 4,
            data: endpoint & 0x80 ? new Uint8Array([9, 9]) : undefined,
          }),
        ),
        interruptTransfer: vi.fn(
          async (_endpoint: number, _data: Uint8Array): Promise<BulkTransferResult> => ({
            status: 'ok',
            bytesWritten: 0,
          }),
        ),
        claimInterface: vi.fn(async () => {}),
        releaseInterface: vi.fn(async () => {}),
        close: vi.fn(async () => {
          closed.push(true);
        }),
      };
      opened.push(handle);
      return handle;
    }),
    onConnect: vi.fn((): Dispose => () => {}),
    onDisconnect: vi.fn((): Dispose => () => {}),
  };
  return { ...adapter, opened, closed };
}

describe('WasmUsbHostBridge', () => {
  it('lists devices', async () => {
    const adapter = makeFakeAdapter();
    const bridge = new WasmUsbHostBridge(adapter);
    const list = await bridge.deviceList();
    expect(list).toEqual([DEVICE]);
  });

  it('opens a device and forwards transfers', async () => {
    const adapter = makeFakeAdapter();
    const bridge = new WasmUsbHostBridge(adapter);
    const handle = await bridge.deviceOpen(DEVICE);
    expect(handle).toBeGreaterThan(0);
    expect(adapter.opened).toHaveLength(1);

    const ctrl = await bridge.controlTransfer(handle, {
      requestType: 0,
      recipient: 0,
      request: 0x06,
      value: 0,
      index: 0,
    });
    expect([...ctrl]).toEqual([0, 1]);

    const bulk = await bridge.bulkTransfer(handle, 0x81, new Uint8Array(0));
    expect(bulk.data && [...bulk.data]).toEqual([9, 9]);
  });

  it('throws on unknown handle', async () => {
    const adapter = makeFakeAdapter();
    const bridge = new WasmUsbHostBridge(adapter);
    await expect(bridge.controlTransfer(4242, { requestType: 0, recipient: 0, request: 0, value: 0, index: 0 })).rejects.toThrow(
      /Invalid USB handle/,
    );
  });

  it('closes device and releases handles on releaseAll', async () => {
    const adapter = makeFakeAdapter();
    const bridge = new WasmUsbHostBridge(adapter);
    const handle = await bridge.deviceOpen(DEVICE);
    await bridge.deviceClose(handle);
    await bridge.deviceOpen(DEVICE);
    await bridge.releaseAll();
    expect(adapter.closed).toEqual([true, true]);
  });

  it('requestDevice returns device info', async () => {
    const adapter = makeFakeAdapter();
    const bridge = new WasmUsbHostBridge(adapter);
    const info = await bridge.requestDevice([{ vendorId: 0x1234 }]);
    expect(info).toBeNull();
    expect(adapter.requestDevice).toHaveBeenCalledWith([{ vendorId: 0x1234 }]);
  });
});