# JIT layer (`packages/core/src/jit`)

The **x86 → WASM JIT compiler** and execution engine. This is the heart of the
"recompile Windows machine code" path: raw x86 bytes are decoded to an IR, compiled
to WebAssembly blocks, and executed against a shared linear memory that emulates the
guest address space.

## Modules

| File | Role |
|---|---|
| `x86-decoder.ts` | Decodes x86 (and 16/32-bit-flagged) instructions from raw bytes into typed IR. Handles prefixes, opcode maps (0F, SSE-ish escapes), ModRM/SIB/disp/imm, segment overrides, and multi-byte NOPs (`0F 1F`). |
| `ir.ts` | Typed IR node definitions representing decoded instructions and operand values. |
| `codegen.ts` | Compiles IR basic blocks into executable WASM, allocating temporaries (L_TMP/L_TMP2…), emitting moves (`emitXchg`, `emitXadd`, `emitCmpXchg`, `emitCmov`), and rewriting `int 0x2E` traps. |
| `wasm-encoder.ts` | Low-level WebAssembly binary encoder used by the codegen. |
| `runtime.ts` | The WASM execution context: CPU registers/flags, linear memory, and helper read/write primitives used by guest code and API handlers. |
| `cpu.ts` | CPU context layout and register/flag helper functions shared by the executor, trap path, and SEH/setup code. |
| `engine.ts` | Coordinates basic-block compilation and execution (the JIT engine entry point). |
| `executor.ts` | Runs compiled blocks, drives control flow step by step, and forwards traps to the given `TrapHandler`. |
| `trap-dispatcher.ts` | `ApiTrapDispatcher`: converts a caught API trap into an `ApiCallContext` and routes it into the interceptor. |

## Data flow

```
x86 bytes
   └─ x86-decoder ──(IR)──▶ codegen ──▶ wasm-encoder ──▶ WASM bytes
                                   │
                                   └──▶ engine / executor ──▶ runtime.ts (regs+memory)
                                            │ (on API trap)
                                            ▼
                                    trap-dispatcher ──▶ api/interceptor
```

## Divergence model

Instead of single-stepping every instruction, the executor runs straight-line blocks
and only inspects control flow at block boundaries, plus on `int 0x2E` (the trap
pointing at the API interceptor). Guest functions that call our stubs are resumed
with the real x86 stack discipline.

## Notes for contributors

- **The decoder is the stability bottleneck.** Bugs here affect every executable.
  Two notable examples in the handover log: `0F 1F` multi-byte NOPs must consume
  their ModRM bytes, and `C6 mov r/m8, imm8` must keep 8-bit operand size on dst/src,
  not just on the immediate.
- **codegen temporaries are shared by `storeOperand`.** A pattern that stashes a
  value in `L_TMP` and then calls `storeOperand` before reading it back will silently
  lose the exchange (the `xchg esp, eax` bug). Check temporaries against
  `storeOperand`'s own usage.
- The guest currently runs in a **single thread**; there is no multi-threaded guest
  scheduler yet.
- **x64 multiply (`emitMul64`, `codegen.ts`):** the three forms are now implemented:
  `imul r64, r/m64, imm` (low 64), signed single-operand `imul r/m64` (RAX = low 64,
  RDX = sign-extend(RAX)), and unsigned `mul r/m64` (RDX:RAX = full 128-bit product).
  The unsigned form splits into 32-bit half products to compute the high 64 bits, then
  writes RAX (low) and RDX (high) via `i64Store`. The decoder emits
  `{ op:'mul'|'imul', dst: r/m64 }` with **no** `src`/`target` for the single-operand
  forms, so the multiplier is read from RAX and the result is written back to RDX:RAX
  (not `dst`) — the same shape as the 32-bit `mul`/`imul` at `emitMul`.
- **x64 memory model caveat:** JIT-emitted guest loads/stores hit the shared WASM
  linear memory **directly** (no `ensure()`), so for x64 the buffer must already cover
  the guest's high addresses (the initial x64 stack top is `DEFAULT_STACK_TOP =
  0x08000000`, and the loader `ensure()`s `stackTop + 0x80000`). A guest that touches
  an address ≥ the current buffer size traps with "memory access out of bounds" — widen
  the initial/ensured memory for x64 to cover the addresses the binary actually uses.
- See the JIT module tests (`engine.test.ts`, `x86-decoder.test.ts`) and the probe
  scripts under [`scripts/probe-*.ts`](../../../../scripts/README.md) for isolated
  reproduction of tricky instructions.