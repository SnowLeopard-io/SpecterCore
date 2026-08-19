# cmd.exe Emulator Debugging — Handover (2026-08-19 20:42, session 5)

> Single source of truth for continuing the work. Read fully before touching anything.
> All addresses are absolute VAs (image base 0x400000).

## Goal

Make the specter-core Windows PE emulator run `C:/Windows/SysWOW64/cmd.exe` with
`cmd /c dir C:\Windows` and emit the directory listing to stdout.

- Project root: `C:\Users\HUAWEI\Desktop\windows` (pnpm workspace, package `@specter-core`)
- Target binary: `C:/Windows/SysWOW64/cmd.exe` (entry VA 0x41de90 = mainCRTStartup, narrow-argv CRT)
- MUI satellite merged: `C:/Windows/System32/en-US/cmd.exe.mui` (message table type 11, merged OK)

## Current Status (one paragraph)

**dir now WORKS end-to-end.** Output (cmd-fix50-out.bin):

```
 Volume in drive C has no label.
 Volume Serial Number is 1234-ABCD

 Directory of C:\

01/01/1601  12:00:00 AM263,cmd.exe
               1 File(s) 263, bytes
               0 Dir(s)            0 bytes free
```

- FindFirstFileExW path is `"C:\Windows"` (correct; was `"C:\Windows\Windows"`).
- All headers correct except `" Directory of C:\"` (should be `"C:\Windows"`).
- File row content present but layout compressed (fields run together), size
  truncated to `"263,"` (should be `"263,168"`), date/time are 1601/00:00
  (find-data FILETIME is 0 — expected, fs bridge provides no timestamps).
- cmd still exits 1 (should be 0 for a successful dir). UNRESOLVED.
- stdout has stray NUL bytes (WriteConsoleW writes raw UTF-16LE to onOutput —
  diag only; the real app may convert).

**4 bugs fixed this session (Bug11-Bug14) — all in the EMULATOR, none in cmd:**

| Bug | Root cause | Fix |
|---|---|---|
| **Bug11** enum path "C:\Windows\Windows" | `wcsrchr` had NO handler (stub table mapper.ts `'wcsrchr': 0` → dispatch returns 0/NULL). cmd's parent-dir truncation `0x40aac4: wcsrchr(resolvedPath, L'\\')` returned NULL → truncation skipped → dir-tree `[obj+4]` kept full path → concat doubled the last component | handlers.ts: added `wcsrchr` + `_wcsrchr` (reverse scan, returns LAST match address) |
| **Bug12** all dir rows blank | `_o___stdio_common_vswprintf` had NO handler → returned 0 → every formatted row empty | handlers.ts: added `vswprintfImpl` (handles %s/%S/%c/%d/%i/%u/%o/%x/%X/%p/%% with flags/width/precision), registered as `_o___stdio_common_vswprintf` + `__stdio_common_vswprintf` |
| **Bug13** header mojibake (" Volume in drive 娸Ș…") | FormatMessageW handler read `Arguments` (a `va_list*`) as an LPCWSTR* array — missing ONE level of indirection → inserts were garbage stack values | guest-process.ts: when no `FORMAT_MESSAGE_ARGUMENT_ARRAY`(0x2000) and not `IGNORE_INSERTS`(0x200), deref `[argsPtr]` once first |
| **Bug14** spurious "File Not Found" + exit 1 | findNextFile returned ERROR_FILE_NOT_FOUND(2) at enumeration end; cmd treats 2 as real failure | handlers.ts FindNextFileW/A: empty entries → `E.ERROR_NO_MORE_FILES`(18); diag-trap.ts buildExeFs.findNextFile also returns 18 |

## IMPORTANT: progress.md v4's "vswprintf wrapper" hypothesis was WRONG

The previous handover blamed `0x40a36e: call 0x41ee28` (3 args) for corrupting the
path object via a broken vswprintf wrapper. **0x41ee28 is NOT vswprintf:**

- `0x41ee28: jmp dword ptr [0x450494]` — an IAT thunk; **0x450494 = memset**.
  `0x40a36e` and `0x40a9e9`'s `0x41ee28(&pathobj, 0, 0x104)` are just
  `memset(pathobj, 0, 0x104)` — a path-object init (confirmed: log line ~487
  `memset(0x7ffeb18, 0, 0x104)`).
