import { describe, expect, it, vi } from 'vitest';
import { EventBus } from './event-bus';

type TestEvents = {
  ping: { n: number };
  done: void;
};

describe('EventBus', () => {
  it('emits to subscribed listeners', () => {
    const bus = new EventBus<TestEvents>();
    const spy = vi.fn();
    bus.on('ping', spy);
    bus.emit('ping', { n: 1 });
    expect(spy).toHaveBeenCalledWith({ n: 1 });
  });

  it('unsubscribes via returned dispose', () => {
    const bus = new EventBus<TestEvents>();
    const spy = vi.fn();
    const dispose = bus.on('ping', spy);
    dispose();
    bus.emit('ping', { n: 1 });
    expect(spy).not.toHaveBeenCalled();
  });

  it('off removes a listener', () => {
    const bus = new EventBus<TestEvents>();
    const a = vi.fn();
    const b = vi.fn();
    bus.on('ping', a);
    bus.on('ping', b);
    bus.off('ping', a);
    bus.emit('ping', { n: 0 });
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalled();
  });

  it('once fires only once', () => {
    const bus = new EventBus<TestEvents>();
    const spy = vi.fn();
    bus.once('ping', spy);
    bus.emit('ping', { n: 1 });
    bus.emit('ping', { n: 2 });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('does not throw when emitting to empty topic', () => {
    const bus = new EventBus<TestEvents>();
    expect(() => bus.emit('ping', { n: 0 })).not.toThrow();
  });

  it('isolates listener exceptions', () => {
    const bus = new EventBus<TestEvents>();
    const err = new Error('boom');
    const good = vi.fn();
    bus.on('ping', () => {
      throw err;
    });
    bus.on('ping', good);
    expect(() => bus.emit('ping', { n: 0 })).not.toThrow();
    expect(good).toHaveBeenCalled();
  });

  it('tracks listener count', () => {
    const bus = new EventBus<TestEvents>();
    const fn = () => {};
    bus.on('ping', fn);
    bus.on('done', fn);
    expect(bus.size).toBe(2);
  });

  it('clear removes all', () => {
    const bus = new EventBus<TestEvents>();
    const spy = vi.fn();
    bus.on('ping', spy);
    bus.clear();
    bus.emit('ping', { n: 0 });
    expect(spy).not.toHaveBeenCalled();
  });
});