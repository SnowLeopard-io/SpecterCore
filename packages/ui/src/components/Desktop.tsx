import { useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import type { DesktopController, DirEntry, WindowHandle } from '@specter-core/contracts';
import { copyRecursive, deleteRecursive, dirname, moveRecursive, uniqueName } from '@specter-core/shared';
import { tokens } from '@specter-core/contracts';
import { useUi } from '../context';
import { WindowFrame } from './WindowFrame';
import { Taskbar } from './Taskbar';
import { StartMenu } from './StartMenu';
import { ContextMenu } from './ContextMenu';
import { FileContextMenu } from './FileContextMenu';
import { collectDropFiles, importFiles } from '../import-files';
import { downloadBytes } from '../download';
import { uiClipboard, type UiClipboardEntry } from '../ui-clipboard';
import type { UiController } from '../types';
import { AppIcon } from '../AppIcon';

interface DesktopProps {
  controller: DesktopController;
}

function useWindowList(controller: DesktopController): WindowHandle[] {
  const [windows, setWindows] = useState<WindowHandle[]>(controller.windowManager.listWindows());
  useEffect(() => {
    const dispose = controller.windowManager.onChange(() => {
      setWindows([...controller.windowManager.listWindows()]);
    });
    return () => {
      void dispose();
    };
  }, [controller]);
  return windows;
}

/** 虚拟桌面目录：拖入的文件与右键新建的内容都落在这里，并显示为桌面图标。 */
const DESKTOP_DIR = 'Desktop';

/** Return the real Windows file-type icon (extracted from the OS) for a desktop item. */
function desktopFileIcon(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith('.exe') || lower.endsWith('.dll')) return 'icons/application.svg';
  if (lower.endsWith('.txt') || lower.endsWith('.md') || lower.endsWith('.log') || lower.endsWith('.ini') || lower.endsWith('.json'))
    return 'icons/text-document.svg';
  if (lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.gif') || lower.endsWith('.bmp'))
    return 'icons/image-file.svg';
  if (lower.endsWith('.mp3') || lower.endsWith('.wav') || lower.endsWith('.ogg') || lower.endsWith('.flac') || lower.endsWith('.aac') || lower.endsWith('.m4a')) return 'icons/audio-file.svg';
  if (lower.endsWith('.mp4') || lower.endsWith('.webm') || lower.endsWith('.mov') || lower.endsWith('.mkv') || lower.endsWith('.avi')) return 'icons/video-file.svg';
  if (lower.endsWith('.bkapp')) return 'icons/package.svg';
  return 'icons/document.svg';
}

/** Full Windows-style desktop: wallpaper, icons, windows, taskbar, start menu. */
export function Desktop({ controller }: DesktopProps) {
  const { kernel } = useUi();
  const windows = useWindowList(controller);
  const [apps, setApps] = useState(controller.listApps());
  const [startOpen, setStartOpen] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [desktopItems, setDesktopItems] = useState<DirEntry[]>([]);
  const [selectedApp, setSelectedApp] = useState<string | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const [itemMenu, setItemMenu] = useState<{ x: number; y: number; name: string } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const [clipboard, setClipboard] = useState<UiClipboardEntry | null>(null);
  useEffect(() => uiClipboard.subscribe(() => setClipboard(uiClipboard.get())), []);
  const dragDepth = useRef(0);

  const fs = controller.getFileSystem();

  // 安装/卸载应用后刷新开始菜单与桌面图标。
  useEffect(() => {
    const dispose = controller.onAppsChanged(() => setApps(controller.listApps()));
    return () => {
      void dispose();
    };
  }, [controller]);

  const refreshDesktop = (): void => {
    if (!fs) {
      setDesktopItems([]);
      return;
    }
    // 桌面目录可能尚不存在（首次运行），先创建再列目录。
    void fs
      .createDirectory(DESKTOP_DIR)
      .catch(() => {})
      .then(() => fs.listDirectory(DESKTOP_DIR))
      .then((entries) =>
        setDesktopItems(
          [...entries].sort((a, b) => {
            if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
            return a.name.localeCompare(b.name);
          }),
        ),
      )
      .catch(() => setDesktopItems([]));
  };

  useEffect(() => {
    refreshDesktop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fs]);

  // 客户机（notepad 等）通过 FS 桥写虚拟盘后自动刷新桌面图标，无需手动 F5。
  // 变化事件携带 store 路径（如 'Desktop/notes.txt'）；只要其父目录命中桌面
  // 目录（或 moved 的目标落入桌面），就重列桌面目录。
  const refreshDesktopRef = useRef(refreshDesktop);
  refreshDesktopRef.current = refreshDesktop;
  useEffect(() => {
    if (!kernel.container.has(tokens.bridgeFs)) return;
    const bridge = kernel.container.resolve(tokens.bridgeFs);
    const cancel = bridge.onChange((change) => {
      if (dirname(change.path) === DESKTOP_DIR || (change.to !== undefined && dirname(change.to) === DESKTOP_DIR)) {
        refreshDesktopRef.current();
      }
    });
    return () => {
      void cancel();
    };
  }, [kernel]);

  const createFolder = (): void => {
    if (!fs) return;
    const base = 'New Folder';
    const name = uniqueName(base, desktopItems);
    void fs
      .createDirectory(`${DESKTOP_DIR}/${name}`)
      .then(() => refreshDesktop())
      .catch(() => {});
  };

  // Desktop icon right-click actions. Paths live under DESKTOP_DIR; all store
  // operations go through the recursive helpers in @specter-core/shared.
  const openItem = (item: DirEntry): void => {
    const full = `${DESKTOP_DIR}/${item.name}`;
    if (item.kind === 'directory') void controller.launch('file-explorer', { path: full });
    else void controller.openFile(full);
  };
  const downloadItem = async (item: DirEntry): Promise<void> => {
    if (!fs || item.kind !== 'file') return;
    const full = `${DESKTOP_DIR}/${item.name}`;
    try {
      const f = await fs.openFile(full, 'read');
      const size = await f.size();
      const data = await f.read(0, size);
      await f.close();
      downloadBytes(item.name, data);
    } catch {
      /* ignore */
    }
  };
  const runItem = (item: DirEntry): void => {
    if (item.kind !== 'file' || !item.name.toLowerCase().endsWith('.exe')) return;
    const full = `${DESKTOP_DIR}/${item.name}`;
    void controller.openCommandPrompt(`start "" "C:\\${full.replace(/\//g, '\\')}"`, `C:\\${DESKTOP_DIR.replace(/\//g, '\\')}`);
  };
  const copyItem = (item: DirEntry): void => {
    uiClipboard.set({ path: `${DESKTOP_DIR}/${item.name}`, name: item.name, isDir: item.kind === 'directory' });
  };
  const pasteToDesktop = async (): Promise<void> => {
    if (!fs || !clipboard) return;
    const dstName = uniqueName(clipboard.name, desktopItems);
    try {
      await copyRecursive(fs, clipboard.path, `${DESKTOP_DIR}/${dstName}`);
      refreshDesktop();
    } catch {
      /* ignore */
    }
  };
  const deleteItem = async (item: DirEntry): Promise<void> => {
    if (!fs) return;
    const full = `${DESKTOP_DIR}/${item.name}`;
    try {
      await deleteRecursive(fs, full);
      if (clipboard && clipboard.path === full) uiClipboard.set(null);
      refreshDesktop();
    } catch {
      /* ignore */
    }
  };
  const beginRename = (name: string): void => {
    setItemMenu(null);
    setRenaming(name);
    setTimeout(() => renameInputRef.current?.select(), 0);
  };
  const commitRename = async (oldName: string, newName: string): Promise<void> => {
    setRenaming(null);
    if (!fs || !newName) return;
    const trimmed = newName.trim();
    if (!trimmed || trimmed === oldName) return;
    const from = `${DESKTOP_DIR}/${oldName}`;
    const to = `${DESKTOP_DIR}/${trimmed}`;
    if (desktopItems.some((it) => it.name === trimmed)) return;
    try {
      await moveRecursive(fs, from, to);
      refreshDesktop();
    } catch {
      /* ignore */
    }
  };
  const openItemMenu = (e: ReactMouseEvent, name: string): void => {
    e.preventDefault();
    e.stopPropagation();
    // Mutually exclusive with the desktop background context menu.
    setMenu(null);
    let mx = e.clientX;
    let my = e.clientY;
    // Keep the menu inside the viewport (sc-desktop covers the full viewport).
    if (mx + 210 > window.innerWidth) mx = Math.max(0, window.innerWidth - 210);
    if (my + 260 > window.innerHeight) my = Math.max(0, window.innerHeight - 260);
    setItemMenu({ x: mx, y: my, name });
  };

  const uiController = useMemo<UiController>(
    () => ({
      close: (id) => controller.windowManager.closeWindow(id),
      focus: (id) => controller.windowManager.focusWindow(id),
      minimize: (id) => controller.windowManager.minimize(id),
      maximize: (id) => controller.windowManager.maximize(id),
      restore: (id) => controller.windowManager.restore(id),
      moveWindow: (id, x, y) => controller.windowManager.moveWindow(id, x, y),
      resizeWindow: (id, width, height) => controller.windowManager.resizeWindow(id, width, height),
    }),
    [controller],
  );

  const focusedId = windows.length > 0 ? windows[windows.length - 1]!.id : null;

  const renderContent = (win: WindowHandle): ReactNode => {
    const content = win.options.content;
    if (content) return content.render(uiController) as ReactNode;
    return <div className="sc-window-empty">No content for "{win.title}"</div>;
  };

  const isBackground = (target: EventTarget | null): boolean => {
    const el = target as HTMLElement | null;
    if (!el || !el.classList) return false;
    return (
      el.classList.contains('sc-desktop') ||
      el.classList.contains('sc-wallpaper') ||
      el.classList.contains('sc-desktop-icons')
    );
  };

  const launch = (appId: string): void => {
    setSelectedApp(appId);
    void controller.launch(appId);
  };

  // 拖入真实文件 → 导入虚拟桌面目录（保留目录结构），并作为桌面图标显示。
  const onDesktopDrop = async (e: ReactDragEvent): Promise<void> => {
    e.preventDefault();
    e.stopPropagation();
    const el = e.target as HTMLElement | null;
    // 窗口内容由各应用自行处理（如文件资源管理器导入到当前目录）。
    if (el && el.closest('.sc-window')) return;
    dragDepth.current = 0;
    setDropActive(false);
    if (!fs) return;
    const files = await collectDropFiles(e.dataTransfer);
    if (files.length === 0) return;
    await importFiles(fs, files, DESKTOP_DIR);
    refreshDesktop();
    // 拖入的 .exe 直接运行（launchGuestExecutable 分派，不再弹运行确认窗口）。
    for (const item of files) {
      if (item.path.toLowerCase().endsWith('.exe')) {
        void controller.openFile(`${DESKTOP_DIR}/${item.path}`);
      }
    }
  };

  return (
    <div
      className="sc-desktop"
      onContextMenu={(e) => {
        e.preventDefault();
        setStartOpen(false);
        // Mutually exclusive with the file/desktop-item context menu.
        setItemMenu(null);
        setMenu({ x: e.clientX, y: e.clientY });
      }}
      onPointerDown={(e) => {
        if (isBackground(e.target)) {
          setMenu(null);
          setItemMenu(null);
          setStartOpen(false);
          setSelectedApp(null);
        }
      }}
      onDragEnter={(e) => {
        e.preventDefault();
        dragDepth.current += 1;
        setDropActive(true);
      }}
      onDragOver={(e) => {
        e.preventDefault();
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDropActive(false);
      }}
      onDrop={onDesktopDrop}
    >
      <div className="sc-wallpaper" />
      <div className="sc-desktop-icons">
        {apps.map((app) => (
          <button
            key={app.appId}
            className={`sc-desktop-icon ${selectedApp === app.appId ? 'selected' : ''}`}
            title={app.description}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => launch(app.appId)}
          >
            <AppIcon icon={app.icon} className="sc-desktop-icon-img" />
            <span className="sc-desktop-icon-label">{app.name}</span>
          </button>
        ))}
        {desktopItems.map((item, i) => {
          const key = `desktop-${item.name}-${i}`;
          const full = `${DESKTOP_DIR}/${item.name}`;
          const isDir = item.kind === 'directory';
          return (
            <button
              key={key}
              className={`sc-desktop-icon ${selectedApp === key ? 'selected' : ''}`}
              title={isDir ? `Open ${item.name}` : item.name}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => setSelectedApp(key)}
              onDoubleClick={() => {
                if (isDir) void controller.launch('file-explorer', { path: full });
                else void controller.openFile(full);
              }}
              onContextMenu={(e) => openItemMenu(e, item.name)}
            >
                            {isDir ? (
                <img className="sc-desktop-icon-img" src="icons/folder.svg" alt="" draggable={false} />
              ) : (
                <img className="sc-desktop-icon-img" src={desktopFileIcon(item.name)} alt="" draggable={false} />
              )}
              {renaming === item.name ? (
                <input
                  ref={renameInputRef}
                  className="sc-explorer-rename"
                  defaultValue={item.name}
                  onClick={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void commitRename(item.name, (e.target as HTMLInputElement).value);
                    else if (e.key === 'Escape') setRenaming(null);
                  }}
                  onBlur={(e) => void commitRename(item.name, e.target.value)}
                />
              ) : (
                <span className="sc-desktop-icon-label">{item.name}</span>
              )}
            </button>
          );
        })}
      </div>

      {itemMenu && (() => {
        const item = desktopItems.find((it) => it.name === itemMenu.name);
        if (!item) return null;
        return (
          <FileContextMenu
            x={itemMenu.x}
            y={itemMenu.y}
            entry={item}
            onClose={() => setItemMenu(null)}
            actions={{
              onOpen: () => openItem(item),
              onDownload: () => void downloadItem(item),
              onRun: () => runItem(item),
              onCopy: () => copyItem(item),
              onRename: () => beginRename(item.name),
              onDelete: () => void deleteItem(item),
            }}
          />
        );
      })()}

      {windows.map((win) => (
        <WindowFrame
          key={win.id}
          window={win}
          controller={uiController}
          focused={win.id === focusedId}
          renderContent={() => renderContent(win)}
        />
      ))}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onRefresh={refreshDesktop}
          onNewFolder={createFolder}
          onOpenExplorer={() => void controller.launch('file-explorer')}
          onPaste={clipboard ? () => void pasteToDesktop() : null}
          onClose={() => setMenu(null)}
        />
      )}

      <StartMenu
        open={startOpen}
        apps={apps}
        onLaunch={(appId) => {
          launch(appId);
          setStartOpen(false);
        }}
        onShutdown={() => {
          void kernel.stop().then(() => {
            setStartOpen(false);
          });
        }}
      />

      {dropActive && (
        <div className="sc-drop-overlay">
          <div className="sc-drop-overlay-inner">Drop files to add them to the desktop</div>
        </div>
      )}

      <Taskbar windows={windows} openStart={startOpen} onToggleStart={() => setStartOpen((v) => !v)} />
    </div>
  );
}
