interface ContextMenuProps {
  x: number;
  y: number;
  onRefresh: () => void;
  onNewFolder: () => void;
  onOpenExplorer: () => void;
  onWipe: () => void;
  onClose: () => void;
}

/** Desktop right-click context menu (Windows 11 style). */
export function ContextMenu({ x, y, onRefresh, onNewFolder, onOpenExplorer, onWipe, onClose }: ContextMenuProps) {
  return (
    <div className="bk-context-menu" style={{ left: x, top: y }}>
      <button
        onClick={() => {
          onOpenExplorer();
          onClose();
        }}
      >
        <span className="bk-context-icon">📂</span> Open File Explorer
      </button>
      <button
        onClick={() => {
          onNewFolder();
          onClose();
        }}
      >
        <span className="bk-context-icon">📁</span> New Folder
      </button>
      <hr />
      <button
        onClick={() => {
          onRefresh();
          onClose();
        }}
      >
        <span className="bk-context-icon">↻</span> Refresh
      </button>
      <hr />
      <button
        className="bk-context-danger"
        onClick={() => {
          onWipe();
          onClose();
        }}
      >
        <span className="bk-context-icon">🗑</span> Wipe Virtual Disk
      </button>
      <button onClick={onClose}>
        <span className="bk-context-icon">⚙</span> Properties
      </button>
    </div>
  );
}
