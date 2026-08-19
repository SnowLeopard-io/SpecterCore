# cmd.exe 模拟器调试进展（handover）

## 目标

让 specter-core 模拟器运行 `C:/Windows/SysWOW64/cmd.exe`，执行 `cmd /c dir C:\Windows` 并输出 dir 结果。

- 项目根：`C:\Users\HUAWEI\Desktop\windows`（pnpm workspace，包 @specter-core）
- 目标二进制：`C:/Windows/SysWOW64/cmd.exe`（entry VA 0x41de90 = mainCRTStartup，窄 argv 程序）

## 常用命令

```powershell
# 构建
node node_modules/.pnpm/esbuild@0.28.2/node_modules/esbuild/bin/esbuild --bundle scripts/diag-trap.ts --outfile=node_modules/.cache/diag-trap.cjs --platform=node --format=cjs --target=es2020 --external:typescript

# 运行（记录 API 轨迹）
$env:BK_ARGS='cmd /c dir C:\Windows'; $env:BK_TRACE='api'; node node_modules/.cache/diag-trap.cjs "C:/Windows/SysWOW64/cmd.exe" > node_modules/.cache/cmd-fix5.log 2>&1

# 反汇编（BASE=0x400000；.text va=0x1000 raw=0x400 size 0x32200；.data va=0x34000 raw=0x32600+0x400；.idata va=0x50000 raw=0x32a00）
& "C:/Users/HUAWEI/.workbuddy/binaries/python/envs/diag/Scripts/python.exe" scripts/disasm-win.py "C:/Windows/SysWOW64/cmd.exe" <va> <len>
```

- 最新运行：`node_modules/.cache/cmd-fix5.log`，结果 `status=exit eip=0x0 stubs=284`（干净退出码 0，但无任何输出，dir 从未执行）。

## 当前卡点（一句话）

cmd 的 `main()` 解析命令行后，全局 `[0x4406dc]`（命令行 tail 指针）仍为 0 →
cmd 判定"没有命令行"，进入**交互模式**调用 `ReadConsoleW`（返回 0）→ 之后在
0x4116c0 解析器中 `[0x440888]==ebx(0)` 触发 `longjmp(0x446b48, 2)` → 重试循环
0x415d20 → 最终 `_o_exit(0)`。

## 已完成的修复（Bug1–Bug5）

1. **Bug1** BrandingFormatString delay-load argCount + `allocDynamicStub` procName toLowerCase（已验证）。
2. **Bug2** `X86_API_ARG_COUNT` 补 `getconsolescreenbufferinfo:2` 及控制台族（已验证，0x40baa6 OOB 消失）。
3. **Bug3** `_setjmp3` handler（guest-process.ts ~2149）：arg0=env，trap 读 [esp] 为返回 eip、espAtTrap+4 为 Esp，写 6 dword 返回 0；hook `ucrtbase.dll/_setjmp3`（已验证，longjmp 落到 0x415e35）。
4. **Bug4** 新增 `SetConsoleMode` handler 返回 1（已验证）。
5. **Bug5** `GetConsoleMode` handler 改为向 `*lpMode`（raw(ctx,1)）写 DWORD 0x7 再 return ok(1)（handlers.ts ~146，仿 GetCPInfo 用 host.memory.write）。已应用并重跑 fix5。

## 本次会话新发现（fix5 后）

### 1. cmd 是窄 argv 程序，且已拿到 argc=4 / argv 正确
- cmd.exe 入口是 `mainCRTStartup`（0x41de90），**导入的是窄 `_o___p___argv`(0x450444) / `_o___p___argc`(0x450448)**，不是 wargv。
- fix5 日志：`_o___p___argc -> 0x4`，`_o___p___argv -> 0x20003c8`，`GetCommandLineW -> 0x2000370`（0x2000370 = cmdLineW，内容应为 "cmd /c dir C:\Windows"）。
- 说明 argv 层面没问题；问题在 cmd 自己的命令行解析（不用 CRT argv）。

