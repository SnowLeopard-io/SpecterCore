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