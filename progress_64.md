# SpecterCore x64 兼容层进度记录

> 目标：让 32 位已正常的 SpecterCore 兼容层能运行 64 位（PE32+/x64）的 notepad.exe / cmd.exe。
> 本文档用于交接，记录已完成修复、当前调查状态与下一步。用户语言：中文，代码英文。

## 运行/调试入口

- 运行: `pnpm run:exe -- apps/web/public/win/notepad-x64.exe`（另有 `cmd-x64.exe`）
- 反汇编: `node node_modules/.cache/diag-x64.mjs <exe> <eip-hex> [count]`（脚本改后需先 `pnpm exec esbuild` 重新打包到 node_modules/.cache）
- API 调用轨迹 + 尾部 eip: `node node_modules/.cache/trace-x64.mjs <exe>`（scripts/trace-x64.ts，需先 esbuild）
- V8 报错 `@+N` = 整模块字节偏移
- `dump-wasm` 默认 64 字节窗口可能解码出"验证通过"的短块，必须传大 nbytes（如 256）才能复现 run-exe 长块错误
- 预存无关 typecheck 错误：`packages/ui/src/apps/BrowserApp.tsx(139,22)` getAppWindowId 不存在（勿修）

## 关键知识点（踩坑记录）

- **i64 移位 count 是 i64**：i64.shl/shr_s/shr_u（0x86-0x88）签名 `[i64 i64] -> [i64]`，count 必须是 i64（wasm-chart/MDN 已确认）。i32 移位用 i32 count；SIMD 是 i32，别混。
- **x86-64 立即数**：
  - opcode 0x81/0x83（group1 r/m, imm）：imm 是 **imm32 符号扩展**（REX.W 下扩展到 64），不是 imm64。用 `readImm(64)`=readU64 会多吃 4 字节吃掉后续 opcode。
  - opcode 0x3c/0x3d（acc, imm）：REX.W 下同样 **imm32 符号扩展**（cmp rax, imm32 = 6 字节，不是 10 字节）。
  - opcode 0xC7（mov r/m, imm32）：REX.W 下 imm32 符号扩展（`readS32()`，不是 `readImm(32)` 无符号）。
  - 仅 `mov r64, imm64`（0xB8-0xBF REX.W）真用 imm64。
- **寄存器宽写零扩展**：x64 下写 32 位寄存器须零扩展高 32 位（storeOperand 已处理）。
- **间接 call/jmp 目标在 x64 是 i64**：64 位 mem 装载产生 i64，写 EIP（i32 存储）前必须 `i32WrapI64()`。
- **local 约定**：0-5 = L_A/L_B/L_S/L_TMP/L_TMP2/L_ORIG（i32）；6-8 = L_I64/L_I64A/L_I64B（i64）。
- **64 位栈**：stackTop=0x08000000，headroom=0x80000，rsp=stackTop-8（x64）。runtime 构造 initialPages=512（32MB），最大=maximum（默认上限需 ≥ 0x08080000/64KB 才能 ensure 扩到栈顶）。
- **sleb64** 用位运算 `n & 0x7f`（ToInt32 截断），对 <2^32 常量正确；真 64 位大常量会错（当前 guest 地址 <2^32，暂不触发）。
- **dispatch rawArgs (x64)**：trap 时 rcx/rdx/r8/r9 = 前 4 参，rsp=调用者rsp-8，第 5+ 参数在 `[rsp+0x28+(i-4)*8]`。
- **32 位与 64 位 notepad 行为差异**：SHGetKnownFolderPath 失败时，32 位跳过标题/横幅路径继续；64 位直接放弃创建窗口（走失败分支）。

## 已完成修复

### codegen.ts（i64 移位 count 修复）
- 所有 `fn.i32Const(63); fn.i64ShrU()` → `fn.i64Const(63)`（node 脚本替换，0 处残留）
- emitShift64 主体 count 加 `fn.i64ExtendI32U()`
- CF shl `(64-count)`、shr/sar `(count-1)` 均先 `i64ExtendI32U()` 再 `i64ShrU`
- 其余 i64 shift 调用点（246/271/977/1040/2109/2232/2266/2408 行）已核验用 i64Const count

### emitXchg（64 位 xchg）
- 64 位 park 值用 L_I64A/L_I64B（i64），不用 i32 的 L_TMP2/L_TMP
- 修复 `local.set[0] expected i32, found i64.load` @0x1001bdf（`48 87 15...` XCHG r/m64,rdx）

