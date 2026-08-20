import { FolderIcon, OpenIcon, PasteIcon, RefreshIcon, WindowsLogoIcon } from './icons';

interface ContextMenuProps {
  x: number;
  y: number;
  onRefresh: () => void;
  onNewFolder: () => void;
  onOpenExplorer: () => void;
  /** Paste is only offered when something was copied (never on file entries). */
  onPaste: (() => void) | null;
  onClose: () => void;
}

/** Desktop right-click context menu (Windows 11 style). */
export function ContextMenu({ x, y, onRefresh, onNewFolder, onOpenExplorer, onPaste, onClose }: ContextMenuProps) {
  return (
    <>
      <div
        className="sc-context-menu-overlay"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div className="sc-context-menu" data-sc-context-menu style={{ left: x, top: y }}>
      <button
        onClick={() => {
          onOpenExplorer();
          onClose();
        }}
      >
        <span className="sc-context-icon"><OpenIcon /></span> Open File Explorer
      </button>
      <button
        onClick={() => {
          onNewFolder();
          onClose();
        }}
      >
        <span className="sc-context-icon"><FolderIcon /></span> New Folder
      </button>
      {onPaste && (
        <button
          onClick={() => {
            onPaste();
            onClose();
          }}
        >
          <span className="sc-context-icon"><PasteIcon /></span> Paste
        </button>
      )}
      <hr />
      <button
        onClick={() => {
          onRefresh();
          onClose();
        }}
      >
        <span className="sc-context-icon"><RefreshIcon /></span> Refresh
      </button>
      <button onClick={onClose}>
        <span className="sc-context-icon"><WindowsLogoIcon /></span> Properties
      </button>
      </div>
    </>
  );
}
