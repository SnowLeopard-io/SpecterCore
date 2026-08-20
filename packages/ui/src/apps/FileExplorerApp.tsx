import { useCallback, useEffect, useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent } from 'react';
import type { DirEntry, FileStore } from '@specter-core/contracts';
import { decodeText } from '@specter-core/shared';
import { useUi } from '../context';
import { collectDropFiles, importFiles } from '../import-files';
import { downloadBytes } from '../download';

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

function iconFor(entry: DirEntry): string {
  if (entry.kind === 'directory') return '📁';
  const lower = entry.name.toLowerCase();
  if (lower.endsWith('.txt') || lower.endsWith('.md') || lower.endsWith('.log') || lower.endsWith('.ini'))
    return '📝';
  if (lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.gif') || lower.endsWith('.bmp'))
    return '🖼️';
  if (lower.endsWith('.wav') || lower.endsWith('.mp3') || lower.endsWith('.ogg')) return '🎵';
  if (lower.endsWith('.exe') || lower.endsWith('.dll')) return '⚙️';
  return '📄';
}

function formatSize(bytes: number): string {
  if (bytes >= 1 << 30) return `${(bytes / (1 << 30)).toFixed(2)} GB`;
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(2)} MB`;
  if (bytes >= 1 << 10) return `${(bytes / (1 << 10)).toFixed(1)} KB`;
  return `${bytes} B`;
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
  const [dropActive, setDropActive] = useState(false);
  const dragDepth = useRef(0);
  const reqRef = useRef(0);

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
      if (entry.kind === 'directory') await fs.removeDirectory(full);
      else await fs.deleteFile(full);
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

  const segments = path.split('/').filter(Boolean);
  const canBack = nav.index > 0;
  const canUp = path !== '';

  const selectedEntry = entries.find((e) => e.name === selected) ?? null;
  const selectedIsDir = selectedEntry?.kind === 'directory';
  const selectedIsExe =
    selectedEntry?.kind === 'file' && selectedEntry.name.toLowerCase().endsWith('.exe');

  const openCmdHere = (): void => {
    // Open cmd.exe with the current folder as its initial working directory.
    void controller.openCommandPrompt(undefined, toWindowsPath(path));
  };
  const openCmdInSelected = (): void => {
    if (!selectedEntry || selectedEntry.kind !== 'directory') return;
    void controller.openCommandPrompt(undefined, toWindowsPath(joinPath(path, selectedEntry.name)));
  };
  const runSelectedExe = (): void => {
    if (!selectedEntry || selectedEntry.kind !== 'file') return;
    const full = joinPath(path, selectedEntry.name);
    void controller.openCommandPrompt(`start "" "${toWindowsPath(full)}"`, toWindowsPath(path));
  };

  // 拖入真实文件 → 导入当前目录并刷新。
  const onDrop = async (e: ReactDragEvent): Promise<void> => {
    e.preventDefault();
    e.stopPropagation();
    dragDepth.current = 0;
    setDropActive(false);
    if (!fs) return;
    const files = await collectDropFiles(e.dataTransfer);
    if (files.length === 0) return;
    await importFiles(fs, files, path);
    load(path);
  };

  return (
    <div
      className="sc-explorer"
      onDragEnter={(e) => {
        e.preventDefault();
        e.stopPropagation();
        dragDepth.current += 1;
        setDropActive(true);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDropActive(false);
      }}
      onDrop={onDrop}
    >
      <div className="sc-explorer-toolbar">
        <button className="sc-explorer-btn" disabled={!canBack} onClick={back} aria-label="Back">
          ◀
        </button>
        <button className="sc-explorer-btn" disabled={!canUp} onClick={up} aria-label="Up">
          ▲
        </button>
        <button className="sc-explorer-btn" onClick={() => load(path)} aria-label="Refresh">
          ↻
        </button>
        <button className="sc-explorer-btn" onClick={() => void newFolder()} aria-label="New folder">
          📁+
        </button>
        <button
          className="sc-explorer-btn"
          disabled={!selected}
          onClick={() => void deleteSelected()}
          aria-label="Delete"
        >
          🗑
        </button>
        <button
          className="sc-explorer-btn"
          disabled={!selected || entries.find((e) => e.name === selected)?.kind !== 'file'}
          onClick={() => void downloadSelected()}
          aria-label="Download"
        >
          ⬇
        </button>
        <button className="sc-explorer-btn" onClick={openCmdHere} aria-label="Open command prompt here" title="Open command prompt in this folder">
          🖥
        </button>
        <button
          className="sc-explorer-btn"
          disabled={!selectedIsDir}
          onClick={openCmdInSelected}
          aria-label="Open command prompt in selected folder"
          title="Open command prompt in selected folder"
        >
          📁🖥
        </button>
        <button
          className="sc-explorer-btn"
          disabled={!selectedIsExe}
          onClick={runSelectedExe}
          aria-label="Run executable"
          title="Run selected executable in command prompt"
        >
          ▶
        </button>
        <div className="sc-explorer-address">
          <span className="sc-explorer-crumb" onClick={() => load('')}>
            C:
          </span>
          {segments.map((seg, i) => {
            const crumbPath = segments.slice(0, i + 1).join('/');
            return (
              <span key={crumbPath}>
                <span className="sc-explorer-sep">›</span>
                <span className="sc-explorer-crumb" onClick={() => load(crumbPath)}>
                  {seg}
                </span>
              </span>
            );
          })}
        </div>
      </div>

      {error && <div className="sc-explorer-error">{error}</div>}

      <div className="sc-explorer-list">
        {loading && <div className="sc-explorer-empty">Loading…</div>}
        {!loading && !fs && (
          <div className="sc-explorer-empty">No virtual disk available in this environment.</div>
        )}
        {!loading && fs && entries.length === 0 && (
          <div className="sc-explorer-empty">This folder is empty.</div>
        )}
        {!loading &&
          entries.map((entry) => (
            <div
              key={entry.name}
              className={`sc-explorer-row ${selected === entry.name ? 'selected' : ''}`}
              onClick={() => setSelected(entry.name)}
              onDoubleClick={() => openEntry(entry)}
            >
              <span className="sc-explorer-icon">{iconFor(entry)}</span>
              <span className="sc-explorer-name">{entry.name}</span>
              <span className="sc-explorer-size">
                {entry.kind === 'directory' ? '' : formatSize(entry.size)}
              </span>
              <span className="sc-explorer-type">{entry.kind === 'directory' ? 'Folder' : 'File'}</span>
            </div>
          ))}
      </div>

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

      {dropActive && (
        <div className="sc-explorer-drop">Drop files to import into this folder</div>
      )}
    </div>
  );
}
