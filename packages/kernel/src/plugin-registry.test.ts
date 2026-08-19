import { describe, expect, it } from 'vitest';
import type { Plugin } from '@specter-core/contracts';
import { PluginRegistry, PluginRegistryError } from './plugin-registry';

function makePlugin(id: string, dependsOn?: string[]): Plugin {
  return { id, name: id, version: '0.1.0', dependsOn };
}

describe('PluginRegistry', () => {
  it('orders by dependency', () => {
    const r = new PluginRegistry();
    r.register(makePlugin('c', ['a', 'b']));
    r.register(makePlugin('b', ['a']));
    r.register(makePlugin('a'));
    expect(r.order().map((p) => p.id)).toEqual(['a', 'b', 'c']);
  });

  it('keeps registration order for independent plugins', () => {
    const r = new PluginRegistry();
    r.register(makePlugin('x'));
    r.register(makePlugin('y'));
    expect(r.order().map((p) => p.id)).toEqual(['x', 'y']);
  });

  it('rejects duplicate ids', () => {
    const r = new PluginRegistry();
    r.register(makePlugin('a'));
    expect(() => r.register(makePlugin('a'))).toThrow(PluginRegistryError);
  });

  it('detects missing dependency', () => {
    const r = new PluginRegistry();
    r.register(makePlugin('a', ['nope']));
    expect(() => r.order()).toThrow(PluginRegistryError);
  });

  it('detects circular dependency', () => {
    const r = new PluginRegistry();
    r.register(makePlugin('a', ['b']));
    r.register(makePlugin('b', ['a']));
    expect(() => r.order()).toThrow(/Circular/);
  });

  it('self circular dependency', () => {
    const r = new PluginRegistry();
    r.register(makePlugin('a', ['a']));
    expect(() => r.order()).toThrow(/Circular/);
  });

  it('unregister removes plugin', () => {
    const r = new PluginRegistry();
    r.register(makePlugin('a'));
    expect(r.unregister('a')).toBe(true);
    expect(r.has('a')).toBe(false);
  });
});