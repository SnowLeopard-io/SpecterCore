import type { DirEntry } from '@specter-core/contracts';

export interface FileMenuActions {
  onOpen: () => void;
  onDownload: () => void;
  onRun: () => void;
  onCopy: () => void;
  onRename: () => void;
  onDelete: () => void;
}

interface FileContextMenuProps {
  /** Absolute-positioned inside the nearest position:relative ancestor. */
  x: number;
  y: number;
  entry: DirEntry;
  actions: FileMenuActions;
  onClose: () => void;
}

/** Right-click context menu for a single file or directory entry. */
export function FileContextMenu({ x, y, entry, actions, onClose }: FileContextMenuProps) {
  const isExe = entry.kind === 'file' && entry.name.toLowerCase().endsWith('.exe');
  return (
    <>
      <div
        className="sc-file-menu-overlay"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div className="sc-file-menu" style={{ left: x, top: y }}>
        <button
          onClick={() => {
            actions.onOpen();
            onClose();
          }}
        >
          <span className="sc-context-icon">📂</span> Open
        </button>
        {entry.kind === 'file' && (
          <button
            onClick={() => {
              actions.onDownload();
              onClose();
            }}
          >
            <span className="sc-context-icon">⬇</span> Download
          </button>
        )}
        {isExe && (
          <button
            onClick={() => {
              actions.onRun();
              onClose();
            }}
          >
            <span className="sc-context-icon">▶</span> Run
          </button>
        )}
        <hr />
        <button
          onClick={() => {
            actions.onCopy();
            onClose();
          }}
        >
          <span className="sc-context-icon">📋</span> Copy
        </button>
        <button
          onClick={() => {
            actions.onRename();
          }}
        >
          <span className="sc-context-icon">✎</span> Rename
        </button>
        <button
          className="sc-context-danger"
          onClick={() => {
            actions.onDelete();
            onClose();
          }}
        >
          <span className="sc-context-icon">🗑</span> Delete
        </button>
      </div>
    </>
  );
}
