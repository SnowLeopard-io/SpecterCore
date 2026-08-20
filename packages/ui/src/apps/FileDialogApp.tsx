import { useCallback, useEffect, useRef, useState } from 'react';
import type { DirEntry, FileStore } from '@specter-core/contracts';
import type { FileDialogOptions } from '@specter-core/core';
import { useUi } from '../context';

function joinPath(base: string, name: string): string {
  return base === '' ? name : `${base}/${name}`;
}

function parentPath(path: string): string {
  const segs = path.split('/').filter(Boolean);
  segs.pop();
  return segs.join('/');
}

/** Map a virtual-disk store path to the Windows path comdlg32 expects back. */
function toWindowsPath(storePath: string): string {
  if (!storePath || storePath === '/') return 'C:\\';
  return 'C:\\' + storePath.replace(/\//g, '\\');
}

/** Map a Windows path (C:\...) to a store path (dirs joined with '/'). */
function toStorePath(winPath: string): string {
  const cleaned = winPath.replace(/^[A-Za-z]:[\\/]+/, '');
  return cleaned.replace(/\\/g, '/');
}

function iconFor(entry: DirEntry): string {
  if (entry.kind === 'directory') return '📁';
  const lower = entry.name.toLowerCase();
  if (lower.endsWith('.txt') || lower.endsWith('.md') || lower.endsWith('.log') || lower.endsWith('.ini'))
    return '📝';
  if (lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.gif') || lower.endsWith('.bmp'))
    return '🖼️';
  return '📄';
}

interface FileDialogAppProps {
  kind: 'open' | 'save';
  opts: FileDialogOptions;
  /** Resolves with the chosen Windows path, or null when cancelled. */
  onResult: (path: string | null) => void;
}

/**
 * Host-driven common file dialog (comdlg32 GetOpenFileNameW/GetSaveFileNameW
 * provider). Renders a compact virtual-disk browser:
 *  - open:  navigate + pick a file, double-click or [Open] confirms;
 *  - save:  navigate + type a file name, [Save] confirms (returns the path);
 * [Cancel] / closing the window resolves null.
 */
export function FileDialogApp({ kind, opts, onResult }: FileDialogAppProps) {
  const { controller } = useUi();
  const fs = controller.getFileSystem() as FileStore | null;

  // Initial directory: lpstrInitialDir wins, else the file's parent, else root.
  const [path, setPath] = useState(() => {
    const init = toStorePath(opts.initialDir || 'C:\\');
    return init === '' ? '' : init;
  });
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [fileName, setFileName] = useState(opts.defaultName);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const reqRef = useRef(0);

  const load = useCallback(
    (target: string): void => {
      if (!fs) return;
      const id = ++reqRef.current;
      setLoading(true);
      setError(null);
      void fs
        .listDirectory(target)
        .then((list) => {
          if (id !== reqRef.current) return;
          const sorted = [...list].sort((a, b) => {
            if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
            return a.name.localeCompare(b.name);
          });
          setEntries(sorted);
          setPath(target);
          setLoading(false);
        })
        .catch((err: unknown) => {
          if (id !== reqRef.current) return;
          setError(`Cannot open "${target}": ${String(err)}`);
          setLoading(false);
        });
    },
    [fs],
  );

  useEffect(() => {
    load(path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fs]);

  const enterDir = (entry: DirEntry): void => {
    if (entry.kind === 'directory') {
      setSelected(null);
      load(joinPath(path, entry.name));
    } else {
      setSelected(entry.name);
      // In save mode, picking a file fills the name box with that file.
      if (kind === 'save') setFileName(entry.name);
    }
  };

  const confirm = (): void => {
    if (kind === 'open') {
      if (!selected) {
        setError('Select a file first.');
        return;
      }
      onResult(toWindowsPath(joinPath(path, selected)));
      return;
    }
    // save
    const name = fileName.trim();
    if (!name) {
      setError('Enter a file name.');
      return;
    }
    onResult(toWindowsPath(joinPath(path, name)));
  };

  const cancel = (): void => onResult(null);

  const segments = path.split('/').filter(Boolean);
  const canUp = path !== '';

  return (
    <div className="sc-file-dialog">
      <div className="sc-file-dialog-head">
        <span className="sc-file-dialog-title">{opts.title || (kind === 'open' ? 'Open' : 'Save As')}</span>
      </div>
      <div className="sc-file-dialog-address">
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
        <span className="sc-file-dialog-up">
          <button className="sc-explorer-btn" disabled={!canUp} onClick={() => load(parentPath(path))} aria-label="Up">
            ▲
          </button>
          <button className="sc-explorer-btn" onClick={() => load(path)} aria-label="Refresh">
            ↻
          </button>
        </span>
      </div>
      {error && <div className="sc-explorer-error">{error}</div>}
      <div className="sc-file-dialog-list">
        {loading && <div className="sc-explorer-empty">Loading…</div>}
        {!loading && !fs && <div className="sc-explorer-empty">No virtual disk available.</div>}
        {!loading && fs && entries.length === 0 && <div className="sc-explorer-empty">This folder is empty.</div>}
        {!loading &&
          entries.map((entry) => (
            <div
              key={entry.name}
              className={`sc-explorer-row ${selected === entry.name ? 'selected' : ''}`}
              onClick={() => enterDir(entry)}
              onDoubleClick={() => {
                if (entry.kind === 'directory') enterDir(entry);
                else {
                  setSelected(entry.name);
                  if (kind === 'save') setFileName(entry.name);
                  else confirm();
                }
              }}
            >
              <span className="sc-explorer-icon">{iconFor(entry)}</span>
              <span className="sc-explorer-name">{entry.name}</span>
              <span className="sc-explorer-size">{entry.kind === 'directory' ? '' : `${entry.size} B`}</span>
              <span className="sc-explorer-type">{entry.kind === 'directory' ? 'Folder' : 'File'}</span>
            </div>
          ))}
      </div>
      <div className="sc-file-dialog-foot">
        {kind === 'save' && (
          <input
            className="sc-file-dialog-name"
            value={fileName}
            onChange={(e) => setFileName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') confirm();
            }}
            placeholder="File name"
            spellCheck={false}
          />
        )}
        <div className="sc-file-dialog-actions">
          <button className="sc-nt-btn" onClick={cancel}>
            Cancel
          </button>
          <button className="sc-nt-btn primary" onClick={confirm}>
            {kind === 'open' ? 'Open' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
