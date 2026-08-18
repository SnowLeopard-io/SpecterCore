import type { KernelEvents, Plugin, PluginContext } from '@bk/contracts';
import { tokens } from '@bk/contracts';
import { OpfsFileStore } from './opfs';
import { MemoryFileStore } from './memory-store';
import { WebWorkerPool } from './worker-pool';
import { WebUsbAdapter } from './usb';
import { WebGpuAdapter } from './gpu';
import { WebAudioHostAdapter } from './audio';
import { createProbe } from './environment';

/**
 * L1 宿主层插件。
 * 将浏览器原生能力封装为服务注册进容器：OPFS 文件库、Worker 池、USB/GPU/Audio 适配器。
 * 任意实现可替换：测试环境注入 MemoryFileStore。
 */
export const HostLayerPlugin: Plugin = {
  id: 'host.layer',
  name: 'Host Layer (L1)',
  version: '0.1.0',
  description: 'OPFS virtual disks, worker pool, WebUSB/WebGPU/WebAudio adapters',
  dependsOn: [],

  async setup(context: PluginContext): Promise<void> {
    const { container, logger } = context;

    // 环境探测：缺失能力记录警告而非直接拒绝（让页面仍可加载，控制面板展示）
    const probe = createProbe();
    if (probe.missing.length > 0) {
      logger.warn('browser capabilities missing: %s', probe.missing.join(', '));
    }

    let store: OpfsFileStore | MemoryFileStore | null = null;
    if (probe.capabilities.opfs) {
      try {
        store = await OpfsFileStore.create('C');
        const capacity = await store.capacity();
        logger.info('opfs virtual disk ready, capacity=%d bytes', capacity);
      } catch (err) {
        logger.warn('OPFS init failed, falling back to memory store: %o', err);
      }
    }
    if (!store) {
      store = new MemoryFileStore('C');
      logger.warn('using in-memory file store (non-persistent)');
    }
    container.registerInstance(tokens.hostFileStore, store);
    context.events.emit('host:fs:ready', {
      storeName: store.name,
      capacity: await store.capacity(),
    });

    const workerPool = new WebWorkerPool({ maxWorkers: 32 });
    container.registerInstance(tokens.hostWorkerPool, workerPool);
    logger.info('worker pool available=%s', String(workerPool.available));

    container.registerInstance(tokens.hostUsb, new WebUsbAdapter());
    container.registerInstance(tokens.hostGpu, new WebGpuAdapter());
    container.registerInstance(tokens.hostAudio, new WebAudioHostAdapter());
  },

  async start(context: PluginContext): Promise<void> {
    const { container, events } = context;
    const usb = container.resolve(tokens.hostUsb);
    if (usb.available) {
      usb.onConnect((device) => events.emit('host:usb:connected', device));
      usb.onDisconnect((device) => events.emit('host:usb:disconnected', device));
    }
  },
};

export type { KernelEvents };