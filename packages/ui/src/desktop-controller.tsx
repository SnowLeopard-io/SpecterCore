import type {
  AppLaunchArgs,
  AppPackage,
  DesktopAppInfo,
  DesktopController,
  Dispose,
  FileStore,
  InstalledApp,
  KernelRuntime,
  LocalFileInfo,
  SystemInfo,
  WindowContent,
  WindowManager,
} from '@bk/contracts';
import type { ReactNode } from 'react';
import { tokens } from '@bk/contracts';
import {
  appForFile,
  installPackage as installPkg,
  listInstalledApps as listRegistryApps,
  toStorePath,
  uninstallPackage as uninstallPkg,
} from '@bk/shared';
import {
  GuestProcessRunner,
  JitEngineImpl,
  WasmRuntimeImpl,
} from '@bk/core';
import { createRoot } from 'react-dom/client';
import { probeCapabilities } from '@bk/host';
import { UiContext } from './context';
import { Desktop } from './components/Desktop';
import { DEFAULT_APPS } from './apps';
import { ensureBuiltinWinFiles } from './builtin-win';
import { setGuestText } from './guest-text';
import { GuestWindowView } from './apps/RunExecutableApp';
import { InstalledAppView } from './apps/InstalledAppView';
import type { AppDefinition, UiController } from './types';

const INSTALLED_PREFIX = 'installed:';

function reactContent(node: ReactNode): WindowContent {
  return { kind: 'react', render: (_controller: UiController) => node };
}

/**
 * Desktop controller: the glue between the L6 shell, the kernel and the demo
 * app registry. Owns the React mount point, app launching and the installed
 * app registry cache (Program Files + Windows/registry.json).
 */
export class DesktopControllerImpl implements DesktopController {
  readonly windowManager: WindowManager;
  private readonly apps: AppDefinition[];
  private readonly launchedWindows = new Map<string, string>();
  private readonly installed = new Map<string, InstalledApp>();
  private readonly appsChanged = new Set<() => void>();
  private root: ReturnType<typeof createRoot> | null = null;
  private mounted = false;

  constructor(
    private readonly kernel: KernelRuntime,
    apps: AppDefinition[] = DEFAULT_APPS,
  ) {
    this.windowManager = kernel.container.resolve(tokens.uiWindows);
    this.apps = apps;
    this.windowManager.onWindowClosed((id) => {
      for (const [appId, windowId] of this.launchedWindows) {
        if (windowId === id) this.launchedWindows.delete(appId);
      }
    });
    // 启动时从虚拟盘注册表恢复已安装应用（开始菜单/桌面图标随之刷新）。
    void this.refreshInstalled().catch(() => {});
  }

  async mount(container: HTMLElement): Promise<void> {
    if (this.mounted) return;
    this.root = createRoot(container);
    this.root.render(
      <UiContext.Provider value={{ kernel: this.kernel, controller: this }}>
        <Desktop controller={this} />
      </UiContext.Provider>,
    );
    this.mounted = true;
  }

  unmount(): void {
    this.root?.unmount();
    this.root = null;
    this.mounted = false;
  }

  async launch(appId: string, args?: AppLaunchArgs): Promise<void> {
    // 已安装应用：按注册表记录打开独立窗口。
    if (appId.startsWith(INSTALLED_PREFIX)) {
      const rec = this.installed.get(appId.slice(INSTALLED_PREFIX.length));
      if (!rec) throw new Error(`Not installed: ${appId}`);
      const handle = await this.windowManager.createWindow({
        title: rec.entryTitle,
        icon: rec.icon,
        width: rec.entryWidth,
        height: rec.entryHeight,
        content: reactContent(<InstalledAppView app={rec} />),
        appId,
      });
      this.launchedWindows.set(appId, handle.id);
      this.windowManager.bindApp(appId, handle.id);
      return;
    }

    const app = this.apps.find((a) => a.appId === appId);
    if (!app) throw new Error(`Unknown app: ${appId}`);
    // Built-in Windows tools run as REAL guest windows — no application shell
    // window around them (the notepad window itself is the app).
    if (app.appId === 'windows-notepad') {
      await this.launchGuestWindow({
        storePath: 'Windows/SysWOW64/notepad.exe',
        modulePath: 'C:/Windows/SysWOW64/notepad.exe',
        name: 'Notepad',
      });
      return;
    }
    // 带参数（open 动词：用某文件/目录打开）时始终新建窗口 —— 记事本已开着
    // 再双击 txt 必须新开一个窗口加载文件，而不是聚焦旧窗口丢掉参数。
    if (!args) {
      const existing = this.launchedWindows.get(appId);
      if (existing) {
        await this.windowManager.focusWindow(existing);
        return;
      }
    }
    const base = args?.path ? `${app.name} — ${args.path.split('/').filter(Boolean).pop() ?? ''}` : app.name;
    const handle = await this.windowManager.createWindow({
      title: base,
      icon: app.icon,
      width:
        app.appId === 'file-explorer'
          ? 660
          : app.appId === 'image-viewer'
            ? 640
            : app.appId === 'system-info' || app.appId === 'exe-runner'
              ? 520
              : 480,
      height:
        app.appId === 'file-explorer'
          ? 460
          : app.appId === 'image-viewer'
            ? 460
            : app.appId === 'exe-runner'
              ? 420
              : app.appId === 'minesweeper'
                ? 420
                : 380,
      content: reactContent(app.render(args)),
      appId: app.appId,
    });
    this.launchedWindows.set(appId, handle.id);
    this.windowManager.bindApp(appId, handle.id);
  }