### 2. cmd 走交互模式：`[0x4406dc] == 0`
- 0x4113c2 `mov eax,[0x4406dc]; test eax,eax; jne 0x411479`：若 `[0x4406dc]`（命令行 tail）非零则处理命令行，否则 0x4113cf 走交互读取。
- fix5 日志确认走了交互：`ReadConsoleW(0xfffffff6, 0x43c6d0, 0x2000, 0x7fffee4, 0x0) -> 0x0`（无 handler，返回 0）。此后还有 GetConsoleTitleW / SetConsoleCtrlHandler 等交互式初始化调用。
- **所以根因是 `[0x4406dc]` 没有被 main() 的 argv 解析填上非零值。**

### 3. main() 命令行解析流程（已梳理）
- main() 位于 0x415c37（prologue 0x415c39 push ebp / 0x415c51 call [0x450238]=GetCurrentThreadId 等）。
- 0x415cf3–0x415cfc：`lea edi,[ebp-0x14]` 后 4 次 `stosd` 清零 `[ebp-0x14..-0x8]`（4 个槽）。
- 0x415cfd：`lea ecx,[ebp-0x14]; call 0x40b743` —— **0x40b743 是命令行解析器**，入口 ecx=槽数组指针，填充 `[ebp-0x14]` 等槽。
- 0x40b743 内：0x40b803 call [0x453004]（delay-load GetCommandLineW），0x40b82d call [0x4501e0]=GetCommandLineW → 0x2000370；随后 wcslen(0x40b836 循环)、0x40b858 call 0x416063（拷贝/分配）、0x40b873 call 0x4136f0、0x40b8d9 call 0x40df9d（tokenizer，接收 cmdline 副本 + 槽数组）。
- main() 0x415d6a–0x415dcd：循环 eax=0..2 读取 `[ebp+eax*4-0x14]`（即 [ebp-0x14]/[-0x10]/[-0xc]），对每个非零槽 `call 0x410800`。
- **0x410800（0x4108ac）`mov [0x4406dc], eax`（eax=传入 edx=槽值）→ 设置命令行 tail 指针。**

### 4. longjmp(2) 触发点已定位（非 0x411d4e 返回 0）
- 0x4116e7 `mov ebx,[0x4406dc]`；0x4116f2 `test edi,edi; jne 0x411728`；0x4116f6 `test ebx,ebx; jne 0x411728`。
- edi==0 且 ebx==0 时走 0x4116fa `xor ecx,ecx; call 0x411d4e`（CRT 控制台检查，fix5 已通过返回 1）。
- 0x411701 `test eax,eax; je 0x41195a`（0x411d4e 返回 0 才 longjmp —— 现在返回 1，不走这条）。
- 0x411709 `cmp [0x440888], ebx; je 0x41195a`：`[0x440888]==ebx(0)` → **longjmp(0x446b48, 2)**。
- `[0x440888]` 仅在 0x411739 被置 1，条件是 0x411728 分支（`[0x440888]==0 && edi!=0 && ebx==0`）。因 edi==0，置 1 分支未执行。

### 5. longjmp(2) 后的执行链
- longjmp(0x446b48,2) → 0x415e35，eax=2 → 0x415f58 `xor ecx,ecx; jmp 0x415d20` → `call 0x4165fe`。
- 0x4165fe：`push 0; call 0x416620` 循环至非零 → 0x41660e `push esi; call [0x450398]`（=_o_exit）。
- `_o_exit` 日志 rawArgs[2]=0x415d25 = 0x415d20 处 call 的返回地址 → 必然 `_o_exit(0)` → status=exit。

### 6. fail-fast 异常（fix5 新出现，疑点）
- ReadConsoleW 之后出现：`SetUnhandledExceptionFilter(0x0)` → `UnhandledExceptionFilter(0x401000)` → `GetCurrentProcess() -> 0xffffffff` → `TerminateProcess(0xffffffff, 0xc0000409) -> 0x0` → `GetLastError() -> 0x78`。
- 0xc0000409 = STATUS_STACK_BUFFER_OVERRUN —— 这是 `__report_gsfailure`/GS 栈 cookie 失败路径！因模拟 TerminateProcess 返回 0（不真正杀进程），执行继续。
- 之后又跑了一轮 0x411d4e + 0x4124d0（SetConsoleMode/GetConsoleMode 到 0x4386b4/0x4386b8），然后 longjmp(2)。
- **疑点**：可能是某个 stub/handler（或 _setjmp3/longjmp 的 Esp 语义）写坏了栈 / 覆盖了 GS cookie。也可能是 ReadConsoleW 返回 0 触发 cmd 的异常路径。需排查。

