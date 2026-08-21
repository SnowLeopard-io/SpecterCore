# PE layer (`packages/core/src/pe`)

Loads Windows PE32/PE32+ images and maps them into the guest linear memory that the
JIT runs against.

## Modules

| File | Role |
|---|---|
| `loader.ts` | Parses a PE byte buffer into a `PeImage` structure: DOS/NT headers, section table, optional header (arch, subsystem, entry point), data directories, and import/export metadata. |
| `mapper.ts` | `mapPeImage()` maps the PE's sections into guest linear memory and **rewrites the import address table (IAT)** into trap stubs so calls to imported Win32 functions land in our interceptor. Returns a `MappedImage` (base, entry point, stubs). |

## The IAT and arg-count table

`mapper.ts` owns `X86_API_ARG_COUNT`, the table that tells the trap-stub machinery
how many **stack slots** a stdcall callee pops (`ret N`). Getting an entry wrong is a
classic failure mode documented in the root [README](../README.md):

- Under-counting → stub `ret 0` while the caller expects `ret N` → args left on the
  stack → the caller's epilogue `pop edi/esi/ebx` reads shifted slots → garbage
  registers and fake-handle-is-pointer crashes.
- The delay-load `ResolveDelayLoadedAPI` path must look up the proc name
  **lower-cased**, matching the keys in `X86_API_ARG_COUNT`.

## Delay-load imports

`ResolveDelayLoadedAPI` is handled so that delay-imported functions (e.g. winbrand's
`BrandingFormatString`) also route through the same stub mechanism. Keep the
`toLowerCase()` normalization consistent between the static-import and delay-load
paths.

## See also

- `@specter-core/shared` ships a lightweight standalone PE header parser
  (`shell/pe.ts`) used by tooling; this package is the full runtime loader/mapper.
- Pipeline context: see `packages/core/README.md`.