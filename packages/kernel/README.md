# @specter-core/kernel

The **kernel assembler**: a small dependency-injection (IoC) container, a typed
event bus, and plugin lifecycle management that wires the six layers together into a
running system.

## Modules

| File | Role |
|---|---|
| `container.ts` | Lightweight DI container: `register`, `resolve`, `registerInstance`, `resolveAsync`, `has`, `unregister`, `dispose`. |
| `kernel.ts` | `Kernel` runtime lifecycle manager: `use()`, `init()`, `start()`, `stop()`, plus the container, event bus, and plugin context. |
| `event-bus.ts` | `EventBus<Events>` type-safe event system: `on`, `once`, `off`, `emit`, `clear`. |
| `plugin-registry.ts` | `PluginRegistry`: registration, listing, and **topological ordering** from `dependsOn`. |
| `logger.ts` | `ConsoleLogger` with log levels and a silent fallback. |
| `errors.ts` | `KernelError` plus DI-token / event-payload helpers. |

## Why loose coupling matters

The project enforces contract-first decoupling: layers communicate through interface
contracts (in `@specter-core/contracts`) and DI tokens rather than concrete imports.
Each layer package ships a plugin (e.g. `@specter-core/bridges` registers fs/GDI/audio/
USB bridges) that registers its services into the container once the kernel starts,
so runtime wiring stays declarative and testable.

## Example

```ts
kernel.use(bridgeLayerPlugin);   // registers host-backed services
kernel.use(corePlugin);          // registers JIT/PE/interceptor factories
await kernel.init();
await kernel.start();
```

Service lookups go through tokens (`kernel.resolve(SomeToken)`), and cross-cutting
notifications go through the event bus, keeping contracts stable while the
implementation layers evolve.

## See also

- `bridgeLayerPlugin` in `@specter-core/bridges` and the host plugin in
  `@specter-core/host`.
- Layer-dependency rules in [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md).