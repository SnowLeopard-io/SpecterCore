# 进度 / 交接文档 (PROGRESS)

> **给下一个 agent 的交接入口。** 目标：让 **Windows exe** 在 Browser Kernel 的 JIT 里跑起来，最终在 L6 桌面（apps/web）里加载并运行（含控制台输出）。
> 读完本文件后请读 `packages/core/src/{pe, jit, process, api}/` 与 `packages/contracts/src/core/`。
> **2026-08-19 交接（Step 9 Layer 1 完成）：notepad 的消息循环已真实化——GetMessageW 返回 1 + WM_CREATE、DispatchMessageW 用嵌套 Executor 真实调用了 notepad 主窗口 WndProc（DefWindowProcW(0x10001, 0x1, 0x0, 0x0) 为铁证），WndProc 返回后消息循环退出 → `_o_exit(0)` → `status=exit eip=0x0`（cleanExit=true）。图形桥接 Layer 1（WndProc 执行链）完成；下一步是 Layer 2：GDI 桥接（WndProc 的 WM_PAINT 绘制路径）。见 Step 9 下一步。**

## 当前目标（用户需求，2026-08-18 起）

1. 支持 **64 位 Windows exe（PE32+, magic 0x20B）**。
2. 最终在 **L6 桌面**里加载本地 exe 并运行。
3. 每做一步在 `docs/PROGRESS.md` 留痕。

## 已完成里程碑（历史，可复现）

- 32 位 headless 闭环：`sample/hello.exe` 打印 `hello from browser-kernel!` 退出码 7。✓
- x64 headless 闭环：`sample/hello-x64.exe`（自造 PE32+）打印 x64 消息。✓
- L6 桌面集成：`apps/web` 的 RunExecutableApp 真实执行 + 控制台输出（`pnpm --filter @bk/app-web build` ✓）。
- 真实 Inno 安装包（TraeWork_CN-Setup-x64.exe，32 位）从秒挂推进到 LZMA 解压（见 Step 3/4 历史）。
- 真实 notepad.exe（SysWOW64 x86）：delay-load 收尾打通 → cookie 校验通过 → **干净退出**（`status=exit eip=0x0`，`_o_exit(0)`），见 Step 6。✓
- 真实 notepad.exe：**GUI 假句柄层 + WinRT/WIP 跳过 + __chkstk/XADD 修复**，推进到"单实例互斥体检查"（见 Step 7）。✓（部分）

## 架构备忘（新 agent 必读）

- 平坦模型：fs 基址 = 0，`fs:[0]` = SEH 链头（guest 地址 0 处 = 0xffffffff）；`fs:[0x2c]` = TLS 数组。
- API 调用 = trap stub：`mov eax, slot; int 0x2e; ret N`（N = 弹参量，cdecl 为 0）；slot 经 IAT → 分发到 interceptor。
- **stub 的 `ret N` 必须精确匹配调用方压栈的字节数（stdcall 按参数占栈算，REGHANDLE 等 8 字节参数算 2 槽）。argCount 错 → 栈漂移 → 返回地址/栈 cookie 错位 → 诡异的 fail-fast 或死循环。这是本轮 3 个 bug 的共性根因。**
- 嵌套执行（SEH handler / _initterm / 任意 guest 函数调用）统一用嵌套 Executor + sentinel `int 0x2d` 停，**必须 snapshot/restore 全寄存器含 EIP**。
- `__bk_seh_debug` 全局开关；`[seh]` 日志含每次 RaiseException/RtlUnwind 的链遍历。
- **运行环境**：`pnpm` 坏了（corepack 路径转义），用 managed node + esbuild 直跑（见下）。
- `node_modules/@bk/*` 必须是 junction（`scripts/fix-bk-links.py`），改 `packages/*` 后行为没变先查这个。
- **int3（0xCC）填充区会被 executor 当普通代码穿过**（见 Step 6 bug 3）：exe 若"执行"到 int3 填充区会继续跑而不是 fault，掩盖真实错误。

## 常用命令（Step 4 起的标准工作流）

```bash
N="C:/Users/HUAWEI/.workbuddy/binaries/node/versions/22.22.2/node.exe"
PY="C:/Users/HUAWEI/.workbuddy/binaries/python/envs/diag/Scripts/python.exe"
cd C:/Users/HUAWEI/Desktop/windows

# 1) typecheck
"$N" node_modules/typescript/bin/tsc -p tsconfig.json --noEmit

# 2) 打包诊断器（esbuild bundle）
"$N" node_modules/esbuild/bin/esbuild scripts/diag-trap.ts --bundle --platform=node --format=esm --outfile=node_modules/.cache/diag-trap.mjs

# 3) 跑目标 exe（notepad 现在 ~5-10s 内 clean exit；日志大时 grep 过滤）
"$N" node_modules/.cache/diag-trap.mjs "C:/Windows/SysWOW64/notepad.exe" > /tmp/x.log 2>&1

# 4) 反汇编窗口（capstone，线性地址）
"$PY" scripts/disasm-win.py "C:/Windows/SysWOW64/notepad.exe" <addr-hex> <len-hex>

# 5) 资源树扫描（rsrc-scan.py 已支持路径参数）
"$PY" scripts/rsrc-scan.py "C:/Windows/SysWOW64/notepad.exe"
```

测试/回归：`"$N" node_modules/vitest/vitest.mjs run`（**当前 187/187 通过，25 files**）、`"$N" node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`。

---

# Step 6（2026-08-19 交接，本轮从 delay-load 推进到 clean exit）

## 一句话现状

notepad.exe（SysWOW64 x86）**干净退出**：`[diag] status=exit eip=0x0 stubs=312`，退出码 0。执行路径：CRT 启动 → MUI 字符串 → 窗口初始化（LoadStringW/CoCreateGuid/CoTaskMemAlloc/ResolveDelayLoadedAPI 全通）→ RegisterClassExW（默认返回 0）→ CreateWindowExW（**默认返回 0，窗口"创建失败"**）→ WinMain 失败路径 → `_o_exit(0)` → 进程退出。**GUI 假句柄层未实现**——这是下一步的卡点（见下）。

## 本轮修复的 bug（按根因，全部过 typecheck，vitest 187/187 无回归）