### x86-decoder（立即数 imm32 修复）
- 0x80/0x81/0x83：`s === 64 ? this.readS32() : this.readImm(s)`（0x83 仍 readS8）
- 0x3c/0x3d（acc,imm）：REX.W 下 `readS32()`，非 readImm(64)
- 0xC7：REX.W 下 `readS32()`
- 修复 `48 81 ec 98 00 00 00`（sub rsp,0x98）→ "extra bits in varint @+74" @0x1002268

### emitJmp/emitCall 间接目标
- 非 rel 目标 pushOperand 后 `if (target.size === 64) fn.i32WrapI64();` 再 storeEip
- 修复 `call [rip+...]`（i64 目标写 i32 EIP）@0x10101d8

### 当前进展（故障消除里程碑）
- 所有 JIT wasm 验证错误消除至 0x10083f8 之前
- 0x10083f8 的 runtime OOB（mov [rsp+0x18],r8）→ 已通过（此前猜测内存上限不足，实际后来推进到更深处，非内存问题）
- x64 notepad 现在能走完 CRT 启动、注册窗口类、加载菜单/字符串（221 个 API trap）
- **新障碍**：SHGetKnownFolderPath 失败（旧 failHr）导致 64 位 notepad 直接放弃窗口创建 → 已改为返回 S_OK + Documents 路径（见下）

## 当前调查中（未解决）

**现象**：x64 notepad 在 SHGetKnownFolderPath 成功返回后，后续 `ret`（0x10220a6 附近）弹出返回地址 = 0x2000cd0（正是我的 Documents 路径缓冲区），跳到数据区 → fault "unsupported opcode 0x63 (ARPL)"。

**轨迹尾部**（trace-x64）：
`0x1022056 0x102205a 0x100a0c0 0x100a0e4 0x100a11a 0x1022068 0x1022081 0x102208b 0x2006a8 0x2006af 0x1022092 0x2000cd0`

**关键观察**：
- SHGetKnownFolderPath 调用点 ret=0x102200e，out=0x7ffedf8（栈上），rsp=0x7ffeda8，`[out]=0 [out+4]=0`（调用前正常）
- 我的 handler 把 Documents 缓冲地址（0x2000cd0）写入 `[out]`，但 **writeInt32 只写 4 字节**；0x2000cd0 低 32 位 = 0x2000cd0，高 32 位未写（若 out 处原有脏数据会残留高位，但 32 位 < 4GB 时高位应为 0）
- **疑似问题**：64 位指针应该用 64 位写入。若 guest 按 8 字节读 `*out`，低 4 字节=0x2000cd0、高 4 字节=残留垃圾 → 返回/后续逻辑用错地址。但 ret 弹出的地址恰是 0x2000cd0（低 32 位）而非垃圾高位拼出来的值，所以更可能是**某个 call 把 out 里的 4 字节值当返回地址**？
- 0x102208b 是 `call [rip+0x7c46]`（经 IAT 的间接 call），目标 stub=0x2006a8 → trap → 返回 0x1022092 → epilogue（nop;mov rbx,[rsp+0x50];mov rax,rdi;add rsp,0x20;pop rdi;pop rsi;pop rbp;ret）→ **ret 弹出 0x2000cd0**

**待验证假设**（下一步）：
1. **64 位指针写 4 字节截断**：SHGetKnownFolderPath 的 out 指针写入应改为 64 位（writeInt32 只写 4 字节）。查 runtime 是否有 writeInt64/写 8 字节的方法，改成 8 字节写入。其它写指针的 handler（pmp_qi、WindowsCreateString 等）x64 下可能同样只写了 4 字节——需系统性检查所有写 out 指针的地方。
2. 若 1 不是根因：在 0x1022092 前 dump [rsp] 附近 64 字节，确认 ret 弹出值来源；检查 0x100a0c0/0x100a0e4/0x100a11a 这段（SHGetKnownFolderPath 后的 notepad 代码）如何消费路径指针、有没有把 buffer 地址当返回地址压栈。

## 代码位置速查

