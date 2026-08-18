import type { Plugin, PluginContext } from '@bk/contracts';
import { tokens } from '@bk/contracts';
import { ObjectManagerImpl } from './process/object-manager';
import { MemoryManagerImpl } from './process/memory-manager';
import { ProcessManagerImpl } from './process/process-manager';
import { ApiInterceptorImpl } from './api/interceptor';
import { registerDefaultHandlers } from './api/handlers';
import { PeLoaderImpl } from './pe/loader';
import { WasmRuntimeImpl } from './jit/runtime';
import { JitEngineImpl } from './jit/engine';

/**
 * L3 Windows compatibility core plugin.
 * Registers process/memory/object managers, the API interceptor (with default
 * handlers), the real PE loader and the x86 -> WASM JIT engine with its
 * shared runtime memory.
 */
export const CoreLayerPlugin: Plugin = {
  id: 'core.layer',
  name: 'Core Layer (L3)',
  version: '0.2.0',
  description:
    'Process/thread/memory management, kernel objects, API interceptor, PE loader, x86 JIT',
  dependsOn: ['bridge.layer'],

  async setup(context: PluginContext): Promise<void> {
    const { container, events } = context;

    const objectManager = new ObjectManagerImpl();
    container.registerInstance(tokens.coreObjects, objectManager);

    const memoryManager = new MemoryManagerImpl();
    container.registerInstance(tokens.coreMemory, memoryManager);

    let workerPool = null;
    if (container.has(tokens.hostWorkerPool)) {
      workerPool = container.resolve(tokens.hostWorkerPool);
    }
    const processManager = new ProcessManagerImpl(objectManager, memoryManager, workerPool, events);
    container.registerInstance(tokens.coreProcess, processManager);

    // P1: shared WASM linear memory — created before the interceptor so API
    // handlers can dereference guest pointers through host.memory.
    const runtime = new WasmRuntimeImpl();

    const apiHost = {
      fs: container.resolve(tokens.bridgeFs),
      gdi: container.resolve(tokens.bridgeGdi),
      audio: container.resolve(tokens.bridgeAudio),
      usb: container.resolve(tokens.bridgeUsb),
      process: processManager,
      memory: {
        read: (address: number, length: number) => runtime.readBytes(address, length),
        write: (address: number, data: Uint8Array) => runtime.writeBytes(address, data),
      },
    };
    const interceptor = new ApiInterceptorImpl(apiHost, events);
    registerDefaultHandlers(interceptor);
    container.registerInstance(tokens.coreApi, interceptor);

    const jit = new JitEngineImpl(runtime);
    container.registerInstance(tokens.corePe, new PeLoaderImpl());
    container.registerInstance(tokens.coreJit, jit);
    container.registerInstance(tokens.coreWasmRuntime, runtime);
  },
};
