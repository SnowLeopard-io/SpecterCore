import type { Awaitable, Dispose } from './kernel';

/**
 * DI 令牌：以 symbol 标识服务类型，类型参数保证类型安全。
 * 同一服务在注册与解析处共享同一令牌实例。
 */
export interface Token<T = unknown> {
  readonly __brand: unique symbol;
  readonly __type?: T;
}

export function createToken<T>(description: string): Token<T> {
  return Symbol(description) as unknown as Token<T>;
}

export interface Factory<T> {
  (container: IContainer): Awaitable<T>;
}

export interface RegistrationOptions {
  /** 延迟实例化：仅在首次 resolve 时创建 */
  lazy?: boolean;
  /** 是否单例（默认 true） */
  singleton?: boolean;
}

export interface IContainer {
  register<T>(token: Token<T>, factory: Factory<T>, options?: RegistrationOptions): void;
  registerInstance<T>(token: Token<T>, instance: T): void;
  /** 同步解析。若工厂为异步，抛出 ContainerError，请改用 resolveAsync */
  resolve<T>(token: Token<T>): T;
  resolveAsync<T>(token: Token<T>): Promise<T>;
  has(token: Token<unknown>): boolean;
  unregister(token: Token<unknown>): boolean;
  dispose(): Promise<void>;
}

export interface IEventBus<Events extends object = Record<string, unknown>> {
  on<K extends keyof Events>(type: K, handler: (payload: Events[K]) => void): Dispose;
  once<K extends keyof Events>(type: K, handler: (payload: Events[K]) => void): Dispose;
  off<K extends keyof Events>(type: K, handler: (payload: Events[K]) => void): void;
  emit<K extends keyof Events>(type: K, payload: Events[K]): void;
  clear(): void;
  readonly size: number;
}