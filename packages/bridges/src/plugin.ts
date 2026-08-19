import type { Plugin, PluginContext } from '@specter-core/contracts';
import { tokens } from '@specter-core/contracts';
import { FileSystemBridgeImpl } from './fs';
import { NullAudioBridge } from './audio';
import { NullGdiBridge } from './graphics';
import { WasmUsbHostBridge } from './usb';

/**
 * L2 system-call bridge layer plugin.
 * Registers Windows-API-facing bridges onto the container, backed by L1 host services.
 * Swapping a bridge implementation (e.g. NullGdiBridge -> CanvasGdiBridge) is a drop-in change.
 */
export const BridgeLayerPlugin: Plugin = {
  id: 'bridge.layer',
  name: 'Bridge Layer (L2)',
  version: '0.1.0',
  description: 'File system, GDI, audio and USB bridges mapping Windows APIs to the browser host',
  dependsOn: ['host.layer'],

  async setup(context: PluginContext): Promise<void> {
    const { container, events, logger } = context;

    const store = container.resolve(tokens.hostFileStore);
    const fsBridge = new FileSystemBridgeImpl(store, (path, error, operation) => {
      events.emit('bridge:fs:error', { path, error, operation });
    });
    container.registerInstance(tokens.bridgeFs, fsBridge);
    logger.info('file system bridge ready (backend=%s)', store.name);

    container.registerInstance(tokens.bridgeGdi, new NullGdiBridge());
    container.registerInstance(tokens.bridgeAudio, new NullAudioBridge());

    const usbAdapter = container.resolve(tokens.hostUsb);
    container.registerInstance(tokens.bridgeUsb, new WasmUsbHostBridge(usbAdapter));
  },
};