import { useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent, ReactNode } from 'react';
import type { DesktopController, WindowHandle } from '@bk/contracts';
import { useUi } from '../context';
import { WindowFrame } from './WindowFrame';
import { Taskbar } from './Taskbar';
import { StartMenu } from './StartMenu';
import { ContextMenu } from './ContextMenu';
import { collectDropFiles, importFiles } from '../import-files';
import type { UiController } from '../types';

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

function desktopFileIcon(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith('.exe')) return '⚙️';
  if (lower.endsWith('.txt') || lower.endsWith('.md') || lower.endsWith('.log') || lower.endsWith('.json')) return '📝';
  if (lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.gif') || lower.endsWith('.bmp')) return '🖼️';
  if (lower.endsWith('.bkapp')) return '📦';
  return '📄';
}

/** Full Windows-style desktop: wallpaper, icons, windows, taskbar, start menu. */
export function Desktop({ controller }: DesktopProps) {
  const { kernel } = useUi();
  const windows = useWindowList(controller);
  const [apps, setApps] = useState(controller.listApps());
  const [startOpen, setStartOpen] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [desktopItems, setDesktopItems] = useState<{ name: string; kind: 'file' | 'directory' }[]>([]);
  const [selectedApp, setSelectedApp] = useState<string | null>(null);
  const [dropActive, setDropActive] = useState(false);
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
          entries
            .map((e) => ({ name: e.name, kind: e.kind === 'directory' ? ('directory' as const) : ('file' as const) }))
            .sort((a, b) => {
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

  const createFolder = (): void => {
    if (!fs) return;
    let name = 'New Folder';
    let n = 1;
    while (desktopItems.some((item) => item.name === name)) {
      n += 1;
      name = `New Folder (${n})`;
    }
    void fs
      .createDirectory(`${DESKTOP_DIR}/${name}`)
      .then(() => refreshDesktop())
      .catch(() => {});
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
    return <div className="bk-window-empty">No content for "{win.title}"</div>;
  };

  const isBackground = (target: EventTarget | null): boolean => {
    const el = target as HTMLElement | null;
    if (!el || !el.classList) return false;
    return (
      el.classList.contains('bk-desktop') ||
      el.classList.contains('bk-wallpaper') ||
      el.classList.contains('bk-desktop-icons')
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
    if (el && el.closest('.bk-window')) return;
    dragDepth.current = 0;
    setDropActive(false);
    if (!fs) return;
    const files = await collectDropFiles(e.dataTransfer);
    if (files.length === 0) return;
    await importFiles(fs, files, DESKTOP_DIR);
    refreshDesktop();
    // 6.6：拖入的 .exe 运行优先 —— 打开「运行确认」窗口。
    for (const item of files) {
      if (item.path.toLowerCase().endsWith('.exe')) {
        void controller.launch('exe-runner', { path: `${DESKTOP_DIR}/${item.path}` });
      }
    }
  };

  return (
    <div
      className="bk-desktop"
      onContextMenu={(e) => {
        e.preventDefault();
        setStartOpen(false);
        setMenu({ x: e.clientX, y: e.clientY });
      }}
      onPointerDown={(e) => {
        if (isBackground(e.target)) {
          setMenu(null);
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
      <div className="bk-wallpaper" />
      <div className="bk-desktop-icons">
        {apps.map((app) => (
          <button
            key={app.appId}
            className={`bk-desktop-icon ${selectedApp === app.appId ? 'selected' : ''}`}
            title={app.description}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => launch(app.appId)}
          >
            <span className="bk-desktop-icon-img">{app.icon}</span>
            <span className="bk-desktop-icon-label">{app.name}</span>
          </button>
        ))}
        {desktopItems.map((item, i) => {
          const key = `desktop-${item.name}-${i}`;
          const full = `${DESKTOP_DIR}/${item.name}`;
          const isDir = item.kind === 'directory';
          return (
            <button
              key={key}
              className={`bk-desktop-icon ${selectedApp === key ? 'selected' : ''}`}
              title={isDir ? `Open ${item.name}` : item.name}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => setSelectedApp(key)}
              onDoubleClick={() => {
                if (isDir) void controller.launch('file-explorer', { path: full });
                else void controller.openFile(full);
              }}
            >
              <span className="bk-desktop-icon-img">{isDir ? '📁' : desktopFileIcon(item.name)}</span>
              <span className="bk-desktop-icon-label">{item.name}</span>
            </button>
          );
        })}
      </div>

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
        <div className="bk-drop-overlay">
          <div className="bk-drop-overlay-inner">Drop files to add them to the desktop</div>
        </div>
      )}

      <Taskbar windows={windows} openStart={startOpen} onToggleStart={() => setStartOpen((v) => !v)} />
    </div>
  );
}