### Bug 1：ResolveDelayLoadedAPI 缺 argCount（delay-load 收尾卡点）
- **症状**（Step 5 卡点）：`ResolveDelayLoadedAPI(...) -> 0x200a54` 后 `eip=0x427690`（delay-load 描述符地址，数据区当代码执行）fault。
- **根因**：`X86_API_ARG_COUNT` 无 `resolvedelayloadedapi` → stub `ret 0`（cdecl）。但 `__delayLoadHelper2`（0x425cf0）是薄封装：`call [__imp_ResolveDelayLoadedAPI]; pop ebp; ret 8`。ResolveDelayLoadedAPI 是 **stdcall 6 参数**。ret 0 导致：`pop ebp` 弹掉 arg0（0x400000）、`ret 8` 把 **arg1（0x427690 = 描述符地址）当返回地址** pop → eip 落数据区。
- **修复**：mapper.ts `'resolvedelayloadedapi': 6`（stub 变 `ret 24`）。
- 反汇编佐证：0x425cf0-0x425d19（6 个 push 后 call [0x42a24c]）。

### Bug 2：EventUnregister argCount 错（REGHANDLE 是 8 字节）
- **症状**：CreateWindowExW 返回 0 后 cookie 校验失败 → `__report_gsfailure`（0x42631f，push 0xC0000409 → GetCurrentProcess → TerminateProcess(0xC0000409)）→ fail-fast。
- **根因**：`EventUnregister(REGHANDLE RegHandle)` 的 REGHANDLE 是 **ULONG64**，x86 stdcall 压 8 字节 = **2 个 4 字节槽**，stub 需 `ret 8`。表里 `'eventunregister': 1` → `ret 4` → 栈偏 4 字节 → 0x40f32f `mov ecx,[esp+0x4c]` 读 GS cookie 副本错位（读到 0）→ `__security_check_cookie` 失败。
- **修复**：mapper.ts `'eventunregister': 1→2`；顺手修正 `'eventwritetransfer': 8→5`（REGHANDLE 8B + PCEVENT_DESCRIPTOR 4B + PVOID 4B + ULONG 4B = 20B = 5 槽）。
- 反汇编佐证：0x40f31f-0x40f329 `push [0x42811c]; push [0x428118]; call [0x42a578]` = 压一个 64 位 REGHANDLE（高 4 + 低 4）。教训：**参数表按"栈上占几个 4 字节槽"计数，不是按"参数个数"**。

### Bug 3：CRT exit（_o_exit）未实现 → 死循环重入 WinMain
- **症状**：GetMessageW 从未被调用，但 LoadStringW 无限循环（134 万次），maxSteps=8M 触发 limit；`0x40f10a`（WinMain 初始化函数）ENTER **5599 次**，esp 每层 -0x40，返回地址恒 0x425f60。
- **根因**：WinMain 失败 → `0x425fd6 call 0x426ee8` = `jmp [0x42a4dc]` = **`_o_exit`（ucrtbase）**。无 handler → 返回 0 → 进程没退出 → 继续执行 `0x425fde call 0x426e60`（`_o__exit`，也返回 0）→ 落在 **0x425fe3 int3 填充区**，int3 被 executor 当普通代码穿过 → `0x425ff0: call 0x4265cc; jmp 0x425e68` → **重新进入 WinMain** → 无限初始化循环（每轮重分配字符串表、泄漏堆）。
- **修复**：guest-process.ts `installStartupHandlers` 里 hook ucrtbase `_exit/_Exit/exit/_o_exit/_o__exit` → `crtExit` handler（设置 `this.exitCode = arg0`、`this.exitRequested = true`、`this.runtime.setEip(0)`），等价 ExitProcess 语义。
- 验证：修复后 `_o_exit(0x0) -> 0x0` 后进程终止，`[diag] status=exit eip=0x0`。

### Bug 4（顺带发现）：loadstringw argCount 错
- `'loadstringw': 3` → **4**（LoadStringW(hInst,id,buf,cch) 是 4 参数 stdcall）。ret 12 每调用泄漏 4 字节；notepad 的调用者用 ebp 帧 + leave 恢复所以未炸，但必须修正。已重跑验证（见"验证状态"）。

## 当前代码改动清单（本会话）

- `packages/core/src/pe/mapper.ts`：
  - `'resolvedelayloadedapi': 6`（新）
  - `'eventunregister': 1→2`、`'eventwritetransfer': 8→5`
  - `'loadstringw': 3→4`、新增 `'loadstringa': 4`
  - **新增 GUI API argCount（stdcall）**：`registerclassexw/a: 1, showwindow: 2, updatewindow: 1, getmessagew/a: 4, translateacceleratorw: 3, isdialogmessagew: 2, defwindowprocw: 4, postquitmessage: 1, sendmessagew/a: 4, postmessagew/a: 4, getwindowlongw: 2`（已有的：createwindowexw: 12, peekmessagew: 5, dispatchmessagew: 1, translatemessage: 1, setwindowlongw: 3, destroywindow: 1, callwindowprocw: 5, getdc: 1, releasedc: 2）。**GetWindowLongW 是 2 参数（hWnd, nIndex），不是 3。**
- `packages/core/src/process/guest-process.ts`：新增 `crtExit` handler（ucrtbase `_exit/_Exit/exit/_o_exit/_o__exit`）。
- `scripts/diag-trap.ts`：加 maxSteps 8M；**临时断点已清理**（见"诊断工具"）。

## ⚠️ 验证状态（重要）

- vitest **187/187 通过**（25 files）✅
- typecheck 通过 ✅
- lint **0 errors / 0 warnings** ✅（本会话修掉 8 error + 1 warning：handlers.ts 未用 ctx ×4、codegen.ts FPU_BASE 未用导入、guest-process EXCEPTION_CONTINUE_SEARCH/resLookup 未用、nameVal prefer-const、多余 eslint-disable）
- **notepad clean exit 基线（status=exit eip=0x0）已验证**：loadstringw=4 + GUI argCount（含 getwindowlongw=2 修正）后重跑仍 `_o_exit(0)` 正常终止、`status=exit eip=0x0` ✅；diag-trap 断点清理后重跑同样 clean exit ✅

## 当前卡点 / 下一步（从这接手，按序）