### 7. 0x4124d0 控制台模式设置（已确认语义）
- stdout：GetConsoleMode 到 0x4386b4，检查 `(mode & [0x43416c])==[0x43416c]`（不满足则 0x41257f 重新 SetConsoleMode）。
- stdin：GetConsoleMode 到 0x4386b8，检查 `(mode & 0x17)==0x7`（0x412541 cmp al,7，mode=0x7 通过）。
- fix5 中均返回 1，正常。

## 关键全局变量 / IAT 槽（本次已修正）

- `[0x4406dc]` = 命令行 tail 指针（0 则交互模式）。引用点：0x4108ac(写)、0x4108ad、0x41135a、0x4117f2、0x411935、0x42d90b。
- `[0x440888]` = "已有命令行"标志（0x411739 置 1）。仅 0x41170b/0x41172a/0x41173b 引用。
- `[0x4406d4]` = 0x4386ca 的命令行缓冲指针（0x41193a、0x4108c5 设置）。
- `[0x4386b4]/[0x4386b8]` = stdout/stdin 控制台模式。
- `[0x4406d0]` = 命令缓冲相关指针（0x4108cf、0x411950）。
- IAT 槽（0x450xxx）**在文件内读不到**（.data raw 只有 0x400 字节，槽区 raw 偏移 OOB），必须用 .idata first-thunk 表解析（imp_ro=0x32f24）。已确认的关键槽：
  - [0x450000]=ApiSetQueryApiSetPresence, [0x45000c]=GetConsoleMode, [0x450010]=SetConsoleMode, [0x450014]=SetConsoleCtrlHandler, [0x450018]=ReadConsoleW, [0x45001c]=WriteConsoleW, [0x450038]=GetConsoleScreenBufferInfo, [0x450044]=GetConsoleTitleW
  - [0x450090]=**GetLastError**（修正：之前标 unknown）, [0x4500b4]=GetFileType（thunk 0x51a10/hint 0x37 已核实）, [0x4500bc]=SetFilePointer, [0x4500c0]=ReadFile, [0x4500f4]=WriteFile, [0x4500fc]=CreateFileW
  - [0x450138]=HeapAlloc, [0x45013c]=HeapFree, [0x450140]=GetProcessHeap
  - [0x4501a0]=GetCPInfo, [0x4501d0]=**GetStdHandle**（修正）, [0x4501e0]=**GetCommandLineW**, [0x4501f4]=GetEnvironmentStringsW
  - [0x450208]=CreateProcessW, [0x450214]=TerminateProcess, [0x450238]=GetCurrentThreadId
  - [0x4502d0]=AcquireSRWLockShared, [0x4502c8]=ReleaseSRWLockShared, [0x450298]=EnterCriticalSection, [0x4502a0]=LeaveCriticalSection, [0x4502b4]=InitializeCriticalSection
  - [0x450334]=_o__get_osfhandle, [0x450398]=_o_exit, [0x4503c0]=_o_malloc, [0x450460]=wcschr, [0x450464]=longjmp, [0x45046c]=_setjmp3, [0x450494]=memset
  - delay-load 槽：0x453004 → GetCommandLineW（kernel32 #10），0x453020 → BrandingFormatString

## MSVC jmp_buf / 长跳

- x86 jmp_buf：[0]=Ebp [4]=Ebx [8]=Edi [12]=Esi [16]=Esp [20]=Eip。
- jmp_buf 0x446b48 在 0x415d33 / 0x415e2b 设置（保存 eip=0x415e35）。
- `_setjmp3` thunk 0x424cbd = jmp [0x45046c]；longjmp 包装 0x423da3(val=1) / 0x423dbf(val=2)，触发点 0x41195a。

## 下一步建议

