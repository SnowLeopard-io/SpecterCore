import type { DriverRegistry, UsbDeviceInfo, UsbDriver } from '@specter-core/contracts';

/**
 * USB driver registry (design doc 5.1).
 * Drivers are matched against devices by class/subclass/vendor/product.
 */
export class DriverRegistryImpl implements DriverRegistry {
  private readonly drivers = new Map<string, UsbDriver>();

  register(driver: UsbDriver): void {
    if (this.drivers.has(driver.id)) {
      throw new Error(`Driver "${driver.id}" already registered`);
    }
    this.drivers.set(driver.id, driver);
  }

  unregister(id: string): boolean {
    const driver = this.drivers.get(id);
    if (!driver) return false;
    driver.dispose();
    return this.drivers.delete(id);
  }

  findFor(device: UsbDeviceInfo): UsbDriver | null {
    for (const driver of this.drivers.values()) {
      if (driver.matches(device)) return driver;
    }
    return null;
  }

  list(): UsbDriver[] {
    return [...this.drivers.values()];
  }
}