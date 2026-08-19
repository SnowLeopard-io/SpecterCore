import { describe, expect, it } from 'vitest';
import { createToken } from '@specter-core/contracts';
import { Container, ContainerError } from './container';

const tokenA = createToken<string>('a');
const tokenB = createToken<number>('b');
const tokenAsync = createToken<number>('async');

describe('Container', () => {
  it('resolves registered factory (singleton)', () => {
    const c = new Container();
    let calls = 0;
    c.register(tokenA, () => {
      calls += 1;
      return 'hello';
    });
    expect(c.resolve(tokenA)).toBe('hello');
    expect(c.resolve(tokenA)).toBe('hello');
    expect(calls).toBe(1);
  });

  it('supports transient instances', () => {
    const c = new Container();
    c.register(tokenB, () => Math.random(), { singleton: false });
    expect(c.resolve(tokenB)).not.toBe(c.resolve(tokenB));
  });

  it('registerInstance stores the exact instance', () => {
    const c = new Container();
    const inst = { x: 1 };
    c.registerInstance(tokenA as never, inst as never);
    expect(c.resolve(tokenA as never)).toBe(inst);
  });

  it('throws on missing token', () => {
    const c = new Container();
    expect(() => c.resolve(tokenB)).toThrow(ContainerError);
  });

  it('throws on duplicate registration', () => {
    const c = new Container();
    c.register(tokenA, () => 'x');
    expect(() => c.register(tokenA, () => 'y')).toThrow(ContainerError);
  });

  it('throws on synchronous resolve of async factory', () => {
    const c = new Container();
    c.register(tokenAsync, () => Promise.resolve(42));
    expect(() => c.resolve(tokenAsync)).toThrow(ContainerError);
  });

  it('resolveAsync awaits async factories', async () => {
    const c = new Container();
    c.register(tokenAsync, () => Promise.resolve(42));
    expect(await c.resolveAsync(tokenAsync)).toBe(42);
  });

  it('has/unregister work', () => {
    const c = new Container();
    c.register(tokenA, () => 'x');
    expect(c.has(tokenA)).toBe(true);
    expect(c.unregister(tokenA)).toBe(true);
    expect(c.has(tokenA)).toBe(false);
  });

  it('dispose clears everything', async () => {
    const c = new Container();
    c.register(tokenA, () => 'x');
    c.registerInstance(tokenB, 1);
    await c.dispose();
    expect(c.has(tokenA)).toBe(false);
    expect(c.has(tokenB)).toBe(false);
  });
});