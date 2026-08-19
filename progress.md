# cmd.exe Emulator Debugging — Handover (2026-08-19 21:22, session 6)

> Single source of truth for continuing the work. Read fully before touching anything.
> All addresses are absolute VAs (image base 0x400000).

## Goal

Make the specter-core Windows PE emulator run `C:/Windows/SysWOW64/cmd.exe` with
`cmd /c dir C:\Windows` and emit the directory listing to stdout.

- Project root: `C:\Users\HUAWEI\Desktop\windows` (pnpm workspace, package `@specter-core`)
- Target binary: `C:/Windows/SysWOW64/cmd.exe` (entry VA 0x41de90 = mainCRTStartup, narrow-argv CRT)
- MUI satellite merged: `C:/Windows/System32/en-US/cmd.exe.mui` (message table type 11, merged OK)

## Current Status (one paragraph)

**dir WORKS end-to-end and cmd EXITS 0.** Output (cmd-fix68-out.bin):

```
 Volume in drive C has no label.
 Volume Serial Number is 1234-ABCD

 Directory of C:\

01/01/1601  12:00:00 AM263,cmd.exe
               1 File(s) 263, bytes
               0 Dir(s)            0 bytes free
```

- `[diag] status=exit eip=0x0` — **exit code 0, no more fault** (was fault at 0x406515, exit 1).
- stdout is clean (no stray NUL bytes; WriteConsoleW truncates at first NUL).
- Remaining cosmetic issues: header `" Directory of C:\"` (should be `"C:\Windows"`),
  file-row size `"263,"` (should be `"263,168"`), row fields run together.

**2 bugs fixed this session (Bug15, Bug16) — one in the EMULATOR, one in the runner:**

