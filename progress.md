# SpecterCore — Progress Notes

> Short handover notes for recent work. Full details live in `docs/PROGRESS.md`.

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
