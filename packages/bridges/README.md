# @specter-core/bridges

The **L2 bridge layer**: adapters that translate Windows system-function semantics
into browser/OS capabilities (OPFS-backed virtual disk, WebUSB, Web Audio, and a
software GDI rasterizer). This is where HLE meets the host.

## Modules

| File | Role |
|---|---|
| `plugin.ts` | `BridgeLayerPlugin` registers file-system, GDI, audio, and USB bridges onto the container, depending on `host.layer`. |
| `fs.ts` | `FileSystemBridgeImpl` maps Windows file APIs to the `FileStore` contract: CreateFile / ReadFile / WriteFile / SetFilePointer / FindFirstFile / attributes / locks. |
| `handle-table.ts` | `FileHandleTable`: numeric file handles, path-based handle tracking, sharing-conflict detection, and handle release. |
| `graphics.ts` | `NullGdiBridge` implements the `GdiBridge` contract as a placeholder (no-op / "not implemented") so guest paint requests degrade gracefully. |
| `raster.ts` | GDI **software rasterizer**: 32-bit ARGB `GdiSurface`, shape drawing, bit-block transfer, and ROP2/ROP3 index resolution. |
| `audio.ts` | `WaveOutAudioBridge` implements waveOut/DirectSound-style audio with host-side mixing and volume control, plus a no-op fallback. |
| `usb.ts` | `WasmUsbHostBridge` maps L3 USB handles to the L1 WebUSB adapter: device listing, open, and handle tracking. |

## Design intent

Bridges implement the interface contracts declared in `@specter-core/contracts`
(`fs.ts`, `graphics.ts`, `audio.ts`, `usb.ts`). The routing decision (a Windows call
→ implement it here vs. trap in core) lives in the core API layer; bridges stay
focused on translating to concrete host adapters.

## GDI roadmap

The current GDI layer is a **software rasterizer + paint-command capture** with a
no-op `NullGdiBridge` fallback. The "guest window" rendering path at the L6 desktop
layer still needs bitmap-level host rendering, which is tracked under the graphics
bridge milestone in [docs/PROGRESS.md](../../docs/PROGRESS.md).