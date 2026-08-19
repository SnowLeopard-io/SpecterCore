# cmd.exe Emulator Debugging — Handover (2026-08-19 20:05, session 4)

> Single source of truth for continuing the work. Read fully before touching anything.
> All addresses are absolute VAs (image base 0x400000).

## Goal

Make the specter-core Windows PE emulator run `C:/Windows/SysWOW64/cmd.exe` with
`cmd /c dir C:\Windows` and emit the directory listing to stdout.

- Project root: `C:\Users\HUAWEI\Desktop\windows` (pnpm workspace, package `@specter-core`)
- Target binary: `C:/Windows/SysWOW64/cmd.exe` (entry VA 0x41de90 = mainCRTStartup, narrow-argv CRT)
- MUI satellite merged: `C:/Windows/System32/en-US/cmd.exe.mui` (message table type 11, merged OK)

## Current Status (one paragraph)

**The old "C:\" truncation bug is FIXED** (root cause = HeapReAlloc handler arg-index bug,
Bug10 below). dir target is now correctly `"C:\Windows"` (verified at dir handler 0x40bf53).
**NEW remaining blocker: the enumeration path becomes `"C:\Windows\Windows"` instead of
`"C:\Windows\*"`** — during dir's output phase, 0x408ba9 concatenates the full target
`"C:\Windows"` (as the "directory" part) with its own last component `"Windows"` (as the
"name" part), producing `"C:\Windows\Windows"`, so FindFirstFileExW enumerates nothing,
prints "File Not Found" to stderr, exits 1. Root cause is upstream: the dir-object
`[obj+4]` ("directory" field) is built as the FULL path `"C:\Windows"` instead of the
parent dir `"C:\"`. The exact writer of that field is ~90% traced (evidence below); the
remaining unknown is why the path-object `[ebp-0x220]+0x208` ends up `"C:\Windows"` —
suspicion: the 0x41ee28 (vswprintf wrapper) call at 0x40a36e writes garbage/overwrites
into the path object because 0x40a36e only pushes 3 args while 0x41ee28 forwards 5
(remaining 2 are stale stack values = wrong format string).

---

## Fixed This Session (Bug10 = the "C:\" truncation root cause)

Applied to `packages/core/src/process/guest-process.ts` (HeapReAlloc hook).

### Bug10 — HeapReAlloc arg-index bug (Task #7 "target truncated" root cause)
- `HeapReAlloc(hHeap, dwFlags, lpMem, dwBytes)`: **lpMem is rawArgs[2]**, but the handler
  read `rawArgs[1]` (=dwFlags=0). So `old` was 0 → the `if (!old)` branch ran → bumpAlloc
  WITHOUT copying → returned an EMPTY block.
- Where it bites: cmd's realloc helper **0x411cd0** (used by the **0x40fed0 tokenizer tail**
  — the tokenizer that produces `dir`'s target argument). 0x40fed0 collects the token in a
  bump buffer, then 0x411cd0 HeapReAlloc's it; empty result → `dir`'s target became `""`,
  and cmd's fallback logic turned it into `"C:\"` (cwd). Hence old symptom: `C:\` instead
  of `C:\Windows`, enumerating `C:\*\*`.
- Fix (guest-process.ts ~1345): `const old = ctx.rawArgs[2] ?? 0;` — same class of bug as
  Bug7 (HeapSize arg index), already fixed previously.
- VERIFIED: 0x40fed0 now returns `"C:\Windows"` (probe 0x40c1d6 eax=0x2091568), dir
  handler 0x40bf53 target=`"C:\Windows"`, and 0x40a9e9 targetParam=`"C:\Windows"`.

---

## Current Blocker (Task #7 continued): enum path "C:\Windows\Windows"

