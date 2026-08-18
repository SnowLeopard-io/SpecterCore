# Browser Kernel — Architecture

> Browser Kernel 在浏览器中通过 WASM + HLE（高级别模拟）运行 Windows x86 应用。
> 本文件描述代码仓库的分层架构、解耦机制与扩展指南。

## 分层一览

仓库以 `packages/*` 反映设计文档的六层架构，`apps/web` 为浏览器入口。

```
┌─────────────────────────────────────────────────────────────┐
│ apps/web (Vite)  ─ 引导：组装 Kernel + 各层插件 + 挂载桌面     │
├─────────────────────────────────────────────────────────────┤
│ L6  packages/ui         桌面外壳：窗口管理器 / 任务栏 / 开始菜单 │
│ L4  packages/drivers    USB 驱动模型(IRP/URB) / PnP / 显示驱动  │
│ L3  packages/core       进程/内存/内核对象 / API 拦截 / PE/JIT │
│ L2  packages/bridges    FS/GDI/音频/USB 桥接（Win32 语义）     │
│ L1  packages/host       OPFS / Worker 池 / WebUSB/GPU/Audio   │
│     packages/kernel     DI 容器 / 事件总线 / 插件系统 / 生命周期 │
│     packages/contracts  层间接口契约 + DI 令牌（唯一事实来源）   │
│     packages/shared     跨层无框架工具（路径/通配符/异步）       │
└─────────────────────────────────────────────────────────────┘
```

## 三条解耦机制

1. **契约优先（contracts-first）**
   `@bk/contracts` 只含类型/枚举/常量，零实现。所有包只依赖它（+ `shared`）。
   任一层换实现（如 `NullGdiBridge` → `CanvasGdiBridge`）都不影响其他层。

2. **DI 令牌（tokens）**
   `contracts/src/tokens.ts` 集中定义服务令牌。各层插件在 `setup()` 中
   `container.registerInstance(tokens.xxx, impl)`，依赖方 `container.resolve(tokens.xxx)`。
   层与层之间唯一的耦合点就是这些令牌——这就是扩展点。

3. **事件总线（event bus）**
   `contracts/src/events.ts` 定义全系统事件表（USB 插拔、进程创建/退出、窗口事件…）。
   层间通信只发事件，不互相 import。新事件加进事件表即可被任意层订阅。

## 插件生命周期

每个逻辑层是一个 `Plugin`（`contracts/kernel.ts`），Kernel 按 `dependsOn` 拓扑排序执行：

```
host.layer → bridge.layer → core.layer → driver.layer → ui.layer
```

```
new Kernel({...})
  .use(HostLayerPlugin).use(BridgeLayerPlugin)…  // or plugins: [...]
await kernel.init();   // setup: 注册服务、建立事件订阅
await kernel.start();  // start: 启动硬件适配器（USB 监听等）
await kernel.stop();   // 逆序 stop → 清空容器与事件总线
```

## 端口与适配器（Ports & Adapters）

契约即端口，浏览器实现与测试实现都是适配器，可互换：

- `FileStore`（`contracts/host.ts`）
  - 浏览器适配器：`OpfsFileStore`（`@bk/host`）
  - 测试适配器：`MemoryFileStore`（`@bk/host`，纯内存）
  - 上层 `FileSystemBridgeImpl` 完全不知道底层是哪种。

## Win32 语义桥接

`@bk/bridges/fs.ts` 是 P0 里最完整的一条链路：

```
CreateFile/ReadFile/WriteFile/SetFilePointer/FindFirstFile/…
        │  (Win32 错误码、句柄表、共享模式、通配符)
        ▼
      FileStore（OPFS 或内存虚拟硬盘）
```

## 插件扩展指南

| 想做什么 | 怎么做 |
| -------- | ------ |
| 新的文件后端 | 实现 `FileStore`，注册到 `tokens.hostFileStore` |
| 新的图形后端 | 实现 `GdiBridge`，注册到 `tokens.bridgeGdi` |
| 新的 USB 类驱动 | 实现 `UsbDriver`，`registry.register(driver)` |
| 新的桌面应用 | 在 `@bk/ui/src/apps.ts` 加一个 `AppDefinition` |
| 新的 Windows API | `interceptor.hook('module.dll','Proc',handler)` |
| 替换任意层实现 | 写自己的 Plugin 注册同令牌即可覆盖（后注册覆盖） |

## 性能指标映射

设计文档 7.1 的指标已在契约层预留锚点：

- JIT 编译吞吐量 → `JitEngine.getStats()`
- 系统调用延迟 → `ApiInterceptorImpl.dispatch()` 计时
- 内存占用 → `MemoryManagerImpl` 区域统计 + `WasmRuntime`
- 帧率 → `DisplayDriver.onVsync` / `GpuAdapter.onFrame`

## 里程碑

- P0（本次交付）：全部骨架可运行，`pnpm test/build/lint` 通过。
- P1：PE 加载 + JIT（`wasm/` 工具链落地）。
- 后续：见 `设计文档.md` 第十部分。

## 相关命令

```bash
pnpm install        # 安装依赖
pnpm dev            # 启动 Vite 开发服务器（含 COOP/COEP 头）
pnpm test           # Vitest 单元测试
pnpm typecheck      # 全仓 TypeScript 检查
pnpm lint           # ESLint
pnpm build          # 构建可部署静态站点（apps/web/dist）
```