import { Kernel } from '@bk/kernel';
import { HostLayerPlugin } from '@bk/host';
import { BridgeLayerPlugin } from '@bk/bridges';
import { CoreLayerPlugin } from '@bk/core';
import { DriverLayerPlugin } from '@bk/drivers';
import { UiLayerPlugin, ensureBuiltinWinFiles } from '@bk/ui';
import { tokens, type FileStore } from '@bk/contracts';
import type { DesktopController } from '@bk/contracts';

/**
 * Bootstraps the whole system: assemble the kernel with one plugin per layer,
 * then mount the L6 desktop into the given container.
 *
 * Layer plugin order is resolved automatically through dependsOn:
 *   host.layer -> bridge.layer -> core.layer -> driver.layer -> ui.layer
 */

// 1.2 安全上下文强制：OPFS/WebUSB/AudioWorklet 等均需安全上下文。
// 仅 localhost/HTTPS 允许启动，否则直接拒绝并给出提示。
export function assertSecureContext(container: HTMLElement): void {
  if (typeof window === 'undefined' || window.isSecureContext) return;
  container.innerHTML =
    '<div style="padding:32px;font-family:sans-serif;color:#b00;max-width:520px">' +
    '<h2>Insecure context</h2>' +
    '<p>Browser Kernel requires a secure context (HTTPS or localhost) because it uses ' +
    'OPFS, WebUSB and AudioWorklet. Serve this page over <code>https://</code> or ' +
    '<code>http://localhost</code> and reload.</p>' +
    '</div>';
  throw new Error('Browser Kernel requires a secure context (HTTPS or localhost)');
}

// 1.1 浏览器版本检查：目标 Chromium >= 120（Chrome/Edge）。仅警告，不阻断。
export function checkBrowserVersion(): void {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  const match = /(?:Chrome|Edg)\/(\d+)/.exec(ua);
  if (match && Number(match[1]) < 120) {
    console.warn(
      `[browser-kernel] Chromium ${match[1]} detected; the supported baseline is Chromium >= 120. ` +
        'OPFS/WebUSB features may behave differently.',
    );
  }
}

export async function bootstrap(container: HTMLElement): Promise<Kernel> {
  assertSecureContext(container);
  checkBrowserVersion();

  const kernel = new Kernel({
    version: { major: 0, minor: 1, patch: 0 },
    environment: 'browser',
    plugins: [
      HostLayerPlugin,
      BridgeLayerPlugin,
      CoreLayerPlugin,
      DriverLayerPlugin,
      UiLayerPlugin,
    ],
  });

  await kernel.init();
  await kernel.start();

  // Pre-provision the bundled notepad (+ MUI) into the virtual disk.
  if (kernel.container.has(tokens.hostFileStore)) {
    const fs = kernel.container.resolve(tokens.hostFileStore) as FileStore;
    await ensureBuiltinWinFiles(fs)
      .then(() => console.warn('[browser-kernel] builtin win files ready'))
      .catch((err) => console.warn('[browser-kernel] builtin win files failed:', err));
  }

  const desktop = kernel.container.resolve(tokens.uiDesktop) as DesktopController;
  await desktop.mount(container);

  return kernel;
}