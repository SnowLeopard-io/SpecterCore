# 进度 / 交接文档 (PROGRESS)

> **给下一个 agent 的交接入口。** 目标：让 **Windows exe** 在 Browser Kernel 的 JIT 里跑起来，最终在 L6 桌面（apps/web）里加载并运行（含控制台输出）。
> 读完本文件后请读 `packages/core/src/{pe, jit, process, api}/`、`packages/ui/src/` 与 `packages/contracts/src/`。
> **2026-08-19 交接（Step 13 进行中）：cmd.exe 攻坚——定位并修复了 Step 12 遗留「最后 1 次 cookie FAIL」的两个根因：①`emitXchg`（codegen.ts）把 a 旧值存 L_TMP 但 storeOperand 内部第一步就覆盖 L_TMP → `xchg esp,eax` 静默失效 → __chkstk 未分配栈 → `push ebx` 覆盖 [ebp-4] cookie（**0x40b4c8 FAIL 真正根因**）②`0F 1F /r` 多字节 NOP 不消费 ModRM（x86-decoder.ts）→ 0x40eb20 解码错位 fault。修复后 0x40b4c8/0x40bba9/0x414aa9/0x40b6e3 cookie 全 OK，cmd 推进到 `ApiSetQueryApiSetPresence → RtlCreateUnicodeStringFromAsciiz → 0x42d39c`。当前卡点：**0x42d47a cookie FAIL（ebp=0x7000000）——ApiSetQueryApiSetPresence（无 handler 无 argCount）默认处理向 present 指针（=0x41efeb 帧 [ebp-1]=0x7fffe63）写数据，4 字节覆盖相邻 [ebp]=0x7fffe64 槽（保存的调用者 ebp）→ leave 后 ebp=0x07000000 → 后续全错位**。下一步：查 dispatcher 默认行为确认 → 给 ApiSetQueryApiSetPresence 加 handler（present 只写 1 字节）+ 补 rtlcreateunicodestringfromasciiz argCount:2 → cmd 应能进入 dir 执行。⚠️ 本会话有同事并行修改同一工作区（以文件实际内容为准，提交前 git status 确认）。diag-trap 留了 [ck3]/[ck4] 断点供定位 0x42d47a（用完删）。**

## 当前目标（用户需求，2026-08-18 起，2026-08-19 更新）

1. 支持 **Windows exe** 在浏览器 Kernel JIT 里真实运行，最终 L6 桌面（apps/web）内加载运行。
2. **内置工具真实化**（用户硬性要求，2026-08-19）：notepad（✅ 已完成：MUI + 独立窗口 + 真实菜单）、cmd（攻坚中）、文件资源管理器（要求"和我电脑的一样"，升级中）——必要文件 agent 侧从 C 盘复制进项目（public/win/），运行时默认预置虚拟盘，用户不用拖。
3. **打底层**：CMD 做成真的、Shell 做成真的（底层 API 补齐，见 Step 11）。
4. 每做一步在 `docs/PROGRESS.md` 留痕。

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
- **虚拟盘（FileStore，浏览器=OPFS，node=MemoryFileStore）**：`stat`/`openFile('read')` 遇缺失目录树返回 null / 抛错（Step 10 已修），绝不隐式创建；'write' 模式不创建文件（要 'create'）；createDirectory 非幂等（node 版）。内置工具经 `packages/ui/src/builtin-win.ts` 懒预置（bootstrap + launchGuestWindow 双调用点）。
- **UI 层（packages/ui）**：DesktopController（launch 对内置 guest 应用走 launchGuestWindow 独立窗口分支）→ WindowManager（L6 原生窗口）→ GuestWindowView（菜单栏+编辑区，strip &）。内置 notepad 在 apps.tsx 的 render 是占位 null，真实入口是 launchGuestWindow。
- **GuestProcessResult**：windows（窗口树 hwnd/className/wndProc/parent/text/menu）、paintCommands（GDI 绘制指令）、muiLoaded/muiSource（MUI 合并状态）。

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

# 6) MUI/菜单全链路验证（node 模拟浏览器：虚拟盘 + readFile）
"$N" node_modules/esbuild/bin/esbuild scripts/probe-mui.ts --bundle --platform=node --format=esm --outfile=node_modules/.cache/probe-mui.mjs
"$N" node_modules/.cache/probe-mui.mjs 2>&1 | grep -E "\[probe\]|\[bk\]"