1. **GUI 假句柄层（handlers 未实现！mapper argCount 已就绪）**，目标是让 notepad 走"创建窗口成功"路径：
   - `RegisterClassExW/A` → 返回递增原子（非 0）
   - `CreateWindowExW/A` → 返回递增假 HWND（0x10000 起）
   - `ShowWindow` → 1；`UpdateWindow` → 1
   - **验收信号**：`GetMessageW` 返回 0（WM_QUIT 语义）→ notepad 消息循环（0x40f1c7-0x40f26f）`jne 0x40f1c7` 不跳 → WinMain 正常返回 → `ExitProcess(0)` → `cleanExit=true`。这是最小闭环。
   - 若想跑 WndProc：GetMessageW 第一次返回 1（假消息），`DispatchMessageW` 用嵌套 Executor 调 guest WndProc（仿 SEH handler 模式，见架构备忘），完成后 `PostQuitMessage` → 第二次 GetMessageW 返回 0 退出。
   - notepad 消息循环用到的槽：TranslateAcceleratorW(0x42a110)、IsDialogMessageW(0x42a114)、TranslateMessage(0x42a118)、DispatchMessageW(0x42a11c)、GetMessageW(0x42a10c)。
   - handler 放在 guest-process.ts 的 user32 块（LoadCursorW 附近），注意 `GetMessageW` 的 lpMsg 参数（rawArgs[0]）可写 0 或跳过（返回 0 时 notepad 不读）。
2. L6 `RunExecutableApp` 补 fs 桥 + readFile（与 run-exe 对齐，目前只有 CLI 有）。
3. SSE/XMM 补强（0F 57 xorps、0F 2E/2F comiss、f3/f2 标量变体）——真实 exe 后续必撞（notepad 0x40f30f 已有 xorps/movlpd）。
4. **int3（0xCC）应显式 fault**：codegen/decoder 对 0xCC 目前按普通指令处理，exe 执行到 int3 填充区会被"穿过"（Bug 3 依赖此绕过；修掉可让"跑到填充区"直接暴露）。改后需重跑 notepad 确认无回归（正常路径不应执行到 int3）。
5. 回归：typecheck + 全量 vitest + lint + app-web 构建。

## 诊断工具 / 断点（已清理，保持干净）

- `scripts/diag-trap.ts`：**本会话的临时断点（[cookie]/[gs]/[ev]/[strtab]/[chain]/[winmain]/[retpath]/[dbg]/[stack]/[iter]）已全部移除**；保留：LoggingInterceptor 的 `[api]` dispatch 日志（含 LoadStringW/RegisterWindowMessageW/CreateFileW/MessageBoxW 详细行）、maxSteps 8_000_000、最后 64 block 的 `[trace]`（fault/limit 时打印）、dumpFault 现场 dump。notepad 全量日志约 374 行。
- **IAT 槽→函数名映射**：用临时 python 内联脚本（解析导入表 OFT/FT 遍历，见会话记录）；关键槽已查：0x42a10c=GetMessageW, 0x42a110=TranslateAcceleratorW, 0x42a114=IsDialogMessageW, 0x42a118=TranslateMessage, 0x42a11c=DispatchMessageW, 0x42a1e8=LoadStringW, 0x42a578=EventUnregister, 0x42a24c=ResolveDelayLoadedAPI, 0x42a4dc=_o_exit, 0x42a53c=_o__exit, 0x42a57c=EventRegister。**0x42a5a4/0x42a5a8 不在静态导入表（None）**，但 0x425f20/0x40f2bc 有 `call [0x42a5a4]`（疑似 CRT InitOnce/atexit 相关），未实现 handler，当前返回 0 未炸。

## 本会话未解 / 注意点（继承 + 新增）

- **CreateWindowExW 默认返回 0** → notepad 走失败路径退出（GUI 假句柄层实现后应返回非 0）。
- **int3 被穿过**（Bug 3 根因之一，见下一步 #5）。
- `RegQueryValueExW` 返回 0（ERROR_SUCCESS）但**不写数据**——notepad 读注册表设置读到垃圾，可能影响行为；目前没炸。
- `_o___stdio_common_vswprintf` 返回 0（未实现格式化）——GUID→字符串格式化路径返回 0，错误消息为空；遇异常先考虑它。
- `IsProcessorFeaturePresent(0x17)` 返回 0（fastfail 不可用）→ __report_gsfailure 走 UnhandledExceptionFilter 路径；若要精确模拟 fastfail 需返回 1。
- x87 `fcom`（0x422740 等）未实现。
- `0x42a5a4` 槽在 0x425f20/0x40f2bc 被 `call [0x42a5a4]` 调用（InitOnce/CRT 注册表相关？），未实现 handler，当前返回 0 未炸。
- `SHGetKnownFolderPath` 通过 delay-load 解析（日志显示 `kernel32.dll!SHGetKnownFolderPath`，实际应在 shell32；allocDynamicStub 的 module 判定取第一个匹配 hook，目前无功能影响）。

---

# Step 5（2026-08-19 历史，delay-load 卡点，已被 Step 6 解决）

## 一句话现状（历史）

notepad.exe（SysWOW64 x86）已跑通：**CRT 启动 → MUI 字符串加载 → 窗口初始化（LoadStringW/LoadCursorW/LoadAcceleratorsW/RegisterWindowMessageW/RegQueryValueExW/CoCreateGuid/CoTaskMemAlloc 全通）**，卡在 **delay-load 辅助（ResolveDelayLoadedAPI 返回 stub 后 eip 仍落到 delay-load 描述符 0x427690 = 数据区 → fault）**——已由 Step 6 Bug 1 修复。

## Step 5 已修的 bug（历史，防回退）

1. CoCreateGuid 越界写：Data4 应写 p+8（曾写 p+10，覆盖调用者栈 cookie 副本低 16 位 → __report_gsfailure）。**教训：任何 guest 内存写都要核对结构体布局/边界。**
2. malloc 未实现 → operator new 失败 → _CxxThrowException：ucrtbase malloc/calloc/realloc/free 全走 bump heap。
3. normalizeApiSetModule 误路由：api-ms-win-core-com-* 优先 → ole32.dll。
4. LoadStringW 块号/槽位公式错：块 id = (stringId>>4)+1、槽 = stringId & 0xF。
5. exe 自身无 RT_STRING：实现 MUI 合并（mergeMuiResources + namedResources）。
6. LoadMenuW/LoadAcceleratorsW 未实现：数字 ID + 字符串名双查。
7. LoadCursorW/LoadIconW：递增伪句柄（0x1000 起）。
8. LocalSize：读 [p-4] & ~7。
9. ResolveDelayLoadedAPI 初版实现（Step 6 修正了其 argCount）。

