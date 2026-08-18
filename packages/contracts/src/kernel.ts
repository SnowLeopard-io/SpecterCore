/**
 * 内核级契约：插件系统、生命周期、日志。
 */

export type Awaitable<T> = T | Promise<T>;

export type Dispose = () => Awaitable<void>;

import type { IContainer, IEventBus } from './di';
import type { KernelEvents } from './events';

export interface Logger {
  trace(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export interface VersionInfo {
  major: number;
  minor: number;
  patch: number;
}

export type KernelEnvironment = 'browser' | 'worker' | 'node' | 'test';

export interface KernelOptions {
  version: VersionInfo;
  environment: KernelEnvironment;
  logger?: Logger;
  /** 插件自动装载：传入的插件会被 Kernel.use() 按依赖顺序注册 */
  plugins?: readonly Plugin[];
}

/**
 * 插件上下文：每个插件 setup/start/stop 时注入。
 * 依赖 IContainer / IEventBus 的接口形态，避免 contracts 反向依赖 kernel 实现。
 */
export interface PluginContext {
  readonly kernel: KernelRuntime;
  readonly container: IContainer;
  readonly events: IEventBus<KernelEvents>;
  readonly logger: Logger;
}

/**
 * 插件契约：分层扩展的入口。
 * 每个逻辑层（L1 宿主 / L2 桥接 / L3 核心 / L4 驱动 / L6 界面）都是一个插件。
 * 第三方能力（新的文件后端、新的 USB 驱动、新的图形后端）通过实现本接口接入。
 */
export interface Plugin {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  /** 依赖的其他插件 id，Kernel 保证拓扑排序后按序初始化 */
  readonly dependsOn?: readonly string[];
  setup?(context: PluginContext): Awaitable<void>;
  start?(context: PluginContext): Awaitable<void>;
  stop?(context: PluginContext): Awaitable<void>;
}

export interface KernelRuntime {
  readonly options: KernelOptions;
  readonly logger: Logger;
  readonly container: IContainer;
  readonly events: IEventBus<KernelEvents>;
  readonly plugins: readonly Plugin[];
  use(plugin: Plugin): KernelRuntime;
  useAll(plugins: readonly Plugin[]): KernelRuntime;
  init(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}