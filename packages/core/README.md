# @specter-core/core

The **L3 execution core** of SpecterCore. It turns a Windows x86 PE into a runnable
guest inside the browser by decoding x86 to a typed IR, JIT-compiling basic blocks
to WebAssembly, and trapping Win32 API calls into TypeScript handlers (high-level
emulation, HLE).

## What lives here

```
src/
├── jit/       x86 decoder → IR → WASM codegen, runtime, block executor, trap dispatcher
├── pe/        PE32/PE32+ loader and section mapper with IAT rewriting
├── process/   guest virtual memory, objects, process/thread lifecycle, and the GuestProcessRunner
├── api/       API-Set normalization + handler router and the default Win32 handlers
└── index.ts   public barrel; plugin.ts exposes core facilities to the rest of the kernel
```

## The execution pipeline

1. A caller loads a PE file and creates a `GuestProcessRunner`.
2. `pe/loader.ts` parses the PE image into a `PeImage`.
3. `pe/mapper.ts` maps sections into guest WASM linear memory, rewrites the import
   address table (IAT) into trap stubs, and returns the stubs.
4. `process/guest-process.ts` resets CPU state, seeds the stack, applies patches,
   installs startup / resource / GUI / SEH / file hooks, and builds the
   `ApiTrapDispatcher` and `Executor`.
5. `jit/engine.ts` / `jit/executor.ts` run compiled blocks through the codegen,
   WASM encoder, and runtime.
6. When the guest hits an API trap, `jit/trap-dispatcher.ts` builds an
   `ApiCallContext` and dispatches it into `api/interceptor.ts`.
7. `api/interceptor.ts` normalizes API-Set module names and calls the registered
   handler from `api/handlers.ts` or a guest-process-local hook.

Every sub-module has its own README — see `src/jit`, `src/pe`, `src/process`, and
`src/api`. The canonical cross-layer contracts (interfaces + DI tokens) live in
the `@specter-core/contracts` package; this package only depends on
`@specter-core/contracts` and the layers below it, per the rules in
[docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md).