## Step 5 新增代码（历史）

- MUI 合并（mergeMuiResources）、LoadMenuW/A + LoadAcceleratorsW/A（loadResBytes）、ucrtbase 分配器、ole32（CoTaskMemAlloc/Free/Realloc/CoCreateGuid）、ResolveDelayLoadedAPI 初版。详见 git/代码注释。

---

# Step 7（2026-08-19 交接，本轮从 clean exit 推进到「单实例互斥体检查」）

## 一句话现状

notepad.exe（SysWOW64 x86）在 Step 6「干净退出（_o_exit 失败路径）」基础上推进了一大步：
**RegisterClassExW → 1（假 atom）、CreateWindowExW → 0x10001（假 HWND）、WIP 检查优雅跳过（RoGetActivationFactory → E_NOTIMPL）、__chkstk / lock xadd 修复**，最后落在**单实例互斥体检查**：`CreateMutexExW(0, name, 0, 0x1f0001) -> 0x0` + `GetLastError -> 0x0` → notepad 把 NULL mutex 解释为"另一个实例在运行" → **未调用 GetMessageW 就 status=exit eip=0x0（cleanExit=false，无 _o_exit/ExitProcess）**。**下一步：让 CreateMutexExW 返回非 0 假句柄，验收 = GetMessageW 被调用（返回 0）→ WinMain 正常返回 → ExitProcess(0) → cleanExit=true。**

## 本轮改动清单（全部过 typecheck）

### 1. GUI 假句柄层（guest-process.ts，插在 LoadCursorW 块之后）
- `RegisterClassExW/A` → 递增 class atom（1 起）
- `CreateWindowExW/A` → 递增假 HWND（0x10000 起）
- `ShowWindow` → 1、`UpdateWindow` → 1
- `GetMessageW/A` → **0**（= WM_QUIT 语义；lpMsg 不写，返回 0 时 notepad 不读）
- 消息循环其余槽 → 合理默认：TranslateAcceleratorW/IsDialogMessageW/TranslateMessage/DispatchMessageW/DefWindowProcW/PostQuitMessage/SendMessageW/A → 0；PostMessageW/A → 1；GetWindowLongW/SetWindowLongW → 0；DestroyWindow → 1
- 注意：**GetMessageW 返回 0 是最小闭环**；若要跑 WndProc，需 GetMessageW 第一次返回 1 + DispatchMessageW 用嵌套 Executor 调 guest WndProc（仿 SEH handler 模式），完成后 PostQuitMessage → 第二次返回 0。

### 2. WinRT 字符串/激活 + SHGetKnownFolderPath（核心修复，否则静默死）
- **根因**：这些函数返回 HRESULT，但默认未实现 handler 返回 **0 = S_OK 且不写出参** → guest 认为成功并解引用未初始化的输出指针 → notepad WIP 检查拿到垃圾工厂指针 → vtable call 走垃圾 → WASM 内存被 ensure() 一路撑到 4GB → **进程被系统静默杀掉（exit 1，无 [diag] 输出）**。
- mapper.ts `X86_API_ARG_COUNT` 新增（stdcall，缺了会栈漂移 4*N/call）：
  `windowscreatestringreference:4, windowscreatestring:3, windowsdeletestring:1, windowsgetstringrawbuffer:2, rogetactivationfactory:3, rogetmatchingrestrictederrorinfo:2, setrestrictederrorinfo:1, shgetknownfolderpath:4`
- guest-process.ts（bumpAlloc 定义之后、Sleep 钩子附近）：
  - `WindowsCreateStringReference(src,len,headerPtr,out)`：**必须 S_OK 并写合法 HSTRING**。notepad 对该函数失败的 `js` 路径会走 0x40cc99（push 0/0/1/ecx; call [0x42a25c] = 抛异常/fail-fast，**不优雅**）。实现：headerPtr 写 {len, 0}，out 写 headerPtr+8（HSTRING 布局 [h-8]=len, [h-4]=flags, h=数据），返回 0。
  - `WindowsCreateString(src,len,out)`：bumpAlloc(len*2+8) 同布局，返回 0。
  - `WindowsGetStringRawBuffer(h, lenOut)`：len=[h-8] 写 lenOut，返回 h。
  - `WindowsDeleteString` → S_OK no-op（引用串本就 no-op，堆串泄漏可接受）。
  - `RoGetActivationFactory` / `RoGetMatchingRestrictedErrorInfo` / `SetRestrictedErrorInfo` → **返回 0x80004001（E_NOTIMPL，负数）**。notepad 对 RoGetActivationFactory 失败走 **trace 日志 + jmp 跳过（优雅）**（0x40bcb6 / 0x40bcaa 的 `test esi,esi; jns` 检查）。
  - `SHGetKnownFolderPath` → 0x80004001（delay-load 解析成 kernel32.dll，所以 kernel32 + shell32 双 hook；notepad 失败路径 `js` 优雅跳过 banner/标题构建）。
- 反汇编佐证：notepad WIP 检查在 0x40bb80 区域，激活字符串 0x405110 = "Windows.Security.EnterpriseData.ProtectionPolicyManager"（55 字符）；这是**可选功能**，未托管系统上跳过完全正常。

### 3. Bug：xchg eax, r32 解码偏移（x86-decoder.ts，严重，可能影响所有 exe）
- **症状**：`__chkstk`（0x427330，MSVC 栈探测）执行 `xchg esp, eax` 后 ret 到垃圾地址（notepad 里 eip=0x22 fault / 静默 exit）。
- **根因**：0x91-0x97 解码用 `REG32[opcode - 0x91]`，**应 -0x90**（0x91→ecx 是 REG32[1] 不是 [0]）。导致 `0x94`（xchg eax, esp）被解码成 `xchg eax, ebx` → esp 不被交换 → __chkstk 的 `pop ecx` 弹到返回地址、`ret` 弹垃圾。
- **修复**：`REG32[opcode - 0x90] ?? 'esp'`。隔离复现脚本 `scripts/probe-xchg.ts`（编译 [0x94,0xc3] 看解码+执行）、`scripts/probe-chkstk.ts`（执行 0x427330，eax=0x146c，验返回 0x413455）。**教训：单字节寄存器映射表索引要对 modrm-reg field，不能想当然。**

