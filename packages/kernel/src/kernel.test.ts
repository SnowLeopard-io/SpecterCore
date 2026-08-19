import { describe, expect, it, vi } from 'vitest';
import type { Plugin } from '@specter-core/contracts';
import { Kernel } from './kernel';
import { silentLogger } from './logger';

function makePlugin(id: string, dependsOn?: string[]): Plugin {
  return {
    id,
    name: id,
    version: '0.1.0',
    dependsOn,
    setup: vi.fn(async () => {}),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  };
}

function makeKernel(): Kernel {
  return new Kernel({ version: { major: 0, minor: 1, patch: 0 }, environment: 'test', logger: silentLogger });
}

describe('Kernel lifecycle', () => {
  it('executes plugins in dependency order for setup and start', async () => {
    const kernel = makeKernel();
    const a = makePlugin('a');
    const b = makePlugin('b', ['a']);
    kernel.useAll([b, a]);
    await kernel.init();
    await kernel.start();

    const aSetup = a.setup as ReturnType<typeof vi.fn>;
    const bSetup = b.setup as ReturnType<typeof vi.fn>;
    // b 的 setup 必须在 a 之后执行
    expect(aSetup.mock.invocationCallOrder[0]!).toBeLessThan(bSetup.mock.invocationCallOrder[0]!);
    expect(aSetup.mock.calls[0]?.[0]).toBeTruthy();
  });

  it('stops plugins in reverse order', async () => {
    const kernel = makeKernel();
    const a = makePlugin('a');
    const b = makePlugin('b', ['a']);
    kernel.useAll([b, a]);
    await kernel.init();
    await kernel.start();
    await kernel.stop();

    const aStop = a.stop as ReturnType<typeof vi.fn>;
    const bStop = b.stop as ReturnType<typeof vi.fn>;
    expect(bStop.mock.invocationCallOrder[0]!).toBeLessThan(aStop.mock.invocationCallOrder[0]!);
  });

  it('forbids lifecycle calls out of order', async () => {
    const kernel = makeKernel();
    await expect(kernel.start()).rejects.toThrow(/Cannot start/);
    await expect(kernel.stop()).rejects.toThrow(/Cannot stop/);
  });

  it('emits lifecycle events', async () => {
    const kernel = makeKernel();
    const initSpy = vi.fn();
    const startSpy = vi.fn();
    kernel.events.on('kernel:init', initSpy);
    kernel.events.on('kernel:start', startSpy);
    await kernel.init();
    await kernel.start();
    expect(initSpy).toHaveBeenCalled();
    expect(startSpy).toHaveBeenCalled();
  });

  it('rejects unknown environment', () => {
    expect(
      () =>
        new Kernel({
          version: { major: 0, minor: 1, patch: 0 },
          environment: 'invalid' as never,
          logger: silentLogger,
        }),
    ).toThrow();
  });

  it('plugins registered via constructor options', async () => {
    const a = makePlugin('a');
    const kernel = new Kernel({
      version: { major: 0, minor: 1, patch: 0 },
      environment: 'test',
      logger: silentLogger,
      plugins: [a],
    });
    expect(kernel.plugins).toHaveLength(1);
    await kernel.init();
    expect(a.setup).toHaveBeenCalled();
  });
});