### Symptom chain
1. FindFirstFileExW called ONCE (log line ~644): `FindFirstFileExW(0x21a5de8, 0x1, 0x21b5dd4, 0x0, 0x0, 0x2)`, path=`"C:\Windows\Windows"`.
2. That call site is **0x408d08: call 0x41afe9** (the FindFirstFileExW wrapper), with
   `edx = [ebp-0x18]` (0x408ba9's local) = `"C:\Windows\Windows"` (probe-verified).
3. `[ebp-0x18]` was produced by **0x408cac: call 0x417ed4(ecx=0x21a5de8 fresh buf, edx=0x7fe9,
   "C:\Windows"(0x2155ac0), "Windows"(0x2155a08))** — 0x417ed4 is a path-concat helper
   (copies arg1 + "\" + arg2, see 0x417f41 cmp dx,0x5c / push 0x401f6c="\").
4. So dir's output phase concatenates **"C:\Windows"** (full target, from `[edi+4]`) with
   **"Windows"** (last component, from `[[edi+0xc]]`) → `"C:\Windows\Windows"`.
   Correct would be parent dir `"C:\"` + `"Windows"` (i.e. `[edi+4]` should be `"C:\"`).
5. `[edi+4]` and `[[edi+0xc]]` come from the dir tree object built in **0x40a320**
   (dir outer handler): `[obj+0]="Windows"` (0x40a60a: 0x40dc0d copy of the filename part)
   and `[obj+4]="C:\Windows"` (0x40a625: 0x40dc0d copy of `[ebp-0x18]` or `&[ebp-0x220]`).

### Root-cause chain (traced, ~90%)
- 0x40a320 local `[ebp-0x18]` == path-object `[ebp-0x220]+0x208` == 0x20d55e0 `"C:\Windows"`.
  The path object is a 0x208+ byte struct at `[ebp-0x220]`; field `+0x208` (== `[ebp-0x18]`)
  holds the "resolved path" pointer.
- 0x40a320 initializes `[ebp-0x18]=0` at 0x40a351 (verified, ONLY writer in 0x40a320 by
  byte-scan). Yet at 0x40a4b6 (after 0x414ad6) and 0x40a60f it is already 0x20d55e0
  `"C:\Windows"` → someone writes it in between (see suspicions below).
- 0x40a4ac: call **0x414ad6**(&[ebp-0x220], src) — probe (0x414ad6, retInto=0x40a4b1)
  shows `src=0x2024f28 "C:\Windows"` at that moment, and `[obj+208]=0x20d55e0` already.
- **Contradiction to resolve**: probe 0x40a60f (later) shows `[44ef10]=0x2024f28 "C:\"`,
  but the 0x414ad6 probe (earlier) showed the SAME address 0x2024f28 as `"C:\Windows"`.
  → the string at 0x2024f28 changes content between those points; whoever writes it
  (`0x414ad6`'s inner 0x4136f0? or the 0x41ee28 vswprintf?) is a prime suspect.
- 0x40a4b1: call **0x408af6** — if `[0x4408bc]` (dir wrapper 0x40a9e9's path buffer)
  is nonzero it does `0x414ad6(0x44ed08, [0x4408bc])` (append into global path object 0x44ed08).
- **0x41ee28 is NOT a GetCurrentDirectory-style helper — it is a vswprintf wrapper**:
  `0x41ee28: push [ebp+8..0x18] (5 args) → call 0x41dbf5 (=mov eax,0x434220) → call 0x41eccc`
  where `0x41eccc: jmp [0x45042c]` and `[0x45042c]` resolves (delay-load) to
  `_o___stdio_common_vswprintf` (probe: args 0x3d, 0, buf, size, fmt).
  `0x40a36e: call 0x41ee28(&[ebp-0x220], 0, 0x104)` pushes only **3** args → the 2 extra
  args forwarded to vswprintf (fmt/args) are STALE STACK VALUES → vswprintf may write
  garbage into the path object. THIS is the top suspect for corrupting `[ebp-0x220]` /
  `[ebp-0x18]` (obj+0x208) / the 0x2024f28 string.

### Evidence gathered (do NOT re-investigate)
- 0x40fed0 → `"C:\Windows"` (0x40c1d6, eax=0x2091568). dir handler 0x40bf53 target
  `"C:\Windows"` both entries (probe 521/545 of cmd-fix34+). 0x40a9e9 targetParam
  `"C:\Windows"` (0x40a9e9 probe). 0x40c138 append-"\*" logic intact (would produce
  `"C:\Windows\*"` if reached with correct input — but dir output phase uses 0x417ed4 concat).
- FindFirstFileExW wrapper 0x41afe9(ecx=cb, edx=lpFileName, 4 stack args); callers:
  **0x408d08** (ecx=0x41b160, edx=[ebp-0x18]="C:\Windows\Windows") — THE ACTIVE ONE;
  0x419189 (ecx=0x41b130, edx=[ebx], never reached — 0x41916d loop not entered);
  0x40dcb4 inside 0x40dc53 (ecx=0x41b130, 0x40dc53 never called — 0x413e1a not reached).
- **0x40dc0d is a plain string-copy helper** (wcslen → HeapAlloc → 0x4136f0), NOT a
  resolver. **0x40dc53** (0x40dcb4: FindFirstFileExW with ecx=0x41b130) is the real
  resolve+enum fn but is never executed in this run.
- 0x414ad6 = path-object concat: `0x4136f0(dst=[obj+0x208] or obj, maxlen=[obj+0x210], src=[ebp+8])`
  — copies src INTO the object's resolved-path slot; also `[obj+208]` read at 0x414b06.
- 0x417ed4 = two-string concat with "\" separator (0x401f6c).
- IAT corrections vs previous handover: **0x4500bc = SetFilePointer** (was "?"),
  **0x4500e8 = GetFileAttributesW** (was mislabeled "GetFullPathNameW(?)").
  0x45042c (delay-load) = _o___stdio_common_vswprintf. 0x4500e4 = FindFirstFileExW.
- Format strings: 0x4027c8 `"%04X-%04X.%c%s"` (time), 0x402c20 `"%s..."`,
  0x401f6c `"\"` (concat sep), 0x401da8 `" .REM"`-ish.
- GetCommandLineW returns `"cmd /c dir C:\Windows"` (0x2000370) correctly.

### Next concrete steps (try in order)
1. **Probe around 0x40a36e (call 0x41ee28)** — block starts: 0x40a36e itself (call) or
   0x40a373 (add esp,0xc). Dump path object `[ebp-0x220]` first 0x20 bytes + `[ebp-0x18]`
   (obj+0x208) BEFORE vs AFTER 0x41ee28, to prove the vswprintf wrapper corrupts the object.
   Also dump the 2 stale forwarded args (`[esp+14]/[esp+18]` at the 0x41eccc probe) for the
   0x40a36e call specifically — line 616 of cmd-fix49.log shows (0x3d, 0, 0x7ffeb38, 0xff,
   0x4027c8) which is NOT the 0x40a36e call (that one is the 0x7ffeb18 buffer); find the
   0x7ffeb18 variant in the log (or add filter) — its fmt arg will reveal the garbage.
2. **Confirm who writes 0x2024f28** (string seen as "C:\" at 0x40a60f but "C:\Windows" at
   0x414ad6 entry): probe 0x40a4a0 (cmovne edx) dumping `[0x44ef10]` + its string; then
   check whether 0x414ad6's inner 0x4136f0 (dst = obj+0x208 = 0x20d55e0) is what later
   overwrites 0x2024f28, or whether the vswprintf call does.
3. **Ultimate fix target**: make the dir-tree build in 0x40a320 produce `[obj+4] = "C:\"`
   (parent dir) instead of `"C:\Windows"`. Either fix the path-object corruption upstream
   (steps 1-2) or, if that's a rabbit hole, patch the concat at 0x408cac/0x417ed4 semantics
   so the "directory" part is trimmed to the parent (strip last component). Prefer fixing
   the actual corruption, not patching cmd.
4. Sanity-check 0x41ee28 contract: it forwards 5 args to vswprintf; the "correct" callers
   push 5 (e.g. 0x40a393 pushes 3 too? verify), while 0x40a36e pushes 3. If 0x40a36e is
   correct cmd code, then 0x41ee28 must be treated as varargs helper where the missing
   args are supposed to be harmless — check what real cmd expects (fmt should be the 3rd
   or 5th arg). Log line 616's call (0x7ffeb38, 0xff, 0x4027c8) shows fmt=0x4027c8 →
   vswprintf(buf, 0xff, 0x4027c8, ...) formats time — i.e. 0x41ee28(buf, ?, ?, fmt, ...)
   where fmt is the 5th stack arg in that call; for 0x40a36e the fmt slot is stale.

---

## Key Addresses

### cmd.exe functions (dir chain)
- `0x408b1c` dir exec entry (8 stack args, ret 0x20). `0x408ba9` dir exec core (sub, ret 0x10).
- `0x408cac` call 0x417ed4 (concat "C:\Windows"+"Windows" — THE WRONG JOIN).
  `0x408d08` call 0x41afe9 (FindFirstFileExW wrapper) with edx=[ebp-0x18].
- `0x41afe9` FindFirstFileExW wrapper (ecx=cb, edx=lpFileName, 4 stack args; ret 0x10).
  `0x41b130`/`0x41b160` per-entry callbacks (0x41b160 = "always 1" stub).
- `0x40dc0d` **string copy** helper. `0x40dc53` resolve+enum (0x40dcb4 calls 0x41afe9,
  ecx=0x41b130) — NOT executed (0x413e1a caller not reached).
- `0x40fed0` tokenizer (delims 0x401d48 `=,;` + iswspace; excludes "/"; returns 1st token).
- `0x40c1a6` param parser: 0x40fed0 → 0x414840 (lowercase/strip quotes) → 0x40dc0d copy →
  `[context+0x4c]`. `0x40c2d9` stores target.
- `0x40bf53` dir handler (ecx=obj, [obj+0]=target). `0x40a9e9` dir wrapper (ecx=target).
- `0x40a320` dir outer handler — **builds dir tree**: `[obj+0]="Windows"` (0x40a60a),
  `[obj+4]="C:\Windows"` (0x40a625, WRONG — should be "C:\"). `0x40a351` [ebp-0x18]=0.
  `0x40a36e` call 0x41ee28 (3 args!). `0x40a4ac` call 0x414ad6. `0x40a4b1` call 0x408af6.
- `0x409b0a` X = dir executor (ecx=context; called from 0x41718e; context=&[esp+0x10]).
- `0x414ad6` path-object concat (0x4136f0 copies src into obj / obj+0x208).
- `0x408af6` if [0x4408bc]≠0: 0x414ad6(0x44ed08, [0x4408bc]) + clear [0x4408bc].
- `0x41ee28` vswprintf wrapper (5-arg forward; `0x41eccc: jmp [0x45042c]`).
- `0x417ed4` concat2 with "\". `0x4136f0` wcsncpy_s-style copy (stops at src NUL).
- `0x411cd0` HeapReAlloc wrapper (fixed by Bug10).
- `0x419189` alt FindFirstFileExW caller (not reached; ecx=0x41b130).
- Parser/main as before: 0x40b743, 0x410800 dispatch, 0x415d7b main slot loop.

### Globals
- `[0x44ef10]` = 0x2024f28 ("C:\" at 0x40a60f probe; "C:\Windows" at 0x414ad6 probe —
  CONTENT CHANGES — unresolved writer).
- `0x44ed08` global path object (0x408af6 appends [0x4408bc] into it).
- `[0x4408bc]` dir wrapper 0x40a9e9's path buffer (alloc'd 0xffce at 0x40aa73).
- `[0x4406dc]` cmd tail ptr; `[0x4386ca]` line buffer; `[0x43c6d0]` stdin-read buffer (empty
  in /c mode — normal). `[0x440860]` /c flag (=1). `[0x4408c0]` last-error.
- Path object layout: `[ebp-0x220]` = obj (0x208+ bytes); `+0x208` == `[ebp-0x18]` = resolved
  path pointer; `+0x210` = capacity; `+0x20c` = flag byte.

### IAT slots (dump-iat3.cjs)
- `0x4500e4`=FindFirstFileExW, `0x4500c4`=FindFirstFileW, `0x4500bc`=**SetFilePointer**,
  `0x4500e8`=**GetFileAttributesW** (NOT GetFullPathNameW), `0x450148`=HeapReAlloc,
  `0x45014c`=HeapSize, `0x45042c`(delay)=_o___stdio_common_vswprintf, `0x4501e0`=GetCommandLineW.

## Logs & helper scripts (node_modules/.cache/)

| File | Purpose |
|---|---|
| `cmd-fix49.log` | **Latest** — has 0x414ad6 (5 calls incl. src="C:\Windows" at retInto=0x40a4b1), 0x41eccc (vswprintf wrapper, 4 calls), 0x40a4b6, 0x40a60f (globals), 0x417ed4 (concat args), 0x40dc0d, 0x40bf53 |
| `cmd-fix47/48.log` | 0x414ad6 / 0x40a4b6 variants |
| `cmd-fix45/46.log` | 0x40a60f ebp + globals ([44ef10]="C:\", [ebp-0x18]="C:\Windows") |
| `cmd-fix34.log` | **Bug10 verified**: 0x40fed0→"C:\Windows", 0x40bf53 target="C:\Windows" |
| `cmd-fix25-33.log` | Bug10 hunt (0x40c1d6/0x40c1a6/0x40dc0d probes) |
| `cmd-fix13-24.log` | pre-Bug10 (old "C:\" symptom, tokenizer probes) |
| `diag-trap.cjs` | esbuild bundle of scripts/diag-trap.ts (keep; debug harness) |
| `bkargs.txt` | `cmd /c dir C:\Windows` (inject via BK_ARGS) |
| `dump-iat3.cjs` | Working IAT resolver |

## Quick Commands

```bash
# Rebuild diagnostic bundle (esbuild pulls TS source; no core build needed)
node node_modules/.pnpm/esbuild@0.28.2/node_modules/esbuild/bin/esbuild \
  --bundle scripts/diag-trap.ts --outfile=node_modules/.cache/diag-trap.cjs \
  --platform=node --format=cjs --target=es2020 --external:typescript

# Run. Sandbox blocks literal `cmd /c` — args come via BK_ARGS.
BK_ARGS="$(cat node_modules/.cache/bkargs.txt)" node node_modules/.cache/diag-trap.cjs \
  "C:/Windows/SysWOW64/cmd.exe" > node_modules/.cache/cmd-fix50.log 2>&1

# Disassemble a window (VA, not RVA)
PYEXE=$(ls /c/Users/HUAWEI/.workbuddy/binaries/python/envs/*/Scripts/python.exe 2>/dev/null | head -1)
"$PYEXE" scripts/disasm-win.py "C:/Windows/SysWOW64/cmd.exe" <va-hex> <len-hex>
```

## Active diag-trap.ts probes (TK list — keep, they are the breadcrumbs)
Parser/main: 0x40df9d/40dfe9/40e088/40e19c/40e155, 0x40b743/40b7c4/40b8de/40bac2/415d02,
0x415d66/415d6a, 0x411d24/411d30/41005f.
Dispatch: 0x410800 (slot dump), 0x4108a9, 0x4108f6 (token dump), 0x41090a, 0x410c28/410c5f.
Dir chain: 0x40bf53 (obj+ret), 0x40a9e9 (targetParam+ret), 0x40a320 (ctx), 0x409b0a (ctx),
0x40c1a6 (param parse), 0x40c1d6 (0x40fed0 ret), 0x40dc0d (string copy), 0x40dc53,
0x40dc77/40dc89/40dcb9 (0x40dc53 internals — NOTE these belong to 0x40dc53 which never runs),
0x41afe9 (FindFirstFileExW wrapper w/ retInto), 0x41916d (alt caller — not reached),
0x417ed4 (concat args), 0x414ad6 (path-obj concat: obj, [obj+208], src, retInto),
0x40a4ac/40a4b6 (obj+208 state), 0x40a60f (globals [44ef10]/44ed08/[ebp-0x18]),
0x40a376 (obj+208 after 0x41ee28 — NOT a block start, misses), 0x41eccc (vswprintf wrapper
args — shows the 5 forwarded args incl. stale fmt).
NOTE: onStep is BLOCK-level — mid-block addresses will NOT fire (0x40a376, 0x40a4ac missed).

## Success criteria
1. FindFirstFileExW path == `"C:\Windows\*"` (currently `"C:\Windows\Windows"`).
2. Log shows FindNextFileW + WriteConsoleW with real rows: "Volume in drive C has no label.",
   " Directory of C:\Windows", file names/sizes/dates.
3. `dir` output appears on stdout; cmd exits 0 (or 1 only for the /c command's exit code).
4. dir handler 0x40bf53 target stays `"C:\Windows"` (Bug10 fix must not regress).