- The real 5-arg vswprintf wrapper is a SEPARATE function at **0x41ee40**:
  `push [ebp+8..0x18]; call 0x41dbf5 (mov eax,0x434220); mov ecx,[eax]; push [eax+4];
  or ecx,1; push ecx; call 0x41eccc (jmp [0x45042c] → _o___stdio_common_vswprintf)`.
  vswprintf args = (options=0x3d, buffer=rawArgs[2], count=rawArgs[3],
  format=rawArgs[4], locale=rawArgs[5], va_list=rawArgs[6]).
- So Bug12's fix belongs in the vswprintf HANDLER, not in cmd.

## Verified probe evidence (do NOT re-investigate)

- wcsrchr was called but unhandled: log line ~527/545 `wcsrchr(0x2135550, 0x5c) -> 0x0`.
- After Bug11: `0x40a4b6` probe `[ebp-0x18]=0x20d55e0 "C:\"`, `0x40a60f`
  `[ebp-0x18]="C:\" [44ef10]=0x2024f28 "C:\"`, `0x417ed4` probe at 0x408cac:
  `[esp+4]=0x2155a88 "C:\" [esp+8]=0x2155a08 "Windows"` → concat `"C:\Windows"` ✓.
- Bug13: FormatMessageW probe showed `[argsPtr+0]=0x7ffe4cc` (va_list value, read
  as string = garbage) but `[vaList+0]=0x2185a38 "C"` (correct insert). All three
  headers now format correctly.
- Bug14: last writes now are the summary lines (msgId 0x2378/0x2379), `_o_exit(0x1)`.

## UNRESOLVED issues (next session, in priority order)

### 1. " Directory of C:\" should be "C:\Windows" (cosmetic but on the checklist)
- The header insert comes from the dir tree node's `[node+4]` field:
  `0x42529c: mov eax,[ebp+8]; push [eax+4]` → observed `[node+4]=0x2155a88 "C:\"`.
- The SAME `[node+4]` feeds the enumeration concat at `0x408cac`
  (`0x417ed4([n+4], [[n+0xc]])` = `"C:\" + "\" + "Windows"` = `"C:\Windows"` ✓).
  So `[node+4]` currently = parent dir, which makes the enumeration right but the
  header wrong. Real cmd wants `[node+4]="C:\Windows"` (header) AND enumeration
  `"C:\Windows\*"` — implying the concat's 2nd arg should be `"*"`.
- Evidence: **another node builder at 0x425660** writes `[node+0]=0x401f70 "*"`
  (or 0x401f74 if flag) and `[node+0xc]=0` (see 0x4256a7-0x4256eb) — i.e. real cmd
  intends the name/wildcard field to be `"*"`. Observed node at 0x408ba9 instead:
  `node=0x20f55a8 { [n+0]=0, [n+4]="C:\", [n+0xc]=0x7fff63c (stack), [[n+0xc]]="Windows" }`.
