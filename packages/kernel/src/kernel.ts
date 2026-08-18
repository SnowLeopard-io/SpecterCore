import type { KernelEvents, KernelOptions, KernelRuntime, Plugin, PluginContext } from '@bk/contracts';
import { Container } from './container';
import { EventBus } from './event-bus';
import { ConsoleLogger } from './logger';
import { PluginRegistry } from './plugin-registry';
import { KernelError } from './errors';

const SUPPORTED_ENVIRONMENTS = ['browser', 'worker', 'node', 'test'] as const;

/**
 * Browser Kernel 内核装配器。
 *
 * 职责：
 *  - 统一管理插件生命周期（init → start → stop），按依赖拓扑执行；
 *  - 提供共享 DI 容器与事件总线作为插件间的唯一耦合点；
 *  - 对外暴露 KernelRuntime，供引导层（apps/web）装配。
 */
export class Kernel implements KernelRuntime {
  readonly options: KernelOptions;
  readonly logger;
  readonly container: Container;
  readonly events: EventBus<KernelEvents>;

  private readonly registry = new PluginRegistry();
  private readonly contexts = new Map<string, PluginContext>();
  private phase: 'created' | 'init' | 'started' | 'stopped' = 'created';

  constructor(options: KernelOptions) {
    if (!SUPPORTED_ENVIRONMENTS.includes(options.environment)) {
      throw new KernelError(`Unsupported environment: ${options.environment}`);
    }
    this.options = options;
    this.logger = options.logger ?? new ConsoleLogger();
    this.container = new Container();
    this.events = new EventBus<KernelEvents>();
    if (options.plugins && options.plugins.length > 0) {
      this.useAll(options.plugins);
    }
  }

  get plugins(): readonly Plugin[] {
    return this.registry.list();
  }

  use(plugin: Plugin): KernelRuntime {
    this.assertPhase('created');
    this.registry.register(plugin);
    return this;
  }

  useAll(plugins: readonly Plugin[]): KernelRuntime {
    for (const plugin of plugins) this.use(plugin);
    return this;
  }

  private assertPhase(expected: 'created'): void {
    if (this.phase !== expected) {
      throw new KernelError(`Kernel is in phase "${this.phase}", expected "${expected}"`);
    }
  }

  async init(): Promise<void> {
    if (this.phase !== 'created') {
      throw new KernelError(`Cannot init in phase "${this.phase}"`);
    }
    this.phase = 'init';
    this.logger.info('kernel initializing, environment=%s', this.options.environment);

    const ordered = this.registry.order();
    for (const plugin of ordered) {
      const context = this.buildContext(plugin);
      this.contexts.set(plugin.id, context);
      this.logger.debug('setup plugin %s v%s', plugin.name, plugin.version);
      await plugin.setup?.(context);
    }

    this.events.emit('kernel:init', undefined);
    this.logger.info('kernel initialized, %d plugins loaded', ordered.length);
  }

  async start(): Promise<void> {
    if (this.phase !== 'init') {
      throw new KernelError(`Cannot start in phase "${this.phase}"`);
    }
    const ordered = this.registry.order();
    for (const plugin of ordered) {
      const context = this.contexts.get(plugin.id)!;
      this.logger.debug('start plugin %s', plugin.name);
      await plugin.start?.(context);
    }
    this.phase = 'started';
    this.events.emit('kernel:start', undefined);
    this.logger.info('kernel started');
  }

  async stop(): Promise<void> {
    if (this.phase !== 'started' && this.phase !== 'init') {
      throw new KernelError(`Cannot stop in phase "${this.phase}"`);
    }
    const ordered = this.registry.order().reverse();
    for (const plugin of ordered) {
      const context = this.contexts.get(plugin.id);
      if (!context) continue;
      try {
        this.logger.debug('stop plugin %s', plugin.name);
        await plugin.stop?.(context);
      } catch (err) {
        this.logger.warn('plugin %s failed to stop: %o', plugin.name, err);
      }
    }
    await this.container.dispose();
    this.events.clear();
    this.contexts.clear();
    this.phase = 'stopped';
    this.events.emit('kernel:stop', undefined);
    this.logger.info('kernel stopped');
  }

  private buildContext(_plugin: Plugin): PluginContext {
    return {
      kernel: this,
      container: this.container,
      events: this.events,
      logger: this.logger,
    };
  }
}

export { silentLogger, ConsoleLogger } from './logger';