### 4. XADD 支持（0F C0/C1，notepad 0x406dbf 的 `lock xadd [0x428d3c], eax`）
- decoder：case 0xc0/0xc1（**注意 opcode 是 c0/c1，不是 f0/f1——0f 是双字节转义前缀，我一开始写错过**），同 CMPXCHG 结构。
- codegen：`emitXadd`（tmp=dst+src; dst=src; src=tmp; flags 按 ADD：ZSP + OF + CF(L_S<u L_A) + AF）。
- ir.ts Op 增加 `'xadd'`。
- 该指令是 Interlocked/引用计数原语（0x406dbf：xor eax,eax; mov [0x428c94],ecx; inc eax; lock xadd; inc eax; ret）。

## ⚠️ 验证状态（重要）

- typecheck 通过 ✅（含 3 处 lint 关注的注释/代码）
- **vitest 未跑**（上下文紧张，接手后先跑 `"$N" node_modules/vitest/vitest.mjs run` 确认 187/187 无回归）
- notepad 实跑：`status=exit eip=0x0 stubs=312`，454 行日志（Step 6 基线 370 行）；**但 GetMessageW 从未被调用**，`cleanExit=false`
- 最后 API 序列（单实例检查）：`CreateMutexExW(0x0, name@0x7ffef24, 0x0, 0x1f0001) -> 0x0` + `GetLastError -> 0x0` + `GetModuleHandleW(0x401ad0) -> 0x0` + `IsDebuggerPresent -> 0x0`
- 退出前 trace：0x40b373 → 0x40b37a → 0x426000 → 0x426008 → 0x40b38b（0x40b3a1 函数尾）

## 当前卡点 / 下一步（从这接手，按序）

1. **单实例互斥体**（当前卡点）：
   - `CreateMutexExW(lpAttributes, lpName, dwFlags, dwDesiredAccess)` → 返回**递增非 0 假句柄**（0x20000 起或复用 hwndSeq）→ notepad 认为自己是唯一实例 → 继续到消息循环。
   - 注意 guest 的 `GetLastError` 目前**总是返回 0**（handlers.ts 的 GetLastError → ok(0)，不读 interceptor.lastErrors）——CreateMutexExW 返回 NULL 时 notepad 因 lastError=0 走"另一个实例"分支。若返回假句柄则无需 lastError。
   - 也可顺带 hook `OpenMutexW/CloseHandle`（CloseHandle 已有）。
   - **验收**：`GetMessageW(0x7fff1d8-ish, 0, 0, 0)` 出现在日志且返回 0 → 0x40f267 消息循环 `jne 0x40f1c7` 不跳 → WinMain 返回 → CRT `ExitProcess(0)` / `exit(0)` → **cleanExit=true**（diag 的 [diag] 行应多打印 cleanExit 以确认，当前只打 status/eip）。
2. 之后继续推进：notepad 可能还有 RegisterClassExW 第二类窗口（0x41f93f）、LoadImageW、GetDpiForWindow、SystemParametersInfoForDpi 等（见 IAT 槽位表），遇缺再补。
3. 回归：typecheck + 全量 vitest + lint（`"$N" node_modules/eslint/bin/eslint.js` 或项目既有命令）+ app-web 构建。
4. **临时诊断脚本**（可删可留）：`scripts/probe-chkstk.ts`、`scripts/probe-xchg.ts`、`scripts/probe-wasm-dump.ts`（esbuild bundle 到 node_modules/.cache 后跑）。留着方便回归 xchg/chkstk 修复。

## 诊断工具 / 断点（保持干净）

- `scripts/diag-trap.ts`：未加新断点；保留 `[api]` dispatch 日志、maxSteps 8M、最后 64 block `[trace]`、dumpFault。
- IAT 槽位（本轮补查，VA = 0x400000 + rva）：0x42a490=RoGetActivationFactory、0x42a498=WindowsDeleteString、0x42a49c=WindowsCreateString、0x42a4a0=WindowsCreateStringReference、0x42a4a4=WindowsGetStringRawBuffer（winrt api-ms 均 normalize 到 kernel32.dll）；0x42d044=SHGetKnownFolderPath（delay-load）；0x42a108=SetWinEventHook、0x42a120=UnhookWinEvent（消息循环区域）；0x42a5a4=__guard_check_icall 类 CFG 检查（未实现，返回 0 未炸，调用模式 `mov eax,[obj]; mov esi,[eax+N]; ...; call [0x42a5a4]; call esi`）。

## 本会话未解 / 注意点

- `_o___stdio_common_vswprintf` 仍返回 0（trace 日志的格式化输出为空），不影响主流程。
- `RegQueryValueExW` 返回 0 但不写数据（notepad 读注册表设置读到垃圾，没炸）。
- SSE/XMM 仍未实现 xorps 的 flag 语义（0x40c04e 有 `xorps xmm0,xmm0`，当前按 xmm-move 处理或可跑，未验证细节）。
- `CreateMutexExW` 未实现（下一步 #1）。
- `GetModuleHandleExW(0x6, 0x406e00, ...) -> 0x0`（单实例检查前后有调用，返回 0 未炸，可能影响行为）。

---

# Step 8（2026-08-19 交接，从单实例检查推进到 RDTSC 卡点）

## 一句话现状

notepad.exe（SysWOW64 x86）比 Step 7 大幅推进：**单实例检查（CreateMutexExW + WaitForSingleObjectEx + OpenSemaphoreW + CreateSemaphoreExW）全通 → EDP/WIP 检查（mock IProtectionPolicyManager 工厂）全通 → 第二窗口创建（0x10002）→ 编辑控件初始化（EM_* 消息）→ 状态栏（CreateStatusWindowW 返回 0 未处理）→ SetWindowTextW 设标题 → 随机种子初始化**，当前卡在 **RDTSC（0F 31）未实现 → fault at 0x414472**（`decode error: unsupported two-byte opcode 0f 31`）。日志 609 行（Step 7 基线 454 行）。**GetMessageW 仍未调用**。