| Bug | Root cause | Fix |
|---|---|---|
| **Bug15** cmd div-by-zero fault at 0x406515 → exit 1 | `GetDiskFreeSpaceExW/A` missing from mapper.ts `X86_API_ARG_COUNT` → trap stub `ret 0` instead of `ret 16` → 16 bytes of args never cleaned → **esp drift** inside 0x430b52 → later push/pop read/write wrong stack slots → `[ebp-0x18]` corrupted → cmd calls `__report_gsfailure` soft path → returns with esp still off → `pop esi` restores garbage `0x7ffeb08` → 0x40a04f passes that as the output-state obj to 0x40652b → 0x4064f2 does `eax=[obj+8]; div [obj+0x20]` with both = 0 → 0/0 `RuntimeError: unreachable` | mapper.ts: added `'getdiskfreespaceexw': 4, 'getdiskfreespaceexa': 4` |
| **Bug16** stdout full of NUL bytes (v5 UNRESOLVED #4) | cmd passes the line-buffer **capacity** as WriteConsoleW nChars (0x220/0x2c8 etc.); the tail of the buffer is NUL padding; the handler converted all nChars chars including NULs | guest-process.ts `WriteConsoleW/W`: stop the wide→UTF-8 loop at the first `0x0000` (break), so padding NULs never reach onOutput |

## How Bug15 was found (do NOT re-investigate, but the chain is the breadcrumb)

The v5 handover said "cmd still exits 1" and blamed the div fault's operands. Full chain:

1. `0x430b52` (dir summary output, "X Dir(s) ... bytes free") calls
   `GetDiskFreeSpaceExW(0x21c69c0, 0x7ffeb08, 0x7ffeaf8, 0x7ffeb00)` at 0x430c33
   (`call [0x4500dc]`, 4 stdcall args, ret 16). No argCount entry → stub ret 0 →
   **esp after the call is 16 bytes lower than it should be.**
2. esp drift cascades: later `push ecx / call __report_gsfailure / pop ecx`
   (0x430cab-0x430cb1) and the final `pop edi / pop esi / pop ebx` (0x430cb7-0x430cbb)
   read from wrong stack slots. Probe evidence at 0x430cb1 (0x430b52 pre-return):
   `savedEsi@[ebp-0x24c]=0x20d1598` (intact!) but `pop esi` actually read
   `[esp+8]=0x7ffeb08` (the GetDiskFreeSpaceExW lpFreeBytes arg slot) → esi corrupted.
3. `[ebp-0x18]` (0x430b52 local, set to 0 at 0x430b85) became non-zero → the
   `test ecx,ecx; je 0x430cb2` at 0x430ca7 didn't take the skip → `call 0x41e1a7`
   (0x430cac) executed — that's the **soft __report_gsfailure path**:
   `0x41e1a7: jmp 0x41ea3d → jmp 0x41edd4 → jmp dword ptr [0x4503ac]` (tail-call an
   API, returns straight to 0x430cb1). It is NOT a hard RaiseException path here.
4. Back in the 0x4098e0 dispatcher: `0x40a04f: mov ecx, esi; call 0x40652b` with
   esi=0x7ffeb08 (stack garbage). 0x40652b → 0x4064f2 with obj=0x7ffeb08 (all-zero
   stack slot): `mov edi,edx; mov ebx,ecx; xor esi,esi; wcschr(edi,'\n')` returns 0
   (edi=0 → 0x40e37e `test ecx,ecx; je 0x40e38d` → eax=0), then
   `0x406515: mov eax,[ebx+8]; xor edx,edx; div dword ptr [ebx+0x20]` — both 0 → #DE.
5. Fix = 4 extra bytes in mapper.ts. After the fix the last 0x40652b call sees a
   healthy obj (`0x20d1598`, `[+8]=0xb2`, `[+0x20]=0x50`), 0x40652b finalizes, and
   the dispatcher returns cleanly. `status=exit eip=0x0`.

## IMPORTANT disassembly correction (v5 text was based on a stale decode)

**0x4064f2 is NOT `mov edi,ecx; mov ebx,[ecx+8]`.** Actual bytes at 0x4064f2:
`8b ff 53 56 57 8b fa 8b d9 33 f6 6a 0a 5a 8b cf e8 ...` →
`mov edi,edx; mov ebx,ecx; xor esi,esi; push 0xa; pop edx; mov ecx,edi; call 0x40e37e`.

So the real contract of the **line-count function 0x4064f2(ecx=obj, edx=str)**:
- `edi = str` (from `[obj+0x10]` set by the caller), `ebx = obj`.
- Loop: `wcschr(edi, '\n')` (0x40e37e = thin wrapper, `call [0x450460]`); if found,
  `0x424fce` counts rows against `[ebx+0x20]` (row width, 0x50=80) and continues
  at `0x4064fd`; if not found and esi==0, `eax = [ebx+8]; eax /= [ebx+0x20]`.
- Healthy obj (heap, 0x20d1598): `[+8]` = running char count, `[+0x20]` = 80.
- Fault obj (stack garbage 0x7ffeb08): both 0 → 0/0.

Also confirmed: `0x41ee28: jmp [0x450494]` = **memset thunk** (v5 was right);
`0x41ee40` = 5-arg vswprintf wrapper → 0x41eccc → `_o___stdio_common_vswprintf`.

## UNRESOLVED issues (next session, in priority order)

### 1. " Directory of C:\" should be "C:\Windows" (cosmetic, on the checklist)
- Unchanged from v5: header insert comes from the dir-tree node `[node+4]`
  (`0x42529c: mov eax,[ebp+8]; push [eax+4]` → observed `"C:\"`). The same
  `[node+4]` feeds the enumeration concat at 0x408cac (`"C:\" + "\" + "Windows"`),
  which is why the listing works but the header is short.
- NEXT STEP: determine which node builder ran (0x425660 vs 0x40a320 family);
  real cmd wants `[node+4]="C:\Windows"` for the header AND the concat's 2nd arg
  becomes `"*"` so FindFirstFileExW sees `"C:\Windows\*"`. Probe 0x417ed4
  (fires) to dump the node; 0x42529c/0x408ba9 are NOT block starts (probes miss).

### 2. file-row size truncated: "263," (should be "263,168")
- findData size is correct (263168, `findData@0x21b5d24 size=263168`).
- The string at `0x7ffa2f0` **already is** `"263,"` (UTF-16LE `32 00 36 00 33 00 2c 00`
  + NUL) when it reaches the row vswprintf (`fmt="%s"`). So the truncation happens
  upstream in the number→grouped-string formatter.
- Facts gathered:
  - `0x41d730` is the grouped-number formatter (allocates `[esi*2+0x28]` bytes,
    calls `0x40d9f4` = vswprintf wrapper → 0x40da2d). **No direct `call 0x41d730`
    found in .text — it is dispatched via a function pointer** (find the pointer
    table / indirect call sites).
  - `0x40d9f4(buf, count, fmt, va)` thin wrapper; `0x40da2d` = real vswprintf.
  - The `fmt="%5lu"` vswprintf calls (buf=0x44f240, va=0x1 → `"    1"`) are the
    **File(s)/Dir(s) counters**, NOT the size — size never goes through a `%lu`.
  - `0x446ad0` (runtime state, memmove'd into 0x7ffa2b8 and wcsncmp'd vs 0x7ffa2aa)
    is around the same formatting code but is a runtime value, not a constant.
- NEXT STEP: find how 0x7ffa2f0 gets written (break on write via a probe at the
  formatter entry, or trace `_i64tow_s`/`_ultow_s`-style CRT calls — none appear
  in the [api] log, so it is cmd-internal code, likely 0x40da2d area). Why does
  the digit loop stop after `"263,"`? Suspect the count passed to vswprintf
  (`count=[ebp-0xc]>>1 = wcslen(src)*? + 0x14`) or a wrong length fed to the
  grouping loop.

### 3. row layout: "01/01/1601  12:00:00 AM263,cmd.exe" (fields run together)
- Depends mostly on #2 (size field width/padding) and the field offsets in cmd's
  row builder. Revisit after #2.

### 4. Why does cmd pass nChars = buffer capacity (0x220/0x2c8) to WriteConsoleW?
- Defensive fix (Bug16) already makes stdout clean, but the underlying cause is
  unexplained: cmd's `_putws`-style path passes the line-buffer size, not the
  text length, for every line (including `" Volume...\r\n"` which is 34 chars but
  nChars=0x220=544). Likely a wrong return value from one of the CRT helpers
  (vswprintf/FormatMessageW/0x40d9f4 return length vs capacity). Cosmetic now.

## Key Addresses (updated)

### cmd.exe functions (dir chain)
- `0x408b1c` dir exec entry (8 stack args, ret 0x20). `0x408ba9` dir exec core.
  Callers of 0x408ba9: 0x408b5d, 0x4256f3, 0x431cdd. 0x408b1c pushes ebx/esi/edi
  and restores them on every return path (0x408b97).
- `0x408cac` concat via 0x417ed4. `0x408d08` FindFirstFileExW wrapper (0x41afe9).
- `0x40a320` dir outer handler (saves esi/edi/ebx, sub esp 0x454). Called at 0x409ca1.
- `0x4098e0` dispatcher that drives one dir entry: 0x409c53 `lea ecx,[ebp-0x880]; call 0x40a061`
  (init output-state obj → stores heap ptr into [ebp-0x880]); 0x40a061 fails when
  `0x411d4e` returns non-zero (jne 0x425a9e / 0x425ac3 — [ebp-0x880] stays 0);
  0x409e72 calls 0x408b1c; 0x409f7d calls 0x430b52; 0x40a04f calls 0x40652b(esi).
- `0x430b52` dir summary ("X Dir(s) Y bytes free"): sub esp 0x244, saves ebx/esi/edi
  at [ebp-0x250]/[ebp-0x24c]/[ebp-0x248] (push order ebx,esi,edi → savedEsi=[ebp-0x24c]).
  Calls GetDiskFreeSpaceExW (0x430c33), vswprintf (0x430c87 via 0x40d9f4),
  FormatMessageW msgId 0x2379 (0x430c96 via 0x42e5f0). GS-soft path 0x430cab-0x430cb1.
- `0x40652b` output-state finalize; `0x4064f2` line-count (see correction above);
  `0x40656a` finalize v2 (0x409df9 calls it).
- `0x41d730` grouped-number formatter (function-pointer dispatched; no direct callers).
  `0x40d9f4` vswprintf wrapper → `0x40da2d` real vswprintf. `0x41d78b` alloc site
  inside the formatter (HeapAlloc 0x150 appears with ret-addr 0x41d78b).
- `0x40e37e` wcschr wrapper (`test ecx,ecx; je 0x40e38d; push edx; push ecx;
  call [0x450460]; pop ecx; pop ecx; ret`).
- `0x41e1a7` = `jmp 0x41ea3d` = `jmp 0x41edd4` = `jmp [0x4503ac]` (soft
  __report_gsfailure tail-call). `0x41e1b2` = hard path (RaiseException 0xc0000409).
- `0x42529c` " Directory of %s" (msgId 0x2339) call site.
- Parser/main: 0x40b743, 0x410800 dispatch, 0x415d7b main slot loop, 0x415d25 exit.

### IAT slots relevant to this session
- `0x4500dc`=GetDiskFreeSpaceExW (call at 0x430c33), `0x4503ac`=gsfailure tail-call
  API (0x41edd4), `0x450460`=wcschr (0x40e384), `0x450334`/`0x45001c`=quoted-token
  write pair (0x425035/0x42503d, inside 0x424fe8 branch), `0x450494`=memset,
  `0x45042c`(delay)=_o___stdio_common_vswprintf, `0x450380`=_o__wcsicmp,
  `0x45045c`=wcsrchr, `0x450100`=GetVolumeInformationW.

## Logs & helper scripts (node_modules/.cache/)

| File | Purpose |
|---|---|
| `cmd-fix68.log` / `cmd-fix68-out.bin` | **Latest** — exit 0, clean stdout (215 bytes), 782 [api] lines, all probes incl. 0x430b52/0x430cb1 saved-esi and onOutput hex dumps |
| `diag-trap.cjs` | esbuild bundle of scripts/diag-trap.ts (rebuild after editing TS) |
| `bkargs.txt` | `cmd /c dir C:\Windows` (inject via BK_ARGS) |
| `cmd-fix50.log` | v5 session log (pre-Bug15 fault evidence) |

## Quick Commands

```bash
# Rebuild diagnostic bundle (esbuild pulls TS source; no core build needed)
node node_modules/.pnpm/esbuild@0.28.2/node_modules/esbuild/bin/esbuild \
  --bundle scripts/diag-trap.ts --outfile=node_modules/.cache/diag-trap.cjs \
  --platform=node --format=cjs --target=es2020 --external:typescript

# Run. Sandbox blocks literal `cmd /c` — args come via BK_ARGS.
BK_ARGS="$(cat node_modules/.cache/bkargs.txt)" node node_modules/.cache/diag-trap.cjs \
  "C:/Windows/SysWOW64/cmd.exe" > node_modules/.cache/cmd-fixNN-out.bin 2> node_modules/.cache/cmd-fixNN.log

# Disassemble a window (VA, not RVA)
PYEXE=$(ls /c/Users/HUAWEI/.workbuddy/binaries/python/envs/*/Scripts/python.exe 2>/dev/null | head -1)
"$PYEXE" scripts/disasm-win.py "C:/Windows/SysWOW64/cmd.exe" <va-hex> <len-hex>

# Verify actual bytes at a VA (use this if disasm looks wrong)
PYEXE=$(ls /c/Users/HUAWEI/.workbuddy/binaries/python/envs/*/Scripts/python.exe 2>/dev/null | head -1)
"$PYEXE" -c "import sys; img=open('C:/Windows/SysWOW64/cmd.exe','rb').read(); va=int(sys.argv[1],16); off=0x400+(va-0x401000); print(img[off:off+16].hex(' '))" <va-hex>
```

## Active diag-trap.ts probes (keep — they are the breadcrumbs)

v5 probes (0x40a320/0x40a9e9/0x40bf53/0x40c1a6/0x40dc0d/0x41afe9/0x417ed4/
0x414ad6/0x40a4ac/0x40a4b6/0x40a60f/0x41eccc, 0x408ba9/0x408b1c no-fire) + new:

- `0x40652b`/`0x4064f2`/`0x40656a`/`0x406507`: dump obj(ecx) fields +8/+10/+20,
  `*obj+8` contents, `[+10]` string; 0x406507 additionally dumps ebx,[ebx+8],[ebx+0x20].
- `0x409c4b`/`0x40a061`/`0x425a9e`/`0x425ac3`/`0x425ad9`: output-state init gate
  and failure paths ([ebp-0x880] state).
- `0x40a022`/`0x40a04f`/`0x409ca6`/`0x409cce`/`0x409fd4`/`0x409e77`/`0x409df9`/
  `0x409f82`: esi/edi/ebx drift tracking through the 0x4098e0 dispatcher
  (0x409ca6 shows esi=0x20d1598 intact; 0x409f82 shows esi=0x7ffeb08 corrupt).
- `0x430b52`/`0x430cb1`/`0x430cb2`: 0x430b52 entry args; 0x430cb1 pre-return
  (savedEsi@[ebp-0x24c], savedEdi@[ebp-0x250], savedEbx@[ebp-0x254], esp layout).
- `0x42529c`: header FormatMessageW call site (no-fire, keep as no-op).
- LoggingInterceptor: vswprintf fmt+va dump with **raw bytes** of the first va arg
  when it is a stack pointer (0x7fe0000-0x8000000) — this is how "263," was pinned.
- `onOutput`: logs every console write with hex prefix (len + nonzero count).

## Success criteria (status)

1. FindFirstFileExW path == `"C:\Windows"` — functionally correct for enumeration;
   `"C:\Windows\*"` ideal after fix #1.
2. Log shows WriteConsoleW rows: volume header ✓, " Directory of C:\Windows"
   (path still `C:\`), file rows ✓ (size/layout WIP), summary ✓.
3. `dir` output on stdout ✓; **cmd exit 0 ✓ (Bug15 fixed)**; stdout free of
   NUL padding ✓ (Bug16 fixed).
4. dir handler 0x40bf53 target stays `"C:\Windows"` ✓ (no regression).
