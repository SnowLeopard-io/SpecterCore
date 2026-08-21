# @specter-core/drivers

The **L4 driver abstraction** — the device‑driver model (IRP/URB) and the concrete
driver implementations that sit between the core's kernel objects and the L1 host
adapters. This layer is where hardware‑class drivers (USB, display) are registered and
where PnP/registry bookkeeping lives.

## Modules

| Path | Role |
|---|---|
| `src/plugin.ts` | `DriverLayerPlugin` — registers the driver registry and built‑in drivers into the DI container. |
| `src/usb/pnp.ts` | USB Plug‑and‑Play manager — device arrival/removal, driver matching. |
| `src/usb/registry.ts` | USB driver registry — `registry.register(driver)` lets new class drivers plug in. |
| `src/graphics/display.ts` | Display driver model (`DisplayDriver.onVsync` / `GpuAdapter.onFrame`) backing the GDI/3D bridge. |

## Notes

- A new device class is added by implementing `UsbDriver` (contract in
  `@specter-core/contracts`) and calling `registry.register(driver)`; the rest of the
  system discovers it through the event bus and DI tokens, never by a concrete import.
- Drivers speak the IRP/URB contract in `contracts/drivers.ts` and reach the browser
  through the L1 USB bridge (`contracts/host.ts` → `UsbHostAdapter`).
- Audio / WebGPU 3D / USB passthrough are still **pending** (milestones P4–P7); the
  display and USB PnP scaffolding here is the landing zone for that work.
