# specter-core Windows PE Emulator — Handover (2026-08-20, session 12)

> Single source of truth for continuing the work. Read fully before touching anything.
> All addresses are absolute VAs (image base 0x400000).
> Sessions 10 & 11 full handovers are preserved unchanged below.

## Session 12 summary — notepad Save As ROOT-CAUSED & GREEN; file ops + direct .exe launch

**Goal:** finish the comdlg32 save fix (session 11 was stuck at "WriteFile never
called"), then add File Explorer right-click ops, move the disk-wipe button out,
and make double-clicking an .exe launch it directly (no shell windows).

**Status: all done, verified.** notepad Save As now writes the file through the
REAL comdlg32 dialog (verifier PASS), the desktop + File Explorer have
copy/paste/rename/delete right-click menus, Wipe Virtual Disk is out of the
desktop menu (kept on DesktopController for a future Settings window), and
double-clicking any .exe runs the real guest directly.

## The big root cause (session 12) — LocalLock missing from X86_API_ARG_COUNT

Session 11's frontier: after WideCharToMultiByte's length query, notepad jumped
straight to SetEndOfFile — WriteFile was never called; the write helper
`0x410a66` bailed because its 3rd arg (stack slot `[esp+0x18]`) was 0.

**Root cause: `locallock`/`localunlock` were NOT in `X86_API_ARG_COUNT`** (only
localalloc/localrealloc/localfree/localsize were). The save routine does
`push ebx; call LocalLock`; with argCount 0 the trap stub generated `ret 0`
instead of `ret 4`, leaking 4 bytes and shifting every later `[esp+X]` read by
+4. So `0x410d2a: mov [esp+0x18], eax` (the encoding value 0xfde9=65001) landed
at `[esp+0x14]`, and `0x410d4a` read `[esp+0x18]` = 0 → 0x410a66 thought "nothing
to write" → file saved empty. Adding `'locallock': 1, 'localunlock': 1` fixed it.

How it was found: runtime probes (GuestProcessOptions.probes) at 0x410d41 /
0x410d4a / 0x410d7e showed `[esp+0x14]=0xfde9` but `[esp+0x18]=0x0` — a 4-byte
esp drift, pointing at a missing-argCount stub. **Enabling probes inside the
DispatchMessageW nested Executor was required first** (the save routine runs in
the WndProc nested executor, which previously had no onStep wiring).

## Other fixes this session

| Area | Change |
|---|---|
| `mapper.ts` | `'locallock': 1, 'localunlock': 1` (THE save fix); de-duplicated 7 duplicate X86_API_ARG_COUNT keys (TS1117 was being masked) |
| `guest-process.ts` | dispatchMessage nested Executor now receives `options.probes`/`onStep` (probes fire inside WndProc); SetEndOfFile handler → `host.fs.setEndOfFile` |
| `bridges/fs.ts` + `contracts/bridge/fs.ts` | NEW `FileSystemBridge.setEndOfFile(handle)` (truncate to current pointer via store `truncate`) |
| `handlers.ts` | WideCharToMultiByte/MultiByteToWideChar NUL semantics: explicit cchWideChar/cbMultiByte counts do NOT append/return NUL (only NUL-scan mode +1) — without this notepad wrote a trailing NUL and saved 24 bytes instead of 23 |
| `shared/shell/fs-ops.ts` (NEW) | `copyRecursive` / `deleteRecursive` / `moveRecursive` / `uniqueName` — recursive copy/move/delete over FileStore (store.move only handles files) |
| `ui/ui-clipboard.ts` (NEW) | module-level copy/paste singleton shared by File Explorer and Desktop (subscribe/get/set) |
| `ui/components/FileContextMenu.tsx` (NEW) | shared entry right-click menu: Open / Download / Run (exe) / Copy / Rename / Delete |
| `FileExplorerApp.tsx` | right-click on row → FileContextMenu; right-click on blank → New Folder / Paste / Refresh; inline rename input; context menu is absolute-positioned inside `.sc-explorer` (NOT fixed — `.sc-desktop` is fixed+overflow:hidden and traps fixed menus, the classic "menu never appears" bug) |
| `components/Desktop.tsx` | desktop icon right-click → FileContextMenu (Open/Download/Run/Copy/Rename/Delete) + inline rename; background menu Paste (clipboard non-empty) |
| `components/ContextMenu.tsx` | Wipe Virtual Disk REMOVED (per user: move to a future Settings window); added Paste item (onPaste when clipboard set) |
| `desktop-controller.tsx` | NEW `launchGuestExecutable(storePath)`: double-clicked .exe (open verb) runs the real guest directly — cmd.exe → `openCommandPrompt` terminal, notepad.exe → `launchGuestWindow` (fixed modulePath for MUI), others → hosted guest windows. No RunExecutableApp shell window |
| `RunExecutableApp.tsx` | removed Security-Warning confirm layer (auto-runs when `initialFile` set), removed Install button + installing phase, removed the "Console/Windows + Guest Window (GUI bridge)" debug panel (user: "这个东西直接不要"); start-menu entry without a file still shows the picker |
| `InstallerApp.tsx` | double-clicked .bkapp installs immediately (skips overview page) |

## Verifier: scripts/notepad-dialog-check.ts (PASS, exit 0)

Same harness as session 11 (real SysWOW64 notepad.exe + MemoryFileStore), now
asserting `saved.txt` contains "dialog-check". Also: the guest never posts
WM_QUIT, so `runner.run()` can hang after WM_CLOSE — the script now verifies
saved.txt via a timer independent of run() returning, and prints the verdict
with a SYNCHRONOUS `fs.writeSync(2, ...)` (process.exit truncates async stderr).

```bash
BS=$(ls -d node_modules/.pnpm/esbuild@*/node_modules/esbuild/bin/esbuild | head -1)
"$BS" --bundle scripts/notepad-dialog-check.ts --outfile=node_modules/.cache/notepad-dialog-check.cjs \
  --platform=node --format=cjs --target=es2020 --external:typescript
timeout 30 "C:/Users/HUAWEI/.workbuddy/binaries/node/versions/22.22.2/node.exe" \
  node_modules/.cache/notepad-dialog-check.cjs "C:/Windows/SysWOW64/notepad.exe"
# expect: [diag] saved.txt="Typed by dialog-check\r\n" / check PASS / exit 0
```

## Verification loop (all green)

- `tsc --noEmit` exit 0
- `eslint .` exit 0
- `vitest run` → 31 files / 253 tests ALL PASS (note: vitest finishes but the
  process lingers; `timeout 120` returns 124 — that's the timeout, not a failure)

## Still open / next

- **Settings window** (user said "等会儿做一个设置窗口放进去"): host the
  Wipe-Virtual-Disk action there. `DesktopController.wipeStorage()` is intact.
- Desktop/FileExplorer copy is a shared clipboard but **cut (move) is not
  implemented** — Copy+Paste always copies; user asked only for copy/paste.
- Double-clicking a *console* .exe that is neither cmd.exe nor has top-level
  windows will hang in the interactive message loop (same as before); a
  console-detection + terminal fallback could come later.
- The old `RunExecutableApp` shell is still registered for Start-Menu manual
  runs (picker). Notepad's bundled path (`windows-notepad` app) is unchanged.

---

# Session 11 historical handover — preserved unchanged

## Session 11 summary — notepad Save As (Full comdlg32 dialog fix), IN PROGRESS

**Goal (user decision): implement the FULL comdlg32 fix** — real `GetOpenFileNameW` /
`GetSaveFileNameW` handlers driven by a host-side virtual-disk dialog, so notepad's
File > Open and Save As actually work. (The "quick Ctrl+S" fix was explicitly REJECTED
by the user — do NOT do the commandLine/file-path shortcut.)

**Current status (one paragraph):** The dialog layer is fully wired: comdlg32
GetOpenFileNameW/A + GetSaveFileNameW/A handlers + OPENFILENAME marshal + a React
virtual-disk dialog (FileDialogApp) are in place. The headless verifier
(scripts/notepad-dialog-check.ts) drives a REAL notepad.exe Save As and the flow now
**advances past every previously-blocking API**: GetSaveFileNameW→TRUE, PathFileExistsW,
CreateFileW (with GetLastError cleared → 0), EM_GETHANDLE, LocalLock, GetACP,
WideCharToMultiByte (length query → 24). **But the file write still does not happen**:
after the WideCharToMultiByte length query notepad jumps straight to SetEndOfFile /
LocalUnlock / EM_SETMODIFY / CloseHandle — i.e. it thinks the save is done (no error
MessageBox anymore!) yet **WriteFile is never called**. Disassembly (below) shows
notepad's internal write helper 0x410a66 bails out early (returns 1, "nothing to write")
because a stack slot [esp+0x18] is 0. This is the current debugging frontier.

## Changes made this session (all verified: typecheck + lint pass)

| File | Change |
|---|---|
| `packages/core/src/pe/mapper.ts` | `X86_API_ARG_COUNT` += `getopenfilenamew/a:1`, `getsavefilenamew/a:1`, `commdlgextendederror:0`, `deletefilew/a:1`, `pathfileexistsw/a:1`, `widechartomultibyte:8`, `multibytetowidechar:6`, `wcsnlen:2`, `setendoffile:1`, `getfileattributesexw/a:3`, `pathfindextensionw:1`, `pathfindfilenamew:1` (stdcall arg counts so dynamic stubs `ret N` correctly) |
| `packages/contracts/src/bridge/fs.ts` | `WinError` += `ERROR_FILENAME_EXCED_RANGE=206`, `ERROR_CANCELLED=1223` |
| `packages/core/src/process/guest-process.ts` | `GuestProcessOptions.fileDialog?: (kind, opts: FileDialogOptions) => Promise<string\|null>` + exported `FileDialogOptions`; `installFileDialogs()` (4 comdlg32 handlers + OPENFILENAME 32-bit struct marshal: reads lpstrFile/nMaxFile/lpstrInitialDir/lpstrTitle/lpstrFilter, calls host `fileDialog`, writes path back UTF-16 + nFileOffset/nFileExtension, returns TRUE/FALSE; `CommDlgExtendedError`→ERROR_CANCELLED); CreateFileW success now `setLastError(pid, 0)` (was leaving stale error → notepad aborted save); NEW DeleteFileW/A (notepad deletes target before rewriting; missing → "This function is not supported on this system."); NEW PathFileExistsW/A (shlwapi + kernel32 alias); NEW LocalLock/LocalUnlock (fixed-block lock returns handle); NEW ucrtbase string handlers (wcsnlen/wcslen/strlen/wcscpy/wcsncpy/strcpy/strncpy/wcschr/wcsrchr/strchr/strrchr/wcsncmp/wcscmp/strncmp/strcmp); `guestHeapAlloc` field (bumpAlloc lifted out so GUI bridge can allocate); SendMessageW EDIT case `0x00bd EM_GETHANDLE` (allocates guest UTF-16 buffer with the text, returns its address — notepad reads it directly for save) |
| `packages/core/src/api/handlers.ts` | GetFileAttributesW/A failure now returns `0xffffffff` (INVALID_FILE_ATTRIBUTES) instead of 0 (notepad tests `== -1` for missing file); NEW GetACP→65001 / GetOEMCP→65001; NEW WideCharToMultiByte / MultiByteToWideChar (UTF-8 via TextEncoder/Decoder; cchWideChar<=0 treated as NUL-scan; **clears lpUsedDefaultChar output — notepad checks it after the call**); NEW `memWStrLen` helper |
| `packages/ui/src/apps/FileDialogApp.tsx` | NEW — React virtual-disk file dialog (open: pick file; save: pick dir + type name; Cancel/close → null), reuses sc-explorer styling |
| `packages/ui/src/desktop-controller.tsx` | `launchGuestWindow` passes `fileDialog` → new `showFileDialog(kind, opts)`: opens a desktop window with FileDialogApp, resolves with the chosen Windows path or null; window-chrome close counts as cancel |
| `packages/ui/src/styles.css` | `.sc-file-dialog*` styles appended |
| `scripts/notepad-dialog-check.ts` | NEW — headless end-to-end verifier (see below) |

## The verifier: scripts/notepad-dialog-check.ts

Runs the REAL `C:/Windows/SysWOW64/notepad.exe` against the REAL in-memory disk
(MemoryFileStore + FileSystemBridgeImpl — same stack as the browser desktop), then:
1. at 2.5 s posts EDIT text "Typed by dialog-check\r\n" and sends the File > Save As
   menu command (WM_COMMAND id=4, found from the parsed RT_MENU);
2. the host `fileDialog` provider returns a fixed path `C:\Users\Guest\Desktop\saved.txt`;
3. at 20 s posts WM_CLOSE to stop the guest (notepad otherwise loops forever);
4. asserts `dialogCalls >= 1` and the saved file contains "dialog-check".

```bash
BS=$(ls -d node_modules/.pnpm/esbuild@*/node_modules/esbuild/bin/esbuild | head -1)
"$BS" --bundle scripts/notepad-dialog-check.ts --outfile=node_modules/.cache/notepad-dialog-check.cjs \
  --platform=node --format=cjs --target=es2020 --external:typescript
"C:/Users/HUAWEI/.workbuddy/binaries/node/versions/22.22.2/node.exe" \
  node_modules/.cache/notepad-dialog-check.cjs "C:/Windows/SysWOW64/notepad.exe" \
  > node_modules/.cache/notepad-dialog-out.bin 2> node_modules/.cache/notepad-dialog-out.log
```

## The save flow today (from the log — each line is a fixed blocker)

```
GetSaveFileNameW                 -> 1     (dialog returned our path)
GetFileAttributesW(NULL)         -> 0 err=2 (notepad probes NULL; harmless)
PathFileExistsW(saved.txt)       -> 0     (does not exist yet)
CreateFileW(OPEN_ALWAYS=4)       -> 0x10  (handle OK)
GetLastError                     -> 0     (FIXED: was stale 2 → save aborted)
SendMessageW(WM_GETTEXTLENGTH 0xe)-> 23
SendMessageW(EM_GETHANDLE 0xbd)  -> 0x2004570 (FIXED: guest text buffer)
LocalLock(0x2004570)             -> 0x2004570 (FIXED)
GetACP                           -> 65001 (FIXED)
WideCharToMultiByte(65001,...,cchWide=0,...) -> 24  (length query OK)
   ^^^ NEXT DEBUGGING FRONTIER — after this notepad does NOT convert/write
SetEndOfFile                     -> 0 err=120 [NOT_IMPL]  (called, but no WriteFile happened before it)
LocalUnlock / EM_SETMODIFY / CloseHandle -> save considered "done", file is EMPTY
```

No error MessageBox appears anymore ("This function is not supported on this system."
is GONE — that was the DeleteFileW/NOT_IMPL blocker, fixed). The process reaches the
normal completion path but writes nothing.

## Disassembly evidence (notepad.exe) — why WriteFile is skipped

- The save routine lives around `0x410c00..0x41105a`. The write helper is `0x410a66`
  (it calls WideCharToMultiByte via IAT `0x42a3fc`, WriteFile via IAT `0x42a29c`,
  LocalUnlock via `0x42a2c4`).
- At `0x410d41..0x410d54` after the length query:
  - `cmp [esp+0x24], 0` — this is the **lpUsedDefaultChar** slot (we now clear it).
  - `mov ecx, eax` (ecx = 24), `test ecx,ecx; jne 0x410d7e` → takes the write path.
- `0x410d7e` loads args and calls `0x410a66`.
- **`0x410a66` starts with `cmp dword ptr [ebp+0x10], 0; jne continue; xor eax,eax;
  inc eax; jmp return` — i.e. if its 3rd argument (a stack slot, loaded from
  `[esp+0x18]` at `0x410d4a`) is ZERO it returns 1 ("nothing to write") and skips
  the WideCharToMultiByte conversion + WriteFile entirely.**
- `0x410d4a: mov eax, [esp+0x18]` — that slot is currently 0 in our runs, so the
  helper bails. On real Windows it is presumably non-zero (likely a "convert needed"
  flag / encoding id / code page saved earlier in the routine).

**Next step (this is THE bug to fix):** find what notepad writes into `[esp+0x18]`
before `0x410d4a` and why it is 0 here. Look at the routine's prologue
(`0x410c00` region: `mov [esp+0x2c], eax` after GetLastError at 0x410c61, and
`mov [esp+0x28], eax` = WM_GETTEXTLENGTH at 0x410c91) — the value at `[esp+0x18]`
is probably set by one of these stores with a different slot offset than the reader
expects, or it is initialized from `[0x428e74]` (encoding global) / a prior call.
Options: (a) dump/compare `[esp+0x18]` under the disassembler and set it correctly
via a runtime probe (probes framework already exists — see desktop-controller
`cmdFormatProbes` / guest-process `probes` option); (b) more likely, one of OUR
handlers is writing the wrong number of stack bytes or corrupting the slot — check
the return path of the WideCharToMultiByte handler and the dispatcher's `ret N`
stack cleanup for `widechartomultibyte: 8` (32 bytes) — a wrong cleanup would shift
`[esp+0x18]` reads. Verify with a probe at `0x410d4a` printing `[esp+0x18]`.

Also still unimplemented along the path: `SetEndOfFile` (needs a truncate handler on
the FileSystemBridge handle — check `host.fs` for an existing truncate/setEndOfFile),
`PathFindExtensionW`, `GetFileAttributesExW`, `GetWindowPlacement`, `CharUpperW`,
`SetCursor`, `SetThreadDpiAwarenessContext`, `IsProcessorFeaturePresent` — most are
cosmetic (return 0 keeps notepad going), but `SetEndOfFile` matters once writing works.

## Other things to know

- `GetFileAttributesW(NULL)` returning 0 err=2 is FINE (notepad passes a NULL probe).
- `defaultName` from the dialog was `"*.txt"` — notepad pre-fills lpstrFile with the
  filter pattern, not a real name; harmless, do not chase.
- Keep `commandLine: ''` for cmd (session 9 rule) — untouched this session.
- notepad runs with `interactive: true`; the verifier's 20 s WM_CLOSE stops it.
- Local verification loop before pushing stays: `tsc --noEmit` + `eslint .` +
  `vitest run` all exit 0 (verified green after this session's changes).

---

# Session 10 historical handover (CI green) — preserved unchanged

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

## Goal (session 10, from session 9)

Take the session-8 milestone (`cmd /c dir` works headless) and turn it into a REAL
interactive "Command Prompt" app in the browser desktop, then make `cd`/`dir`/`echo`
work interactively, wire the File Explorer to cmd, and diagnose why notepad cannot
save. Also copy a small set of real Windows fonts into the virtual disk.

Project root: `C:\Users\HUAWEI\Desktop\windows` (pnpm workspace, package `@specter-core`).
Target binary: `C:/Windows/SysWOW64/cmd.exe` (a CUSTOM build — its PE import table
parses as absent/nonstandard, and it has quirks documented below).

## Current Status (session 10, one paragraph)

**The browser desktop "Command Prompt" app now runs the REAL cmd.exe interactively:
banner, prompt, `dir`, `echo`, `cd <path>` (absolute and relative), `exit` all work,
and the cwd / volume label / serial are real.** File Explorer got three buttons that
open cmd in a folder or run a selected .exe through it. Four real fonts are staged in
`apps/web/public/win/Fonts/` and provisioned to `Windows\Fonts`. Two known cmd
format-string artifacts remain (`Not enough storage is available...` on stderr at
startup, and a `%0` tail on the banner) — they are pre-existing cmd quirks, harmless.
notepad **cannot save**: root cause fully identified (comdlg32 `GetSaveFileNameW` not
implemented + desktop launch doesn't pass a file path), fix pending user decision.
**Session 11: user chose the FULL comdlg32 dialog fix (this handover's top section).**

## How the desktop cmd works now (architecture, session 10)

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

## Root causes found & fixed (session 10)

| # | Symptom | Root cause | Fix |
|---|---|---|---|
| 1 | `dir`/`echo` produced NO output in browser (prompt only) | `commandLine: 'cmd.exe'` makes this custom cmd skip interactive command output entirely | Pass `commandLine: ''` in `launchGuestConsole` |
| 2 | cwd artifact `C:\cmd.exe` seen in early screenshots | That was the **diag harness's fake FS** (`buildExeFs` returns DIRECTORY for any non-wildcard path, so cmd's startup probe `cwd\cmd.exe` "existed"); the real MemoryFileStore-based FS returns not-found → no override. Not a real bug | Added `GuestProcessOptions.cwd` for the desktop; validated with `scripts/cmd-cwd-check.ts` against the real FS |
| 3 | `cd C:\Windows` failed with `ERROR_INVALID_DRIVE(0xf)` | `GetDriveTypeW/A` had NO handler → default 0 (DRIVE_UNKNOWN) → cmd thinks the drive doesn't exist | handlers.ts: `GetDriveTypeW/A` → `DRIVE_FIXED(3)` for drive-lettered roots; added `GetLogicalDrives` → `0x4` |
| 4 | `cd` failed with `ERROR_DIRECTORY(0x10b)` | cmd calls `FindFirstFileW("C:\Windows\")` (trailing backslash); `splitFindPattern` turned the empty tail into the pattern → no match → `ERROR_NO_MORE_FILES(18)` | `splitFindPattern`: strip trailing `[\\/]+`; bare drive (`C:`) → `{dir:'', pattern:'*'}` |
| 5 | `cd Windows` failed (relative) | cmd calls `GetFullPathNameW("\Windows", ...)` — leading-`\` = **relative to drive root, not cwd**; old handler prepended cwd → `C:\Desktop\Windows` (nonexistent) | `GetFullPathNameW`: 3-way — drive-absolute as-is; `\`-prefixed → prepend current drive letter; else prepend cwd |
| 6 | `Volume in drive C has no label.` + `1234-ABCD` | hardcoded placeholders in `GetVolumeInformationW/A` | label `'Specter FS'`; serial = `volumeSerial(rootPath)` (djb2 of root path, folded to 16-bit halves → `C:\` = `CDC7-CDC7`) |

## New core capability: runtime probes (session 10)

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

## Files modified (session 10)

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

## notepad cannot save — root cause (session 10/11)

Two independent layers:

1. **Save As / Open dialog — completely unimplemented.** notepad's Save As goes
   through `comdlg32!GetSaveFileNameW`; File > Open uses `GetOpenFileNameW`. There
   were ZERO handlers for either (comdlg32 was only in the module allowlist). The
   dialog never appeared, so Save As failed silently.
   **Session 11: implemented (host-driven dialog) — see top section.**
2. **Save (Ctrl+S, existing file) — broken by the desktop launch path, not by I/O.**
   `WriteFile` → `host.fs.writeFile` → `MemoryFileStore.write` is fully implemented and
   works. But `launchGuestWindow` never passes a file path as `commandLine`, so notepad
   opened from File Explorer starts "Untitled" — Ctrl+S then falls into the Save As
   dialog (layer 1).
   **User decision (session 11): the "quick Ctrl+S / pass file path" fix is REJECTED.**
   Do not add a commandLine shortcut; the comdlg32 dialog is the intended path.

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
**Session 11 note: Option C's Ctrl+S part is now moot (user chose the comdlg32 dialog
fix); the "standard user dirs" part is still open and independent.**

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
# notepad save routine (session 11):
"$PYEXE" scripts/disasm-win.py "C:/Windows/SysWOW64/notepad.exe" 0x410c00 0x160
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