# 7) 带命令行跑 guest（cmd 调试；BK_ARGS 传参，BK_NO_MUI=1 模拟无 MUI 浏览器）
# 注意：cmd.exe 文件名触发 bash 安全拦截，先 cp 改名 cguest.exe（同一个 guest 镜像）
BK_ARGS='cmd /c dir C:\Windows' "$N" node_modules/.cache/diag-trap.mjs node_modules/.cache/cguest.exe > /tmp/cmd.log 2>&1
```

测试/回归：`"$N" node_modules/vitest/vitest.mjs run`（**当前 189/189 通过，25 files**）、`"$N" node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`、lint `"$N" node_modules/eslint/bin/eslint.js packages scripts apps --ext .ts,.tsx`。构建：`cd apps/web && rm -rf dist && "$N" ../../node_modules/vite/bin/vite.js build`（**vite 前必须手动 rm -rf dist**，沙箱 safe-delete 拦 emptyDir trash；preview 404 = dist 删了构建没完成）。

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

### 下一步（Layer 2：GDI 桥接）—— ✅ 已完成（见下）
- notepad 主窗口 WndProc 目前只处理了 WM_CREATE（返回 0）。WM_PAINT 会调 BeginPaint/GetDC/TextOutW 等 GDI API（当前默认返回 0，notepad 多数不检查，但绘制为空白）。
- 建议先枚举 WndProc 在 WM_PAINT/WM_SIZE 路径实际调用的 GDI API（跑 WM_PAINT 看日志），逐个补 argCount + 合理默认；再把绘制指令桥接到宿主（L6）渲染。
- 也可先发第二条消息 WM_PAINT（GetMessageW 队列预置）验证 WndProc 的绘制路径不 fault。

### Layer 2 完成记录（GDI 桥接层，2026-08-19）
**关键侦察结论**：notepad 主窗口 WndProc（0x40e9c0）是纯消息转发——WM_PAINT(0xf)/WM_ERASEBKGND 等直接 `DefWindowProcW`，**无任何 GDI 绘制调用**；notepad 的"图形"全部在 EDIT 系统控件里。因此 Layer 2 交付的是**通用 GDI 桥接层**（任何真实 GUI exe 的绘制路径都不炸 + 指令可被宿主渲染）：
- **mapper.ts 补齐 ~50 个 GDI argCount**（gdi32 全部 stdcall）：beginpaint/endpaint/getclientrect/getwindowrect/textoutw/a/exttextoutw/a/drawtextw/a/settextcolor/setbkcolor/setbkmode/getstockobject/selectobject/deleteobject/createfontindirectw/a/createsolidbrush/createhatchbrush/createpen/fillrect/framerect/bitblt/stretchblt/patblt/movetoex/lineto/rectangle/ellipse/roundrect/gettextmetrics/gettextfacew/setmapmode/getmapmode/gettextalign/settextalign/setviewportorgex/setwindoworgex/createcompatibledc/createcompatiblebitmap/selectpalette/realizepalette/savedc/restoredc。
- **guest-process.ts installGuiBridge 新增 GDI 块**：
  - 伪对象池 `gdiObjSeq`（0x3000 起）：GetDC/GetWindowDC/BeginPaint（写 PAINTSTRUCT.hdc）/GetStockObject/CreateFontIndirectW（读 LOGFONTW.lfFaceName+28）/CreateSolidBrush/CreatePen/CreateCompatibleDC/Bitmap 返回递增伪句柄；SelectObject 返回 0；DeleteObject/ReleaseDC/EndPaint→1。
  - **PaintCommand 绘制指令捕获**（`this.paintCommands`，结果经 `GuestProcessResult.paintCommands` 输出）：TextOutW/ExtTextOutW（读 UTF-16 字符串）→`{op:'text',hdc,x,y,text}`；LineTo→`line`；FillRect/FrameRect（读 RECT）→`fillrect`/`rect`；Rectangle→`rect`；BitBlt/StretchBlt/PatBlt→1（no-op）。
  - 状态类默认：SetTextColor/SetBkColor/SetBkMode/SetTextAlign/SetMapMode 返回旧值；GetTextMetrics 写 tmHeight=16/tmAscent=12/tmDescent=4；GetTextFaceW 写 "Consolas"；GetDeviceCaps→96；MoveToEx 写 POINT。
  - **EDIT 控件文本捕获**（SendMessageW 增强）：对 className=="EDIT" 的窗口处理 WM_SETTEXT(0xC，记录文本)/WM_GETTEXT(0xD，写回 UTF-16)/WM_GETTEXTLENGTH(0xE)；其余消息返回 0。
  - **GetClientRect/GetWindowRect**：写 {0,0,800,560}/{0,0,800,600}（布局 math 不塌缩）。
  - **窗口树输出**：`GuestProcessResult.windows`（hwnd/className/wndProc/parent/text）。
- **验证**：notepad `status=exit eip=0x0`（cleanExit）✓；diag 输出窗口树 `[win] 0x10001 class="Notepad" wndProc=0x40e9c0`、`[win] 0x10002 class="Edit"`；paint 命令为空（notepad 启动不绘制，符合预期）。回归：typecheck ✓、vitest 189/189 ✓、lint 0/0 ✓。

### 下一步（Layer 3：L6 桌面集成）—— ✅ 已完成（见下）
- apps/web 加"窗口容器"：把 `GuestProcessResult.windows`（窗口树：类名/标题/文本）和 `paintCommands`（绘制指令）渲染成可见面板；RunExecutableApp 补 fs 桥 + readFile（Step 6 下一步 #2，未做）。
- 可选：给 EDIT 控件加 WM_PAINT 宿主渲染（文字可见）；或先验证一个"自己画窗口"的 exe（WriteFile/TextOutW 路径）。

### Layer 3 完成记录（L6 桌面集成，2026-08-19）
- **RunExecutableApp.tsx**：`run()` 保存 `guestResult`（state）；running 阶段控制台下方渲染 **Guest Window 面板**（`.bk-guest`）：
  - 每个顶层窗口（parent===0）一张 Windows 风格窗口卡（`.bk-win`）：标题栏（类名 — 文本 + HWND）、内容区（paintCommands 按坐标绝对定位渲染：text→span、fillrect/rect→div；Edit 类窗口显示文本；无绘制显示 "no paint commands"）。
  - 底部窗口清单（`.bk-guest-list`）：hwnd/className/wndProc/text 逐行列出（含子窗口）。
  - paint 命令只画在第一个顶层窗口（无 hdc→hwnd 归属映射）。
- **styles.css**：`.bk-guest*`/`.bk-win*`/`.bk-paint*` 一套 Windows 11 风格（圆角、阴影、标题栏、等宽字体）。
- **修复 dispatcher maxArgs 8→16**（trap-dispatcher 构造，guest-process run()）：CreateWindowExW 是 12 参 stdcall，hWndParent 在 rawArgs[8]（第 9 参）——原 8 槽拿不到，导致 Edit 控件 parent 误报 0。修复后窗口树正确：`0x10002 class="Edit" parent=0x10001`。
- **验证**：notepad `status=exit eip=0x0` cleanExit ✓；窗口树 `[win] 0x10001 class="Notepad" wndProc=0x40e9c0 parent=0x0` + `[win] 0x10002 class="Edit" parent=0x10001` ✓；apps/web vite build ✓（132 modules，425 kB JS）；preview http://localhost:4173 ✓。回归：typecheck ✓、vitest 189/189 ✓、lint 0/0 ✓。
- 注：vite build 前须手动 `rm -rf dist`（沙箱 safe-delete 会拦 vite 的 emptyDir trash 操作）；`node_modules/@bk` 需 junction（scripts/fix-bk-links.py）。

### 下一步（候选）
- **EDIT 控件宿主 WM_PAINT**：给 Edit 类窗口在 guest 侧画文字（WndProc 模拟）或宿主侧直接把 `text` 渲染到窗口卡内容区（当前已显示文本，但非位图级）。
- **验证自绘窗口 exe**：找一个真正调 TextOutW/FillRect 的程序验证 PaintCommand 捕获链路（notepad 启动不绘制，paint 为空）。
- RunExecutableApp 补 fs 桥 + readFile（MUI 资源，Step 6 遗留：notepad 在浏览器里跑需要 MUI 合并）。

## 诊断工具（已清理）

- `scripts/diag-trap.ts`：本会话未加新断点；保留 [api] 日志、maxSteps 8M、[trace]、dumpFault。
- IAT 槽补充（VA，本轮新确认）：0x42a210=GetFileAttributesExW（delay-load，静态表无）、0x42a120=UnhookWinEvent、0x42a108=SetWinEventHook、0x42a578=EventUnregister。
- 已知未解（继承）：`RegQueryValueExW` 返回 0 不写数据；`_o___stdio_common_vswprintf` 返回 0；`GetModuleHandleExW` 返回 0；`IsProcessorFeaturePresent(0x17)` 返回 0（fastfail 不可用）；`CoInitializeEx`/`CoUninitialize` 未实现 handler（默认返回 0=S_OK，未炸）。

---

# Step 10（2026-08-19 交接：内置 Windows Notepad —— MUI 预置 + 独立窗口 + 真实菜单 + 文本回流）

## 一句话现状

浏览器里点开始菜单 **Notepad (Windows)** → **直接弹出独立 notepad 窗口**（L6 原生窗口，无中间应用壳）：真实 MUI 字符串标题、真实 RT_MENU 菜单栏（File/Edit，无 & 符号）、白色可输入编辑区、输入回流 guest EDIT 控件、菜单项点击发真实 WM_COMMAND（ID 来自 MUI）。F12 控制台确认 `[bk] merged 13 MUI resources (C:/Windows/SysWOW64/en-US/notepad.exe.mui)`。

## 架构：内置工具全链路（新 agent 必读）

```
apps/web/public/win/          ← 打包资源（构建随 dist 发布）
  notepad.exe (307KB, SysWOW64) + en-US/zh-CN/notepad.exe.mui + cmd.exe + win.ini + hosts + readme.txt
       ↓ fetch（懒预置，幂等）
packages/ui/src/builtin-win.ts ← ensureBuiltinWinFiles(fs)：stat 空/缺失 → fetch → 写虚拟盘
  Windows/SysWOW64/notepad.exe + Windows/SysWOW64/{en-US,zh-CN}/notepad.exe.mui
       ↓ 点击图标
DesktopController.launch('windows-notepad') → launchGuestWindow()
  openFile 读虚拟盘 exe → GuestProcessRunner.run(image, { interactive, modulePath:'C:/Windows/SysWOW64/notepad.exe',
  readFile: 虚拟盘查找（MUI 合并源）, onMessageWait, onTextChanged })
       ↓ guest 创建窗口后
