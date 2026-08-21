# SpecterCore — Progress Notes

> Short handover notes for recent work. Full details live in `docs/PROGRESS.md`.

## 2026-08-21 — Session 20 (winmine.exe flagship demo — RUNS!)

### Mission
- Make classic Minesweeper (`apps/web/public/win/winmine.exe`, VC6-era 32-bit
  GUI) run inside SpecterCore as the flagship browser-desktop demo.

### Milestone: winmine runs the FULL startup + initial render (headless)
- `flow-api.mjs apps/web/public/win/winmine.exe` → **184 API calls, clean exit
  (GetMessageW queue empty = WM_QUIT), no fault.** Sequence:
  CRT init → LoadStringW (UI strings) → registry reads (RegCreateKeyExW /
  RegQueryValueExW) → LoadIconW/LoadCursorW/GetStockObject → RegisterClassW →
  LoadMenuW/LoadAcceleratorsW → **CreateWindowExW** → GetMenuItemRect/MoveWindow
  → LoadResource (bitmaps) → **board draw (16× SetDIBitsToDevice)** →
  CheckMenuItem ×7 + SetMenu → **mine placement (20× rand = 10 mines × x/y)** →
  board redraw with mines → SetRect/InvalidateRect → clean exit.

### Fixes this round
1. **`setdibitstodevice: 12`** (mapper.ts) — MISSING argCount → stub `ret 0` →
   48 bytes leaked per call; winmine's 16-iteration draw loop then `ret` popped
   garbage (eip=0x10). Also added `setrop2: 2`, `setpixel: 3`, `getlayout: 1`,
   `setlayout: 2` (GDI) and `settimer/killtimer/getdesktopwindow/loadmenu/
   setmenu/getdlgitemint/setdlgitemint/releasecapture/setcapture/
   mapwindowpoints/ptinrect/winhelpw` (USER32).
2. **`rand`/`srand` implemented** (handlers.ts) — MSVCRT LCG
   (`next = next*1103515245+12345; return (next>>16)&0x7fff`), state in a JS
   module var. Registered under BOTH `ucrtbase.dll` AND `msvcrt.dll` (winmine
   imports msvcrt.dll directly; normalizeApiSetModule does NOT map msvcrt→
   ucrtbase). Before: no-op srand + missing rand → rand() always 0 → mine
   placement `do{x=rand()%w;y=rand()%h}while(cell mined)` spun forever (890K
   rand calls / 200MB log).

### Desktop integration (browser)
- `builtin-win.ts`: provision `win/winmine.exe` → `Windows/SysWOW64/winmine.exe`.
- `apps.tsx`: `windows-minesweeper` app (Games group, `icons/minesweeper.svg`).
- `desktop-controller.tsx`: special-case launch via `launchGuestWindow` (same
  path as notepad — real guest window, no shell), `guestIconFor` → minesweeper.
- `resource-preload.ts`: preload `icons/minesweeper.svg`.
- New icon: `apps/web/public/icons/minesweeper.svg`.

### Build / run commands
```
NODE="C:/Users/HUAWEI/.workbuddy/binaries/node/versions/22.22.2/node.exe"
$NODE node_modules/esbuild/bin/esbuild scripts/flow-api.ts --bundle --platform=node --format=esm --outfile=node_modules/.cache/flow-api.mjs
$NODE node_modules/.cache/flow-api.mjs "apps/web/public/win/winmine.exe" 40
```
- Type check: pre-existing errors ONLY (codegen XmmOperand `.size`,
  x86-decoder `b` undefined, BrowserApp `getAppWindowId`). No new errors.

### Next steps (in order)
1. **Verify in the browser**: run the vite dev server, click Minesweeper on the
   desktop, confirm the board window renders (GDI canvas) with the menu bar.
   Mouse clicks (WM_LBUTTONDOWN) → reveal cells — the interactive message loop
   already blocks on GetMessageW waiting for host input.
2. If the board renders but cells don't reveal: check the WM_LBUTTONDOWN →
   WndProc dispatch path and the SetDIBitsToDevice redraw after each click.
3. Keep the handover notes in this file updated.

## 2026-08-21 — Session 19 round 2 (32-bit VSCode installer, agent handover)