## 本轮改动清单（全部过 typecheck）

### 1. 单实例互斥体假句柄（guest-process.ts + mapper.ts）
- `CreateMutexExW/A`、`CreateMutexW/A`、`OpenMutexW/A` → 递增假句柄（0x20000 起）；`ReleaseMutex` → 1
- mapper：`createmutexexw: 4, createmutexw/a: 2, openmutexw/a: 3, releasemutex: 1`

### 2. WaitForSingleObjectEx 缺 argCount（3 参 stdcall）
- mapper：`waitforsingleobjectex: 3`（mutex 检查后 notepad 调 `WaitForSingleObjectEx(0x20001, INFINITE, 0)`，stub ret 0 曾致栈漂移）

### 3. GetLastError 真实语义 + OpenSemaphoreW（单实例第二步）
- notepad 单实例 = 两步：mutex 通过后 `OpenSemaphoreW` 返回 NULL 时检查 `GetLastError()==ERROR_FILE_NOT_FOUND(2)` → 是则"首次运行"继续，否则走失败路径退出（0x407a58）
- **handlers.ts 的 GetLastError 恒返回 0**，不读 interceptor.lastErrors → 修复：
  - guest-process hook `GetLastError` → `interceptor.getLastError(ctx.pid)`（dispatch 只在 errorCode != 0 时写 lastErrors；成功调用不清除 = Windows 语义）
  - hook `SetLastError` → `interceptor.setLastError`
  - `OpenSemaphoreW/A` → `{ returnValue: 0, errorCode: ERROR_FILE_NOT_FOUND }`
  - `CreateSemaphoreExW` → 假句柄（复用 createMutex）；mapper `opensemaphorew: 3, createsemaphoreexw: 6`

### 4. EDP/WIP 检查严格 FailFast —— 本轮最大卡点（mock IProtectionPolicyManager 工厂）
- **触发链**：RoGetActivationFactory 返回 E_NOTIMPL → EDP helper（edpapphelper.cpp:246，调用点 0x424f8b）`test edi,edi; jns` 对**任何负 HRESULT** FailFast（0x424f96 → 0x4076c9 WIL 报告 → 0x40b3a1 报告函数 → __fastfail int 0x29 → exit）。Step 7 的 E_NOTIMPL"优雅跳过"只覆盖早期 WIP 检查（0x40bcaa）；EDP helper 是严格检查
- **修复**：RoGetActivationFactory handler 读 HSTRING 类名（0x405110 = "Windows.Security.EnterpriseData.ProtectionPolicyManager"），匹配则返回 **S_OK + 假 IInspectable 工厂**，否则保持 E_NOTIMPL
- 假工厂：bumpAlloc vtable（16 槽）+ 对象（[0]=vtable 指针）；槽 → trap stub：
  - slot0=`pmp_qi`(3 参, 写 out=this)、slot2=`pmp_release`(1 参!)、slot12=`pmp_checkaccess`(3 参, 返回 0)、slot14=`pmp_isprotected`(2 参, 写 out=0 未保护)、其他=`pmp_vtbl_stub`(0 参)
  - mapper 对应 argCount；handler 都注册在 kernel32.dll（allocDynamicStub 的 module 判定）
- **关键坑 1（HSTRING 布局）**：createStringReference 原实现 `hstring = headerPtr+8`（栈上无数据）→ RoGetActivationFactory 读不到类名 → 改为 **heap 拷贝**（bumpAlloc(len*2+8)，布局与 createString 统一 [h-8]=len, h=数据）
- **关键坑 2（vtable[2] 弹参）**：notepad 释放 helper（0x40a518）`push esi; push edx; call [vtable+8]` 后只 `pop esi; ret` → 被调者必须 **stdcall ret 4**（清 edx），否则栈不平衡 → ret 弹 0 → 静默 exit。**pmp_release argCount=1 不是 0**

### 5. CoCreateInstance 返回 S_OK 但不写 ppv
- notepad 惰性 COM 获取器（0x423246）`test eax,eax; js` 对失败**优雅跳过**；默认未实现返回 0(S_OK) 不写 ppv → 解引用 [0x429e18] 垃圾
- 修复：`CoCreateInstance → 0x80040154 (REGDB_E_CLASSNOTREG)`；mapper `cocreateinstance: 5`

### 6. SRWLock 缺 argCount（1 参 stdcall）
- notepad 锁获取器（0x40a2ec）push 锁指针 → `AcquireSRWLockExclusive`，stub ret 0 → 栈漂移 → pop edi/pop ebx/pop esi/ret 错位 → ret 弹 0 → 静默 exit
- mapper：`acquiresrwlockexclusive/releasesrwlockexclusive/acquiresrwlockshared/releasesrwlockshared: 1`

### 7. SetWindowTextW 缺 argCount（2 参 stdcall）→ GS cookie 破坏
- notepad 标题设置（0x40f812）call SetWindowTextW，stub ret 0 → 栈漂移 8 → GS cookie 副本 [esp+0x2bc] 错位 → `__security_check_cookie`(0x426000) 失败 → __report_gsfailure（0x42631f）→ TerminateProcess(0xC0000409)
- mapper：`setwindowtextw/a: 2`（顺带 `getwindowtextw/a: 3`）

## 当前卡点 / 下一步（按序）

1. **RDTSC（0F 31）未实现**（当前卡点）：fault at 0x414472，`0f 31` 解码报 unsupported。notepad 用 RDTSC 生成随机种子（先读 [0x4287c4]/[0x4287c0]，rdtsc 后存 [ebp-0x8bc]（eax）/edx 高位）。实现：x86-decoder.ts 0F 31 → 'rdtsc' + codegen 写 eax=tsc_low/edx=tsc_high（Date.now()*N 或单调计数）。**注意 decoder 里 0F 前缀指令的 case 结构（先搜 0F 相关处理再插）**
2. 之后继续：**CreateStatusWindowW**（COMCTL32，日志 405 行返回 0 —— notepad 状态栏创建，应返回递增假 HWND，mapper 加 argCount 4 + handler）；可能还有更多 GUI/COM API（GetDpiForMonitor、LoadImageW 等，见 Step 7 遗留）
3. **回归**：typecheck（每轮已过）+ **全量 vitest（本轮未跑，基线 187/187, 25 files）** + lint + app-web 构建
4. 已知未解（继承）：`RegQueryValueExW` 返回 0 不写数据；`_o___stdio_common_vswprintf` 返回 0；`GetModuleHandleExW` 返回 0；`IsProcessorFeaturePresent(0x17)` 返回 0（fastfail 不可用）