  async openFile(path: string): Promise<boolean> {
    const fs = this.getFileSystem();
    if (!fs) return false;
    const stat = await fs.stat(path);
    if (!stat) return false;
    if (stat.kind === 'directory') {
      await this.launch('file-explorer', { path });
      return true;
    }
    const appId = appForFile(path);
    if (appId) {
      await this.launch(appId, { path });
      return true;
    }
    return false;
  }

  async pickLocalFile(): Promise<LocalFileInfo | null> {
    if (typeof window === 'undefined' || typeof window.showOpenFilePicker !== 'function') return null;
    try {
      const [handle] = await window.showOpenFilePicker({
        multiple: false,
        types: [
          {
            description: 'Windows executable',
            accept: { 'application/x-msdownload': ['.exe'] },
          },
        ],
        excludeAcceptAllOption: false,
      });
      if (!handle) return null;
      const file = await handle.getFile();
      const data = new Uint8Array(await file.arrayBuffer());
      return { name: file.name, data };
    } catch (error) {
      // AbortError = 用户在文件选择器里点了取消。
      if (error instanceof DOMException && error.name === 'AbortError') return null;
      throw error;
    }
  }

  listApps(): DesktopAppInfo[] {
    const builtin = this.apps.map((app) => ({
      appId: app.appId,
      name: app.name,
      icon: app.icon,
      description: app.description,
      group: app.group,
      launch: () => this.launch(app.appId),
    }));
    const installedApps: DesktopAppInfo[] = [...this.installed.values()].map((a) => ({
      appId: `${INSTALLED_PREFIX}${a.packageId}`,
      name: a.name,
      icon: a.icon,
      description: a.description,
      group: 'Installed',
      launch: () => this.launch(`${INSTALLED_PREFIX}${a.packageId}`),
    }));
    return [...builtin, ...installedApps];
  }

  listInstalledApps(): InstalledApp[] {
    return [...this.installed.values()];
  }

  async installPackage(pkg: AppPackage): Promise<InstalledApp> {
    const fs = this.getFileSystem();
    if (!fs) throw new Error('No virtual disk available');
    const rec = await installPkg(fs, pkg);
    this.installed.set(rec.packageId, rec);
    this.notifyAppsChanged();
    return rec;
  }

  async uninstallPackage(packageId: string): Promise<void> {
    const fs = this.getFileSystem();
    if (!fs) return;
    await uninstallPkg(fs, packageId);
    this.installed.delete(packageId);
    this.notifyAppsChanged();
  }

  onAppsChanged(listener: () => void): Dispose {
    this.appsChanged.add(listener);
    return () => {
      this.appsChanged.delete(listener);
    };
  }

  private async refreshInstalled(): Promise<void> {
    const fs = this.getFileSystem();
    if (!fs) return;
    const apps = await listRegistryApps(fs);
    this.installed.clear();
    for (const app of apps) this.installed.set(app.packageId, app);
    this.notifyAppsChanged();
  }

  private notifyAppsChanged(): void {
    for (const listener of this.appsChanged) listener();
  }

  getFileSystem(): FileStore | null {
    return this.kernel.container.has(tokens.hostFileStore)
      ? this.kernel.container.resolve(tokens.hostFileStore)
      : null;
  }

  async wipeStorage(): Promise<void> {
    const fs = this.getFileSystem();
    if (!fs) return;
    await fs.format();
    this.installed.clear();
    this.notifyAppsChanged();
    // Reload so the desktop/start menu rebuild against the empty disk.
    if (typeof window !== 'undefined') window.location.reload();
  }