- `packages/core/src/jit/codegen.ts` — 64 位 codegen（移位、xchg、call/jmp wrap）
- `packages/core/src/jit/x86-decoder.ts` — 0x63 MOVSXD、0x81/0x83/0x3c/0x3d/0xC7 imm32
- `packages/core/src/jit/wasm-encoder.ts` — i64 指令集、sleb64
- `packages/core/src/jit/runtime.ts` — 内存 ensure/initialPages/maximum
- `packages/core/src/jit/trap-dispatcher.ts` — x64 rawArgs 读取（rcx/rdx/r8/r9 + 栈）
- `packages/core/src/process/guest-process.ts` — SHGetKnownFolderPath handler（约 2060 行附近，Documents 缓冲 bumpAlloc）、ResolveDelayLoadedAPI（约 1124 行）、栈初始化（约 400 行）
- `packages/core/src/pe/mapper.ts` — IAT trap stub、`call [rip+...]` 重写
- `scripts/trace-x64.ts` / `scripts/diag-x64.ts` — 调试工具（改后需 esbuild）

## 下一步

1. **检查 runtime 是否有 64 位写指针方法**，SHGetKnownFolderPath 及所有写 out 指针的 handler 在 x64 下改为 8 字节写入
2. 重新 trace，看 ret 是否还跳到 0x2000cd0
3. 若仍跳：0x1022092 处 dump [rsp] 栈内容 + 0x100a0c0 段代码的路径消费逻辑
4. 跑通 notepad-x64 → cmd-x64（此前 @0x1024a10 unsupported opcode 0x7）→ 桌面集成（builtin-win.ts 切 64 位 System32）→ typecheck + vitest + 文档

---

## 2026-08-21 会话更新：栈漂移根因已定位并修复

### 根因（重要，本轮确认）
**x64 动态陷阱桩生成了 `ret N`（stdcall）而不是裸 `ret`**，导致每次陷阱调用后 guest 栈 rsp 多退 N 字节（漂移 +0x10），最终把数据指针当返回地址弹出。

- `allocDynamicStub`（guest-process.ts ~1053）**没有区分 x64**，仍用 `X86_API_ARG_COUNT`（如 SHGetKnownFolderPath=4）→ 生成 10 字节桩 `b8 <idx>; cd 2e; c2 10 00`（`ret 16`）。
- x64 调用约定是调用方清理栈，桩必须是 8 字节 `b8 <idx>; cd 2e; c3`（裸 ret）。
- 实测：桩 0x200a38 入口 rsp=0x7ffeda8，执行 `ret 16` 后 rsp=0x7ffedc0（+0x18，正确应 +0x8）→ 之后所有 block 持续漂移 +0x10。
- 影响链：函数入口 E=0x7ffede8，prologue 后应 rsp=E-0x38=0x7ffedb0；SHGetKnownFolderPath 写 path 到 out=[E+0x10]=0x7ffedf8（guest 局部槽，正确）；但因 rsp 漂移，epilogue 的 `ret` 从 [rsp+0x38]=[0x7ffedf8] 弹出 **0x2000cd0（Documents 路径缓冲）** → 跳数据区 fault。
- mapper.ts 静态桩**正确**（`argCount = pe.is64 ? 0 : X86_API_ARG_COUNT[...]`）；只有 allocDynamicStub 漏了 x64 判断。

### 修复已应用
- `allocDynamicStub` 中 `const argCount = pe.is64 ? 0 : (X86_API_ARG_COUNT 查表...)`。
- **作用域坑**：`allocDynamicStub` 定义在 `installStartupHandlers`（guest-process.ts:480，参数含 `pe`）内，`mode` 是 `run` 方法（:393）的局部量，闭包不可见 → 首次编辑用 `mode === 'x64'` 报 `TS2304: Cannot find name 'mode'`（guest-process.ts:1070）。已改用 `pe.is64`。
- `pnpm typecheck` 确认 guest-process.ts 无新增错误（仅剩预存的 codegen.ts XmmOperand/BrowserApp 错误，基线就存在，勿修）。

### 桌面集成（用户要求"接到桌面"）
- `builtin-win.ts`：新增 `win/notepad-x64.exe` + `en-US/notepad-x64.exe.mui` → `Windows/System32/notepad.exe`(.mui)。
- `apps.tsx`：新增 app `windows-notepad-x64`（"Notepad (x64)"，System 组）。
- `desktop-controller.tsx`：`windows-notepad-x64` → `launchGuestWindow({ storePath: 'Windows/System32/notepad.exe', modulePath: 'C:/Windows/System32/notepad.exe', name: 'Notepad (x64)' })`。
- `vite build` 被预存 tsc 错误挡住，但 `vite dev`（跳过 typecheck）可跑；dev server 已起在 http://localhost:5173。**用户实测：点开 64 位直接卡死（主线程被 guest 占死）。**

