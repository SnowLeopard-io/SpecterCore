import type { Factory, IContainer, RegistrationOptions, Token } from '@specter-core/contracts';

export class ContainerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContainerError';
  }
}

interface Entry {
  factory: Factory<unknown>;
  options: RegistrationOptions;
}

/**
 * 轻量类型安全 DI 容器。
 * - 默认单例缓存；支持懒加载；
 * - 工厂可同步或异步返回（异步工厂需使用 resolveAsync）；
 * - 支持实例直注册。
 */
export class Container implements IContainer {
  private readonly entries = new Map<Token<unknown>, Entry>();
  private readonly instances = new Map<Token<unknown>, unknown>();

  register<T>(token: Token<T>, factory: Factory<T>, options: RegistrationOptions = {}): void {
    if (this.entries.has(token as Token<unknown>)) {
      throw new ContainerError(`Token already registered: ${String(token)}`);
    }
    this.entries.set(token as Token<unknown>, {
      factory: factory as Factory<unknown>,
      options: { lazy: true, singleton: true, ...options },
    });
  }

  registerInstance<T>(token: Token<T>, instance: T): void {
    this.entries.set(token as Token<unknown>, {
      factory: () => instance,
      options: { lazy: true, singleton: true },
    });
    this.instances.set(token as Token<unknown>, instance);
  }

  resolve<T>(token: Token<T>): T {
    const key = token as Token<unknown>;
    if (this.instances.has(key)) return this.instances.get(key) as T;

    const entry = this.entries.get(key);
    if (!entry) throw new ContainerError(`No registration for token: ${String(token)}`);

    if (!entry.options.lazy) {
      const value = entry.factory(this);
      if (value instanceof Promise) {
        throw new ContainerError(`Async factory for ${String(token)} - use resolveAsync`);
      }
      this.instances.set(key, value);
      return value as T;
    }

    const value = entry.factory(this);
    if (value instanceof Promise) {
      throw new ContainerError(`Async factory for ${String(token)} - use resolveAsync`);
    }
    if (entry.options.singleton) this.instances.set(key, value);
    return value as T;
  }

  async resolveAsync<T>(token: Token<T>): Promise<T> {
    const key = token as Token<unknown>;
    if (this.instances.has(key)) return this.instances.get(key) as T;

    const entry = this.entries.get(key);
    if (!entry) throw new ContainerError(`No registration for token: ${String(token)}`);

    const value = await entry.factory(this);
    if (entry.options.singleton) this.instances.set(key, value);
    return value as T;
  }

  has(token: Token<unknown>): boolean {
    return this.entries.has(token) || this.instances.has(token);
  }

  unregister(token: Token<unknown>): boolean {
    const removedEntry = this.entries.delete(token);
    const removedInstance = this.instances.delete(token);
    return removedEntry || removedInstance;
  }

  async dispose(): Promise<void> {
    this.instances.clear();
    this.entries.clear();
  }
}