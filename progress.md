# specter-core Windows PE Emulator — Handover (2026-08-20, session 10)

> Single source of truth for continuing the work. Read fully before touching anything.
> All addresses are absolute VAs (image base 0x400000).
> Session 9's full handover is preserved below unchanged; this session was CI-only.

## Session 10 summary — CI fully green (typecheck + lint + test)

**GitHub Actions now passes all three gates for the first time.** Session 9 shipped
the interactive cmd desktop; this session unblocked CI, which had never run past
`pnpm install`. Fixed in sequence:

| Gate | Failure | Fix | Commit |
|---|---|---|---|
| install | `ERR_PNPM_OUTDATED_LOCKFILE` — `packages/ui` importer missing `@specter-core/bridges` | `pnpm-lock.yaml`: added `link:../bridges` entry (same shape as `apps/web`'s existing entry); deleted `pages.yml` (duplicate of `deploy.yml`, same name/trigger/concurrency) | `e76f464` |
| typecheck | 6 pre-existing errors in `handlers.ts` `vswprintfImpl` (`f[i]`/`out[k]` possibly-undefined under `noUncheckedIndexedAccess`) | `const ch = f[i] ?? ''`, `isDigit(f[i] ?? '')`, `const conv = f[i] ?? ''`, `(out[k] ?? 0)` guards; also removed deploy.yml's duplicate `Typecheck, lint and test` step (ci.yml runs those on every push) | `2bb9273` |
| lint | 7 errors: `prefer-const` (`handlers.ts:289 let p`); `no-unused-vars` ×5 (`guest-process.ts sentinel`; `diag-trap.ts valLo/valHi/fmtStr/oC` → `_`-prefixed); `no-empty` (`cmd-cwd-check.ts` catch block) | all fixed; local `eslint .` and `tsc --noEmit` both exit 0 | `d5e9556` |
| test | 11 failures in `raster.test.ts` — `GdiSurface` constructor fills pixels `0xffffffff` (white) but 14 background assertions expected black | **User decision: keep white** (Windows default `COLOR_WINDOW`; notepad renders white-bg/black-text correctly). Test contract updated: unpainted-background assertions `black` → `white`; the `clear()` no-arg default-black assertion stays black | `6fd919c` |

Decisions locked in this session (do not regress):
- **Surface background stays WHITE** (`0xffffffff`, `COLOR_WINDOW`). Do not revert the
  constructor; the test contract now matches it.
- `clear()` with no args clears to **black** — unchanged, still covered by a test.
- CI split: `ci.yml` (verify: typecheck+lint+test) / `deploy.yml` (install+build+publish
  only). No duplicate validation in the deploy path; never re-add `pages.yml`.
- Local verification loop before pushing: `tsc --noEmit` (exit 0) + `eslint .` (exit 0)
  + `vitest run` (all green). These three now define "done".

## Goal (this session, preserved from session 9)

Take the session-8 milestone (`cmd /c dir` works headless) and turn it into a REAL
interactive "Command Prompt" app in the browser desktop, then make `cd`/`dir`/`echo`
work interactively, wire the File Explorer to cmd, and diagnose why notepad cannot
save. Also copy a small set of real Windows fonts into the virtual disk.

Project root: `C:\Users\HUAWEI\Desktop\windows` (pnpm workspace, package `@specter-core`).
Target binary: `C:/Windows/SysWOW64/cmd.exe` (a CUSTOM build — its PE import table
parses as absent/nonstandard, and it has quirks documented below).

## Current Status (one paragraph)

**The browser desktop "Command Prompt" app now runs the REAL cmd.exe interactively:
banner, prompt, `dir`, `echo`, `cd <path>` (absolute and relative), `exit` all work,
and the cwd / volume label / serial are real.** File Explorer got three buttons that
open cmd in a folder or run a selected .exe through it. Four real fonts are staged in
`apps/web/public/win/Fonts/` and provisioned to `Windows\Fonts`. Two known cmd
format-string artifacts remain (`Not enough storage is available...` on stderr at
startup, and a `%0` tail on the banner) — they are pre-existing cmd quirks, harmless.
notepad **cannot save**: root cause fully identified (comdlg32 `GetSaveFileNameW` not
implemented + desktop launch doesn't pass a file path), fix pending user decision.

## How the desktop cmd works now (architecture)

- `apps.tsx`: `command-prompt` app → `render: () => null` (mirrors notepad's
  special-casing so the controller intercepts it).
- `desktop-controller.tsx` `launchGuestConsole()`:
  - reads `Windows/SysWOW64/cmd.exe` from the virtual disk (provisioned by
    `ensureBuiltinWinFiles`),
  - builds `GuestProcessRunner` with:
    - **`commandLine: ''` — CRITICAL.** A non-empty value (e.g. `'cmd.exe'`) makes
      this custom cmd treat itself as invoked-with-args and SILENTLY skip all command
      output (`dir`/`echo`/`cd` produce nothing). Empty = plain interactive shell.
    - `interactive: true`,
    - `cwd` (optional — cmd starts inside that folder),
    - `patches: [{ va: 0x41dea0, bytes: [0xc3] }]` (neutralize `__security_check_cookie`
      so the benign stack-cookie overflow in the interactive reader no longer fast-fails),
    - `probes: cmdFormatProbes()` (see below),
    - `readFile` → `toStorePath` → FileStore (MUI lookup works),
    - `onOutput` → `CmdConsoleChannel.push` → `CmdGuestTerminal`.
  - Terminal: `<pre>`-style output + input row; Enter → `runner.postInput(text + '\r\n')`.
- stdin: `postInput` appends to `stdinBuffer`; `ReadConsoleW/A` and
  `ReadFile(STD_INPUT_HANDLE)` go through `consoleRead` (blocks on empty buffer in
  interactive mode — same suspend/resume pattern as `GetMessageW`; EOF otherwise).
- stdout: `WriteFile`/`WriteConsoleW`/`WriteConsoleA` on the console pseudo-handles
  are captured → `onOutput`. **WriteFile is captured as RAW bytes** (cmd's CRT
  `printf` path; do NOT UTF-16-decode it — it corrupts `echo`/`dir`). WriteConsoleW is
  decoded UTF-16LE → UTF-8, stopping at the first NUL (banner/prompt path).

## Root causes found & fixed this session

| # | Symptom | Root cause | Fix |
|---|---|---|---|
| 1 | `dir`/`echo` produced NO output in browser (prompt only) | `commandLine: 'cmd.exe'` makes this custom cmd skip interactive command output entirely | Pass `commandLine: ''` in `launchGuestConsole` |
| 2 | cwd artifact `C:\cmd.exe` seen in early screenshots | That was the **diag harness's fake FS** (`buildExeFs` returns DIRECTORY for any non-wildcard path, so cmd's startup probe `cwd\cmd.exe` "existed"); the real MemoryFileStore-based FS returns not-found → no override. Not a real bug | Added `GuestProcessOptions.cwd` for the desktop; validated with `scripts/cmd-cwd-check.ts` against the real FS |
| 3 | `cd C:\Windows` failed with `ERROR_INVALID_DRIVE(0xf)` | `GetDriveTypeW/A` had NO handler → default 0 (DRIVE_UNKNOWN) → cmd thinks the drive doesn't exist | handlers.ts: `GetDriveTypeW/A` → `DRIVE_FIXED(3)` for drive-lettered roots; added `GetLogicalDrives` → `0x4` |
| 4 | `cd` failed with `ERROR_DIRECTORY(0x10b)` | cmd calls `FindFirstFileW("C:\Windows\")` (trailing backslash); `splitFindPattern` turned the empty tail into the pattern → no match → `ERROR_NO_MORE_FILES(18)` | `splitFindPattern`: strip trailing `[\\/]+`; bare drive (`C:`) → `{dir:'', pattern:'*'}` |
| 5 | `cd Windows` failed (relative) | cmd calls `GetFullPathNameW("\Windows", ...)` — leading-`\` = **relative to drive root, not cwd**; old handler prepended cwd → `C:\Desktop\Windows` (nonexistent) | `GetFullPathNameW`: 3-way — drive-absolute as-is; `\`-prefixed → prepend current drive letter; else prepend cwd |
| 6 | `Volume in drive C has no label.` + `1234-ABCD` | hardcoded placeholders in `GetVolumeInformationW/A` | label `'Specter FS'`; serial = `volumeSerial(rootPath)` (djb2 of root path, folded to 16-bit halves → `C:\` = `CDC7-CDC7`) |

## New core capability: runtime probes

`GuestProcessOptions.probes: Array<{ eip: number; fn: (rt: WasmRuntimeImpl) => void }>`
— per-block runtime workarounds driven from `onStep` (fired at block starts). Needed
because Bug18/Bug19-style fixes depend on live registers/memory and cannot be
expressed as static `patches`. The runner composes the user's `onStep` with the probe
dispatch when probes are provided.

`cmdFormatProbes()` (desktop-controller.tsx, ported from diag-trap.ts):
- `0x42e327` — space-padding formatter entry: when called from ret `0x430e52`
  (time→size gap, 4 spaces) or `0x405b52` (size→name gap, 2 spaces), recompute the
  actual string length from `[ecx+0x10]`, write the gap spaces + NUL, update
  `savedLen [ecx+8]`. (Bug19 — makes `dir` columns line up.)
- `0x4317b4` — 64-bit number formatter loop condition: force `[ebp-0xd8]` (saved
  separator length) to 1. (Bug18 — thousands separator for file sizes.)

## Files modified this session

| File | Change |
|---|---|
| `packages/core/src/process/guest-process.ts` | stdin queue + `postInput` + `consoleRead`; `WriteFile`/`WriteConsoleW`/`WriteConsoleA` console capture (WriteFile = raw bytes); `ReadFile(STD_INPUT)`; `cwd` option; `probes` option + onStep wiring; `GetFullPathNameW` root-relative fix; `GetModuleFileNameW/A` normalize `/`→`\`; PATH += `C:\Windows\SysWOW64`; FormatMessageW `errorCode: 0x13d as E` (kills the old TS error); removed orphaned WriteFile block |
| `packages/core/src/api/handlers.ts` | `GetDriveTypeW/A`; `GetLogicalDrives`; `volumeSerial()` + `'Specter FS'` label in `GetVolumeInformationW/A`; `splitFindPattern` trailing-separator fix |
| `packages/ui/src/desktop-controller.tsx` | `launchGuestConsole` (commandLine `''`, cwd, probes, GS patch); `openCommandPrompt(initialCommand?, cwd?)`; `cmdFormatProbes()`; `command-prompt` branch via `openCommandPrompt` |
| `packages/ui/src/apps/FileExplorerApp.tsx` | toolbar: 🖥 open CMD here; 📁🖥 open CMD in selected folder; ▶ run selected .exe via cmd (`start "" "C:\..."`) |
| `packages/ui/src/apps/CmdGuestTerminal.tsx` | terminal view (stdout `<pre>`, local echo, exit banner + Close) |
| `packages/ui/src/console-channel.ts` | `CmdConsoleChannel` (buffer + attach/detach + `markExited`/`onExit`) |
| `packages/ui/src/builtin-win.ts` | cmd.exe + en-US/zh-CN MUI + 4 fonts (`arial.ttf/arialbd.ttf/tahoma.ttf/consola.ttf` → `Windows/Fonts/`) |
| `packages/ui/src/apps.tsx` | `command-prompt` → `render: () => null`; removed `CommandPromptApp` import |
| `packages/contracts/src/ui.ts` | `DesktopController.openCommandPrompt(initialCommand?, cwd?)` |
| `apps/web/public/win/Fonts/` | 4 real fonts copied from host `C:\Windows\Fonts` (~3.3 MB total) |
| `scripts/cmd-cwd-check.ts` | NEW — validates the desktop stack end-to-end (real `MemoryFileStore` + `FileSystemBridgeImpl`, seeds cmd.exe + MUI, optional cwd, GS patch + probes, feeds `cd`/`dir`/`exit`, checks output) |
| `scripts/diag-trap.ts` | diagnostic harness (feeds updated to echo/cd/dir/exit; core probes unchanged) |

## Key addresses (cmd.exe) — keep from session 8 + new

- `0x41dea0` — `__security_check_cookie`; patched to `ret` (`0xc3`) at runtime for interactive runs.
- `0x42e327` — space-padding formatter entry (Bug19 probe, now also in the desktop runner).
- `0x4317b4` — 64-bit number formatter loop condition (Bug18 probe, now also in the desktop runner).
- Session 8's dir-chain addresses (0x431749, 0x424be0, 0x430e4d, 0x405b52, 0x41d755, 0x408b1c, ...) are preserved below in the Session 8 appendix.

## notepad cannot save — root cause (PENDING FIX, decision needed)

Two independent layers:

1. **Save As / Open dialog — completely unimplemented.** notepad's Save As goes
   through `comdlg32!GetSaveFileNameW`; File > Open uses `GetOpenFileNameW`. **There
   are ZERO handlers for either** (grep of `packages/core/src` and `packages/ui/src`
   is empty; comdlg32 is only in the module allowlist). The dialog never appears, so
   Save As fails silently. Same for File > Open.
2. **Save (Ctrl+S, existing file) — broken by the desktop launch path, not by I/O.**
   `WriteFile` → `host.fs.writeFile` → `MemoryFileStore.write` is fully implemented and
   works. But `launchGuestWindow` never passes a file path as `commandLine`, so notepad
   opened from File Explorer starts "Untitled" — Ctrl+S then falls into the Save As
   dialog (layer 1).

Fix options (user to pick):
- **Quick (recommended)**: make `launchGuestWindow` accept a `commandLine`/file-path
  arg; when File Explorer opens a `.txt`, pass the store path so notepad's Ctrl+S
  writes back to the original file via `WriteFile`.
- **Full**: implement minimal `GetOpenFileNameW`/`GetSaveFileNameW` stubs (host-driven
  path provider) so notepad's dialogs work. Medium effort.

## explorer.exe — assessed, NOT recommended (decision pending)

Running the real `explorer.exe` (the user's "一劳永逸" idea) is not feasible:
- It needs the whole shell stack: shell32 (0 handlers), COM runtime (`CoCreateInstance`
  is a stub returning E_NOTIMPL, no IShellFolder/IShellView/IContextMenu), comdlg32 (0),
  a real registry (ours is zero-value stubs), DWM/uxtheme/comctl32 v6, and Win11's
  XAML-based shell. Even its import table doesn't parse with a standard PE reader.
- cmd.exe (the simplest console app) needed 5+ workarounds; explorer is orders of
  magnitude more complex. Expected outcome: a window that draws nothing or crashes at
  the first COM call, after days-to-weeks of work.

**Recommended alternative (option A):**
1. Standardize the virtual disk to real Windows layout: `C:\Users\Guest\Desktop`,
   `Documents`, `Downloads`, `Pictures`, `Music`, `Videos`, plus `C:\Windows\System32`
   etc. — all reads/writes stay on standard Win32 APIs.
2. Upgrade OUR FileExplorerApp to Windows-style: tree sidebar (This PC / Desktop /
   Documents...), standard folder shortcuts, right-click context menu, multi-select,
   drag-drop, and OUR OWN open/save dialog (replaces comdlg32 for user-facing flows).
3. Cheap "real Windows" feel: extract real `.ico` icons from `imageres.dll` /
   `shell32.dll` (a few KB each) for the explorer UI. Fonts already copied.

Option C (smallest step): standard user dirs + notepad Ctrl+S quick fix.

## Quick Commands

```bash
# --- Desktop-stack validation (real MemoryFileStore + bridge + cmd.exe) ---
BS=$(ls -d node_modules/.pnpm/esbuild@*/node_modules/esbuild/bin/esbuild | head -1)
"$BS" --bundle scripts/cmd-cwd-check.ts --outfile=node_modules/.cache/cmd-cwd-check.cjs \
  --platform=node --format=cjs --target=es2020 --external:typescript
# usage: cmd-cwd-check.cjs <cmd.exe path> <initial cwd>   (env BK_ARGS for commandLine)
"C:/Users/HUAWEI/.workbuddy/binaries/node/versions/22.22.2/node.exe" \
  node_modules/.cache/cmd-cwd-check.cjs "C:/Windows/SysWOW64/cmd.exe" "C:\Windows"

# --- diag-trap harness (fake FS + probes, session 8 style) ---
"$BS" --bundle scripts/diag-trap.ts --outfile=node_modules/.cache/diag-trap.cjs \
  --platform=node --format=cjs --target=es2020 --external:typescript
BK_ARGS="" "C:/Users/HUAWEI/.workbuddy/binaries/node/versions/22.22.2/node.exe" \
  node_modules/.cache/diag-trap.cjs "C:/Windows/SysWOW64/cmd.exe" \
  > node_modules/.cache/out.bin 2> node_modules/.cache/out.log

# --- typecheck (changed files only) ---
"C:/Users/HUAWEI/.workbuddy/binaries/node/versions/22.22.2/node.exe" \
  node_modules/typescript/bin/tsc --noEmit -p tsconfig.json 2>&1 | grep -E "guest-process|handlers|desktop-controller|builtin-win|FileExplorerApp|CmdGuestTerminal|console-channel|apps.tsx"

# --- esbuild syntax check on a file ---
"$BS" packages/core/src/process/guest-process.ts --format=esm --outfile=/dev/null

# --- disassemble a window (VA, not RVA) ---
PYEXE=$(ls /c/Users/HUAWEI/.workbuddy/binaries/python/envs/*/Scripts/python.exe 2>/dev/null | head -1)
"$PYEXE" scripts/disasm-win.py "C:/Windows/SysWOW64/cmd.exe" <va-hex> <len-hex>
```

Note: Git Bash mangles env-var backslashes (`'C:\Windows'` → `C:/Windows`); when
testing cwd paths use the argv argument (also mangled to `/` — the check tolerates
both separators by comparing the last path component).

## Known artifacts / caveats (do NOT chase these again without new evidence)

- **`Not enough storage is available to process this command.`** — printed once on
  stderr right after the banner (cmd formats system message id 8; source is cmd's own
  internal error path, likely the custom build's `GetEnvironmentVariable`/registry
  probe failing). Cosmetic; present in the very first browser screenshots too.
- **Banner ends with `%0`** (`Microsoft Windows [Version ...]%0`) — cmd format-string
  quirk of this build. Cosmetic.
- **GS cookie patch still required** for interactive cmd: `0x41dea0 → ret`. Root cause
  (JIT stack-cookie slot overflow in the interactive reader) still unfixed — the same
  family as session 8's Bug18/Bug19.
- CI is green as of session 10 (typecheck/lint/test all pass — see Session 10 summary
  above). Keep `tsc --noEmit` / `eslint .` / `vitest run` at exit 0 before pushing.
- The old JS `CommandPromptApp.tsx` (JS shell) is unused; kept on disk for reference.
- `dir` column widths rely on the two probes; if a future cmd build shifts those VAs,
  the probes silently no-op (output stays readable but columns may collapse).

## Session 8 historical appendix (cmd /c dir, headless) — preserved

Goal was: run `cmd /c dir C:\Windows`, emit listing to stdout, exit 0. **All 4 known
problems fixed (workarounds), exit 0.** Key content preserved for JIT work:

- **Bug17** header `C:\`→`C:\Windows`: `GetFileAttributesW/A` now registered in
  handlers.ts (dir enum path).
- **Bug18** size `263,`→`263,168`: probe at `0x4317b4` forces separator length=1.
- **Bug19** row spacing: probe at `0x42e327` writes gap spaces for ret `0x430e52`
  (4 sp) / `0x405b52` (2 sp) and updates `[obj+8]` savedLen.
- **Bug16** WriteConsoleW nChars=capacity: NUL-truncate on decode.
- dir-chain addresses: `0x431749` 64-bit number formatter; `0x424be0` div-by-10;
  `0x446ad0` separator `","`; `0x42e3c3` `rep stosd` fill loop (suspect, unproven);
  `0x430e4d`/`0x405b52` padding call sites; `0x41d755` vswprintf wrapper; `0x408b1c`
  dir exec; `0x40a320` dir outer handler; `0x4098e0` dispatcher; `0x430b52` summary.
- IAT slots: `0x4500dc` GetDiskFreeSpaceExW, `0x450460` wcschr, `0x450494` memset,
  `0x45042c` _o___stdio_common_vswprintf, `0x45045c` wcsrchr, `0x450100` GetVolumeInformationW.
- Logs: `node_modules/.cache/cmd-fix109-out.bin` = session 8 "ALL FIXED" output.
