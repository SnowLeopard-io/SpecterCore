# @specter-core/contracts

The **single source of truth** for cross-layer communication. This package contains
**only types, enums, constants, DI tokens, and event-table definitions — zero
implementation**. Every other package depends on it (and on `@specter-core/shared`),
never on a sibling's concrete class, which is what keeps the layers swappable.

## Layout

| Path | Role |
|---|---|
| `src/di.ts` | DI container interface (`register` / `resolve` / `registerInstance` …). |
| `src/tokens.ts` | Central registry of every service DI token — the only coupling point between layers, and the only extension point. |
| `src/events.ts` | The system-wide typed event table (`KernelEvents`) — USB plug/unplug, process create/exit, window events, `core:api:call`, `core:api:not-implemented`, …. |
| `src/kernel.ts` | `Plugin` / `Kernel` lifecycle contracts (`use`, `init`, `start`, `stop`). |
| `src/host.ts` | L1 host adapter **ports**: `FileStore`, `UsbHostAdapter`, `GpuAdapter`, `AudioAdapter`, environment/secure-context checks. |
| `src/bridge/*.ts` | L2 bridge **ports** — `fs.ts` (file-system bridge), `graphics.ts` (`GdiBridge`), `audio.ts`, `usb.ts`. |
| `src/core/*.ts` | L3 **ports** — `api.ts` (interceptor/handler contracts), `jit.ts` (`JitEngine` / `WasmRuntime`), `pe.ts` (`PeLoader`), `process.ts` (`GuestProcessRunner`). |
| `src/drivers.ts` | L4 driver contracts (`UsbDriver`, IRP/URB). |
| `src/ui.ts` | L6 UI contracts — `AppDefinition`, window-manager surface. |
| `src/package.ts` | Package metadata / version. |

## Rules

- **No implementation here.** Real code lives in the layer packages (`host`, `bridges`,
  `core`, `drivers`, `ui`). A contract is a *port*; the browser and test builds are
  interchangeable *adapters* (e.g. `OpfsFileStore` vs `MemoryFileStore` both satisfy
  `FileStore`).
- **New cross-layer capability?** Add the interface here, a token in `tokens.ts`, and
  (if it publishes) an event in `events.ts` — then implement it in the owning layer.

See [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) for the full layered design.