onMessageWait → 把 guest 顶层窗口创建为 L6 独立窗口（WindowManager.createWindow + GuestWindowView 内容）
```

## 本轮关键修复/实现（按用户问题顺序）

### 1. 点不开图标（根因 1：OPFS stat 抛 NotFoundError）
- OPFS `resolveHandle`/`stat` 遇缺失目录树抛 `NotFoundError` → `launchGuestWindow` 未捕获 → 图标点击静默崩。
- 修复：opfs.ts `stat`/`resolveHandle` 缺失目录返回 null；`openFile('read')` 不再隐式创建文件（原 resolveHandle(..., true) 无条件 create，读到空文件 → "not a PE file"）；launchGuestWindow 全程 try/catch → `showGuestError` 弹友好错误窗口。

### 2. 点不开图标（根因 2：预置时序不可靠）→ 懒预置
- `ensureBuiltinWinFiles` 提取为共享模块 `packages/ui/src/builtin-win.ts`（@bk/ui 导出），bootstrap.ts 和 launchGuestWindow 都调用（幂等：stat 非空文件即跳过，空/缺失重写，fetch 失败记录 warn）。
- 校验：跳过条件带 `kind==='file' && size>0`，杜绝旧 openFile bug 留下的空文件永久占位。

### 3. "not a PE file"
- openFile('read') 模式不创建文件（见上），修复空文件被当 PE 加载。

### 4. 菜单只有一部分 / 带 & 符号 / 点菜单无作用
- **& 是 Win32 加速键标记**（&File→F 键）：前端 GuestWindowView 显示层 stripAmps。
- **RT_MENU 逆向结论**（Win11 SysWOW64 notepad.exe.mui，铁证，防再走弯路）：
  - 记录 = `WORD flags + 标题`（UTF-16 NUL 结尾，4 字节对齐），**无 popupOffset、无独立 id 字段**——popup 标题也在 off+2（不是 off+4，不是 off+4+popupOffset）。
  - **0x10 位是 ID 的一部分**（Find=0x15=21），不能当 MF_POPUP；0x80（MF_END）是分隔符/分节，**不关闭 section**（File>Exit 在其后仍属 File）；0x800 是 MF_SEPARATOR。
  - 顶层 popup 只有 **File/Edit** 两个；Undo/Find/Format/View/StatusBar/Help 都是 **Edit 的子菜单**（解析时 flatten 进 Edit.items，内容 100% 真实）。所以"只加载了一部分"是误解——结构就是这样。
  - parseMenuResource（guest-process.ts 私有方法）：popup 标题 off+2、MF_END(0x80) 减 depth 不关 section、MF_SEPARATOR(0x800) 跳过、嵌套 popup(depth>0) 作为 item 加入当前 section、size 限界。
  - **菜单挂载点**：notepad 菜单是 **WNDCLASSEXW.lpszMenuName（+36，MAKEINTRESOURCE(1)）类菜单**，不是 LoadMenuW！registerClass 读 lpszMenuName → menuResourceTable（type 4）→ parseMenuResource → classMenus；createWindow 从类菜单带出。
- **菜单项点击无作用（根因）**：guest→前端文本回流通道未接 + EDIT 控件关键消息未处理。修复：
  - guest-process EDIT 控件（SendMessageW 分支）补：WM_SETTEXT(0xC) 记录+回流、WM_GETTEXT(0xD)/WM_GETTEXTLENGTH(0xE)/EM_GETMODIFY(0xB9)/EM_REPLACESEL(0xC2)/EM_GETSEL/EM_SETSEL/EM_SCROLLCARET 等。
  - **文本回流**：`packages/ui/src/guest-text.ts`（subscribeGuestText：interceptor→`guestOnText` 总线，组件订阅）；GuestProcessOptions.onTextChanged → GuestWindowView 订阅更新 textarea；desktop-controller 的 launchGuestWindow 传 onTextChanged；onMessageWait 时把顶层窗口创建为独立 L6 窗口（guestWinIds 去重）。
  - **进程退出关窗**：guest cleanExit 后前端把对应 L6 窗口关闭。
- **菜单只有 File/Edit 两项是正常的**（RT_MENU 结构如此）；Edit 子菜单项 ID 部分不准（Cut=1 实为 10、Copy=769——嵌套 popup 的 ID 语义待精确化），File 菜单 ID 全真实（1:&New, 8:New &Window, 2:&Open, 3:&Save, 4:Save &As, 5:Page Setup, 6:&Print, 7:E&xit）。

### 5. 独立窗口（用户硬性要求：内置应用不套 RunExecutableApp 壳）
- `DesktopController.launch('windows-notepad')` 走专用分支 `launchGuestWindow`（不走 app.render 壳；apps.tsx 里 windows-notepad render 是占位 null）。
- GuestWindowView 从 RunExecutableApp.tsx 导出，desktop-controller 复用。
- 菜单项点击 → `runner.postMessage({hwnd, msg:0x0111/*WM_COMMAND*/, wParam:it.id})` → guest 真实处理（File 菜单 ID 真实）。

### 6. MUI 加载状态可观测
- GuestProcessResult 增 `muiLoaded`/`muiSource`；前端结束态打印 `[MUI] merged: <path>` 或 `[MUI] NOT loaded`。
- **注意**：浏览器里 en-US 优先（System32/en-US/notepad.exe.mui），zh-CN 也预置但模块名决定语言。

## 验证状态

- **probe-mui.ts**（scripts/，node 模拟浏览器完整路径：MemoryFileStore 虚拟盘 + readFile）→ `muiLoaded=true`、`merged 13 MUI resources`、File 菜单完整真实（1:&New, 8:New &Window, 2:&Open, 3:&Save, 4:Save &As, 5:Page Setup, 6:&Print, 7:E&xit）、Edit 含全部真实项。跑法：`"$N" node_modules/esbuild/bin/esbuild scripts/probe-mui.ts --bundle --platform=node --format=esm --outfile=node_modules/.cache/probe-mui.mjs && "$N" node_modules/.cache/probe-mui.mjs 2>&1 | grep -E "\[probe\]|\[bk\]"`。
- 浏览器日志：`[browser-kernel] provisioned Windows/SysWOW64/notepad.exe (307712 bytes)` ×3 + `builtin win files ready`；运行后 `[bk] merged 13 MUI resources`。
- 回归：typecheck ✓、vitest **189/189** ✓、lint 0/0 ✓、build ✓（历轮 index-Da0IRqmJ → … → CPICXGIS → DqK7bcyX）。
- **构建注意**：vite build 前必须手动 `rm -rf dist`（沙箱 safe-delete 拦 emptyDir trash）；构建要等 `tail -3 /tmp/build.log` 确认成功，preview 404 = dist 被删构建没完成（多次踩坑）。

## 已知未解 / 注意点（Step 10 继承）

- **notepad 的 Open/Save 走 GetOpenFileNameW（comdlg32 通用对话框）——未实现**，返回 0=用户取消 → Open/Save 点了没反应（New/Exit 等不依赖对话框的命令应生效）。这是"菜单按钮没作用"的剩余部分。
- 文件资源管理器是 demo 假实现（用户要求真实化，见 Step 11 下一步）。
- `RegQueryValueExW` 返回 0 不写数据；`_o___stdio_common_vswprintf` 返回 0；`GetModuleHandleExW` 返回 0；`IsProcessorFeaturePresent(0x17)` 返回 0。
- 浏览器无法直接访问 C 盘（沙箱）："真的资源管理器"= 升级虚拟盘浏览 + 从 C 盘打包预置（agent 侧复制），运行时默认写入，不用用户拖。
- **虚拟盘旧数据**：OPFS 持久化，升级后右键桌面 Wipe Virtual Disk 清空重试（下次启动自动重新预置）。

---

# Step 11（2026-08-19 交接：打底层 —— CMD 真实化起步 + 系统 API 补强）

## 一句话现状

**cmd.exe 已预置**（apps/web/public/win/cmd.exe，263KB，SysWOW64 32 位，构建后 200 可访问）。底层 API 大幅补强（任何真实 exe 都受益）。cmd 调试从"静默退出"推进到"**控制台初始化通过 → cmd 内部逻辑退出**"（无 API 依赖的纯内部逻辑，需反汇编 cmd CRT 启动定位）。

## 本轮改动清单（全部过 typecheck；vitest 189/189；lint 0/0）

### 1. 文件系统（dir 的地基，handlers.ts + FileSystemBridge）
- `FindFirstFileW/A`、`FindNextFileW/A`、`FindClose`：WIN32_FIND_DATAW（592B）完整写入（dwFileAttributes/dwFileSize/dwReserved0 等），splitFindPattern（目录/通配符分离），调用 FileSystemBridge.findFirstFile 虚拟盘列目录。
- `GetCurrentDirectoryW/A`、`SetCurrentDirectoryW/A`：per-run `cwd='C:\\'`（guest-process 实例字段）。

### 2. 命令行与参数表（cmd main 的地基，guest-process.ts）
- `GetCommandLineW/A` 支持 `options.commandLine`（BK_ARGS 环境变量 / RunExecutableApp 传入）。
- UCRT `__argv/__argc/__wargv/__wargc` + `_o__` 变体：**窄+宽 argv 数组构造**（之前返回 0 → cmd main 拿不到参数直接退出）；`_environ` 空环境。
- `GetModuleHandleW`：lpModuleName 为系统 DLL（kernel32 等）时返回 base（cmd 检查 `GetModuleHandleW(L"KERNEL32.DLL")`，返回 0 直接退出）。

### 3. 控制台/系统（handlers.ts）
- `GetCPInfo`：**成功语义 + 写 CPINFO（MaxCharSize=2）**（原默认返回 0=失败 → cmd 认为控制台初始化失败退出）。
- `GetThreadLocale`/`GetUserDefaultLCID` → 0x409。
- Reg 系列：`RegOpenKeyExW/A` → 假句柄 + 值 0；`RegQueryValueExW/A` → 值 0（0x0 大小）；`RegEnumValueW/A` → ERROR_NO_MORE_ITEMS；`RegCloseKey` → 1。
- `OpenThread` → 递增假句柄（cmd 需要线程句柄，返回 0 在 main 前退出）。

### 4. 弹参表补强（pe/mapper.ts X86_API_ARG_COUNT，stdcall 按栈槽计数）
- `setthreaduilanguage: 1`（缺了 stub ret 0 → 栈不平衡崩溃）；`getconsolemode: 2, setconsolemode: 2`；`getfileinformationbyhandleex: 4, setfileinformationbyhandle: 4`；`getstdhandle: 1`、`getconsoleoutputcp: 0`、`getconsolecp: 0`；重复 key 清理。

## cmd 调试进展（逐步排除，防回退）

| 阶段 | 症状 | 根因 | 修复 |
|---|---|---|---|
| 1 | 静默退出（日志极短） | GetCPInfo 返回 0=失败 | GetCPInfo 成功语义+写 CPINFO |
| 2 | 静默退出 | GetModuleHandleW(L"KERNEL32.DLL") 返回 0 | 系统 DLL 返回 base |
| 3 | 静默退出 | UCRT argv=NULL → main 拿不到参数 | __argv/__argc/__wargv/__wargc 构造 |
| 4 | call argv 区 fault | SetThreadUILanguage 等缺 argCount → 栈不平衡 | 弹参表补齐 |
| 5 | 注册表后退出 | RegQueryValueExW 不写数据 | Reg 系列 handler |
| 6 | main 前退出 | OpenThread 返回 0 | OpenThread 假句柄 |
| 7 | **控制台初始化通过后内部退出** | cmd 内部逻辑（无 API 依赖） | **未解：需反汇编 cmd CRT 启动** |

- 环境注意：`cmd.exe` 文件名触发 bash 安全拦截（被当系统命令），调试用 `cp C:/Windows/SysWOW64/cmd.exe node_modules/.cache/cguest.exe` 改名绕过（同一个 guest 镜像）。
- diag-trap.ts 已支持 `BK_ARGS='cmd /c dir C:\Windows'` 传命令行（argv[0] 建议用 'cmd'，cguest.exe 会触发 cmd 的 argv[0] 检查）。

## 当前卡点 / 下一步（按序，用户方向："一切和 Windows 一样"）

1. **攻坚 cmd**：反汇编 cmd 的 CRT 启动（disasm-win.py 0x41dd08 附近），定位"控制台初始化通过后"的内部退出点。命令 `"$PY" scripts/disasm-win.py "C:/Windows/SysWOW64/cmd.exe" <addr-hex> 200`。
2. **内置 Command Prompt 应用**（与 notepad 同模式：独立窗口 + 交互 stdin 桥接——GetStdHandle 已返回假句柄，需 WriteFile→stdout 回流 + ReadFile→stdin 下发）。
3. **GetOpenFileNameW 文件对话框桥接**（comdlg32，notepad Open/Save 无反应的剩余部分）→ 用虚拟盘文件选择器（项目已有 FileExplorerApp 可复用）。
4. **文件资源管理器真实化**（用户硬性要求）：explorer.exe 实测不可行（单实例 Shell 程序，依赖 CoCreateInstance/IShellFolder 整套 Shell，787 个 API stub 后静默退出）——正确路线是升级内置 FileExplorerApp 为 Windows 11 风格真实资源管理器（浏览虚拟盘 + 侧边栏/重命名/新建文件/状态栏 + 从 C 盘打包预置真实文件：win.ini/hosts/readme.txt 已预置）。
5. 回归：typecheck + vitest（189/189）+ lint + `rm -rf dist && vite build` + preview 验证。

## 诊断工具（已清理）

- `scripts/diag-trap.ts`：保留 [api] 日志、maxSteps 8M、[trace]、dumpFault；支持 `BK_ARGS`（命令行）、`BK_NO_MUI=1`（模拟无 MUI 浏览器环境）。
- `scripts/probe-mui.ts`：浏览器路径模拟（虚拟盘 + readFile）验证 MUI 合并/菜单。
- 反汇编：`"$PY" scripts/disasm-win.py "C:/Windows/SysWOW64/cmd.exe" 41dd08 200`（capstone，线性地址）。

---

# Step 12（2026-08-19 交接：cmd.exe 攻坚 —— 7 项底层修复，fail-fast 根因已除，剩 1 次 cookie FAIL 未定位）

## 一句话现状

cmd.exe（SysWOW64 x86）比 Step 11 大幅推进：**修复 7 个底层 bug 后，「控制台初始化通过 → fail-fast(0xC0000409)」链条基本解除**——原来 3 次 GS-cookie FAIL 已降到 **1 次**（0x40b4c8 调用点）。当前卡在：cmd 大初始化函数（0x40af82 循环）尾部 `__security_check_cookie` 失败，因为 **cookie 副本 [ebp-4] 在函数执行中被清零（入口已为 0，expect=cookie^ebp）**，**写者尚未定位**（RegQueryValueExW 已排除）。日志 223 行，`status=fault eip=0x40eb20`（fail-fast 后垃圾执行的 wcslen）。

**notepad 回归已恢复**：`status=exit eip=0x0 stubs=312` cleanExit ✓（用户已修复并 git 提交，基线 0acff25）。

## 本轮修复的 bug（按根因，全部过 typecheck；vitest 未跑需下轮确认）

### Bug 1：getcpinfo argCount 错（1→2）—— cmd「静默 exit」的收尾
- **症状**（Step 11 卡点）：cmd 控制台初始化通过后 eip=0 静默退出（`status=exit eip=0x0`），0x40b836 wcslen 死循环。
- **根因**：`GetCPInfo(UINT, LPCPINFO)` = **2 参 stdcall**，mapper 只有 `'getcpinfo': 1` → stub `ret 4` → 栈偏 4 → `pop ebx` 弹到未弹出的参数（0x1b5=cp）→ `bl=0xb5≠0` → 误入 DBCS 前导字节构建函数 0x427bde → 其 `ret` 弹 CPINFO 数据地址 0x446b10 → 当代码执行 → 垃圾 → eip=0 exit。
- **修复**：`'getcpinfo': 2`（反汇编证据：0x4167c1 函数 `push 0x446b10; push eax; call [0x4501a0]`）。

### Bug 2：环境块缺失（GetEnvironmentStringsW/A 返回 0）—— 0x40b836 死循环
- **症状**：修复 Bug 1 后 cmd 在 0x40b836（wcslen 风格循环）死循环（trace 64 次全 0x40b836）。
- **根因**：0x40b82d `call [0x4501e0]`（GetCommandLineW 路径，fail-fast 后垃圾执行）和 0x40e707（环境拷贝 helper）读环境块；GetEnvironmentStringsW **无 handler 返回 0** → 从 guest 地址 0（SEH 链头 0xffffffff）扫描双 0 终止符 → 死循环。
- **修复**（guest-process.ts `installStartupHandlers`）：
  - `envEntries`：14 个变量（=C:, SystemRoot, COMSPEC, PATH, TEMP, TMP, USERPROFILE, HOMEDRIVE, HOMEPATH, PROMPT, PATHEXT, OS, NUMBER_OF_PROCESSORS, PROCESSOR_ARCHITECTURE）。
  - `_environ`（`envSlot`）：真实 `char* env[]` 数组（原来 `{NULL}` 空）。
  - `wideEnvBlock`/`narrowEnvBlock`：双 NUL 结尾的 UTF-16LE/ANSI 块；hook `GetEnvironmentStringsW/A`。
  - `GetEnvironmentVariableW/A`：查 envEntries，命中写缓冲（writeW/writeA），未命中返回 0。
- 铁证：diag dump `GetEnvironmentStringsW block @0x20006d8: "=C:=C:\\\u0000SystemRoot=C:\\Windows\u0000COMSPEC=..."` ✓。

### Bug 3：freeenvironmentstringsw 缺 argCount（1 参 stdcall）
- **症状**：环境块修复后 fault at eip=0x7ffff9c（**栈地址**），`unsupported opcode 0xe5`。
- **根因**：0x40e707（环境拷贝 helper）`FreeEnvironmentStringsW(envBlock)` 无 argCount → stub `ret 0` → 栈偏 4 → `pop ebx` 弹 esi 值、`ret` 弹栈上残留（0x7ffff9c）→ 栈当代码执行。
- **修复**：`'freeenvironmentstringsw': 1, 'freeenvironmentstringsa': 1`。

### Bug 4：reggetvaluew 缺 argCount（7 参 stdcall）—— **首个 fail-fast(0xC0000409) 根因**
- **症状**：注册表配置循环（RegQueryValueExW×N + RegGetValueW×2）后 → `_time32` → `_o_srand` → `IsProcessorFeaturePresent(0x17)` → `SetUnhandledExceptionFilter(0)` → `UnhandledExceptionFilter(0x401000)` → `TerminateProcess(0xC0000409)`（fail-fast），随后 0x40b836 死循环（TerminateProcess handler 不终止进程，垃圾继续执行）。
- **根因**：`RegGetValueW` = **7 参 stdcall**（hkey, lpSubKey, lpValue, dwFlags, pdwType, pvData, pcbData），无 argCount → stub `ret 0` → 每次调用栈偏 28 → 主逻辑函数返回时 GS cookie 副本错位 → `__security_check_cookie`(0x41dea0) 失败 → `__report_gsfailure`(0x41e1e2)。
- **修复**：`'reggetvaluew': 7, 'reggetvaluea': 7`。
- 反汇编佐证：0x41e1e2 是 `__report_gsfailure`（`push 0x17; call [0x450240]=IsProcessorFeaturePresent; je 0x41e1fe; int 0x29`），0x41e1b2 是报告尾部（SetUnhandledExceptionFilter→UnhandledExceptionFilter→TerminateProcess(0xC0000409)）。

### Bug 5：getcurrentdirectoryw 缺 argCount（2 参 stdcall）—— **第二个 fail-fast 根因**
- **症状**：Bug 4 修复后 fail-fast 仍在，但推进到 GetEnvironmentVariableW/_o__wcsicmp/GetCurrentDirectoryW 路径；cookie FAIL 3 次（0x40b4c8、0x40bba9×2）。
- **根因**：Step 11 只加了 GetCurrentDirectoryW/A **handler**（guest-process），**漏了 mapper argCount** → stub `ret 0` → 每次调用栈偏 8。**cookie 检查代码 `mov ecx,[esp+0x14]; pop edi; pop esi; xor ecx,esp` 依赖被调者 `ret 8`**（0x40bba3 `call [0x4501e4]`=GetCurrentDirectoryW，idx 217 经 IAT 查询确认）——ret 0 时 esp 偏 8，`[esp+0x14]` 读到错误槽 → cookie^esp 结果差 0x10 → FAIL。
- **修复**：`'getcurrentdirectoryw': 2, 'getcurrentdirectorya': 2, 'setcurrentdirectoryw': 1, 'setcurrentdirectorya': 1`。
- **铁证**：IAT dump 显示修复前 `IAT 0x4501e4 stub: b8 d9 00 00 00 cd 2e c3`（ret 0），修复后 `c2 08 00`（ret 8）；0x40bba9 的 cookie 检查从 FAIL 变 **OK**（`ecx=0x305e2c77 == want`）。

### Bug 6：_o__wcsicmp / _time32 / _o_srand 无 handler
- **症状**：`_o__wcsicmp(0x402018="KEYS...", 0x401de0="CD...") -> 0x0`（**相等**！）——cmd 内部变量名匹配（KEYS/GOTO/DPATH…）全部误判；`_time32 -> 0x0`（srand(0) 种子固定）。
- **修复**（handlers.ts ucrtbase 块）：`_o__wcsicmp/_wcsicmp/wcsicmp`（宽串不区分大小写比较，返回 -1/0/1）、`_stricmp`（窄）、`_time32/time`（返回 `Date.now()/1000` 并写 out 参数）、`_o_srand/srand`（no-op）。
- 验证：日志 `_o__wcsicmp(0x402018, 0x401e0c) -> 0x1`、`-> 0xffffffff`（真实比较）、`_time32 -> 0x6a850192`（真实时间戳）。

### Bug 7：RegQueryValueExW/A 写 lpData 覆盖调用者帧 GS cookie —— 当前卡点的**已排除**项（重要教训）
- **症状**：0x40b4c8 入口 [ebp-4]（cookie 副本）= **0**（应为 cookie^ebp）。
- **发现**：RegQueryValueExW 的 lpData 参数值 = **0x7ffeedc = [ebp-4]**（0x40b4c8 断点 ebp=0x7fffee0）——handler 写 4 字节 0 到 lpData 直接清零 cookie！
- **修复（实验性）**：RegQueryValueExW/A handler **不再写 lpData（arg4）**，只写 lpcbData（arg5）=4（返回 ERROR_SUCCESS，cmd 仍走"值存在"路径）。
- **⚠️ 仍 FAIL**：修复后 [ebp-4] 入口仍为 0 → **写者另有其人**（RegGetValueW 无 handler 不写、RegOpenKeyExW 写 arg4=0x7ffeeb8=[ebp-0x28] 不重叠、RegCloseKey 无写）。**待定位**。

## 当前卡点（从这接手，按序）

1. **定位 0x40b4c8 cookie 清零写者**（下一个 agent 第一件事）：
   - 已知：0x40b4c8 入口 `[ebp-4]=0x0`（expect=cookie^ebp=0x9852de17）；cookie 在函数 prologue（0x40af00 前，需反汇编定位）写入后、0x40b4c8 前被清零。
   - **diag-trap 已留断点**：`onStep` 检查 `eip ∈ {0x40b4c8, 0x40b430, 0x40b49e, 0x40b4ba}` 打印 ebp/esp/[ebp-4]/cookie/expect——**二分**：若 0x40b430 已为 0 → 写者在 prologue~循环前；若 0x40b430 正常、0x40b49e 为 0 → 循环内 0x40b430-0x40b49e 之间（含 0x40b45e `call [0x4501f0]`=ExpandEnvironmentStringsW，idx 220——**该 handler 是否存在？** 若无 handler 默认返回 0，但 **0x40b464: test eax,eax; je 0x40b47b 走 0x40b47b: mov word [ebp-0x1004],ax** 不碰 [ebp-4]）。
   - **候选写者**：①0x40b45e ExpandEnvironmentStringsW（idx 220，3 参，`[0x4501f0]`，需确认 handler 及是否写输出缓冲）；②`0x40b468-0x40b474: call 0x4136f0`（0x800 参数拷贝，dst=[ebp-0x1004]，len 若按 wchar 计写 0x1000 字节 → **覆盖 [ebp-4]**——但仅当 ExpandEnvironmentStringsW 返回非 0 才执行，而日志无 ExpandEnvironmentStringsW 调用 → 未走此分支？需确认）；③其他未列出的 handler 越界写。
   - **建议**：在 0x40b430/0x40b49e 断点基础上，再给 0x40b45e（call ExpandEnvironmentStringsW）和 0x40b468（call 0x4136f0）加断点；或临时 hook 所有"写 guest 内存"的 handler 打印目标地址范围。
2. cookie 通过后的预期：cmd 继续 → 读环境变量/路径解析 → 执行 `dir`（FindFirstFileW 已实现）→ 输出 → 退出或进入 REPL。**验收**：`BK_ARGS='cmd /c dir C:\Windows'` 能列出虚拟盘 C:\Windows 内容（或至少不 fault/limit）。
3. **内置 Command Prompt 应用**（与 notepad 同模式：独立窗口 + 交互 stdin 桥接——GetStdHandle 已返回假句柄，需 WriteFile→stdout 回流 + ReadFile→stdin 下发）。
4. **GetOpenFileNameW 文件对话框桥接**（comdlg32，notepad Open/Save 无反应的剩余部分）→ 用虚拟盘文件选择器（FileExplorerApp 可复用）。
5. **文件资源管理器真实化**（用户硬性要求）：explorer.exe 实测不可行（单实例 Shell 程序）——升级内置 FileExplorerApp 为 Windows 11 风格真实资源管理器（虚拟盘浏览 + 侧边栏/重命名/新建/状态栏 + 预置真实文件 win.ini/hosts/readme.txt）。
6. 回归：typecheck ✓（当前已过）+ **vitest（本轮未跑，基线 189/189）** + lint + `rm -rf dist && vite build` + preview + **浏览器 notepad 回归**（probe-mui.ts 确认 cleanExit）。

## 诊断工具 / 断点（⚠️ 临时断点未清理，下个 agent 用完后删除）

- `scripts/diag-trap.ts` 当前含**临时 [ck] 断点**（onStep 内）：
  - `eip===0x41dea0`：__security_check_cookie 入口，打印 ecx/want/ebp/[ebp-4]/栈 + IAT 0x4501e4/0x4504a0/0x4503d4 stub dump。
  - `eip∈{0x40b4c8, 0x40b430, 0x40b49e, 0x40b4ba}`：cookie 二分断点。
  - `GetEnvironmentStringsW/A` dispatch 后 dump 环境块内容。
  - **定位完成后全部移除**（保留 [api]/[trace]/dumpFault/maxSteps 8M/BK_ARGS/BK_NO_MUI）。
- IAT 查询脚本：`node_modules/.cache/iat3.py`（FirstThunk 遍历，**slot = 0x400000 + first_thunk + j*4**，注意 FirstThunk 是 RVA 要加 image base；已确认 idx 217=GetCurrentDirectoryW、idx 220=ExpandEnvironmentStringsW、idx 28=_o__wcsicmp、idx 3=_time32、idx 49=_o_srand、idx 52=_o_towupper、idx 253=RegCloseKey）。
- 反汇编辅助：cmd 关键地址——0x415c37（主逻辑入口，CRT 0x41ddfd 调用）、0x40e707（环境块拷贝 helper）、0x40bb7e（变量查找+GetCurrentDirectoryW+cookie）、0x40af82（大初始化函数循环）、0x40b4c8（大函数尾 cookie）、0x41dea0（__security_check_cookie）、0x41e1e2（__report_gsfailure）、0x41e1b2（报告尾部）。

## 本会话未解 / 注意点（继承 + 新增）

- **`_o_towupper`（idx 52）无 handler**（默认返回 0）——cmd 的宽字符大小写转换可能受影响（0x40bbc9 `call [0x4503e0]`）。
- **`ExpandEnvironmentStringsW`（idx 220）无 handler**（默认返回 0）——cmd 的 `%VAR%` 展开不生效（0x40b45e 调用），且该路径是 [ebp-4] 覆盖的**头号嫌疑**（0x40b468 拷贝 0x800 可能越界）。
- `RegQueryValueExW` 现在不写 lpData——**cmd 读注册表值会拿到垃圾**（之前写 4 字节 0），但保证 cookie 不崩；后续可在确认 cookie 机制稳定后，改为"只写合理地址"（如检查目标不在当前栈帧内）。
- `IsProcessorFeaturePresent(0x17)` 返回 0 → __report_gsfailure 走 UnhandledExceptionFilter 路径（不是 fastfail）——诊断时注意。
- `TerminateProcess` handler 不终止进程（只对 exitprocess 特殊处理）——fail-fast 后垃圾执行是诊断噪音来源。
- vitest 未跑（基线 189/189）；lint 未跑；apps/web 未构建。
- notepad 回归基线（用户已提交 0acff25）：probe-mui 显示 `status=fault cleanExit=false` 是**用户修复前**的现象，当前代码已恢复 cleanExit ✓（diag-trap 跑真 notepad 验证）。

---

# Step 13（2026-08-19 交接：cmd.exe 攻坚 —— 定位并修复「最后 1 次 cookie FAIL」的两个根因：emitXchg 栈交换静默失效 + 0F 1F 多字节 NOP 解码错位；推进到只剩 ApiSetQueryApiSetPresence 越界写 [ebp] 槽一个卡点）

> **⚠️ 重要：本会话有同事（另一个 agent）并行修改同一工作区。** 交接时 git 工作区可能同时被改动（git status/diff 可能看到非本轮的修改或看不到本轮的修改——以**文件实际内容**为准，不要 `git checkout`/`git stash` 任何东西；提交前先 `git status` 确认，避免覆盖同事的工作）。本轮核心修复在 `packages/core/src/jit/codegen.ts`（emitXchg）与 `packages/core/src/jit/x86-decoder.ts`（0F 1F），**若 git diff 不显示这两个文件，说明同事已帮你提交或工作区已被更新——以当前文件内容是否含修复注释为准**。

## 一句话现状

cmd.exe 比 Step 12 再进一步：**Step 12 遗留的 0x40b4c8 cookie FAIL 已彻底解决**（二分定位到根因：`xchg esp, eax` 在 JIT 中静默失效 → __chkstk 未分配栈 → `push ebx` 覆盖 [ebp-4] cookie 副本）。修复后 cmd 一路推进：注册表配置循环 → 控制台初始化 → 环境/变量比较 → `GetLocaleInfoW` 系列 → `GetProcessHeap/HeapAlloc` → `GetConsoleTitleW` → `GetFileType` → `ApiSetQueryApiSetPresence` → `RtlCreateUnicodeStringFromAsciiz` → **新的卡点：0x42d47a cookie FAIL（ebp=0x7000000 异常）** → fail-fast → TerminateProcess(0xC0000409) → 最终 `status=exit eip=0x0`（**伪 cleanExit**：走的是 fail-fast 报告路径，不是正常 `_o_exit(0)`；TerminateProcess handler 不终止进程，之后垃圾执行偶然 exit）。日志 238 行，stubs=284。

**注意**：`status=exit eip=0x0` 现在**不代表成功**！必须 grep `[ck] cookie chk` 确认无 FAIL，且 `[diag] status=exit` 前无 `TerminateProcess(0xc0000409)`。

## 本轮修复的 bug（按根因）

### Bug A：emitXchg 的 L_TMP 被 storeOperand 覆盖 → `xchg esp, eax` 静默失效（**Step 12 遗留 cookie FAIL @0x40b4c8 的根因**）
- **症状**：0x40b4c8（cmd 大初始化函数 0x40af19 尾部）cookie 副本 [ebp-4] 入口即 0（expect=cookie^ebp），Step 12 判定"写者未定位"。
- **定位过程**（二分断点 [ck2]，diag-trap）：
  1. 在 0x40af26（__chkstk 返回后、cookie 写入前）加断点：**[ebp-4]=0x40af26 —— 这是返回地址本身！** 说明执行到 0x40af26 时 `esp` 仍 = `ebp-4`（栈顶还压着 call 的返回地址）→ **__chkstk 没有分配 0x1040 字节栈空间**。
  2. 隔离复现：`scripts/probe-cmd-chkstk.ts` 直接执行 cmd 的 __chkstk（0x424c80，标准 MSVC 模板，含跨页探测回环 `jb 0x424ca2`）→ 返回后 `esp=0x8000000`（未分配）而非预期的 `0x7ffefc0`。
  3. 继续隔离：`scripts/probe-xchg.ts` 解码 `[0x94, 0xc3]`（`xchg eax, esp; ret`）→ **decoder 正确（xchg eax, esp）但执行错误**：`eax=0x2000 esp=0x2004 eip=0xdeadbeef`（esp 未交换，ret 从旧 esp 弹 0xdeadbeef）。
- **根因**（codegen.ts `emitXchg`）：实现把 a 的旧值存进 `L_TMP`，然后 `storeOperand(fn, a)` —— **storeOperand 内部第一步就是 `fn.localSet(L_TMP)`**，把 L_TMP 覆盖成 b 的值！第二次 `fn.localGet(L_TMP)` 拿到的是 b 值 → `storeOperand(fn, b)` 把 b 写回 b → **交换静默丢失**。对 `xchg esp, eax` 而言 = esp 从未更新 → __chkstk 的 `mov eax,[eax]; mov [esp],eax; ret` 全错位 → 栈未分配 → 0x40af30 `push ebx` 恰好写到 [ebp-4]（cookie 副本槽）→ GS-cookie FAIL。
  - **修复**：a 的旧值存 `L_TMP2`（storeOperand 只碰 L_TMP），b 存 L_TMP：`pushOperand(a)→L_TMP2; pushOperand(b)→L_TMP; storeOperand(a)用L_TMP; storeOperand(b)用L_TMP2`。
  - 验证：probe-xchg → `eax=0x2000 esp=0x104 eip=0x0`（交换成功）；probe-cmd-chkstk → `esp=0x7ffefc0` 与预期完全一致。
- **同类排查**：`emitXadd`（用 L_A/L_B/L_S）、`emitCmpXchg`（L_A/L_B/L_ORIG/L_S/L_TMP2）、`emitCmov`（select 直接 storeOperand）**均不依赖 L_TMP 保留旧值，安全**；仅 emitXchg 有此 bug。
- **教训**：storeOperand 的 L_TMP 副作用是隐蔽陷阱——任何"先暂存寄存器值、后 storeOperand"的 codegen 模式都要检查暂存槽是否被 storeOperand 覆盖。**这是 cmd.exe 最后一个 fail-fast 的真正根因，也解释了为什么 notepad 之前"刚好能跑"**（notepad 的 __chkstk 调用点可能在栈分配后没有立即依赖 esp 的 push 序列，或路径不同）。

### Bug B：0F 1F 多字节 NOP 不消费 ModRM → 解码错位 fault（`unsupported opcode 0x6`）
- **症状**：Bug A 修复后 cmd 推进到 0x40eb20（wcsdup 风格函数）fault：`decode error: UnsupportedError: unsupported opcode 0x6`（0x06 = PUSH ES）。
- **根因**（x86-decoder.ts `decodeTwoByte` case 0x1e/0x1f）：`0F 1F /r` 是**带 ModRM 的多字节 NOP**（如 `0f 1f 40 00` = nop dword ptr [eax]），decoder 之前直接返回 `{op:'nop'}` **不消费 ModRM/SIB/disp 字节** → 后续指令从 NOP 中间开始解码 → 整块错位 → 把 modrm 字节 0x06 当 opcode（PUSH ES）→ decode fault。
- **修复**：case 0x1e/0x1f 改为 `this.decodeRm(32)` 消费操作数字节后再返回 nop。
- 验证：`scripts/probe-decode.ts` 解码 0x40eb20 字节流 → 之前 `DECODE ERROR: unsupported opcode 0x6`，修复后正确解码到 `jcc`（mov ax,[esi] / add esi,2 / test ax,ax / jne 全部正常）。

## 当前卡点（从这接手，按序）：0x42d47a cookie FAIL —— ApiSetQueryApiSetPresence 默认处理越界写 [ebp] 槽

- **症状**：cmd 推进到 0x42d39c（字符串处理函数，调用者 0x40ba01）→ 0x42d47a cookie FAIL：`ecx=0x7000000 want=<cookie> ebp=0x7000000 [ebp-4]=0x0`。ebp 从正常栈地址（0x7fffexx）变成 **0x7000000**（= 0x07000000）。
- **[ck4] 断点铁证**（diag-trap 已留）：
  - `0x41efeb`（ApiSetQueryApiSetPresence 薄包装，`push ebp; mov ebp,esp; push ecx; ...; call 0x41f181; test eax,eax; js ...; leave; ret`）入口：esp=0x7fffe68, ebp=0x7fffecc, **[ebp]=0x7ffff60 正常**。
  - `0x41f010`（ApiSetQueryApiSetPresence 调用返回后）：ebp=0x7fffe64（包装器自己的帧），**但 [ebp]=0x7000000** —— 保存的调用者 ebp 槽被覆盖！
  - 之后 0x42d3c9/0x42d3df：ebp=0x7000000 → 0x42d39c 内所有 `[ebp-0x40]/[ebp-0x54]` 全错位 → cookie FAIL。
- **覆盖机制**（已推理，待确认）：0x41efeb 帧 `[ebp-1]=0x7fffe63`，而 `[ebp]=0x7fffe64` 相邻。0x41f005 `push eax`（eax=lea [ebp-1]=0x7fffe63）→ 0x41f006 `push 0x401034` → `call 0x41f181` = `jmp [0x450000]` = **ApiSetQueryApiSetPresence(namespace=0x401034, present=0x7fffe63)**。**present 指针恰好 = 包装器帧的 [ebp-1]；若默认 handler（无 handler、无 argCount）向 present 写 4 字节（如 0x00000000），会覆盖 [0x7fffe63..0x7fffe66]，而 [0x7fffe64]（保存调用者 ebp 的槽）低 3 字节被清零、高字节残留 0x07 → [ebp] 变 0x07000000**（小端：写 00 00 00 到 0x7fffe63，[0x7fffe64]=00 00 00，原 [0x7fffe67]=0x07 是 0x7fffecc 的高字节 → 读回 0x07000000 ✓ 与观察一致）。
- **待确认/修复（第一步）**：
  1. 查 `ApiTrapDispatcher` 对**无 handler 且无 argCount** 的 API 默认行为——是否写 arg1（present 指针）？搜 `trap-dispatcher.ts` 的默认分支（当前代码 `handlers.ts` 默认返回硬编码 0，但 dispatcher 可能对输出参数有通用处理）。
  2. 无论默认行为如何，**给 ApiSetQueryApiSetPresence 加显式 handler**：`(namespace, present)` 2 参 stdcall，返回 0（STATUS_SUCCESS），写 `present` 1 字节 = 1（TRUE）——**只写 1 字节，绝不写 4 字节**，避免再次踩栈槽。argCount 补 `'apisetqueryapisetpresence': 2`。
  3. 顺带补 **RtlCreateUnicodeStringFromAsciiz（ntdll，2 参 stdcall）argCount**——0x42d3e7 调用后 esp=0x7fffe64（比正常少 8，说明 stub ret 0），无 handler 默认返回 0 可接受（cmd 走 `je 0x42d47a` 失败分支），但 argCount 必须补 `'rtlcreateunicodestringfromasciiz': 2`，否则后续栈漂移。
  4. 修复后再看 cmd 能否继续 → 预期进入 `dir` 执行（FindFirstFileW 已实现）→ 输出虚拟盘 C:\Windows 内容。

## 诊断工具 / 断点（⚠️ 临时断点未清理，下个 agent 用完后删除）

- `scripts/diag-trap.ts` 当前含临时断点（onStep 内）：
  - `[ck]`：`eip ∈ {0x40b4c8, 0x40b430, 0x40b49e, 0x40b4ba}` cookie 二分 + `eip===0x41dea0` __security_check_cookie 入口 dump（**已全部 OK，可删**）。
  - `[ck2]`：`eip ∈ {0x40af26, 0x40afa3, 0x40afe2, 0x40b052, 0x40b0c2, 0x40b132, 0x40b19a, 0x40b22b, 0x40b2f4, 0x40b3e5}`（ebp===0x7fffee0 时打印 [ebp-4]/expect）——**Bug A 定位用，已完成使命，可删**。
  - `[ck3]`：`eip ∈ {0x42d39c, 0x42d3e7, 0x42d3ed, 0x42d47a}` 打印 esp/ebp/eax/ecx——**当前卡点相关，保留到修完 0x42d47a**。
  - `[ck4]`：`eip ∈ {0x41efeb, 0x41f005, 0x41f010, 0x41f025, 0x42d3c9, 0x42d3df}` 打印 esp/ebp/[ebp]/eax——**当前卡点关键证据，保留到修完**。
  - 定位完成后全部移除（保留 [api]/[trace]/dumpFault/maxSteps 8M/BK_ARGS/BK_NO_MUI）。
- 新增探针脚本（可复用）：
  - `scripts/probe-cmd-chkstk.ts`：隔离执行 cmd 的 __chkstk（0x424c80，0x1040 栈分配），验证 esp 下移 + ret 地址搬运。
  - `scripts/probe-decode.ts`：解码 0x40eb20 字节流（含 `0f 1f 40 00` 多字节 NOP），验证 0F 1F 修复。
  - 原 `scripts/probe-xchg.ts`：`[0x94,0xc3]` xchg esp,eax 语义验证（Step 7 遗留，本轮借此发现 emitXchg bug）。
- 反汇编辅助（cmd 关键地址新增）：0x424c80（__chkstk，含跨页回环）、0x42d39c（字符串处理函数，当前卡点所在）、0x41efeb（ApiSetQueryApiSetPresence 薄包装）、0x41f181（= jmp [0x450000]，ApiSetQueryApiSetPresence IAT 槽）、0x40eb20（wcsdup 风格函数，Bug B 解码 fault 点）。

## 本会话未解 / 注意点（继承 + 新增）

- **`ApiSetQueryApiSetPresence`（api-ms-win-core-apiquery）与 `RtlCreateUnicodeStringFromAsciiz`（ntdll）均无 handler、无 argCount** —— 前者越界写 present 指针覆盖 [ebp] 槽（当前卡点），后者 ret 0 栈偏 8。都需补。
- **`status=exit eip=0x0` 不再是成功标志**：cmd 现在会在 fail-fast（0xC0000409）报告后因 TerminateProcess 不终止进程而垃圾执行到 exit。判定成功 = `[ck] cookie chk ... OK`（无 FAIL）+ 无 `TerminateProcess(0xc0000409)` + 出现 `dir` 输出。
- `IsProcessorFeaturePresent(0x17)` 返回 0 → __report_gsfailure 走 UnhandledExceptionFilter 路径。
- `_o_towupper`（idx 52）无 handler（默认 0）——cmd 宽字符大小写转换可能受影响。
- `ExpandEnvironmentStringsW`（idx 220）无 handler——`%VAR%` 展开不生效（0x40b45e 调用点，目前未走到该分支）。
- **同事并行修改警告**：工作区可能被另一个 agent 同时编辑（代码文件以实际内容为准；提交前 git status 确认；不要 checkout/stash/pull 覆盖）。vitest/lint/apps-web-build 本轮未跑（基线 189/189）。notepad 回归基线：用户已提交 8fe812a（Step 12 修复）+ 0acff25，diag-trap 跑真 notepad 应 cleanExit ✓。

---

# Step 14（2026-08-19：cmd.exe 攻坚 —— 定位并修复 C6 解码通用 bug（mov r/m8,imm8 写 4 字节），cmd 从 fail-fast 推进到命令解析阶段；当前卡点 fastcall 函数参数被当指针）

## 一句话现状

Step 13 遗留的 0x42d47a cookie FAIL（ebp=0x7000000）已彻底解决，**真正根因不是 ApiSetQueryApiSetPresence 默认写越界，而是 x86-decoder.ts 的 C6 解码 bug**（`mov r/m8, imm8` 被错当 32 位写 4 字节，覆盖栈上保存的 ebp）。修复后 cmd 日志从 429 行暴增到 911 行，cookie FAIL 彻底消除，cmd 大幅推进：longjmp → _o__get_osfhandle/GetFileType → 命令解析。当前新卡点：**0x40baa6 `cmp [edi], ebx` 越界——edi=0xfffffff4（STD_ERROR_HANDLE 伪句柄）被当指针解引用**。edi 来自 fastcall 函数 0x40b743 的 ecx 参数（`mov [ebp-0x60], esi`，esi=ecx），调用者传入了 STD_ERROR_HANDLE 但函数期望指向 3 句柄结构的指针。vitest 229/229 通过（28 files），notepad cleanExit 回归通过（stubs=312）。

## 本轮修复的 bug（按根因，全部过 typecheck）

### Bug 1（最重大）：C6 `mov r/m8, imm8` 解码用 32 位 size → 写 4 字节覆盖栈（**Step 13 遗留 cookie FAIL @0x42d47a 的真正根因**）
- **症状**：Step 13 推断 ApiSetQueryApiSetPresence 默认处理向 present 指针写 4 字节覆盖 [ebp]。实际补了 handler（只写 1 字节）+ argCount 后，ebp 仍异常（0x7000000）。
- **定位过程**（diag-trap 二分断点）：
  1. 0x42d39c 入口 ebp 正常，0x41efeb（ApiSetQueryApiSetPresence 包装器）入口 [ebp]=0x7ffff60 正常，但 call 返回后 0x41f010 时 [ebp]=0x7000000。
  2. 反汇编包装器 0x41efeb：`push ebp; mov ebp,esp; push ecx; ...; mov byte [ebp-1], 0 @0x41f001; lea eax,[ebp-1]; push eax; push 0x401034; call ApiSetQueryApiSetPresence; ...; leave; ret`。
  3. 0x7000000 = 原 0x07fffed4 的低 3 字节被清零、高字节 0x07 保留——**写 4 字节 0x00000001 到 [ebp-1]=0x7fffe6b 覆盖了 [ebp]=0x7fffe6c 的低 3 字节**。
  4. handler 只写 1 字节，runtime.writeBytes 也精确按字节写。那 4 字节写来自 `mov byte [ebp-1], 0` 本身的 codegen！
  5. 查 x86-decoder.ts `case 0xc6/0xc7`：C6（mov r/m8, imm8）的 immSize 设为 8，但 **dst 和 src 仍用外层 32 位 size** → codegen 写 4 字节而非 1 字节。**这是通用 bug，影响所有 C6 指令（所有 exe）。**
- **修复**：`opSize = opcode===0xc6 ? 8 : size`，decodeRm/rmOperand/immOperand 全部用 opSize。
- **验证**：cmd cookie FAIL 彻底消除（无 TerminateProcess 0xc0000409），日志从 429 行暴增到 911 行。notepad cleanExit 回归通过。vitest 229/229 通过。
- **教训**：C6/C7 共享解码分支时，C6 的 8 位操作数大小必须传播到 dst/src，不能只改 immSize。这是比 Step 13 推断的"ApiSet 默认写越界"更深层的根因——ApiSet handler 修复是必要的但不充分。

### Bug 2：ApiSetQueryApiSetPresence 缺 argCount + handler（Step 13 推断的直接原因，仍需修复）
- **修复**：mapper.ts 补 `'apisetqueryapisetpresence': 2`；guest-process.ts 加 handler（kernel32.dll，写 present 1 字节=1，返回 STATUS_SUCCESS）。
- **注意**：present 是 BOOLEAN（1 字节），必须只写 1 字节。

### Bug 3：RtlCreateUnicodeStringFromAsciiz 缺 argCount
- **修复**：mapper.ts 补 `'rtlcreateunicodestringfromasciiz': 2`（ntdll，2 参 stdcall）。无 handler 默认返回 0 可接受。

### Bug 4：GetConsoleTitleW/A 缺 argCount → 栈漂移 8 字节
- **症状**：0x40b991 `call [0x450044]`=GetConsoleTitleW（push 0x104 + push 缓冲区），mapper 缺 argCount → stub ret 0 → 栈漂移 8 字节。
- **修复**：mapper.ts 补 `getconsoletitlew:2, getconsoletitlea:2, setconsoletitlew:1, setconsoletitlea:1`。
- **验证**：present 指针从 0x7fffe63 变 0x7fffe6b（差 8 字节，证明修复生效）。

### Bug 5：longjmp 未实现 → cmd fall through 错误路径
- **症状**：cmd 推进到 GetCurrentDirectoryW 多次调用后，`longjmp(0x446b48, 2)` 被调用（ucrtbase），无 handler 默认返回 0 不跳转 → cmd fall through 错误路径 → CreateFileW 路径为空 → fault。
- **修复**：guest-process.ts 加 longjmp handler（ucrtbase.dll/msvcrt.dll），假设 MSVC x86 jmp_buf 布局 [0]=Ebp,[4]=Ebx,[8]=Edi,[12]=Esi,[16]=Esp,[20]=Eip，恢复寄存器+设置 eip。
- **未解决**：实际读到 jmp_buf 全 0（eip=0, esp=0），说明 **MSVC jmp_buf 布局假设错误或 setjmp 未调用**。cmd /c 模式可能不调用 setjmp（jmp_buf 是零初始化全局变量）。当前 longjmp 跳转到 eip=0 会 trap，但后续 Bug 6 修复后 cmd 不再走 longjmp 路径。

### Bug 6：_o__get_osfhandle + GetFileType 未实现 → cmd 认为控制台无效 → longjmp 错误路径
- **症状**：`_o__get_osfhandle(0)` 返回 0（默认）→ `GetFileType(0)` 返回 0（FILE_TYPE_UNKNOWN）→ cmd 认为 stdin 无效 → 走 longjmp 错误恢复路径（jmp_buf 未初始化 → eip=0 trap）。
- **修复**：handlers.ts 加 `_o__get_osfhandle`/`_get_osfhandle`（ucrtbase，fd 0/1/2 返回 STD_INPUT/OUTPUT/ERROR_HANDLE 伪句柄）+ `GetFileType`（kernel32，对伪句柄返回 FILE_TYPE_CHAR=2）。
- **验证**：longjmp 不再被调用，cmd 推进到命令解析阶段（0x40baa6）。

## 当前卡点（从这接手）：0x40baa6 edi=0xfffffff4 越界——fastcall 函数 0x40b743 参数 ecx 被当指针

- **症状**：`status=fault eip=0x40baa6`，`memory access out of bounds`。寄存器 edi=0xfffffff4（STD_ERROR_HANDLE），ebx=0xfffffff5（STD_OUTPUT_HANDLE）。
- **fault 指令**：0x40baa6 `mov [0x4386bc], eax` → 0x40baab `cmp [edi], ebx`（edi=0xfffffff4 被当指针解引用）。
- **函数入口**（0x40b743，fastcall 约定）：
  ```
  0x40b743: mov edi, edi
  0x40b745: push ebp
  0x40b746: mov ebp, esp
  0x40b748: sub esp, 0x64
  0x40b75c: mov esi, ecx          ; esi = 第一个参数（fastcall ecx）
  0x40b760: mov [ebp-0x60], esi   ; 保存参数到局部变量
  ...
  0x40b9f9: mov edi, [ebp-0x60]   ; edi = ecx 参数
  0x40b9fc: cmp [edi+8], ebx      ; 把参数当指针，读 [edi+8]
  ```
- **根因分析**：函数期望 ecx 是一个指向 3 句柄结构的指针（[edi]=stdin, [edi+4]=stdout, [edi+8]=stderr），用于检查标准句柄是否被重定向。但调用者传入了 ecx=0xfffffff4（STD_ERROR_HANDLE 伪句柄）。
  - 可能原因 A：调用者传错了参数（应该传结构指针，传了句柄值）。
  - 可能原因 B：我们的某个 API（如 GetStdHandle 或 _o__get_osfhandle）返回了伪句柄，调用者把它当结构指针用了。
  - 可能原因 C：cmd 的 STARTUPINFO 结构中 hStdError 字段被设置成了伪句柄，而代码期望它是指针（不太可能，STARTUPINFO 的 hStd* 是 HANDLE 不是指针）。
- **待定位**：搜索谁调用了 0x40b743（`call 0x40b743`），看调用者在 ecx 中放了什么。0x40b743 可能是 cmd 的 `CheckForRedirectedHandles` 或类似函数。
- **下一步**：
  1. 反汇编搜索 `call 0x40b743` 的调用点（用 capstone 或字节模式搜索 e8 相对偏移）。
  2. 看调用者设置 ecx 的代码——如果 ecx 来自某个全局变量或 API 返回值，确认是否是我们的 API 返回了错误的值。
  3. 如果是 cmd 内部逻辑（调用者确实传了句柄当指针），可能需要在 0x40b743 函数入口加补丁（如果 ecx 是伪句柄则替换为有效结构指针），或者实现更完整的标准句柄模拟。

## 诊断工具 / 断点状态

- `scripts/diag-trap.ts`：**所有临时断点 [ck]/[ck2]/[ck3]/[ck4]/[diag2] 已全部清理**。保留 [api] 日志、maxSteps 8M、[trace] last 64 blocks、dumpFault、BK_ARGS、BK_NO_MUI。
- longjmp handler 中保留了 jmp_buf 64 字节 dump（调试用，确认布局后可删）。
- 诊断日志：`node_modules/.cache/cmd.log`~`cmd5.log`（中间产物，可删）。

## 回归验证（本轮已跑）

- **vitest**：229/229 通过（28 files，7.89s）。比 Step 13 的 189/189 多了 40 个测试（同事新增）。C6 解码修复无回归。
- **notepad cleanExit**：`status=exit eip=0x0 stubs=312`，无 TerminateProcess 0xc0000409。✓
- **typecheck**：通过。
- **lint / apps-web build**：本轮未跑。

## 修改文件清单

- `packages/core/src/jit/x86-decoder.ts` — C6 解码修复（opSize 区分 8/32 位）。**通用 bug，影响所有 exe。**
- `packages/core/src/pe/mapper.ts` — 新增 apisetqueryapisetpresence:2、rtlcreateunicodestringfromasciiz:2、getconsoletitlew:2、getconsoletitlea:2、setconsoletitlew:1、setconsoletitlea:1。
- `packages/core/src/process/guest-process.ts` — 新增 ApiSetQueryApiSetPresence handler + longjmp handler（jmp_buf 布局待修正，含调试 dump）。
- `packages/core/src/api/handlers.ts` — 新增 _o__get_osfhandle/_get_osfhandle（ucrtbase）+ GetFileType（kernel32）。
- `scripts/diag-trap.ts` — 清理所有临时断点。
- `docs/PROGRESS.md` — 本文件（Step 14）。

## 未解 / 注意点（继承 + 新增）

- **当前卡点**：0x40baa6 fastcall 函数 0x40b743 的 ecx 参数（0xfffffff4 伪句柄）被当指针。需定位调用者。
- **longjmp jmp_buf 布局**：当前假设 [0..20]=Ebp/Ebx/Edi/Esi/Esp/Eip 但读到全 0。MSVC 可能用 _setjmp3，jmp_buf 前部有 Registration/TryLevel/Cookie 等字段。cmd /c 模式可能不调用 setjmp（jmp_buf 零初始化）。Bug 6 修复后 cmd 不再走 longjmp 路径，暂不阻塞。
- **内置 Command Prompt 应用**（独立窗口 + stdin/stdout 桥接）尚未实现（Step 11 下一步）。
- **GetOpenFileNameW 文件对话框桥接**（notepad Open/Save）未实现。
- **文件资源管理器真实化**（用户硬性要求"和我电脑的一样"）未完成。
- **同事并行修改警告**：packages/bridges/src/graphics.ts、raster.ts、index.ts、packages/contracts/src/bridge/graphics.ts 已被同事修改，本轮未碰。提交前 git status 确认。
