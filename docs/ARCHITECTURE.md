# SpecterCore — Architecture

> SpecterCore runs Windows x86 applications in the browser through WASM + high-level emulation (HLE).
> This document describes the repository's layered architecture, the decoupling mechanisms, and how to extend it.

## Layer overview

The repository mirrors the six-layer design in the `packages/*` directories; `apps/web` is the browser entry point.

```
┌─────────────────────────────────────────────────────────────┐
│ apps/web (Vite)  ─ bootstrap: assemble Kernel + layer plugins    │
├─────────────────────────────────────────────────────────────┤
│ L6  packages/ui        Desktop shell: window manager / taskbar / start menu │
│ L4  packages/drivers   USB driver model (IRP/URB) / PnP / display driver    │
│ L3  packages/core      Process / memory / kernel objects / API interceptor / PE+JIT │
│ L2  packages/bridges   FS / GDI / audio / USB bridging (Win32 semantics)    │
│ L1  packages/host      OPFS / worker pool / WebUSB / WebGPU / WebAudio       │
│     packages/kernel    DI container / event bus / plugin system / lifecycle  │
│     packages/contracts Cross-layer interface contracts + DI tokens (single source of truth) │
│     packages/shared    Framework-agnostic utilities (paths / wildcards / async)   │
└─────────────────────────────────────────────────────────────┘
```

Layer dependency order: `host → bridges → core → drivers → ui`, wired by the `Kernel` in `dependsOn` topological order.

## The three decoupling mechanisms

1. **Contracts-first**
   `@specter-core/contracts` contains only types / enums / constants — zero implementation. Every package
   depends on it (plus `shared`). Swapping a layer's implementation (e.g. `NullGdiBridge` → `CanvasGdiBridge`)
   never touches another layer.

2. **DI tokens**
   `contracts/src/tokens.ts` centrally defines the service tokens. Each layer plugin registers its
   implementations in `setup()` via `container.registerInstance(tokens.xxx, impl)`; consumers resolve them with
   `container.resolve(tokens.xxx)`. Tokens are the only coupling point between layers — and the extension point.

3. **Event bus**
   `contracts/src/events.ts` defines the system-wide event table (USB plug/unplug, process create/exit, window
   events, …). Layers only publish events — they never import another layer to send a message. New events added
   to the table can be subscribed by any layer.

## Plugin lifecycle

Each logical layer is a `Plugin` (`contracts/kernel.ts`). The `Kernel` sorts them topologically by `dependsOn`

```
host.layer → bridge.layer → core.layer → driver.layer → ui.layer
```

```
new Kernel({...})
  .use(HostLayerPlugin).use(BridgeLayerPlugin)…  // or plugins: [...]
await kernel.init();   // setup: register services, wire event subscriptions
await kernel.start();  // start: spin up hardware adapters (USB listener, etc.)
await kernel.stop();   // stop in reverse dependency order → dispose container + event bus
```

## Ports & Adapters

A contract is a port; the browser implementation and the test implementation are interchangeable adapters:

- `FileStore` (`contracts/host.ts`)
  - Browser adapter: `OpfsFileStore` (`@specter-core/host`)
  - Test adapter: `MemoryFileStore` (`@specter-core/host`, pure in-memory)
  - The upper `FileSystemBridgeImpl` is completely agnostic to which one is wired.

## Win32 semantic bridging

`@specter-core/bridges/fs.ts` is the most complete end-to-end chain:

```
CreateFile/ReadFile/WriteFile/SetFilePointer/FindFirstFile/…
        │  (Win32 error codes, handle table, share modes, wildcards)
        ▼
      FileStore (OPFS or in-memory virtual disk)
```

## Plugin extension guide

| What you want to do            | How |
| ------------------------------ | --- |
| New file backend               | implement `FileStore`, register at `tokens.hostFileStore` |
| New graphics backend           | implement `GdiBridge`, register at `tokens.bridgeGdi` |
| New USB class driver           | implement `UsbDriver`, `registry.register(driver)` |
| New desktop app                | add an `AppDefinition` in `@specter-core/ui/src/apps.tsx` |
| New Windows API                | `interceptor.hook('module.dll','Proc',handler)` |
| Replace any layer implementation | write your own plugin registering the same token (last registered wins) |

## Performance metric anchors

Design-doc section 7.1 metrics are pre-placed in the contract layer:

- JIT compile throughput → `JitEngine.getStats()`
- Syscall latency → `ApiInterceptorImpl.dispatch()` timing
- Memory usage → `MemoryManagerImpl` region stats + `WasmRuntime`
- Frame rate → `DisplayDriver.onVsync` / `GpuAdapter.onFrame`

## Milestones

- P0: full skeleton runnable — `pnpm test/build/lint` pass.
- P1: PE loading + x86 JIT — delivered (see the table in the [README](../README.md)).
- Ongoing: see the [development/handover log](PROGRESS.md).

## Related commands

```bash
pnpm install        # install dependencies
pnpm dev            # start the Vite dev server (COOP/COEP headers)
pnpm test           # Vitest unit tests
pnpm typecheck      # workspace-wide TypeScript check
pnpm lint           # ESLint
pnpm build          # build the deployable static site (apps/web/dist)
```