import { createToken } from './di';
import type { FileStore, UsbHostAdapter, GpuAdapter, AudioHostAdapter, WorkerPool } from './host';
import type { FileSystemBridge } from './bridge/fs';
import type { GdiBridge } from './bridge/graphics';
import type { AudioBridge } from './bridge/audio';
import type { WasmUsbHost } from './bridge/usb';
import type { ProcessManager, KernelObjectManager, MemoryManager } from './core/process';
import type { ApiInterceptor } from './core/api';
import type { PeLoader } from './core/pe';
import type { JitEngine, WasmRuntime } from './core/jit';
import type { DriverRegistry, DisplayDriver, PnPManager } from './drivers';
import type { WindowManager, DesktopController } from './ui';

/**
 * 全系统服务令牌表。
 * 各层插件在此声明自己“提供”的服务（注册）与其他层“消费”的服务（解析）。
 * 这是层与层之间唯一的耦合点，因此也是扩展点：第三方插件可替换任意服务实现。
 */
export const tokens = {
  // ---- L1 宿主层 ----
  hostFileStore: createToken<FileStore>('host.file-store'),
  hostWorkerPool: createToken<WorkerPool>('host.worker-pool'),
  hostUsb: createToken<UsbHostAdapter>('host.usb'),
  hostGpu: createToken<GpuAdapter>('host.gpu'),
  hostAudio: createToken<AudioHostAdapter>('host.audio'),

  // ---- L2 桥接层 ----
  bridgeFs: createToken<FileSystemBridge>('bridge.fs'),
  bridgeGdi: createToken<GdiBridge>('bridge.gdi'),
  bridgeAudio: createToken<AudioBridge>('bridge.audio'),
  bridgeUsb: createToken<WasmUsbHost>('bridge.usb'),

  // ---- L3 兼容核心 ----
  coreProcess: createToken<ProcessManager>('core.process'),
  coreObjects: createToken<KernelObjectManager>('core.objects'),
  coreMemory: createToken<MemoryManager>('core.memory'),
  coreApi: createToken<ApiInterceptor>('core.api'),
  corePe: createToken<PeLoader>('core.pe'),
  coreJit: createToken<JitEngine>('core.jit'),
  coreWasmRuntime: createToken<WasmRuntime>('core.wasm-runtime'),

  // ---- L4 驱动层 ----
  driverRegistry: createToken<DriverRegistry>('drivers.registry'),
  driverPnP: createToken<PnPManager>('drivers.pnp'),
  driverDisplay: createToken<DisplayDriver>('drivers.display'),

  // ---- L6 界面层 ----
  uiWindows: createToken<WindowManager>('ui.window-manager'),
  uiDesktop: createToken<DesktopController>('ui.desktop'),
} as const;

export type TokenMap = typeof tokens;