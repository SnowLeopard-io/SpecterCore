/**
 * L6 用户界面层契约：窗口管理器与桌面视图。
 */

import type { Dispose } from './kernel';
import type { ProcessInfo } from './core/process';
import type { Rect } from './bridge/graphics';
import type { FileStore } from './host';
import type { AppPackage, InstalledApp } from './package';

export type { Rect };

/** Window content rendering is delegated to the shell framework (React). */
export interface UiController {
  close(id: string): Promise<void>;
  focus(id: string): Promise<void>;
  minimize(id: string): Promise<void>;
  maximize(id: string): Promise<void>;
  restore(id: string): Promise<void>;
}

export type WindowState = 'normal' | 'minimized' | 'maximized' | 'closed';

/** 启动应用时的可选参数（如用某个文件/目录打开）。 */
export interface AppLaunchArgs {
  /** 虚拟盘上的 store 路径（无盘符），指向文件或目录。 */
  path?: string;
}

export interface WindowOptions {
  title: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  resizable?: boolean;
  minimizable?: boolean;
  maximizable?: boolean;
  closable?: boolean;
  icon?: string;
  /** 关联的应用标识（如进程名） */
  appId?: string;
  /** 应用渲染入口 */
  content?: WindowContent;
}

/** 窗口内容渲染：由界面层框架（React）实现 */
export interface WindowContent {
  readonly kind: string;
  render(controller: UiController): ReactNode;
}

/** 弱类型别名，避免 contracts 强依赖 React */
export type ReactNode = unknown;

export interface WindowHandle {
  id: string;
  title: string;
  bounds: Rect;
  state: WindowState;
  zIndex: number;
  visible: boolean;
  options: WindowOptions;
}

export interface WindowManager {
  createWindow(options: WindowOptions): Promise<WindowHandle>;
  closeWindow(id: string): Promise<void>;
  moveWindow(id: string, x: number, y: number): Promise<void>;
  resizeWindow(id: string, width: number, height: number): Promise<void>;
  minimize(id: string): Promise<void>;
  maximize(id: string): Promise<void>;
  restore(id: string): Promise<void>;
  focusWindow(id: string): Promise<void>;
  setTitle(id: string, title: string): void;
  getWindow(id: string): WindowHandle | null;
  listWindows(): WindowHandle[];
  onWindowCreated(listener: (window: WindowHandle) => void): Dispose;
  onWindowClosed(listener: (id: string) => void): Dispose;
  /** Fired on any state change (create/close/move/resize/min/max/focus) */
  onChange(listener: () => void): Dispose;
  /** 应用图标/进程与窗口的绑定 */
  bindApp(appId: string, windowId: string): void;
}

export interface DesktopAppInfo {
  appId: string;
  name: string;
  icon: string;
  description: string;
  group: string;
  launch: () => Promise<void>;
}

/** 通过浏览器 File System Access 选择到的本地文件（不进入虚拟盘）。 */
export interface LocalFileInfo {
  name: string;
  data: Uint8Array;
}

export interface DesktopController {
  readonly windowManager: WindowManager;
  mount(container: HTMLElement): Promise<void>;
  unmount(): void;
  launch(appId: string, args?: AppLaunchArgs): Promise<void>;
  listApps(): DesktopAppInfo[];
  getSystemInfo(): Promise<SystemInfo>;
  /** 系统级虚拟硬盘（OPFS FileStore），文件资源管理器用它浏览磁盘 */
  getFileSystem(): FileStore | null;
  /**
   * 按 Windows "open" 动词打开一个文件/目录：目录→文件资源管理器，
   * 文本文件→记事本，.bkapp→安装器，其余类型返回 false（调用方可回退到预览）。
   */
  openFile(path: string): Promise<boolean>;
  /**
   * 打开真 cmd.exe 的交互式终端窗口；可指定初始工作目录（cwd，Windows 路径，
   * 如 'C:\\Windows\\SysWOW64'）与初始命令（initialCommand，如启动某个 exe）。
   * 文件资源管理器「在此处打开命令提示符 / 运行」按钮调用。
   */
  openCommandPrompt(initialCommand?: string, cwd?: string): Promise<void>;
  /** 已安装应用列表（注册表缓存，同步返回）。 */
  listInstalledApps(): InstalledApp[];
  /** 安装应用包：拷贝文件到 Program Files、写注册表、刷新开始菜单/桌面图标。 */
  installPackage(pkg: AppPackage): Promise<InstalledApp>;
  /** 卸载：删除安装目录与注册表项并刷新界面。 */
  uninstallPackage(packageId: string): Promise<void>;
  /** 应用列表变化（安装/卸载）时通知界面刷新。 */
  onAppsChanged(listener: () => void): Dispose;
  /**
   * 用 File System Access（showOpenFilePicker）选一个本地文件，返回字节。
   * 用户取消时返回 null；环境不支持时返回 null。
   */
  pickLocalFile(): Promise<LocalFileInfo | null>;
  /**
   * 宿主驱动的文件对话框（comdlg32 GetOpenFileNameW/GetSaveFileNameW 的提供方）。
   * 弹出一个虚拟盘浏览器窗口，用户选择后返回 Windows 路径，取消/关闭返回 null。
   * guest 进程在 comdlg32 陷阱处 await 此 Promise（与 GetMessageW 阻塞同模式）。
   */
  showFileDialog(
    kind: 'open' | 'save',
    opts: { title: string; initialDir: string; defaultName: string; filter: string },
  ): Promise<string | null>;
  /**
   * 清空虚拟硬盘（format）并重置已安装应用缓存，随后刷新页面。
   * 桌面右键菜单「Wipe Virtual Disk」调用。
   */
  wipeStorage(): Promise<void>;
}

export interface SystemInfo {
  version: string;
  processCount: number;
  processes: ProcessInfo[];
  diskUsed: number;
  diskCapacity: number;
  capabilities: string[];
}

export interface UiBootstrapOptions {
  /** 是否渲染壁纸（默认 true） */
  wallpaper?: boolean;
  /** 窗口默认尺寸 */
  defaultWindowSize?: { width: number; height: number };
}