- NEXT STEP: determine which builder actually ran (probe 0x425660-0x4256f3 region
  and 0x408b5d/0x431cdd callers of 0x408ba9), then make `[node+4]` hold the FULL
  path `"C:\Windows"` while the concat's 2nd arg becomes `"*"`. Prefer fixing the
  builder so the enumeration path becomes `"C:\Windows\*"` (matches success
  criterion #1 exactly). NOTE: onStep is BLOCK-level — 0x408ba9/0x42529c are NOT
  block starts, their probes silently miss; use 0x417ed4 (fires) to dump node.

### 2. exit code 1 (should be 0 for a successful dir)
- `_o_exit(0x1)` at the end. dir printed the full listing, so cmd's dir command
  itself seems to have set a nonzero return, or cmd's exit logic is off. Check the
  last `[tk]`/`[api]` calls before `_o_exit` (log tail) and how cmd computes the
  /c exit code (0x415d7b main slot loop / 0x415d25 exit path — the `_o_exit` call
  came from 0x415d25).

### 3. file-row size truncated: "263," (should be "263,168")
- The size string is ALREADY "263," when it reaches the row vswprintf (line ~753:
  `vswprintf ... [va+0]=0x7ffa2f0 "263,"`). So the truncation happens upstream —
  in the number→string formatter (locale grouping / _i64tow_s path around
  0x41d78b, or a `%`-format call with count 0x10 / 0x48 in the stack dump).
- NEXT: find who formats the size (search log before line 753 for the formatter
  calls; 0x402c20 "%s" writes into 0x21b6850 etc.) and why it stops at "263,".

### 4. WriteConsoleW emits raw UTF-16LE bytes (NUL bytes in stdout)
- diag only shows raw bytes; the handler (handlers.ts WriteConsoleW) — check
  whether it converts wide→UTF-8 or the runner's onOutput is expected to convert.
  For the real app this may already be handled; verify with run-exe.ts.

### 5. row layout: "01/01/1601  12:00:00 AM263,cmd.exe" (fields run together)
- Real cmd: `01/01/1601  12:00:00 AM         263,168 cmd.exe`. Field padding
  depends on the individual field formatters (date "%s  ", time, size right-
  aligned, name) — likely resolves once #3 (size) is fixed and/or the field
  offsets in cmd's row builder are fed correct lengths.

## Key Addresses (updated)

### cmd.exe functions (dir chain)
- `0x408b1c` dir exec entry (8 stack args, ret 0x20). `0x408ba9` dir exec core (sub, ret 0x10).
  Callers: 0x408b5d, 0x4256f3, 0x431cdd.
- `0x408cac` call 0x417ed4 (concat [n+4] + "\" + [[n+0xc]] — now produces "C:\Windows").
  `0x408d08` call 0x41afe9 (FindFirstFileExW wrapper) with edx=[ebp-0x18].
- `0x41afe9` FindFirstFileExW wrapper (ecx=cb, edx=lpFileName, 4 stack args; ret 0x10).
- `0x40dc0d` string copy. `0x40fed0` tokenizer. `0x40bf53` dir handler.
  `0x40a9e9` dir wrapper — builds GLOBAL path obj 0x44ed08; parent truncation via
  `0x40aac4: call 0x414abe` (= wcsrchr thunk, call [0x45045c]) + `0x40aacb: mov
  word ptr [eax+2],0` (needs wcsrchr fixed — Bug11).
- `0x40a320` dir outer handler — builds dir tree; `[obj+4]=copy of [ebp-0x18]` at
  0x40a625. `0x414ad6` path-object concat. `0x408af6` global-object append helper.
- `0x417ed4` concat2 with "\" (0x401f6c). `0x41ee28` = **memset thunk** (jmp
  [0x450494]); `0x41ee40` = vswprintf wrapper (5-arg → 0x41eccc).
- `0x42529c` " Directory of %s" (0x2339) call site — insert = [[ebp+8]+4].
- `0x425660` region — alternative node builder: `[node+0]=0x401f70 "*" or 0x401f74`,
  `[node+4]=copy`, `[node+0xc]=0` (0x4256cb/0x4256db/0x4256eb).
- `0x42d600` region — volume header: 0x42d5b2 GetVolumeInformationW,
  0x42d5fd/0x42d619 0x40d9f4(buf=0x44f240, size=0x104, fmt=0x403ca0, driveChar)
  builds "C" string, 0x42d60f/0x42d626 0x408a5a(msgId, argc, insert...) wrapper
  → 0x40a1f5 → 0x40a92f → FormatMessageW.
- FormatMessageW wrapper chain: 0x408a5a(msgId,argc,...) → 0x40a1f5(argc,&arr)
  → 0x40a92f → FormatMessageW.
- Parser/main: 0x40b743, 0x410800 dispatch, 0x415d7b main slot loop, 0x415d25 exit.

### Globals
- `[0x44ef10]` = 0x2024f28 = global path obj resolved buffer ("C:\" after Bug11).
- `0x44ed08` global path object; `[0x4408bc]` dir wrapper buffer; `[0x4408c0]` last-error.
- `0x44f240` drive-letter "C" buffer (0x42d5e5); `0x446c08` "File Not" buffer.
- Path object layout: `[ebp-0x220]` obj; `+0x208` resolved ptr; `+0x210` capacity; `+0x20c` flag.

### IAT slots (dump-iat3.cjs + manual parse)
- `0x4500e4`=FindFirstFileExW, `0x4500c4`=FindFirstFileW, `0x4500bc`=SetFilePointer,
  `0x4500e8`=GetFileAttributesW, `0x450148`=HeapReAlloc, `0x45014c`=HeapSize,
  `0x450380`=_o__wcsicmp, `0x45045c`=**wcsrchr**, `0x450494`=**memset**,
  `0x45042c`(delay)=_o___stdio_common_vswprintf, `0x4501e0`=GetCommandLineW,
  `0x4503e0`=_o_towupper, `0x4503b0`=(iswalpha-ish, used at 0x42d56f),
  `0x450454`=_o__wcsnicmp, `0x45051c`=?, `0x450100`=GetVolumeInformationW.
- Import modules normalize: api-ms-win-crt-* → ucrtbase.dll; api-ms-win-core-* → kernel32.dll
  (interceptor.ts normalizeApiSetModule). Handler lookup key = `module!proc` lowercased.

## Logs & helper scripts (node_modules/.cache/)

| File | Purpose |
|---|---|
| `cmd-fix50.log` | **Latest** — full run with all probes (wcsrchr, vswprintf, FormatMessageW vaList, findData, WriteConsoleW content, node dump at 0x417ed4). 85 [tk] lines. |
| `cmd-fix50-out.bin` | stdout of latest run (the listing above) |
| `diag-trap.cjs` | esbuild bundle of scripts/diag-trap.ts (rebuild after editing TS) |
| `bkargs.txt` | `cmd /c dir C:\Windows` (inject via BK_ARGS) |
| `dump-iat3.cjs` | IAT resolver (regular imports only; delay-load slots NOT covered) |
| `cmd-fix49.log` | previous session's log (pre-Bug11; has the "C:\Windows\Windows" evidence) |

## Quick Commands

```bash
# Rebuild diagnostic bundle (esbuild pulls TS source; no core build needed)
node node_modules/.pnpm/esbuild@0.28.2/node_modules/esbuild/bin/esbuild \
  --bundle scripts/diag-trap.ts --outfile=node_modules/.cache/diag-trap.cjs \
  --platform=node --format=cjs --target=es2020 --external:typescript

# Run. Sandbox blocks literal `cmd /c` — args come via BK_ARGS.
BK_ARGS="$(cat node_modules/.cache/bkargs.txt)" node node_modules/.cache/diag-trap.cjs \
  "C:/Windows/SysWOW64/cmd.exe" > node_modules/.cache/cmd-fix50-out.bin 2> node_modules/.cache/cmd-fix50.log

# Disassemble a window (VA, not RVA)
PYEXE=$(ls /c/Users/HUAWEI/.workbuddy/binaries/python/envs/*/Scripts/python.exe 2>/dev/null | head -1)
"$PYEXE" scripts/disasm-win.py "C:/Windows/SysWOW64/cmd.exe" <va-hex> <len-hex>

# Find msgId constants / callers in .text (node one-liners, see session history)
```

## Active diag-trap.ts probes (keep, they are the breadcrumbs)

Parser/main, dispatch, dir chain probes as before (0x40a320/0x40a9e9/0x40bf53/
0x40c1a6/0x40dc0d/0x41afe9/0x417ed4/0x414ad6/0x40a4ac/0x40a4b6/0x40a60f/0x41eccc).
New this session:
- `0x417ed4` probe now dumps the dir-tree NODE: `node(edi) [n+0] [n+4] [n+c] [[n+c]]`
  (edi is a HEAP address 0x02xxxxxx — the probe checks `edi>=0x2000000 && <0x3000000`).
- LoggingInterceptor dumps: WriteConsoleW/WriteFile buffer content (wide or hex),
  FindFirstFileExW/W path + findData fields, vswprintf fmt+va args, FormatMessageW
  args + vaList chain + `44f240` content.
- `0x408ba9`/`0x408b1c`/`0x42529c` TK probes were added but **DO NOT FIRE**
  (not block starts) — remove or leave as no-ops; use 0x417ed4 instead.

## Success criteria (status)

1. FindFirstFileExW path == `"C:\Windows\*"` — currently `"C:\Windows"` (functionally
   correct for directory enumeration; "C:\Windows\*" would be ideal after fix #1).
2. Log shows WriteConsoleW rows: volume header ✓, " Directory of C:\Windows" (path
   still `C:\`), file rows ✓ (layout/size WIP), summary ✓.
3. `dir` output on stdout ✓; cmd exit 0 — **still exits 1**.
4. dir handler 0x40bf53 target stays `"C:\Windows"` ✓ (no regression).