1. **查命令行解析为何没填槽**：在 0x40b743 返回后、main 0x415d6a 循环处断点，检查 `[ebp-0x14..-0xc]` 是否非零；若为 0，则跟踪 0x40b743 内部（0x40df9d tokenizer 依赖 `_o__get_osfhandle`/wcslen/拷贝等）哪里失败。重点看 0x40b743 是否依赖某个未 mock 的 API 或 `GetEnvironmentVariableW`/`SearchPathW`。
2. **排查 0xc0000409 fail-fast**（GS cookie）：找 `__security_check_cookie`（_security_cookie 位于 0x4340c0，main 0x415c3f 读取后 `xor ebp` 存 [ebp-4]）在哪触发。可能是某 stub 写坏栈，或 longjmp/_setjmp3 的 Esp 恢复不对。
3. 若命令行解析需要真实文件/路径匹配（例如 cmd 校验 argv[0] 与自身 exe 路径），需在 `_o___p___argv`/GetCommandLineW handler 提供一致内容。

## 相关文件

- `packages/core/src/api/handlers.ts` — GetConsoleMode（现写 0x7）、SetConsoleMode、GetFileType、默认 API 表。
- `packages/core/src/process/guest-process.ts` — GetCommandLineW/argv 处理（~923–975）、_setjmp3 handler（~2149）、longjmp（~2107）、GetProcAddress/ResolveDelayLoadedAPI/allocDynamicStub。
- `packages/core/src/pe/mapper.ts` — X86_API_ARG_COUNT（line 37）与桩生成。
- `packages/core/src/jit/trap-dispatcher.ts` — rawArgs 捕获（esp+4）与 eax 写回。
- `packages/core/src/api/interceptor.ts` — normalizeApiSetModule。
- `scripts/diag-trap.ts` — 诊断运行器（BK_ARGS → options.commandLine）。
- `scripts/disasm-win.py` — 反汇编。
- `node_modules/.cache/cmd-fix5.log` — 最新运行轨迹。

---

## 最新交接附录（2026-08-19）

### 当前结论

目标仍未完成：`cmd /c dir C:\Windows` 尚未产生 dir 输出，运行结果仍为
`status=exit eip=0x0`，随后进入 `ReadConsoleW` 交互路径并以 `_o_exit(0)` 结束。

但问题范围已进一步收窄：

- CRT 窄 argv 已确认正常：`argc=4`，`argv` 指针有效。
- `GetCommandLineW` 已返回 guest 内存中的完整命令行。
- 控制台模式、文件类型、`GetFullPathNameW` 和目标 exe 的 `FindFirstFileW` 校验已通过。
- `_o_towupper`、`_o_iswalpha` 等 CRT 宽字符 handler 已实际命中并返回正确值。
- tokenizer 仍没有把命令尾写入调用者槽数组，因此 `[0x4406dc]` 仍为 0。

### 本轮已完成的代码修复

1. `packages/core/src/api/handlers.ts`
  - 增加 `wcschr` 宽字符串查找。
  - 增加 `_o_iswspace` / `iswspace`。
  - 增加 `_o_towupper` / `towupper`。
  - 增加 `_o_iswalpha` / `iswalpha`。

2. `packages/core/src/process/guest-process.ts`
  - 增加 `GetFullPathNameW`：支持相对路径拼接、写入 UTF-16 缓冲区、返回文件名部分指针。
  - 动态桩按函数名匹配 handler 时改为大小写不敏感。

3. `scripts/diag-trap.ts`
  - `buildExeFs().findFirstFile()` 对目标 exe 返回一个有效的 `FindData`，使 cmd 的自身文件存在性检查能够通过。
  - 已移除本轮临时的 `[cmd]` 槽数组断点日志；保留原有诊断断点。

### 重要验证结果

```text
pnpm typecheck
通过

pnpm exec vitest run packages/core/src/api/interceptor.test.ts packages/core/src/pe/mapper.test.ts
1 个测试文件，7 个测试通过

最新运行关键轨迹：
GetFullPathNameW(...) -> 0x3
FindFirstFileW(...) -> 0x7001
_o_towupper(0x43, ...) -> 0x43
_o_iswalpha(0x43, ...) -> 0x1
ReadConsoleW(...) -> 0x0
_o_exit(0)；status=exit eip=0x0
```

