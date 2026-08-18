import type { Plugin, PluginContext } from '@bk/contracts';
import { tokens } from '@bk/contracts';
import { DriverRegistryImpl } from './usb/registry';
import { PnPManagerImpl, HidUsbDriver, MassStorageUsbDriver } from './usb/pnp';
import { WebGpuDisplayDriver } from './graphics/display';

/**
 * L4 device driver abstraction layer plugin.
 * Registers the USB driver registry, PnP manager and display driver.
 * New drivers are registered here or injected by third-party plugins.
 */
export const DriverLayerPlugin: Plugin = {
  id: 'driver.layer',
  name: 'Driver Layer (L4)',
  version: '0.1.0',
  description: 'USB driver model (IRP/URB), PnP manager, WebGPU display driver',
  dependsOn: ['bridge.layer', 'core.layer'],

  async setup(context: PluginContext): Promise<void> {
    const { container, events, logger } = context;

    const registry = new DriverRegistryImpl();
    registry.register(new HidUsbDriver());
    registry.register(new MassStorageUsbDriver());
    container.registerInstance(tokens.driverRegistry, registry);

    const pnp = new PnPManagerImpl();
    pnp.attachBinder((device) => registry.findFor(device));
    container.registerInstance(tokens.driverPnP, pnp);

    const display = new WebGpuDisplayDriver(() => container.has(tokens.hostGpu));
    container.registerInstance(tokens.driverDisplay, display);
    logger.info('drivers: %s', registry.list().map((d) => d.id).join(', '));

    // Wire PnP to USB connect/disconnect events
    events.on('host:usb:connected', (device) => {
      void pnp.notifyDeviceAdded(device).then((attached) => {
        const driver = registry.findFor(device);
        if (driver) events.emit('drivers:usb:attached', { driverId: driver.id, device });
        void attached;
      });
    });
    events.on('host:usb:disconnected', (device) => {
      void pnp.notifyDeviceRemoved(device).then(() => {
        events.emit('drivers:usb:detached', { driverId: 'unknown', device });
      });
    });
  },
};