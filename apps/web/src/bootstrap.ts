import { Kernel } from '@specter-core/kernel';
import { HostLayerPlugin } from '@specter-core/host';
import { BridgeLayerPlugin } from '@specter-core/bridges';
import { CoreLayerPlugin } from '@specter-core/core';
import { DriverLayerPlugin } from '@specter-core/drivers';
import { UiLayerPlugin, provisionBundledFilesInBackground } from '@specter-core/ui';
import { tokens, type FileStore } from '@specter-core/contracts';
import type { DesktopController } from '@specter-core/contracts';

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
    '<p>SpecterCore requires a secure context (HTTPS or localhost) because it uses ' +
    'OPFS, WebUSB and AudioWorklet. Serve this page over <code>https://</code> or ' +
    '<code>http://localhost</code> and reload.</p>' +
    '</div>';
  throw new Error('SpecterCore requires a secure context (HTTPS or localhost)');
}

// 1.1 浏览器版本检查：目标 Chromium >= 120（Chrome/Edge）。仅警告，不阻断。
export function checkBrowserVersion(): void {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  const match = /(?:Chrome|Edg)\/(\d+)/.exec(ua);
  if (match && Number(match[1]) < 120) {
    console.warn(
      `[specter-core] Chromium ${match[1]} detected; the supported baseline is Chromium >= 120. ` +
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

  // Mount the desktop FIRST — a cold boot must never wait for the ~40 MB of
  // bundled files (system tools + music + images) to be fetched and written
  // into OPFS. Provisioning runs in the background afterwards; guest apps
  // (notepad/cmd) lazily re-ensure the win files if launched before it finishes.
  const desktop = kernel.container.resolve(tokens.uiDesktop) as DesktopController;
  await desktop.mount(container);

  if (kernel.container.has(tokens.hostFileStore)) {
    const fs = kernel.container.resolve(tokens.hostFileStore) as FileStore;
    void provisionBundledFilesInBackground(fs);
  }

  return kernel;
}