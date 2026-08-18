/**
 * L6 应用包契约：安装器与"可安装应用"的单一事实来源。
 *
 * 这是 Windows "安装 exe" 管道的底层契约：无论最终入口执行的是原生 PE
 * （x86 模拟器 / JIT，见 core/pe 与 core/jit），还是当前可运行的脚本包，
 * 安装流程都收敛到同一个模型 —— 包清单 → 拷贝到 Program Files →
 * 写入注册表（Windows/registry.json）。真实 exe 落地后，只有入口执行层
 * 变化，安装 / 卸载 / 快捷方式 / 开始菜单逻辑不变。
 */

/** 包内文件（相对安装目录的路径 + 内容）。 */
export interface AppPackageFile {
  path: string;
  data: Uint8Array;
}

/** 可安装应用包清单。 */
export interface AppPackage {
  /** 唯一标识（对应注册表键名与安装目录名，须为合法 store 路径段）。 */
  packageId: string;
  name: string;
  version: string;
  icon: string;
  description: string;
  /** 安装后启动入口的应用标识（本系统约定为 'installed:<packageId>'）。 */
  entryAppId: string;
  entryTitle: string;
  entryWidth: number;
  entryHeight: number;
  files: AppPackageFile[];
}

/** 注册表中已安装应用的记录（Program Files 内的持久化条目）。 */
export interface InstalledApp {
  packageId: string;
  name: string;
  version: string;
  icon: string;
  description: string;
  entryAppId: string;
  entryTitle: string;
  entryWidth: number;
  entryHeight: number;
  /** 安装目录（虚拟盘 store 路径，如 'Program Files/hello-world'）。 */
  installDir: string;
  /** 安装时间戳（ms）。 */
  installedAt: number;
}
