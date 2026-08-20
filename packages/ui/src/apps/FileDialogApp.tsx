import { useCallback, useEffect, useRef, useState } from 'react';
import type { DirEntry, FileStore } from '@specter-core/contracts';
import type { FileDialogOptions } from '@specter-core/core';
import { useUi } from '../context';
import { ExplorerPane } from '../components/ExplorerPane';

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

interface FileDialogAppProps {
  kind: 'open' | 'save';
  opts: FileDialogOptions;
  /** Resolves with the chosen Windows path, or null when cancelled. */
  onResult: (path: string | null) => void;
}

/**
 * Host-driven common file dialog (comdlg32 GetOpenFileNameW/GetSaveFileNameW
 * provider). Reuses the same ExplorerPane as the File Explorer app so the
 * dialog and the browser look identical:
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

  const canUp = path !== '';

  return (
    <ExplorerPane
      path={path}
      entries={entries}
      loading={loading}
      error={error}
      selected={selected}
      canBack={false}
      canUp={canUp}
      emptyText="This folder is empty."
      onNavigate={(target) => load(target)}
      onBack={() => {
        // Dialogs have no history stack; Back stays disabled.
      }}
      onUp={() => load(parentPath(path))}
      onRefresh={() => load(path)}
      onSelect={(name) => setSelected(name)}
      onOpen={enterDir}
      onContextMenu={() => {
        // No context menu in the dialog.
      }}
      showNavpane={false}
      footer={
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
      }
    />
  );
}