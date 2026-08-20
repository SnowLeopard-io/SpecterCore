import type { DirEntry } from '@specter-core/contracts';
import {
  OpenIcon,
  DownloadIcon,
  RunIcon,
  CopyIcon,
  RenameIcon,
  DeleteIcon,
} from './icons';

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
          <span className="sc-context-icon"><OpenIcon size={14} /></span> Open
        </button>
        {entry.kind === 'file' && (
          <button
            onClick={() => {
              actions.onDownload();
              onClose();
            }}
          >
            <span className="sc-context-icon"><DownloadIcon size={14} /></span> Download
          </button>
        )}
        {isExe && (
          <button
            onClick={() => {
              actions.onRun();
              onClose();
            }}
          >
            <span className="sc-context-icon"><RunIcon size={14} /></span> Run
          </button>
        )}
        <hr />
        <button
          onClick={() => {
            actions.onCopy();
            onClose();
          }}
        >
          <span className="sc-context-icon"><CopyIcon size={14} /></span> Copy
        </button>
        <button
          onClick={() => {
            actions.onRename();
          }}
        >
          <span className="sc-context-icon"><RenameIcon size={14} /></span> Rename
        </button>
        <button
          className="sc-context-danger"
          onClick={() => {
            actions.onDelete();
            onClose();
          }}
        >
          <span className="sc-context-icon"><DeleteIcon size={14} /></span> Delete
        </button>
      </div>
    </>
  );
}