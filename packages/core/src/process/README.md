# Process layer (`packages/core/src/process`)

Guest process/thread state, virtual memory, kernel-like object bookkeeping, and the
top-level runner that ties the JIT, PE loader, and API interceptor together.

## Modules

| File | Role |
|---|---|
| `memory-manager.ts` | Manages guest virtual-memory regions and the bookkeeping behind `VirtualQuery`, heap, and memory hooks during guest execution. |
| `object-manager.ts` | Kernel-like object state that supports guest-state helpers such as TEB/TLS and scratch allocation. |
| `process-manager.ts` | Process/thread lifecycle: `createProcess`, `createThread`, `terminateProcess`, `terminateThread`, handle and scheduling records. |
| `guest-process.ts` | **`GuestProcessRunner`** — orchestrates the full guest PE run: reset CPU, load PE, map sections, patch memory, seed the stack, install startup/resource/GUI/SEH/file hooks, execute blocks via the `Executor`, dispatch `int 0x2E` traps through the `ApiTrapDispatcher`, merge MUI resources, and report the `GuestProcessResult`. |
| `gdi-bridge` | GDI is bridged from the process layer through the `GdiBridge` contract; the placeholder `NullGdiBridge` and the software rasterizer live in `@specter-core/bridges`. |

## GuestProcessRunner

`run(image, options)` produces a `GuestProcessResult` carrying:

- **status / exit code / clean-exit flag** — see the note below about what counts as
  success.
- **eip**, **stubs**, and any error.
- **stdout / stderr** round-tripped from the interactive I/O options.
- **windows / paint commands** emitted through the GDI bridge.
- **MUI state** (`muiLoaded` / `muiSource`) from satellite-resource merging.

Important: `status=exit eip=0x0` is **not** a reliable success marker. An API
fail-fast (`TerminateProcess(0xC0000409)`) followed by garbage execution can also end
in `eip=0x0`. Success is confirmed by the absence of `TerminateProcess(0xc0000409)`
and the expected guest output.

## Standard-handle emulation

`guest-process.ts` seeds fake handles for `GetStdHandle` (fd 0/1/2 → `STD_INPUT/OUTPUT
/ERROR_HANDLE`), `_o__get_osfhandle`/`GetFileType` for the CRT, and an interactive
stdin/stdout bridge so command-line tools like `cmd.exe` can read/write console I/O.

## x64 delay-load fix (`ResolveDelayLoadedAPI`)

For x64, the delay-load thunk table is **8-byte** per entry. The ordinal marker is
`IMAGE_ORDINAL_FLAG64` (bit 63 of the full 8-byte thunk-data), not the low dword the
32-bit path reads. The fix reads the full 64-bit thunk-data (`rd64`), detects the flag,
and resolves by ordinal (`#${entry & 0xffff}`); the resolved pointer is written as a
full 8 bytes (`writeInt32(thunk, stub)` + `writeInt32(thunk+4, 0)`). Without this,
ordinal-only imports (e.g. `cmd.exe` delay-loading `Wldp.dll` by `#10`/`#2`) are mistaken
for tiny name RVAs, the proc name comes back empty, `ResolveDelayLoadedAPI` returns 0,
and CRT init aborts.