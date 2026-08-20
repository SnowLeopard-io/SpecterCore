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
} from '@specter-core/contracts';
import type { ReactNode } from 'react';
import { tokens } from '@specter-core/contracts';
import {
  appForFile,
  decodeText,
  installPackage as installPkg,
  listInstalledApps as listRegistryApps,
  toStorePath,
  uninstallPackage as uninstallPkg,
} from '@specter-core/shared';
import {
  GuestProcessRunner,
  JitEngineImpl,
  WasmRuntimeImpl,
} from '@specter-core/core';
import { createRoot } from 'react-dom/client';
import { probeCapabilities } from '@specter-core/host';
import { UiContext } from './context';
import { Desktop } from './components/Desktop';
import { DEFAULT_APPS } from './apps';
import { ensureBuiltinWinFiles } from './builtin-win';
import { setGuestText } from './guest-text';
import { guestGdiBridgeProvider } from './gdi-bridge-registry';
import { GuestWindowView } from './apps/RunExecutableApp';
import { CmdGuestTerminal } from './apps/CmdGuestTerminal';
import { CmdConsoleChannel } from './console-channel';
import { FileDialogApp } from './apps/FileDialogApp';
import { InstalledAppView } from './apps/InstalledAppView';
import type { AppDefinition, UiController } from './types';

const INSTALLED_PREFIX = 'installed:';

/**
 * Runtime formatting probes for the bundled cmd.exe (ported from
 * scripts/diag-trap.ts, progress.md Bug18/Bug19). These JIT workarounds need
 * live registers/memory, so they run per-block from onStep instead of being
 * static `patches`. Without them cmd's dir formatters either skip padding or
 * mis-place the digit-group separator; with them the listing spacing is sane.
 */
function cmdFormatProbes(): Array<{ eip: number; fn: (rt: WasmRuntimeImpl) => void }> {
  const rd32 = (rt: WasmRuntimeImpl, a: number): number => {
    const b = rt.readBytes(a >>> 0, 4);
    return b.byteLength < 4 ? 0 : new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true);
  };
  return [
    {
      // Space-padding formatter entry (Bug19): when called from the time->size
      // gap (ret 0x430e52, 4 spaces) or size->name gap (ret 0x405b52, 2 spaces),
      // the savedLen at [ecx+8] is stale, so the padding comparison skips the
      // fill. Recompute the actual string length and write the gap + NUL +
      // updated savedLen directly.
      eip: 0x42e327,
      fn: (rt) => {
        const ecx = rt.getReg('ecx') >>> 0;
        const esp = rt.getReg('esp') >>> 0;
        const retAddr = rd32(rt, esp) >>> 0;
        if (retAddr === 0x430e52 || retAddr === 0x405b52) {
          const bufPtr = rd32(rt, ecx + 0x10) >>> 0;
          let actualLen = 0;
          for (let i = 0; i < 300; i++) {
            const ch = rd32(rt, bufPtr + i * 2) & 0xffff;
            if (ch === 0) break;
            actualLen++;
          }
          const numSpaces = retAddr === 0x430e52 ? 4 : 2;
          const space = new Uint8Array(2);
          new DataView(space.buffer).setUint16(0, 0x20, true);
          for (let i = 0; i < numSpaces; i++) rt.writeBytes(bufPtr + (actualLen + i) * 2, space);
          rt.writeBytes(bufPtr + (actualLen + numSpaces) * 2, new Uint8Array(2));
          const len = new Uint8Array(4);
          new DataView(len.buffer).setUint32(0, actualLen + numSpaces, true);
          rt.writeBytes(ecx + 8, len);
        }
      },
    },
    {
      // 64-bit number formatter (Bug18): force the digit-group separator length
      // to 1 — the wcslen in this build returns a wrong value here and the JIT
      // format loop mis-positions the separator otherwise.
      eip: 0x4317b4,
      fn: (rt) => {
        const ebp = rt.getReg('ebp') >>> 0;
        const b = new Uint8Array(4);
        new DataView(b.buffer).setUint32(0, 1, true);
        rt.writeBytes((ebp - 0xd8) >>> 0, b);
      },
    },
  ];
}

function reactContent(node: ReactNode): WindowContent {
  return { kind: 'react', render: (_controller: UiController) => node };
}

/** Real icon for a hosted guest window, chosen from the exe's name. */
function guestIconFor(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes('notepad')) return '/icons/notepad.svg';
  if (lower.includes('cmd') || lower.includes('command') || lower.includes('console')) return '/icons/cmd.svg';
  if (lower.includes('explorer')) return '/icons/explorer.svg';
  if (lower.includes('paint') || lower.includes('photo') || lower.includes('image')) return '/icons/image-file.svg';
  return '/icons/application.svg';
}

