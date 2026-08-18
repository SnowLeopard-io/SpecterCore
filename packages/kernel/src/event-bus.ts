import type { Dispose, IEventBus } from '@bk/contracts';

type Handler<Events, K extends keyof Events> = (payload: Events[K]) => void;

/**
 * 类型安全事件总线。
 * 事件表在 contracts/events.ts 集中定义，跨层通过事件解耦。
 */
export class EventBus<Events extends object> implements IEventBus<Events> {
  private readonly listeners = new Map<keyof Events, Set<Handler<Events, keyof Events>>>();

  get size(): number {
    let n = 0;
    for (const set of this.listeners.values()) n += set.size;
    return n;
  }

  on<K extends keyof Events>(type: K, handler: Handler<Events, K>): Dispose {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(handler as Handler<Events, keyof Events>);
    return () => this.off(type, handler);
  }

  once<K extends keyof Events>(type: K, handler: Handler<Events, K>): Dispose {
    const wrapper: Handler<Events, K> = (payload) => {
      this.off(type, wrapper);
      handler(payload);
    };
    return this.on(type, wrapper);
  }

  off<K extends keyof Events>(type: K, handler: Handler<Events, K>): void {
    const set = this.listeners.get(type);
    if (!set) return;
    set.delete(handler as Handler<Events, keyof Events>);
    if (set.size === 0) this.listeners.delete(type);
  }

  emit<K extends keyof Events>(type: K, payload: Events[K]): void {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const handler of [...set]) {
      try {
        (handler as Handler<Events, K>)(payload);
      } catch (err) {
        // 监听器异常不应中断其余监听器
        console.error(`[event-bus] listener error on "${String(type)}"`, err);
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}