## 诊断工具（已清理）

- `scripts/diag-trap.ts`：**本会话临时 [bp] 断点已全部移除**（0x40b3a1/0x40b500/0x40b5e4/0x40b607/0x40a518/0x40a530/0x40a532/0x424edd/0x424ee5/0x424eeb/0x40a533）；保留 [api] 日志、maxSteps 8M、[trace]、dumpFault
- 临时脚本 `tmp-iat-mutex.py` / `tmp-find-mutex-refs.py` 已删除
- IAT 槽补充（VA）：0x42a444=CreateMutexExW、0x42a448=WaitForSingleObjectEx、0x42a450=OpenSemaphoreW、0x42a418=CreateSemaphoreExW、0x42a490=RoGetActivationFactory、0x42a204=CoCreateInstance、0x42a334=FormatMessageW、0x42a2c4=LocalFree、0x42a41c=AcquireSRWLockExclusive、0x42a420=ReleaseSRWLockExclusive、0x42a124=SetWindowTextW（0x40f812 调用）、0x42a5a4=__guard_check_icall（未实现返回 0，无碍）

---

# Step 9（2026-08-19 交接：从 RDTSC 卡点推进到 notepad cleanExit 里程碑）

## 一句话现状

notepad.exe（SysWOW64 x86）**首次达到完整生命周期闭环**：
`status=exit eip=0x0 stubs=312`，日志 583 行。执行路径：CRT 启动 → MUI 字符串 → 单实例（mutex/semaphore）→ EDP/WIP 跳过 → 窗口初始化（假句柄：RegisterClassExW→atom、CreateWindowExW→0x10001、CreateStatusWindowW→假 HWND、SetWindowTextW）→ **GetMessageW 被调用并返回 0（WM_QUIT 最小闭环）→ 消息循环退出 → WinMain 尾部（GetFileAttributesExW/CoUninitialize/EventUnregister 栈平衡）→ `_o_exit(0)` → 进程退出，cleanExit=true**。Step 6/7/8 反复出现的 GS-cookie fail-fast（0xC0000409）链（0x40f32f → __security_check_cookie → __report_gsfailure）**已消失**。

## 本轮改动清单（全部过 typecheck；vitest 187/187（25 files，新增 2 个解码单测）；lint 0/0）

### 1. RDTSC（0F 31）实现（Step 8 卡点）
- `jit/cpu.ts`：CPU ctx 增加 64 位 TSC 计数器（`TSC_OFFSET=140`，low/high 两个 i32 槽，`CTX_SIZE=140→148`）。
- `jit/ir.ts`：Op 增加 `'rdtsc'`。
- `jit/x86-decoder.ts`：`decodeTwoByte` case 0x31 → `{ op: 'rdtsc' }`（无操作数，不改 flags）。
- `jit/codegen.ts`：`emitRdtsc`——读 TSC 槽、+RDTSC_STEP(0x1000000) 进位传播（i32LtU 判 low 回绕）、写回，再写 eax=low_new/edx=high_new。

### 2. 长直线块优雅截断（decode 层，通用修复）
- **症状**：0x4151fc（notepad 的 PCG 随机数生成函数，无分支 >1024 字节）解码越界 → `unexpected end of block` → fault。
- **修复**：`X86Decoder.decode()` 捕获 `unexpected end of block`，把 pos 回退到当前不完整指令起点并 break，把已解码部分作为非终止块（terminated=false）返回——executor 下一轮从 `endAddress`（最后一条完整指令的 nextAddress）重新取 readAhead 窗口继续编译。JIT 块缓存按 startAddress 命中，循环重入无重复编译。
- **防御**：`instructions.length===0`（buffer 连一条指令都不够）→ 抛 UnsupportedError → engine 生成 fault 块，避免空块在同 EIP 死循环。
- 效果：任何 >readAhead 的长直线块都不再 fault，notepad 的随机数生成函数（0x4151fc 起 ~500 字节）正常执行。

### 3. 缺 argCount 导致 GS-cookie fail-fast（本轮最大卡点，WinMain 尾部）
- **症状**：notepad 走到消息循环之后，0x40f32f `mov ecx,[esp+0x4c]` 读 GS cookie 副本错位 → __security_check_cookie 失败 → __report_gsfailure → `TerminateProcess(0xC0000409)`（eip 落 0xC0000409）。
- **根因链**（Step 6 同类问题复现，教训再次验证：**参数表按栈上占几个 4 字节槽计数**）：
  - `GetFileAttributesExW(lpFileName, fInfoLevelId, lpFileInformation)` = **3 参 stdcall**，表里缺失 → stub `ret 0` → 每调用栈漂移 12 字节 → WinMain 尾部 [esp+0x4c] cookie 副本错位。
  - `SetWinEventHook` = **7 参 stdcall**（eventMin,eventMax,hmod,pfn,pid,tid,flags），表里缺失 → 栈漂移 28 → 消息循环内部 esp 相对访问错位（0x40f1c7 循环）。
  - `UnhookWinEvent` = 1 参 stdcall，表里缺失（notepad 因 SetWinEventHook 返回 0 走 `je 0x40f2db` 跳过，未触发）。
- **修复**（pe/mapper.ts）：`getfileattributesexw/a: 3`、`setwineventhook: 7`、`unhookwinevent: 1`、`coinitialize: 0`（显式）、`terminateprocess: 2`。

### 4. CreateStatusWindowW（Step 8 下一步 #2）
- mapper：`createstatuswindoww: 4`（4 参 stdcall）。
- guest-process.ts：hook `comctl32.dll` CreateStatusWindowW/A → 复用 createWindow 递增假 HWND。

### 5. lint 清理（历史遗留）
- `scripts/probe-chkstk.ts`：去掉未用导入 GuestProcessRunner 与未用变量 mapped（Step 7 遗留的 2 个 lint error）。