### 卡死原因调查（进行中，未解决）
- headless 复现：guest 不进 trap、不报 fault，纯 CPU 空转 → **卡在 delay-load 路径的坏跳转**。
- exec 日志（SPECTER_TRACE_EXEC=1）关键序列：
  ```
  0x10272d0 -> 0          ; __delayLoadHelper2 包装函数（call 0x10272fb 后 rax=0x200a30 动态 stub，正常）
  0x2009a0 -> 1 (trap)
  0x1027302 -> 0
  0x1002d37 -> 0          ; delay-load helper 区（lea rax; jmp rax）
  0x1002d6f -> 0
  0x200a30 -> 1 (trap)
  0x102200e -> 0
  0x1022017/21/25 -> ...  ; wcslen 循环（正常终止，非死循环）
  0x10274e0 -> 0          ; `ff 25 6a 2f 00 00` = jmp [rip+0x2f6a] → [0x102a450]
  0x1027500 -> 0          ; `ff e0` = jmp rax，此时 rax=0x6e0065（垃圾）
  0x6e0065 -> 0           ; 跳进数据区，之后每 +0x400 一个 block 线性执行
  0x6e0465 ... 0x7dc065 ... 0x81a465  ; 时间黑洞（20s 才走 ~250KB）
  ```
- **根因候选**：0x102a450 是 **delay-load（.didat）IAT 槽**。mapper 只改写普通导入表（pe.imports），delay-load 槽只被 applyRelocations 从 0x140027500 rebase 成 0x1027500，**未被填成 trap stub**。0x1027500 是裸 `jmp rax`，期望 rax 已装载真实函数地址，但 rax=0x6e0065。
- trace 确认：`ResolveDelayLoadedAPI` **从未被调用**（无 `[rd]` 日志），所以 delay-load 槽 0x102a450 从未被动态填 stub。
- 0x6e0065 来源未定（疑似从某寄存器/内存拼出的错误地址，或 wcslen 段后 rax 残留）。

### 待验证假设（下一步）
1. **ResolveDelayLoadedAPI 未触发**：notepad-x64 的 delay-load helper（0x10272d0/0x1002d37）走的是自实现路径而非 kernel32 的 ResolveDelayLoadedAPI？检查 0x10272d0 的 call 0x10272fb 目标、以及 delay-load 是如何被期望解析的（_FLoad 标志 / __delayLoadHelper2 直接调用 GetProcAddress？）。
2. **0x102a450 槽为何是 0x1027500**：确认这是 applyRelocations 的结果（delay-load 原始值 0x140027500）。若 helper 期望 call 时 rax=槽地址而 codegen 未正确装载，需查 0x1027500 前的 rax 来源。
3. 若 delay-load helper 走 GetProcAddress(module, name) → 检查 GetProcAddress handler 对 delay-load 的返回是否被正确消费（allocDynamicStub 现在已 x64 正确）。
4. 0x6e0065 溯源：在 0x10274e0 前 dump rax 变化（0x1027302 rax=0x200a30 → 0x10274ac rax=0x2001188 → 0x10274e0 rax=0x6e0065，中间某指令污染 rax）。
5. 之后：跑通 notepad-x64 → cmd-x64 → 桌面 → typecheck+vitest+文档。

### 本轮调试工具变更
- `scripts/trace-x64.ts`：新增 `[wcs]`（0x1022025 wcslen 循环 dump rdx 缓冲）、`[dl]`（0x1026f00-0x1027600 delay-load 区，含 0x10274e0 的 IAT 槽值）、`[rd]`（ResolveDelayLoadedAPI 参数）探针，改用 `console.error` 直写 stderr（防缓冲吞日志）。
- `packages/core/src/jit/executor.ts`：临时加了 `SPECTER_TRACE_EXEC` 环境变量逐 block 打印（诊断用，可留可删）。
- `scripts/run-exe-debug.ts`（新）：headless 复现卡死，maxSteps 400M。
- `scripts/dump-x64.ts`（新）：按 PE 静态映射后 dump 指定地址字节/IAT 槽。
- 注意：headless 后台跑需要 Start-Process + RedirectStandardError，进程不退出时 stderr 可能全缓冲在文件（PowerShell 管道会等进程退出）。