> **Handover**: THIS file was written for an agent switch at 2026-08-21 05:50 GMT+8.
> The 32-bit task owner hands off mid-task. Read the sections below in order, then
> continue with "Next steps".

### Mission (read first)
- Make `D:\Downloads\VSCodeSetup-ia32-1.83.1.exe` (91,074,856 bytes, Inno Setup /
  Delphi-32) actually run inside SpecterCore (browser x86 PE -> WASM JIT layer).
- **Boundary**: another agent owns the 64-bit adaptation (their changes are STAGED,
  incl. `cmd-x64.exe` / `notepad-x64.exe` in `apps/web/public/win/`). Stay on the
  32-bit path, keep edits additive, avoid the other agent's active lines.
- The guest runner is headless via `scripts/flow-vscode.ts` (public `RunOptions`:
  `onStep(eip,runtime)`, `probes`, `createEngine`, `readFile`, `onOutput`).

### Progress this round (since the 02:44 handover)
- **Fixed `process` global crash** (`packages/core/src/jit/executor.ts:84`): the
  `process.env.SPECTER_TRACE_EXEC` check threw `ReferenceError: process is not
  defined` in the browser, breaking cmd.exe/notepad.exe launch. Now guarded with
  `typeof process !== 'undefined'`.
- **Fixed SEH unwind transfer ESP** (`guest-process.ts` RtlUnwind handler): the
  transfer ESP was a fixed `targetFrame - 0x34`; now computed dynamically as
  `inner - 0x28` from the inner SEH record (so `[esp+0x28]` reads the accepting
  record, matching the unwind target's `Frame+4`/`Frame+8` reads). This fixed the
  misaligned jump to 0x407461 (middle of `xor eax,eax`).
- **Implemented RCL/RCR** (`codegen.ts` `emitRotateCarry`/`emitRotateCarry64`,
  wired at the `rcl`/`rcr` decode cases): replaced the `unreachable()` stubs that
  faulted at 0x407461. Handles CF-in/out, masked counts, and OF for both rcl/rcr.
- **Metrics**: basic blocks 11775 -> **20912**, API calls -> **330**. The old
  .itext 0x10100 return-address blocker is GONE (that path now runs cleanly).
  The old "vtable corruption" label was WRONG — see the corrected diagnosis below.

### Current blocker (corrected: NOT vtable corruption — finally-frame data issue)
- Fault: `call [ecx-4]` at 0x405cf0 jumps to 0xc35df8eb.
- **Corrected diagnosis**: `[0x4b10f0]` (the "vtable") = 0x4b50e0 is CORRECT and
  matches the file. The fault target 0xc35df8eb is the DWORD at
  `[0x4b50e0-4] = [0x4b50dc]`, which holds code bytes `eb f8 5d c3`
  (`jmp -8; pop ebp; ret`) interpreted as an address. So the dispatch reads 4
  bytes BEFORE a code address — i.e. 0x4b10f0 is NOT an object.
- **0x4b10f0 is a 63-entry dispatch table** (header at 0x4b10d8: `[0x4b10d8]=0x3f`
  count, `[0x4b10dc]=0x4b10f0` entries ptr; first entry 0x4b50e0 in .itext).
- **Path** (shutdown/finalization): FreeLibrary/LocalFree cleanup -> F2
  (0x407418, forward finalization-list loop) -> F1 (0x4073b0, reverse loop) ->
  0x40718c (finalize cleanup) -> 0x405ce8 (`mov ecx,[eax]; call [ecx-4]`) -> fault.
- **0x40718c** pops a finally-frame at edx=0x7fffec0 (via 0x40cc60, which reads
  the TLS slot: `[0x2c]` TIB TlsStorage + `[0x4b7c14]` TLS index=0). Frame fields:
  `[0]=0x7fffeec [4]=0x405d7a [8]=0x4b10f0 (object) [0xc]=0x41fda2 (record)`.
- **Magic check fails**: `cmp [0x41fda2], 0x0eedfade` — `[0x41fda2]` is x87 code
  bytes (`dd 5d f8 9b`), not the magic. So the cleanup calls the "finalizer" on
  0x4b10f0, dispatching to `[0x4b50dc]` = 0xc35df8eb -> fault.
- TLS slot 0 (finally-frame head) = 0x7fffeec; chain is a 2-node CYCLE
  (0x7fffeec <-> 0x7fffec0), which smells like SEH/finally frame corruption.

### Root cause hypothesis / next lead
- The finally-frame at 0x7fffec0 holds WRONG data: `[8]=0x4b10f0` (dispatch table)
  and `[0xc]=0x41fda2` (code) instead of a real object + a finalization record
  whose first dword is 0x0eedfade. If the magic matched, the finalize would be
  skipped and no fault would occur.
- Next: find WHO pushes the frame at 0x7fffec0 with object=0x4b10f0 /
  record=0x41fda2 (search for the finally-frame push sites; check the
  finalization-list setup at 0x407484 which writes `[0x4bdba0]`). Also verify the
  TLS slot 0 / `[0x2c]` handling — the circular chain suggests a frame was pushed
  but never popped, or the SEH/finally frame layout is misaligned.

### Build / run commands (pnpm is broken, use local esbuild + node22)
```
NODE="C:/Users/HUAWEI/.workbuddy/binaries/node/versions/22.22.2/node.exe"
$NODE node_modules/esbuild/bin/esbuild scripts/flow-vscode.ts --bundle --platform=node --format=esm --outfile=node_modules/.cache/flow-vscode.mjs
$NODE node_modules/.cache/flow-vscode.mjs "D:/Downloads/VSCodeSetup-ia32-1.83.1.exe" 0 "0x4071b9;0x40cc6f;0x405cec" 2>&1 | Select-String -Pattern "\[probe\]|\[flow\]|fault"
```
- Type check: `$NODE node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`
  (pre-existing errors in unrelated areas only: XmmOperand `.size`, BrowserApp.tsx).
- Regression: 32-bit `apps/web/public/win/cmd.exe`, `notepad.exe` still behave
  correctly after all fixes. Do NOT touch the x64 samples.

### File ownership / conflict zones
- **32-bit task safe zone** (edits here): `packages/core/src/process/guest-process.ts`,
  `packages/core/src/pe/mapper.ts`, `packages/core/src/api/*`, scripts under `scripts/`.
- **Shared JIT files** (other agent has staged edits; my scas/cmps/x87/RCL-RCR
  changes are additive and non-overlapping): `ir.ts`, `x86-decoder.ts`,
  `codegen.ts`, `engine.ts`, `wasm-encoder.ts`.
- Probe/diag scripts worth keeping: `scripts/probe-va.ts`, `scripts/probe-scasw.ts`,
  `scripts/flow-vscode.ts` (tracer + API tags + probes), `scripts/check-argcounts.ts`,
  `scripts/disasm-range.ts`, `scripts/imports-scan.py`.

### Next steps (in order)
1. Find where the finally-frame at 0x7fffec0 is pushed (object=0x4b10f0 /
   record=0x41fda2); verify the frame layout and the TLS slot-0 chain.
2. Check the finalization-list setup at 0x407484 (`[0x4bdba0]` list head) and how
   F2/F1 read entries (`entries[index*8]` / `entries[index*8+4]`).
3. Keep the handover notes in this file updated; commit nothing that overlaps the
   other agent's staged JIT work.

## 2026-08-21 — Session 19 round (32-bit VSCode installer, agent handover)

> **Handover**: THIS file was written for an agent switch at 2026-08-21 02:44 GMT+8.
> The 32-bit task owner hands off mid-task. Read the sections below in order, then
> continue with "Next steps".

### Mission (read first)
- Make `D:\Downloads\VSCodeSetup-ia32-1.83.1.exe` (91,074,856 bytes, Inno Setup /
  Delphi-32) actually run inside SpecterCore (browser x86 PE -> WASM JIT layer).
- **Boundary**: another agent owns the 64-bit adaptation (their changes are STAGED,
  incl. `cmd-x64.exe` / `notepad-x64.exe` in `apps/web/public/win/`). Stay on the
  32-bit path, keep edits additive, avoid the other agent's active lines.
- The guest runner is headless via `scripts/flow-vscode.ts` (public `RunOptions`:
  `onStep(eip,runtime)`, `probes`, `createEngine`, `readFile`, `onOutput`).

### Progress so far (installer walk-through)
- Fixed `GetVersionExW/A` stack overflow in `guest-process.ts` (was writing 284
  bytes into a 276-byte `OSVERSIONINFOW` on the guest stack -> clobbered the
  caller's return address -> fake "clean exit" after 17 steps). Now writes exactly
  `dwOSVersionInfoSize` bytes; also fixed `VerifyVersionInfoW` WORD reads (spPair).
- Implemented `scas`/`cmps` in the JIT (ir.ts Op + `repne` flag, decoder 0xa6/0xa7/
  0xae/0xaf with F2/F3 + 0x66 width, codegen `emitScas`/`emitCmps`/`emitRepCond`
  ZF-conditional REP loop). The original stall at 0x40858c (`repne scasw`, Delphi
  StrLen) now decodes+compiles; all 7 scas/cmps sites pass.
- Added x87 no-ops `ffree`/`fincstp` (Delphi stack-pop idiom) and fixed the 0xd9
  reg-direct dispatch bug (D9 C0/FLD ST(0) was misdecoded).
- **Latest metrics**: API calls 109, basic blocks 4931. Fault moved from
  stack-drift @0x7fffe00 -> clean OOB @**0x10100** (zero region return target).
  See "Current blocker" below.

### Resolved: stack drift from API stub pops (DONE this round)
- 5 missing argCounts added to `X86_API_ARG_COUNT` (mapper.ts tail):
  `netwkstagetinfo:3`, `netapibufferfree:1`, `getfileversioninfosizew:2`,
  `getfileversioninfow:4`, `verqueryvaluew:4` (all WINAPI/stdcall). Found via
  `scripts/check-argcounts.ts` (esbuild-bundled) run against the installer.
- Old fault (jump to stack @0x7fffe00) is GONE; the guest now reaches a clean
  `memory access out of bounds` at `eip=0x10100` after 4931 basic blocks /
  109 API calls (was faulting at ~4896 before).

### Current blocker (return address of .itext dispatch fn = 0x10100)
- The .itext outer fn F (0x4b5700..0x4b59xx, a compiler-generated switch/dispatch
  loop calling into 0x40c9f0's helper + LoadStringW) finishes with
  `add esp,0x14c; ret` at 0x4b594f. The `ret` pops 0x10100 off the stack
  (slot 0x7ffff58, near the initial stack top 0x7fffffc) and jumps into a
  ZERO-ONLY region (verified: fault eip 0x10100 bytes are all `00`), so the JIT
  decodes `add [eax],al` junk and hits memory OOB.
- The slot is ALREADY 0x10100 at block #4926 (probe on 0x4b5793), with a stable
  frame (esp=0x7fffe0c, ebp=0x7ffff7c) all the way to the epilogue — so it is
  a stale/corrupt return target set earlier in startup, NOT an in-F overflow.
  `0x10100` ≈ `GetNativeSystemInfo`'s reported `lpMinimumApplicationAddress`
  (0x10000) + 0x100 — smells like the guest stored a heap/callback pointer that
  an earlier unimplemented API populated wrong.
- Nearby stack holds data-table pointers 0x4b10d8 / 0x4b10f0 (dispatch tables).

### Tooling added (keep)
- `scripts/check-argcounts.ts` — enumerates an exe's static IAT vs the argCount
  table; run it on any new exe to catch missing entries before they drift.
- `scripts/disasm-range.ts` — linear disasm over a guest VA window using the JIT's
  own X86Decoder; e.g. `disasm-range.mjs <exe> 0x4b5700 0x300`.
- `flow-vscode.ts` now also dumps the fault-eip bytes + top-of-stack on error.

### Current blocker hypothesis / next lead
Prime suspects to make the guest populate the return slot correctly:
1. Which early startup API returns a wrong pointer that becomes 0x10100 (e.g.
   GetSystemInfo/GetNativeSystemInfo, GetCommandLineW, heap/VirtualQuery paths).
2. Where the guest writes the 0x4b10d8/0x4b10f0 table pointers + the 0x10100
   return slot during startup — probe stack region 0x7ffff40..0x7ffff80 early.

### Build / run commands (pnpm is broken, use local esbuild + node22)
```
NODE="C:/Users/HUAWEI/.workbuddy/binaries/node/versions/22.22.2/node.exe"
$NODE node_modules/esbuild/bin/esbuild scripts/flow-vscode.ts --bundle --platform=node --format=esm --outfile=node_modules/.cache/flow-vscode.mjs
$NODE node_modules/.cache/flow-vscode.mjs "D:/Downloads/VSCodeSetup-ia32-1.83.1.exe" 2>&1 | tail -60
```
- Type check: `$NODE node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`
  (pre-existing errors in unrelated areas only: XmmOperand `.size`, BrowserApp.tsx).
- Regression: 32-bit `apps/web/public/win/cmd.exe`, `notepad.exe` still behave
  correctly after all fixes. Do NOT touch the x64 samples.

### File ownership / conflict zones
- **32-bit task safe zone** (edits here): `packages/core/src/process/guest-process.ts`,
  `packages/core/src/pe/mapper.ts`, `packages/core/src/api/*`, scripts under `scripts/`.
- **Shared JIT files** (other agent has staged edits; my scas/cmps/x87 changes are
  additive and non-overlapping): `ir.ts` (their lanes field ~line 232; my Op/scas/
  cmps/repne + ffree/fincstp), `x86-decoder.ts` (their hunks at 435/502/688/908/
  956/1131; my string-op 619-636 + x87 d9/dd area), `codegen.ts` (their edits up to
  ~2458-2486 emitXadd; my emitScas/emitCmps/emitRepCond ~2631-2900 region),
  `engine.ts`, `wasm-encoder.ts`.
- Probe/diag scripts worth keeping: `scripts/probe-va.ts` (disasm a VA),
  `scripts/probe-scasw.ts`, `scripts/flow-vscode.ts` (tracer + API tags),
  `scripts/check-argcounts.ts` (may be reusable for the import-scan), `scripts/imports-scan.py`.

### Next steps (in order)
1. Enumerate all imports of the installer vs `X86_API_ARG_COUNT`; patch missing
   entries (this unblocks the stack-drift fault at 0x7fffe00).
2. Re-run flow; expect to hit the next real wall. Known candidates ahead: STI
   (0xfb) seen at 0x44f62d; file writes (`buildExeFs.writeFile` currently returns
   err=5) — the installer MUST unpack to disk eventually, so a file-write bridge
   is a coming necessity.
3. Keep the handover notes in this file updated; commit nothing that overlaps the
   other agent's staged JIT work.

## 2026-08-20 — Session 18 round

### Virtual disk auto-refresh (guest writes)
- **Problem**: notepad saving a file did not appear on the desktop / in an open
  Explorer folder until a manual refresh.
- **Fix**: `FileSystemBridgeImpl` now exposes `onChange(listener)` firing
  `FsChange { path, kind, to? }` (store paths) on every mutation (create /
  write / truncate / delete / move). `Desktop.tsx` refreshes when a change hits
  the Desktop dir; `FileExplorerApp.tsx` reloads the current folder. The guest's
  `ApiHost.fs` is the same bridge singleton, so guest writes flow straight in.

### Built-in multimedia
- Source files under `apps/web/public/media/`:
  - `music/` → virtual disk `Users/Public/Music` (4 mp3s)
  - `images/` → virtual disk `Users/Public/Pictures` (14 jpgs, `01.jpg`..`14.jpg`)
- `BUILTIN_MUSIC_FILES` / `BUILTIN_IMAGE_FILES` in `packages/ui/src/builtin-win.ts`
  drive provisioning; File Explorer quick access gained Music + Pictures entries.
- Guide for extending: `apps/web/public/media/README.md`.

### Boot is never blocked by media
- `bootstrap.ts` mounts the desktop FIRST, then fires
  `provisionBundledFilesInBackground(fs)` (void, no await). System tools →
  music → images, each idempotent and deduped via `provisionInFlight`.
- Guest apps lazily re-ensure win files if launched before provisioning ends.

### OPFS dirty-data self-heal
- Symptom: `Not a directory` / `NotFoundError` on `Users/Public/Pictures`
  (stale file entry left by an interrupted provisioning).
- Fix: `ensureDirectory(fs, path)` walks every path segment, deletes a stale
  file entry and recreates the directory (recursive parent creation).
  Used by all provisioning paths. Explorer shows a friendly hint on
  `not a directory` errors.

### Verified
- tsc 0 · eslint 0 · vitest 260/260 · notepad open/dialog checks PASS ·
  cmd-cwd-check PASS · vite build includes all media.