## ⚠️ 验证状态

- typecheck ✓、vitest **187/187（25 files）** ✓（新增 RDTSC/CPUID 解码单测）、lint **0/0** ✓
- **notepad cleanExit 基线**：`[diag] status=exit eip=0x0 stubs=312`，日志 583 行，GetMessageW→0 后走 `_o_exit(0)`，diag 未打印 `last blocks before exit`（cleanExit=true）✅
- 退出序列（日志尾部）：SetWinEventHook(0)→GetMessageW(0)→GetFileAttributesExW(0)→CoUninitialize(0)→EventUnregister(0)→GetModuleHandleW(0)→_o_exit(0)

## 当前卡点 / 下一步（图形桥接，从这接手，按序）

**背景**：Step 6/7/8/9 的 GUI 全是"假句柄最小闭环"——CreateWindowExW 返回假 HWND、GetMessageW 直接返回 0（WM_QUIT），**WndProc 从未被真实调用**，窗口从未"存在"。图形桥接 = 让窗口真实化。分三层：

1. **消息循环真实化 + WndProc 执行链（✅ Layer 1 已完成，见下）**：
   - 维护窗口状态：guest-process 记录 class→WndProc 地址（RegisterClassExW 时读 lpWndProc）、HWND→WndProc（CreateWindowExW 时从类查）、HWND→父窗口/样式。
   - GetMessageW 改为状态机：**第一次返回 1 并写 lpMsg（如 WM_CREATE/WM_PAINT，hwnd=假 HWND）→ DispatchMessageW 用嵌套 Executor 调 guest WndProc（仿 SEH handler 模式，见架构备忘：snapshot/restore 全寄存器含 EIP + sentinel int 0x2d）→ PostQuitMessage 后第二次 GetMessageW 返回 0 → 循环退出**。
   - **验收**：日志出现 WndProc 入口地址（0x401230 附近 notepad 主窗口过程）被 DispatchMessageW 调用，且不 fault。
2. **GDI 桥接（WndProc 跑起来后必然撞）**：BeginPaint/EndPaint/GetDC/ReleaseDC/TextOutW/CreateFontIndirectW/SetTextColor/SetBkMode/FillRect/InvalidateRect/ScrollWindowEx 等 → 先在 guest 内"画"到一块内存位图（或直接 no-op 返回成功），宿主渲染后置。
3. **L6 桌面集成**：apps/web 加"窗口容器"，把 guest 窗口状态（HWND 树、标题、消息日志、GDI 绘制结果）渲染成可见面板；RunExecutableApp 补 fs 桥 + readFile（Step 6 下一步 #2，未做）。

### Layer 1 完成记录（本轮已实现，2026-08-19）
- 新增 `installGuiBridge(dispatcher, jit, mode)`（guest-process.ts，run() 在 installSehDispatch 之后调用），替换原 GUI 假句柄块：
  - **窗口状态表**（实例字段）：`classWndProcs`（atom→wndProc，RegisterClassExW 读 WNDCLASSEXW+8）、`classNames`（类名→atom，读 +40）、`windowRecords`（hwnd→{wndProc,parent}，CreateWindowExW 记录）。
  - **CreateWindowExW/A**：按 atom（`(className>>>16)===0`）或类名查 wndProc；有自定义 wndProc 的窗口自动入队一条 WM_CREATE（系统类 EDIT 等无 wndProc，不入队）。
  - **GetMessageW/A 状态机**：队列非空 → 返回 1 + 写 MSG(hwnd,msg,wParam,lParam,time=0,pt=0) 到 lpMsg；队列空 → 返回 0（WM_QUIT）。
  - **DispatchMessageW/A**：从 lpMsg 读 hwnd/msg/wParam/lParam → `windowRecords` 查 wndProc → 嵌套 Executor（snapshot/restore + sentinel int 0x2d，stdcall 4 参数：sentinel 返回地址 + hwnd/msg/wParam/lParam 依次入栈）调 WndProc，返回 EAX。
  - **PostQuitMessage**：清空消息队列（下次 GetMessageW 返回 0）。
- **验证（铁证）**：日志出现 `GetMessageW -> 0x1` → `TranslateAcceleratorW(×2)` → `TranslateMessage` → **`DefWindowProcW(0x10001, 0x1, 0x0, 0x0)`（= notepad 主窗口 WndProc 收到 WM_CREATE 后调默认处理，参数与 dispatchMessage 传入完全一致）** → `DispatchMessageW -> 0x0` → `GetMessageW -> 0x0` → `_o_exit(0)` → `status=exit eip=0x0`，cleanExit=true。日志 589 行。
- 回归：typecheck ✓、vitest **189/189** ✓（新增 RDTSC/CPUID 解码单测 2 个）、lint 0/0 ✓。

### 下一步（Layer 2：GDI 桥接）
- notepad 主窗口 WndProc 目前只处理了 WM_CREATE（返回 0）。WM_PAINT 会调 BeginPaint/GetDC/TextOutW 等 GDI API（当前默认返回 0，notepad 多数不检查，但绘制为空白）。
- 建议先枚举 WndProc 在 WM_PAINT/WM_SIZE 路径实际调用的 GDI API（跑 WM_PAINT 看日志），逐个补 argCount + 合理默认；再把绘制指令桥接到宿主（L6）渲染。
- 也可先发第二条消息 WM_PAINT（GetMessageW 队列预置）验证 WndProc 的绘制路径不 fault。

## 诊断工具（已清理）

- `scripts/diag-trap.ts`：本会话未加新断点；保留 [api] 日志、maxSteps 8M、[trace]、dumpFault。
- IAT 槽补充（VA，本轮新确认）：0x42a210=GetFileAttributesExW（delay-load，静态表无）、0x42a120=UnhookWinEvent、0x42a108=SetWinEventHook、0x42a578=EventUnregister。
- 已知未解（继承）：`RegQueryValueExW` 返回 0 不写数据；`_o___stdio_common_vswprintf` 返回 0；`GetModuleHandleExW` 返回 0；`IsProcessorFeaturePresent(0x17)` 返回 0（fastfail 不可用）；`CoInitializeEx`/`CoUninitialize` 未实现 handler（默认返回 0=S_OK，未炸）。
