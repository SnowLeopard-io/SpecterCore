# API layer (`packages/core/src/api`)

The **Win32 API interceptor** — the high-level emulation (HLE) half of SpecterCore.
When guest code calls an imported system function, the trap mechanism hands it to the
interceptor instead of real Windows.

## Modules

| File | Role |
|---|---|
| `interceptor.ts` | `ApiInterceptorImpl`: routes trapped API calls to registered handlers, **normalizes API-Set module names** (`api-ms-win-core-*`) back to real DLLs, and stores per-process last-error values (`setLastError`/`getLastError`). |
| `handlers.ts` | Default Win32 API handler implementations registered with the interceptor (kernel32 / ucrtbase / ole32 / ntdll / shlwapi / user32 …). |

## Module-name normalization

Windows redirects many imports through API-Set contract DLLs (e.g.
`api-ms-win-core-filesystem-l1-1-0.dll`). `normalizeApiSetModule()` maps these to the
concrete backing DLL (`kernel32.dll` etc.) so handlers can be looked up and registered
consistently.

## Handler dispatch

1. `ApiTrapDispatcher` (in `jit`) catches an `int 0x2E` trap and builds an
   `ApiCallContext`.
2. `interceptor.dispatch()` normalizes the module, resolves the handler by
   `module!FunctionName`, calls it with the decoded arguments, and writes back the
   return value into the guest's x86 `eax`.
3. Guest-process-local hooks (startup, resource, GUI, GDI, file) are layered on top of
   the default handlers.

## Adding a new API handler

Add the implementation to `handlers.ts` and register it (or hook it in
`guest-process.ts`). If the function uses the **stdcall** calling convention, also add
its stack-slot count to `X86_API_ARG_COUNT` in `pe/mapper.ts` — an incorrect count
corrupts the caller's stack and is one of the most common root causes of cmd.exe /
notepad.exe crashes. See `packages/core/src/pe/README.md` for the fallback rules.