  /**
   * Runs a bundled Windows exe (with its MUI resources on the virtual disk)
   * and hosts each guest top-level window as a REAL desktop window — no
   * application-shell window in between. Used by built-in apps (notepad).
   */
  private async launchGuestWindow(source: { storePath: string; modulePath: string; name: string }): Promise<void> {
    const fs = this.getFileSystem();
    if (!fs) {
      await this.showGuestError(source.name, 'No virtual disk available');
      return;
    }
    // Lazy provision: make sure the bundled exe + MUI exist on the disk even
    // if the startup provisioning failed or storage was wiped.
    try {
      await ensureBuiltinWinFiles(fs);
    } catch (err) {
      await this.showGuestError(source.name, `Provisioning bundled tools failed: ${String(err)}`);
      return;
    }
    let stat = null;
    try {
      stat = await fs.stat(source.storePath);
    } catch (err) {
      await this.showGuestError(source.name, `Cannot read ${source.storePath}: ${String(err)}`);
      return;
    }
    if (!stat || stat.kind !== 'file' || stat.size === 0) {
      await this.showGuestError(
        source.name,
        `Bundled tool missing on the virtual disk (${source.storePath}, size=${stat?.size ?? '?'}) — reload the page to provision it.`,
      );
      return;
    }
    let file;
    try {
      file = await fs.openFile(source.storePath, 'read');
    } catch (err) {
      await this.showGuestError(source.name, `Virtual disk has no ${source.storePath} — reload the page to provision the bundled tools. (${String(err)})`);
      return;
    }
    let image: Uint8Array;
    try {
      const size = await file.size();
      image = await file.read(0, size);
    } finally {
      await file.close();
    }

    const runtime = this.kernel.container.resolve(tokens.coreWasmRuntime) as WasmRuntimeImpl;
    const jit = this.kernel.container.resolve(tokens.coreJit);
    const loader = this.kernel.container.resolve(tokens.corePe);
    const interceptor = this.kernel.container.resolve(tokens.coreApi);
    const runner = new GuestProcessRunner(runtime, jit, loader, interceptor);
    const guestWinIds = new Map<number, string>();
    try {
      await runner.run(image, {
        createEngine: (mode) => new JitEngineImpl(runtime, mode),
        modulePath: source.modulePath,
        readFile: async (p) => {
          const sp = toStorePath(p);
          try {
            const f = await fs.openFile(sp, 'read');
            try {
              const size = await f.size();
              return await f.read(0, size);
            } finally {
              await f.close();
            }
          } catch {
            return null;
          }
        },
        interactive: true,
        onMessageWait: () => {
          const wins = runner.getWindows();
          for (const w of wins) {
            if (w.parent !== 0 || guestWinIds.has(w.hwnd)) continue;
            const edit = wins.find((c) => c.parent === w.hwnd && c.className.toLowerCase() === 'edit');
            void this.windowManager
              .createWindow({
                title: `${w.className}${w.text ? ` — ${w.text}` : ''}`,
                width: 680,
                height: 500,
                icon: '📝',
                resizable: true,
                appId: 'guest-window',
                content: reactContent(
                  <GuestWindowView
                    runner={runner}
                    hwnd={w.hwnd}
                    editHwnd={edit ? edit.hwnd : null}
                    menu={w.menu}
                  />,
                ),
              })
              .then((h) => guestWinIds.set(w.hwnd, h.id));
          }
        },
        onTextChanged: (hwnd, text) => setGuestText(hwnd, text),
      });
      // Process exited (WM_QUIT / ExitProcess) — close the hosted windows.
      for (const id of guestWinIds.values()) {
        try {
          await this.windowManager.closeWindow(id);
        } catch {
          // already gone
        }
      }
      guestWinIds.clear();
    } catch (err) {
      console.error(`[desktop] guest ${source.name} failed:`, err);
      await this.showGuestError(source.name, String(err));
    }
  }

  /** Shows a small error window when a bundled guest app cannot start. */
  private async showGuestError(name: string, message: string): Promise<void> {
    try {
      await this.windowManager.createWindow({
        title: `${name} — failed to start`,
        width: 440,
        height: 220,
        resizable: false,
        content: reactContent(
          <div className="bk-run-stage">
            <div className="bk-run-title">Cannot start {name}</div>
            <pre className="bk-run-note center" style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>
              {message}
            </pre>
          </div>,
        ),
      });
    } catch (err) {
      console.error('[desktop] showGuestError failed:', err);
    }
  }

  async getSystemInfo(): Promise<SystemInfo> {
    const processes = this.kernel.container.has(tokens.coreProcess)
      ? this.kernel.container.resolve(tokens.coreProcess).listProcesses()
      : [];
    let diskUsed = 0;
    let diskCapacity = 0;
    if (this.kernel.container.has(tokens.hostFileStore)) {
      const store = this.kernel.container.resolve(tokens.hostFileStore);
      diskUsed = await store.usedBytes();
      diskCapacity = await store.capacity();
    }
    const capabilities = probeCapabilities();
    const present: string[] = [];
    if (capabilities.opfs) present.push('OPFS');
    if (capabilities.webgpu) present.push('WebGPU');
    if (capabilities.webusb) present.push('WebUSB');
    if (capabilities.audioWorklet) present.push('AudioWorklet');
    if (capabilities.crossOriginIsolated) present.push('COOP/COEP');

    const v = this.kernel.options.version;
    return {
      version: `${v.major}.${v.minor}.${v.patch}`,
      processCount: processes.length,
      processes,
      diskUsed,
      diskCapacity,
      capabilities: present,
    };
  }
}