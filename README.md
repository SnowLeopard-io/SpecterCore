# Browser Kernel

在浏览器中通过 WASM + HLE（高级别模拟）原生运行 Windows x86 应用程序，并提供可选的物理 USB 设备直通能力。不模拟硬件，只模拟 API 接口。

> 项目当前处于 **P1 里程碑**：PE 加载 + x86 JIT 翻译核心已可运行。详见 [设计文档](设计文档.md) 与 [架构说明](docs/ARCHITECTURE.md)。

## 快速开始

```bash
pnpm install
pnpm dev
```

打开 http://localhost:5173 即可看到 Windows 风格桌面（壁纸、图标、可拖动缩放窗口、任务栏、开始菜单）。

生产构建 / 预览：

```bash
pnpm build
pnpm preview
```

## 运行 exe（headless）

x86 PE 由 `@bk/core` 的 PE 加载器 + x86→WASM JIT 执行器在本机跑通：加载 → 映射节区 → 重写 IAT 为 trap stub → 基本块 JIT 翻译 → `int 0x2E` trap 分派到 API 拦截器。

```bash
pnpm build:sample-exe            # 生成 sample/hello.exe（手汇编 PE32，调用 GetTickCount/GetStdHandle/WriteFile/ExitProcess）
pnpm run:exe -- sample/hello.exe # 运行并打印 stdout，输出退出码
```

API 调用（含控制台输出）通过拦截器分派；未实现的 API 返回 `ERROR_NOT_IMPLEMENTED`。

## 质量检查

```bash
pnpm typecheck   # 全仓 TypeScript 严格检查
pnpm test        # Vitest 单元测试
pnpm lint        # ESLint
```

## 仓库结构

```
packages/
  contracts/   层间接口契约 + DI 令牌（唯一事实来源，零实现）
  kernel/      DI 容器 / 类型安全事件总线 / 插件系统 / 内核生命周期
  host/        L1 宿主层：OPFS 虚拟硬盘、Worker 池、WebUSB/WebGPU/WebAudio 适配器
  bridges/     L2 桥接层：FS/GDI/音频/USB 的 Windows API → 浏览器宿主
  core/        L3 兼容核心：进程/线程/内存/内核对象、API 拦截器、PE 加载/映射、x86 JIT
  drivers/     L4 驱动抽象：USB 驱动模型（IRP/URB）、PnP、显示驱动
  ui/          L6 桌面外壳：窗口管理器、桌面、任务栏、开始菜单、演示应用
  shared/      跨层无框架工具（Windows 路径、通配符、异步）
apps/
  web/         Vite 入口 + 系统引导（跨域隔离头）
wasm/          L3/L4 的 C/C++ WASM 源预留（P1 接入工具链）
scripts/       开发工具：run-exe（headless 运行 PE）、build-sample-exe（生成样例 exe）
```

## 分层架构

六层插件按 `dependsOn` 拓扑装配，层间只通过 **DI 令牌** 与 **事件总线** 解耦：

```
host.layer → bridge.layer → core.layer → driver.layer → ui.layer
```

详细设计见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 浏览器要求（设计文档 1.1/1.2/1.6）

- Chromium ≥ 120（Chrome / Edge）
- 必须在 localhost 或 HTTPS 下运行
- 开发服务器已配置 `Cross-Origin-Opener-Policy: same-origin` 与
  `Cross-Origin-Embedder-Policy: require-corp`（启用 `SharedArrayBuffer`）

## 里程碑

| 阶段  | 目标                                   | 状态                                                                                                                                                                     |
| ----- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P0    | 基础设施 + 六层架构骨架                | ✅ 交付                                                                                                                                                                  |
| P1    | PE 加载 + x86 JIT 翻译（wasm/ 工具链） | 🔶 核心完成：PE32 加载/映射 + IAT trap stub 重写 + x86→WASM 基本块 JIT + 执行器 + trap→API 拦截器全链路已跑通（`pnpm run:exe` 可 headless 运行 PE 并打印 stdout/退出码） |
| P2    | L2 文件系统桥接跑通控制台程序          | ⬜                                                                                                                                                                       |
| P3    | 图形桥接 + L6 桌面运行 notepad.exe     | ⬜                                                                                                                                                                       |
| P4-P7 | 音频 / 3D(WebGPU) / USB / 性能达标     | ⬜                                                                                                                                                                       |

## License

本仓库为内部学习/研究项目，未指定许可证。
