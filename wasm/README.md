# WASM Sources (L3 / L4)

This directory is reserved for the C/C++ WASM sources that implement the
Windows compatibility core and device drivers. It is **not yet compiled**
(P0 intentionally ships interface contracts only).

## Toolchain (design doc 9.2)

- [Emscripten 3.1.x](https://emscripten.org) or [wasi-sdk](https://github.com/WebAssembly/wasi-sdk)
- Rust `wasm32-wasip1` target is an alternative for new code

## Planned modules

| Module | Package | Contract | Milestone |
| ------ | ------- | -------- | --------- |
| x86 JIT translator (i386 → WASM) | `@bk/core` JitEngine | `contracts/core/jit.ts` | P1 |
| PE loader + IAT rewriting | `@bk/core` PeLoader | `contracts/core/pe.ts` | P1 |
| API marshalling (WASM → TS) | `@bk/core` ApiInterceptor | `contracts/core/api.ts` | P1 |
| Wine HID / mass-storage drivers | `@bk/drivers` | `contracts/drivers.ts` | P6 |

## Build layout (proposed)

```
wasm/
├── third_party/      # Wine sources, x86 disassemblers (submodules)
├── jit/              # x86 -> WASM translator (C++ or Rust)
├── pe/               # PE loader
├── drivers/          # hidclass.sys / hidparse.sys (Wine)
└── build.sh          # emcc/wasi-sdk build script producing .wasm + .d.ts
```

## Interface contract with the TS layers

- The JIT produces `WebAssembly.Module` instances that execute inside the
  `WasmRuntime` linear memory (`contracts/core/jit.ts`).
- Trapped API calls are marshalled into `ApiCallContext` and dispatched by the
  `@bk/core` interceptor.
- Drivers speak the IRP/URB contract in `contracts/drivers.ts` and reach the
  browser through the WASI-USB bridge (`contracts/bridge/usb.ts`).

> Do not write new WASM code in this milestone. Add the `build.sh` pipeline and
> CI cache in P0-P1 when a concrete module exists.