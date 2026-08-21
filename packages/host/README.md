# @specter-core/host

The **L1 host layer** — the browser‑primitive adapters that back the Win32 contracts.
Everything here wraps a real browser API (OPFS, WebUSB, WebGPU, WebAudio, Web Workers)
so the layers above stay browser‑agnostic and unit‑testable against in‑memory doubles.

## Modules

| File | Role |
|---|---|
| `opfs.ts` | `OpfsFileStore` — the browser adapter for the `FileStore` port, backed by the Origin Private File System. |
| `memory-store.ts` | `MemoryFileStore` — pure in‑memory virtual disk (the test/demo adapter for `FileStore`). |
| `usb.ts` | `UsbHostAdapter` — WebUSB backing for the USB bridge (control / bulk / interrupt transfers, device filtering). |
| `gpu.ts` | `GpuAdapter` — WebGPU backing for the graphics/3D bridge. |
| `audio.ts` / `audio-worklet.ts` | `AudioAdapter` — WebAudio (AudioWorklet) backing for the audio bridge. |
| `worker-pool.ts` / `process-worker.ts` | Worker pool + per‑process worker plumbing for off‑main‑thread guest execution and heavy host tasks. |
| `environment.ts` | Secure‑context / cross‑origin‑isolation checks (`assertSecureContext`, COOP/COEP detection). |
| `plugin.ts` | `HostLayerPlugin` — registers the host adapters into the DI container at kernel `setup()`. |

## Notes

- The `FileStore` port is the most‑used bridge: `FileSystemBridgeImpl` (L2) is completely
  agnostic to whether `OpfsFileStore` or `MemoryFileStore` is wired, so the same FS
  semantics run in the browser and under Vitest.
- All adapters are registered by **token** (`tokens.hostFileStore`, …) in `plugin.ts`;
  swapping an adapter never touches the consuming layers.
- See [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) and the `bridges` package for
  how these adapters are consumed.
