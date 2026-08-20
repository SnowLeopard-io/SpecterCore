import { useCallback, useEffect, useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent } from 'react';
import type { DirEntry, FileStore } from '@specter-core/contracts';
import { copyRecursive, decodeText, deleteRecursive, moveRecursive, uniqueName } from '@specter-core/shared';
import { useUi } from '../context';
import { collectDropFiles, importFiles } from '../import-files';
import { downloadBytes } from '../download';
import { FileContextMenu } from '../components/FileContextMenu';
import { uiClipboard, type UiClipboardEntry } from '../ui-clipboard';
import { ExplorerPane } from '../components/ExplorerPane';
import { NewFolderIcon, PasteIcon, RefreshIcon } from '../components/icons';

const MAX_PREVIEW_BYTES = 64 * 1024;

function joinPath(base: string, name: string): string {
  return base === '' ? name : `${base}/${name}`;
}

function parentPath(path: string): string {
  const segs = path.split('/').filter(Boolean);
  segs.pop();
  return segs.join('/');
}

function basenameOf(path: string): string {
  const segs = path.split('/').filter(Boolean);
  return segs[segs.length - 1] ?? path;
}

/** Map a virtual-disk store path to a Windows path cmd.exe understands. */
function toWindowsPath(storePath: string): string {
  if (!storePath || storePath === '/') return 'C:\\';
  return 'C:\\' + storePath.replace(/\//g, '\\');
}

interface Preview {
  name: string;
  path: string;
  text: string;
  truncated: boolean;
}

interface NavState {
  stack: string[];
  index: number;
}

interface FileExplorerProps {
  /** 启动即进入的目录（store 路径），来自桌面双击或 openFile 动词。 */
  initialPath?: string;
}

interface MenuState {
  x: number;
  y: number;
  entryName: string | null;
}

/** File Explorer (Windows 11 style): browse the virtual disk via the FileStore. */
export function FileExplorerApp({ initialPath }: FileExplorerProps) {
  const { controller } = useUi();
  const fs = controller.getFileSystem() as FileStore | null;

  const [path, setPath] = useState('');
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [nav, setNav] = useState<NavState>({ stack: [''], index: 0 });
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const reqRef = useRef(0);
  const [clipboard, setClipboard] = useState<UiClipboardEntry | null>(null);
  useEffect(() => uiClipboard.subscribe(() => setClipboard(uiClipboard.get())), []);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const explorerRef = useRef<HTMLDivElement | null>(null);

  // Open the context menu at the mouse position, expressed RELATIVE to the
  // explorer container (the menu is absolute-positioned inside it). Using
  // viewport-fixed coordinates breaks here: .sc-desktop is itself
  // position:fixed + overflow:hidden, which traps/offsets nested fixed
  // menus, so they never appear.
  const openContextMenu = (e: ReactMouseEvent, entryName: string | null): void => {
    e.preventDefault();
    e.stopPropagation();
    if (entryName) setSelected(entryName);
    const rect = explorerRef.current?.getBoundingClientRect();
    let mx = e.clientX - (rect?.left ?? 0);
    let my = e.clientY - (rect?.top ?? 0);
    if (rect) {
      // Keep the menu inside the window (flip toward the top-left when the
      // click is near the bottom/right edge).
      if (mx + 210 > rect.width) mx = Math.max(0, rect.width - 210);
      if (my + 260 > rect.height) my = Math.max(0, rect.height - 260);
    }
    setMenu({ x: mx, y: my, entryName });
  };

  const load = useCallback(
    (target: string, navHistory = true): void => {
      if (!fs) return;
      const id = ++reqRef.current;
      setLoading(true);
      setError(null);
      setSelected(null);
      setPreview(null);
      void fs
        .listDirectory(target)
        .then((list) => {
          if (id !== reqRef.current) return; // a newer request superseded this one
          const sorted = [...list].sort((a, b) => {
            if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
            return a.name.localeCompare(b.name);
          });
          setEntries(sorted);
          setPath(target);
          setLoading(false);
          if (navHistory) {
            setNav((n) => ({ stack: [...n.stack.slice(0, n.index + 1), target], index: n.index + 1 }));
          }
        })
        .catch((err: unknown) => {
          if (id !== reqRef.current) return;
          setError(`Cannot open "${target}": ${String(err)}`);
          setLoading(false);
        });
    },
    [fs],
  );

  // Mount: open initialPath if provided, otherwise the root. navHistory=false so
  // this never mutates history and the effect cannot re-fire from history changes.
  useEffect(() => {
    if (!fs) return;
    if (initialPath) {
      void fs.stat(initialPath).then((st) => {
        if (st && st.kind === 'directory') {
          setNav({ stack: ['', initialPath], index: 1 });
          load(initialPath, false);
        } else {
          const parent = parentPath(initialPath);
          load(parent, false);
          setSelected(basenameOf(initialPath));
        }
      });
    } else {
      load('', false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fs, initialPath]);

  const back = (): void => {
    if (nav.index <= 0) return;
    const i = nav.index - 1;
    const target = nav.stack[i]!;
    setNav((n) => ({ ...n, index: i }));
    load(target, false);
  };

  const up = (): void => {
    const parent = parentPath(path);
    if (parent !== path) load(parent);
  };

  const openEntry = (entry: DirEntry): void => {
    if (entry.kind === 'directory') {
      load(joinPath(path, entry.name));
      return;
    }
    const full = joinPath(path, entry.name);
    void controller
      .openFile(full)
      .then((handled) => {
        if (!handled) void openFilePreview(entry);
      });
  };

  const openFilePreview = async (entry: DirEntry): Promise<void> => {
    if (!fs) return;
    const full = joinPath(path, entry.name);
    try {
      const file = await fs.openFile(full, 'read');
      const size = await file.size();
      const data = await file.read(0, Math.min(size, MAX_PREVIEW_BYTES));
      await file.close();
      setPreview({
        name: entry.name,
        path: full,
        text: decodeText(data),
        truncated: size > MAX_PREVIEW_BYTES,
      });
    } catch (err: unknown) {
      setError(`Cannot read "${entry.name}": ${String(err)}`);
    }
  };

  const newFolder = async (): Promise<void> => {
    if (!fs) return;
    let name = 'New Folder';
    let candidate = joinPath(path, name);
    let n = 1;
    const existing = new Set(entries.map((e) => e.name));
    while (existing.has(name)) {
      n += 1;
      name = `New Folder (${n})`;
      candidate = joinPath(path, name);
    }
    try {
      await fs.createDirectory(candidate);
      await load(path);
    } catch (err: unknown) {
      setError(`Cannot create folder: ${String(err)}`);
    }
  };

  const deleteSelected = async (): Promise<void> => {
    if (!fs || !selected) return;
    const entry = entries.find((e) => e.name === selected);
    if (!entry) return;
    const full = joinPath(path, entry.name);
    try {
      await deleteRecursive(fs, full);
      if (clipboard && clipboard.path === full) uiClipboard.set(null);
      await load(path);
    } catch (err: unknown) {
      setError(`Cannot delete "${entry.name}": ${String(err)}`);
    }
  };

  const downloadSelected = async (): Promise<void> => {
    if (!fs || !selected) return;
    const entry = entries.find((e) => e.name === selected);
    if (!entry || entry.kind === 'directory') return;
    const full = joinPath(path, entry.name);
    try {
      const file = await fs.openFile(full, 'read');
      try {
        const size = await file.size();
        const data = await file.read(0, size);
        downloadBytes(entry.name, data);
      } finally {
        await file.close();
      }
    } catch (err: unknown) {
      setError(`Cannot download "${entry.name}": ${String(err)}`);
    }
  };

  const copySelected = (): void => {
    const entry = entries.find((e) => e.name === selected);
    if (!entry) return;
    uiClipboard.set({ path: joinPath(path, entry.name), name: entry.name, isDir: entry.kind === 'directory' });
  };

  const pasteHere = async (): Promise<void> => {
    if (!fs || !clipboard) return;
    const dstName = uniqueName(clipboard.name, entries);
    const dst = joinPath(path, dstName);
    try {
      await copyRecursive(fs, clipboard.path, dst);
      await load(path);
    } catch (err: unknown) {
      setError(`Cannot paste "${clipboard.name}": ${String(err)}`);
    }
  };

  const beginRename = (name: string): void => {
    setRenaming(name);
    setMenu(null);
    // Focus after the input renders (next frame).
    setTimeout(() => renameInputRef.current?.select(), 0);
  };

  const commitRename = async (oldName: string, newName: string): Promise<void> => {
    setRenaming(null);
    if (!fs || !newName || newName === oldName) return;
    const trimmed = newName.trim();
    if (!trimmed || trimmed === oldName) return;
    const from = joinPath(path, oldName);
    const to = joinPath(path, trimmed);
    try {
      if (entries.some((e) => e.name === trimmed)) {
        setError(`A file or folder named "${trimmed}" already exists.`);
        return;
      }
      await moveRecursive(fs, from, to);
      setSelected(trimmed);
      await load(path);
    } catch (err: unknown) {
      setError(`Cannot rename "${oldName}": ${String(err)}`);
    }
  };

  const downloadPreview = async (): Promise<void> => {
    if (!fs || !preview) return;
    try {
      const file = await fs.openFile(preview.path, 'read');
      try {
        const size = await file.size();
        const data = await file.read(0, size);
        downloadBytes(preview.name, data);
      } finally {
        await file.close();
      }
    } catch (err: unknown) {
      setError(`Cannot download "${preview.name}": ${String(err)}`);
    }
  };

  const canBack = nav.index > 0;
  const canUp = path !== '';

  const selectedEntry = entries.find((e) => e.name === selected) ?? null;

  const runSelectedExe = (): void => {
    if (!selectedEntry || selectedEntry.kind !== 'file') return;
    const full = joinPath(path, selectedEntry.name);
    void controller.openCommandPrompt(`start "" "${toWindowsPath(full)}"`, toWindowsPath(path));
  };

  // 拖入真实文件 → 导入当前目录并刷新（拖放高亮由 ExplorerPane 管理）。
  const onDrop = async (e: ReactDragEvent): Promise<void> => {
    if (!fs) return;
    const files = await collectDropFiles(e.dataTransfer);
    if (files.length === 0) return;
    await importFiles(fs, files, path);
    load(path);
  };

  return (
    <ExplorerPane
      containerRef={explorerRef}
      path={path}
      entries={entries}
      loading={loading}
      error={error}
      selected={selected}
      canBack={canBack}
      canUp={canUp}
      renaming={renaming}
      renameRef={renameInputRef}
      emptyText="This folder is empty."
      onNavigate={(target) => load(target)}
      onBack={back}
      onUp={up}
      onRefresh={() => load(path)}
      onSelect={(name) => setSelected(name)}
      onOpen={openEntry}
      onContextMenu={(e, entry) => openContextMenu(e, entry ? entry.name : null)}
      onRenameCommit={(oldName, newName) => void commitRename(oldName, newName)}
      onRenameCancel={() => setRenaming(null)}
      onDrop={(e) => void onDrop(e)}
      toolbarExtra={
        <button className="sc-explorer-btn" onClick={() => void newFolder()} aria-label="New folder" title="New folder">
          <NewFolderIcon size={16} />
        </button>
      }
    >
      {preview && (
        <div className="sc-explorer-preview">
          <div className="sc-explorer-preview-head">
            <span>{preview.name}</span>
            <span className="sc-explorer-preview-actions">
              <button className="sc-explorer-btn" onClick={() => void downloadPreview()} aria-label="Download">
                ⬇
              </button>
              <button className="sc-explorer-btn" onClick={() => setPreview(null)} aria-label="Close preview">
                ✕
              </button>
            </span>
          </div>
          <pre className="sc-explorer-preview-body">
            {preview.text}
            {preview.truncated && '\n… (truncated)'}
          </pre>
        </div>
      )}

      {menu &&
        (() => {
          const entry = menu.entryName ? (entries.find((e) => e.name === menu.entryName) ?? null) : null;
          return (
            <>
              {entry ? (
                <FileContextMenu
                  x={menu.x}
                  y={menu.y}
                  entry={entry}
                  onClose={() => setMenu(null)}
                  actions={{
                    onOpen: () => openEntry(entry),
                    onDownload: () => {
                      setSelected(entry.name);
                      void downloadSelected();
                    },
                    onRun: () => {
                      setSelected(entry.name);
                      runSelectedExe();
                    },
                    onCopy: () => {
                      setSelected(entry.name);
                      copySelected();
                    },
                    onRename: () => beginRename(entry.name),
                    onDelete: () => {
                      setSelected(entry.name);
                      void deleteSelected();
                    },
                  }}
                />
              ) : (
                <>
                  <div
                    className="sc-file-menu-overlay"
                    onClick={() => setMenu(null)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setMenu(null);
                    }}
                  />
                  <div className="sc-file-menu" style={{ left: menu.x, top: menu.y }}>
                    <button
                      onClick={() => {
                        void newFolder();
                        setMenu(null);
                      }}
                    >
                      <span className="sc-context-icon"><NewFolderIcon size={14} /></span> New Folder
                    </button>
                    {clipboard && (
                      <button
                        onClick={() => {
                          void pasteHere();
                          setMenu(null);
                        }}
                      >
                        <span className="sc-context-icon"><PasteIcon size={14} /></span> Paste
                      </button>
                    )}
                    <hr />
                    <button
                      onClick={() => {
                        load(path);
                        setMenu(null);
                      }}
                    >
                      <span className="sc-context-icon"><RefreshIcon size={14} /></span> Refresh
                    </button>
                  </div>
                </>
              )}
            </>
          );
        })()}
    </ExplorerPane>
  );
}
