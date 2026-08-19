import type { AudioHostAdapter, Plugin, PluginContext } from '@specter-core/contracts';
import { tokens } from '@specter-core/contracts';
import { FileSystemBridgeImpl } from './fs';
import { WaveOutAudioBridge } from './audio';
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

    // 音频桥接：优先绑定宿主音频适配器（AudioWorklet 混音），
    // 宿主不可用时退回静默成功实现（Node/无 AudioContext 环境）。
    let hostAudio: AudioHostAdapter | null = null;
    if (container.has(tokens.hostAudio)) {
      hostAudio = container.resolve(tokens.hostAudio) as AudioHostAdapter;
    }
    container.registerInstance(tokens.bridgeAudio, new WaveOutAudioBridge(hostAudio));

    const usbAdapter = container.resolve(tokens.hostUsb);
    container.registerInstance(tokens.bridgeUsb, new WasmUsbHostBridge(usbAdapter));
  },
};