注意：`get_errors` 对 `scripts/diag-trap.ts` 的单文件诊断会报告 Node 类型和 workspace alias 缺失；这是该文件不在根 tsconfig 编译范围内造成的工具诊断，根级 `pnpm typecheck` 已通过。

### 当前最值得追的控制流

cmd 命令行解析器：`0x40b743`。

- 入口：`ecx = callerSlots`，即 main 的 `[ebp-0x14]`。
- 获取命令行：`0x40b82d -> GetCommandLineW`。
- tokenizer：`0x40b8d9 -> 0x40df9d`。
- 成功写入第三个槽的指令：`0x40e1bd: mov [eax+8], esi`。
- tokenizer 失败/跳转汇合点：`0x426f7a`。
- parser 返回后：`0x40b8de`，随后 main 在 `0x415d6a` 读取三个槽。

当前没有观察到 `0x40e1bd` 被执行；因此下一步应确认 tokenizer 为什么没有走到该指令，而不是继续修改 `[0x4406dc]` 或伪造 main 的槽值。

### 下一步建议

1. 在 `scripts/diag-trap.ts` 的 `onStep` 中临时只增加 `0x40e1bd`、`0x426f7a`、`0x40e299` 三个断点，打印 `eip/esi/edi/ebx` 和 `[esp+0x14]`，确认 tokenizer 走的是成功路径还是失败汇合路径。
2. 反汇编并跟踪 `0x40e37e` 的返回值。它负责从 tokenizer 输入中寻找特殊字符；当前 `/` 已由 `wcschr` 正确返回，但还需确认 `0x40e37e` 对 `cmd /c ...` 的后续扫描没有因其他 CRT 分类函数返回值而失败。
3. 从最新 API 轨迹中筛选 `-> 0x0` 的 tokenizer 区间调用，优先补真正影响分支的 API；不要把所有默认 0 的 API 一次性改成成功值。
4. 若确认 tokenizer 已成功生成临时结构但 callerSlots 仍为 0，再检查 `0x40df9d` 的参数约定和 `0x4136f0` 的 UTF-16 拷贝长度；目前尚无证据支持直接改 `_setjmp3` 或栈语义。
5. 修复完成后，重新生成 `node_modules/.cache/diag-trap.cjs`，运行命令如下：

```powershell
node node_modules/.pnpm/esbuild@0.28.2/node_modules/esbuild/bin/esbuild --bundle scripts/diag-trap.ts --outfile=node_modules/.cache/diag-trap.cjs --platform=node --format=cjs --target=es2020 --external:typescript
$env:BK_ARGS='cmd /c dir C:\Windows'; $env:BK_TRACE='api'; node node_modules/.cache/diag-trap.cjs "C:/Windows/SysWOW64/cmd.exe" > node_modules/.cache/cmd-latest.log 2>&1
```

成功标准：日志中不再出现 `ReadConsoleW` 作为首次命令输入路径，出现 `FindFirstFileW`/`FindNextFileW` 或 `WriteFile` 输出轨迹，并且最终不再因 `[0x4406dc]==0` 走 `longjmp(2)`。

---

## Session continuation (2026-08-19)

### Root cause found and FIXED: missing `_o_towlower`

- The command-line tokenizer at `0x40df9d` finds the first `/` in the line, then calls
  `[0x4503dc]` on the char after it. Decoding the PE import table shows **`0x4503dc` →
  `_o_towlower`** (hint 1114). The return value is compared *directly* against literal
  switch chars: `0x63='c'`, `0x71='q'`, `0x3f='?'`, `0x6b='k'`, `0x72='r'`, `0x75='u'`,
  `0x61='a'`, `0x78='x'`, `0x79='y'`, `0x65='e'`, `0x64='d'`.
- `handlers.ts` only had `_o_towupper`/`towupper` (added last session). **`_o_towlower`/
  `towlower` were missing**, so the call returned the default `0`. Then
  `0x40e002 test cx,cx; je 0x42704c` took the failure/merge path, the third slot (command
  tail → `[0x4406dc]`) was never written, and cmd fell into interactive mode →
  `ReadConsoleW` → `longjmp(2)` → `_o_exit(0)`.
