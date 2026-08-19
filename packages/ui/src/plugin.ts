import type { Plugin, PluginContext } from '@specter-core/contracts';
import { tokens } from '@specter-core/contracts';
import { WindowManagerImpl } from './window-manager';
import { DesktopControllerImpl } from './desktop-controller';

/**
 * L6 UI layer plugin: creates the window manager and desktop controller.
 * Mounting into the DOM is done by the app bootstrap after kernel.start().
 */
export const UiLayerPlugin: Plugin = {
  id: 'ui.layer',
  name: 'UI Layer (L6)',
  version: '0.1.0',
  description: 'Windows-style desktop shell, window manager, taskbar and start menu',
  dependsOn: ['core.layer', 'host.layer', 'driver.layer'],

  async setup(context: PluginContext): Promise<void> {
    const { container, events, logger } = context;

    const windowManager = WindowManagerImpl.create();
    container.registerInstance(tokens.uiWindows, windowManager);

    windowManager.onWindowCreated((window) => events.emit('ui:window:created', window));
    windowManager.onWindowClosed((id) => events.emit('ui:window:closed', { id }));

    const desktop = new DesktopControllerImpl(context.kernel);
    container.registerInstance(tokens.uiDesktop, desktop);

    logger.info('ui layer ready');
  },
};