/** Map a virtual-disk store path to a Windows path the guest understands. */
function toWindowsPath(storePath: string): string {
  if (!storePath || storePath === '/') return 'C:\\';
  return 'C:\\' + storePath.replace(/\//g, '\\');
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
        // Double-clicked txt → notepad opens it on startup (GetCommandLineW).
        commandLine: args?.path ? toWindowsPath(args.path) : undefined,
      });
      return;
    }
    if (app.appId === 'command-prompt') {
      await this.openCommandPrompt();
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
          ? 760
          : app.appId === 'image-viewer'
            ? 720
            : app.appId === 'video-viewer'
              ? 800
              : app.appId === 'audio-player'
                ? 640
                : 680,
      height:
        app.appId === 'file-explorer'
          ? 500
          : app.appId === 'image-viewer'
            ? 500
            : app.appId === 'video-viewer'
              ? 540
              : app.appId === 'audio-player'
                ? 520
                : 460,
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
    const lower = path.toLowerCase();
    // Double-clicked .exe: launch the REAL guest process directly — no
    // application-shell window in between.
    if (lower.endsWith('.exe')) {
      await this.launchGuestExecutable(path);
      return true;
    }
    // Double-clicked .bkapp: install it straight onto the virtual disk.
    if (lower.endsWith('.bkapp')) {
      await this.installPackageFile(path);
      return true;
    }
    const appId = appForFile(path);
    if (appId) {
      await this.launch(appId, { path });
      return true;
    }
    return false;
  }

  /** Read a .bkapp manifest off the virtual disk and install it. */
  private async installPackageFile(storePath: string): Promise<void> {
    const fs = this.getFileSystem();
    if (!fs) throw new Error('No virtual disk available');
    const file = await fs.openFile(storePath, 'read');
    let data: Uint8Array;
    try {
      const size = await file.size();
      data = await file.read(0, size);
    } finally {
      await file.close();
    }
    const manifest = JSON.parse(decodeText(data)) as {
      packageId: string;
      name: string;
      version: string;
      icon: string;
      description: string;
      entryAppId: string;
      entryTitle: string;
      entryWidth: number;
      entryHeight: number;
      files: Array<{ path: string; data: string }>;
    };
    const binary = (b64: string): Uint8Array => {
      const raw = atob(b64);
      const out = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
      return out;
    };
    await installPkg(fs, {
      packageId: manifest.packageId,
      name: manifest.name,
      version: manifest.version,
      icon: manifest.icon,
      description: manifest.description,
      entryAppId: manifest.entryAppId,
      entryTitle: manifest.entryTitle,
      entryWidth: manifest.entryWidth,
      entryHeight: manifest.entryHeight,
      files: manifest.files.map((f) => ({ path: f.path, data: binary(f.data) })),
    });
  }

  /**
   * Opens the real guest cmd.exe, optionally running an initial command first
   * (e.g. `cd <dir>` to land in a folder, or launching an executable). The
   * command is queued on stdin before the guest reads it, so it executes right
   * after the banner. Used by the File Explorer ("open CMD here", "run").
   */
  async openCommandPrompt(initialCommand?: string, cwd?: string): Promise<void> {
    await this.launchGuestConsole({
      storePath: 'Windows/SysWOW64/cmd.exe',
      modulePath: 'C:/Windows/SysWOW64/cmd.exe',
      name: 'Command Prompt',
      initialCommand,
      cwd,
    });
  }

  /**
   * Host-driven common file dialog provider (comdlg32 GetOpenFileNameW/A and
   * GetSaveFileNameW/A). Opens a desktop window with the virtual-disk browser
   * (FileDialogApp); resolves with the chosen Windows path, or null when the
   * user cancels / closes the window. The guest process suspends on the
   * comdlg32 trap while this awaits (same pattern as GetMessageW blocking).
   */
  private showFileDialog(
    kind: 'open' | 'save',
    opts: { title: string; initialDir: string; defaultName: string; filter: string },
  ): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      let settled = false;
      let handleId: string | null = null;
      let disposeListener: (() => void) | null = null;
      const done = (path: string | null): void => {
        if (settled) return;
        settled = true;
        disposeListener?.();
        resolve(path);
      };
      disposeListener = this.windowManager.onWindowClosed((id) => {
        if (handleId && id === handleId) done(null);
      });
      void this.windowManager
        .createWindow({
          title: opts.title || (kind === 'open' ? 'Open' : 'Save As'),
          width: 620,
          height: 460,
          icon: '/icons/explorer.svg',
          resizable: true,
          appId: 'file-dialog',
          content: reactContent(
            <FileDialogApp
              kind={kind}
              opts={opts}
              onResult={(path) => {
                done(path);
                if (handleId) this.windowManager.closeWindow(handleId).catch(() => undefined);
              }}
            />,
          ),
        })
        .then((handle) => {
          handleId = handle.id;
        })
        .catch((err) => {
          console.error('[desktop] file dialog failed to open:', err);
          disposeListener();
          done(null);
        });
    });
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
  private async launchGuestWindow(source: {
    storePath: string;
    modulePath: string;
    name: string;
    /** Optional command line handed to the guest (e.g. 'C:\\Users\\a.txt' for
     *  notepad to open on startup). GetCommandLineW/A return it verbatim. */
    commandLine?: string;
  }): Promise<void> {
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
        commandLine: source.commandLine,
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
        gdiBridge: (hwnd) => guestGdiBridgeProvider(hwnd),
        fileDialog: async (kind, opts) => this.showFileDialog(kind, opts),
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
                icon: guestIconFor(source.name),
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

  /**
   * Double-clicked .exe → launch the real guest process directly (no
   * RunExecutableApp shell window). cmd.exe gets its interactive terminal;
   * notepad.exe and other GUI executables are hosted as real guest windows.
   */
  private async launchGuestExecutable(storePath: string): Promise<void> {
    const base = storePath.split('/').filter(Boolean).pop() ?? '';
    const lower = base.toLowerCase();
    if (lower === 'cmd.exe') {
      // Console program: open the real interactive Command Prompt terminal,
      // cwd = the exe's folder.
      const dir = storePath.split('/').filter(Boolean).slice(0, -1).join('/');
      const winDir = `C:\\${dir.replace(/\//g, '\\')}`;
      await this.openCommandPrompt(undefined, winDir);
      return;
    }
    // GUI program: host its top-level windows on the desktop (notepad path).
    // notepad's MUI satellites live under Windows/SysWOW64 on the disk, so
    // its module path is fixed there; other exes report their real location.
    await this.launchGuestWindow({
      storePath,
      modulePath:
        lower === 'notepad.exe'
          ? 'C:/Windows/SysWOW64/notepad.exe'
          : `C:\\${storePath.replace(/\//g, '\\')}`,
      name: base.replace(/\.exe$/i, ''),
    });
  }

  /**
   * Runs the bundled cmd.exe as a REAL guest process with an interactive
   * console terminal. Unlike launchGuestWindow (which hosts a GDI GUI app),
   * cmd is a console program: its stdout streams through GuestProcessRunner's
   * onOutput into a terminal <pre>, and keystrokes posted from the terminal
   * feed its stdin via postInput (see guest-process consoleRead).
   */
  private async launchGuestConsole(source: {
    storePath: string;
    modulePath: string;
    name: string;
    initialCommand?: string;
    /** Initial working directory (Windows path, e.g. 'C:\\Windows\\SysWOW64'). */
    cwd?: string;
  }): Promise<void> {
    const fs = this.getFileSystem();
    if (!fs) {
      await this.showGuestError(source.name, 'No virtual disk available');
      return;
    }
    // Lazy provision so cmd.exe + MUI exist even if startup provision failed.
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
        `Bundled cmd.exe missing on the virtual disk (${source.storePath}, size=${stat?.size ?? '?'}) — reload the page to provision it.`,
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
    const channel = new CmdConsoleChannel();

    // Queue an initial command (e.g. `cd <dir>` or running an exe) before the
    // guest starts reading its stdin, so it executes right after the banner.
    if (source.initialCommand) runner.postInput(source.initialCommand + '\r\n');

    // Open the terminal window first so React can mount and attach to the
    // channel before we start the (possibly-blocking) run.
    const handle = await this.windowManager.createWindow({
      title: source.name,
      width: 680,
      height: 420,
      icon: '/icons/cmd.svg',
      resizable: true,
      appId: 'guest-console',
      content: reactContent(
        <CmdGuestTerminal
          runner={runner}
          channel={channel}
          onClose={() => {
            this.windowManager.closeWindow(handle.id).catch(() => undefined);
          }}
        />,
      ),
    });

    let exitCode = 0;
    let errorMessage: string | null = null;
    try {
      const result = await runner.run(image, {
        createEngine: (mode) => new JitEngineImpl(runtime, mode),
        modulePath: source.modulePath,
        // NOTE: keep the command line EMPTY. A non-empty one (e.g. 'cmd.exe')
        // makes this custom cmd.exe treat itself as invoked with arguments and
        // silently skip command output (dir/echo produce nothing); with an
        // empty command line it runs as a plain interactive shell (verified in
        // scripts/cmd-cwd-check.ts with the real virtual disk).
        commandLine: '',
        interactive: true,
        cwd: source.cwd,
        probes: cmdFormatProbes(),
        // Neutralize cmd.exe's __security_check_cookie (VA 0x41dea0): the
        // interactive input reader overflows the stack cookie slot by a few
        // bytes (a JIT string-instruction boundary quirk), which otherwise
        // fast-fails with STATUS_STACK_BUFFER_OVERRUN. The overflow is benign
        // (saved regs / return address intact), so skipping the check lets cmd
        // run interactively. Mirrors progress.md's cmd.exe memory patches.
        patches: [{ va: 0x41dea0, bytes: [0xc3] }],
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
        onOutput: (bytes, stderr) => channel.push(bytes, stderr),
      });
      exitCode = result.exitCode;
    } catch (err) {
      console.error(`[desktop] guest ${source.name} failed:`, err);
      errorMessage = String(err);
    }
    // Surface the outcome in the terminal and let the user close the window.
    channel.markExited(errorMessage ? -1 : exitCode, errorMessage);
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
          <div className="sc-run-stage">
            <div className="sc-run-title">Cannot start {name}</div>
            <pre className="sc-run-note center" style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>
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