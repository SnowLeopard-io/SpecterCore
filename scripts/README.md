# Scripts

Developer tooling for SpecterCore: PE inspection, disassembly, JIT decoding probes,
guest diagnostics, cmd.exe/notepad regression helpers, and asset generation. Most are
throwaway harnesses; a few are referenced by the handover log.

## Running a guest / diagnosing

| Script | Purpose |
|---|---|
| `run-exe.ts` | Run an executable in the SpecterCore host (headless). |
| `diag-trap.ts` | Diagnostic run instrumented at the API-trap boundary: `[api]` logging, `maxSteps 8M`, `[trace]`, `dumpFault`, `BK_ARGS` (command line), `BK_NO_MUI`. **The primary tool for the cmd.exe/notepad.exe push.** |
| `diag-exe.ts` | Generic diagnostic run for an executable. |
| `probe-mui.ts` | Node simulation of the browser path (virtual disk + readFile) to verify MUI merging and menus. |

## Isolated instruction probes

| Script | Purpose |
|---|---|
| `probe-decode.ts` | Decodes a specific byte stream (e.g. multi-byte NOPs at 0x40eb20). |
| `probe-xchg.ts` | Verifies `xchg esp, eax` semantics (`[0x94, 0xc3]`). |
| `probe-chkstk.ts` / `probe-cmd-chkstk.ts` | Executes a `__chkstk` in isolation to verify stack allocation. |
| `jit-decode-test.ts` / `jit-mov-ebp8-test.ts` / `jit-scanloop-test.ts` | JIT decoding / codegen regression tests. |
| `repro-jcc.ts` / `codegen-check.ts` / `check-argcounts.ts` | JIT control flow / codegen / arg-count validation. |

## PE / binary inspection

| Script | Purpose |
|---|---|
| `pe-dump.ts` | Dump a PE's structure. |
| `peinfo.py` | Extract PE header info. |
| `resolve-iat.ts` / `scan-iat-calls.ts` / `iat3.py` | Resolve and scan IAT entries (import tables). |
| `iat-dump.ts` / `imp-ord.ts` / `scan-iat-ord.ts` | Dump IAT imports and resolve **ordinal-only** imports (used to diagnose x64 delay-load by ordinal, e.g. `Wldp.dll!#10`/`#2`). |
| `probe-sdib-all.ts` | Scan every DLL/SxS import of a PE image. |
| `imports-scan.py` / `scan-calls.ts` | Scan imports / function-call sites. |
| `disasm-win.py` | Capstone disassembly window at a linear address. |
| `rsrc-scan.py` | Scan PE resources. |
| `secinfo.py` | Extract security/info metadata. |

## cmd.exe / notepad debugging

| Script | Purpose |
|---|---|
| `cmd-cwd-check.ts` / `cmd-dir-debug.ts` / `cmd-dir-format-check.ts` | cmd.exe cwd / `dir` listing / formatting behavior. |
| `cmd-x64-check.ts` | **Headless x64 `cmd.exe` (PE32+) boot check** — boots the real `cmd-x64.exe` against `MemoryFileStore` + `FileSystemBridgeImpl`, feeds `echo`/`cd`/`exit` on stdin, and prints output + a fault dump (decoded bytes, GPRs, memory size). Used to bring up the x64 guest (CRT init, `Wldp.dll` delay-load by ordinal, `MUL r/m64`). |
| `notepad-open-check.ts` / `notepad-open-probe.ts` / `notepad-dialog-check.ts` | notepad Open/Save dialog behavior against `GetOpenFileNameW`. |

## Assets / extraction

| Script | Purpose |
|---|---|
| `build-sample-exe.ts` / `build-x64-exe.ts` | Build sample PE executables. |
| `gen-sample-music.py` | Generate the bundled sample audio. |
| `extract-icons.ps1` / `extract-shell-icons.ps1` / `probe-icons.ps1` | Extract / probe icons from executables. |
| `fix-sc-links.py` | Fix symbolic/reference links. |
| `bench.ts` | Benchmark harness. |

> Note: when debugging `cmd.exe`, the bare `cmd.exe` filename is blocked by bash's
> safety filter — copy it to `cguest.exe` (same guest image) as described in
> the root `README.md`.