- **Fix:** added `_o_towlower` and `towlower` (A-Z → a-z) to `handlers.ts`. Verified via the
  `[tk]` tracer: the tokenizer now reaches the `c`-case at `0x40e088` with `ecx=0x63`, the
  parser returns at `0x40b8de`, and `FindFirstFileW` is reached.

### Handover success criteria are now MET

- `ReadConsoleW` is no longer the first command-input path (0 occurrences in `cmd-latest.log`).
- `FindFirstFileW` is now present in the trace — cmd reaches `dir C:\Windows` enumeration.
- No more `longjmp(2)` from `[0x4406dc]==0`.
- `pnpm typecheck` (via managed node + local tsc) passes; `packages/core/src/api/` tests pass (7/7).

### Remaining blocker #1: GS cookie fail-fast (`0xc0000409`)

- After `FindFirstFileW`/`FindClose`, a function's epilogue trips `__report_gsfailure`
  (`0x41e1e4`): it writes `ExceptionCode = 0xc0000409` and does `int 0x29` fastfail →
  `UnhandledExceptionFilter(0x401000)` → `TerminateProcess(0xffffffff, 0xc0000409)`.
  Because `TerminateProcess` is a no-op in the emulator, cmd's SEH catches the exception,
  unwinds, **re-runs the tokenizer**, and finally `_o_exit(0)` — **without emitting any dir
  output**.
- This same `0xc0000409` appeared in fix5 on the interactive path (handover §6, "疑点 #2"),
  so it is a **pre-existing, systemic** issue, not introduced by this change.
- Hypothesis (handover §6 #2): a wrong Esp restore in `_setjmp3`/`longjmp`, or a stub writing
  past a stack buffer, corrupts the GS security cookie (`_security_cookie` at `0x4340c0`;
  per-function cookie at `[ebp-4]`).
- A tried-and-reverted change to `writeFindData` (592 → 566 bytes, skipping
  `cAlternateFileName`) did **not** fix it, so the WIN32_FIND_DATAW write is not the culprit;
  the failure points back to SEH / `_setjmp3`/`longjmp` Esp semantics.

### Remaining blocker #2: MUI resources empty

- Log line: `MUI: found C:/Windows/System32/en-US/cmd.exe.mui but merged 0 resources`.
  cmd's `dir` format strings (`Directory of`, volume label, etc.) live in the message table of
  cmd.exe.mui; with 0 resources merged, cmd cannot format the output.

### Files changed this session

- `packages/core/src/api/handlers.ts`: added `_o_towlower`, `towlower`.
- `scripts/diag-trap.ts`: added focused tokenizer breakpoints and a `[tk]` tracer
  (`0x40dfc5/ce/e4/e9/dff7/dfff/e002/e020/e088/e1bd/426f7a/42704c/40b8de/415d6a`) — kept for
  the GS investigation.

### How to re-run

```powershell
node node_modules/.pnpm/esbuild@0.28.2/node_modules/esbuild/bin/esbuild --bundle scripts/diag-trap.ts --outfile=node_modules/.cache/diag-trap.cjs --platform=node --format=cjs --target=es2020 --external:typescript
BK_ARGS='cmd /c dir C:\Windows' BK_TRACE='api' node node_modules/.cache/diag-trap.cjs "C:/Windows/SysWOW64/cmd.exe" > node_modules/.cache/cmd-latest.log 2>&1
```

### Next steps

1. **(Task #5)** Investigate the GS fail-fast. Hook `__report_gsfailure` / the `int 0x29`
   fastfail to capture the faulting EIP and the failing function's frame, and re-verify the
   `_setjmp3`/`longjmp` Esp semantics in `guest-process.ts` (~2149 / ~2107). The
   `esp = espAtTrap + 4` assumption depends on exactly how the trap-dispatcher delivers a
   `call` trap.
2. **(Task #6)** Make the emulator parse and merge cmd.exe.mui message-table resources so
   `dir` can format its output.

Until #5 is resolved, `cmd /c dir C:\Windows` will reach file enumeration but abort before
printing, because the GS fail-fast unwinds the command.
