import { useRef, useState } from 'react';
import type {
  DragEvent as ReactDragEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
  RefObject,
} from 'react';
import type { DirEntry } from '@specter-core/contracts';
import { BackIcon, UpIcon, RefreshIcon } from './icons';

/** Real Windows file-type icon (extracted from the OS via SHGetFileInfo). */
export function iconPathFor(entry: DirEntry): string {
  if (entry.kind === 'directory') return '/icons/folder.png';
  const lower = entry.name.toLowerCase();
  if (lower.endsWith('.exe') || lower.endsWith('.dll')) return '/icons/application.png';
  if (lower.endsWith('.txt') || lower.endsWith('.md') || lower.endsWith('.log') || lower.endsWith('.ini') || lower.endsWith('.json'))
    return '/icons/text-document.png';
  if (lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.gif') || lower.endsWith('.bmp'))
    return '/icons/image-file.png';
  if (lower.endsWith('.wav') || lower.endsWith('.mp3') || lower.endsWith('.ogg')) return '/icons/audio-file.png';
  if (lower.endsWith('.bkapp')) return '/icons/package.png';
  return '/icons/document.png';
}

export function formatSize(bytes: number): string {
  if (bytes >= 1 << 30) return `${(bytes / (1 << 30)).toFixed(2)} GB`;
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(2)} MB`;
  if (bytes >= 1 << 10) return `${(bytes / (1 << 10)).toFixed(1)} KB`;
  return `${bytes} B`;
}

/** Format a Unix timestamp the way File Explorer shows it in the details view. */
export function formatDate(ms: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  const pad = (n: number): string => n.toString().padStart(2, '0');
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function typeOf(name: string): string {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot < 0) return 'File';
  const ext = lower.slice(dot + 1);
  if (ext === 'exe') return 'Application';
  if (ext === 'dll') return 'Application extension';
  if (ext === 'txt' || ext === 'md' || ext === 'log' || ext === 'ini' || ext === 'json') return 'Text Document';
  if (ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'gif' || ext === 'bmp') return 'Image';
  if (ext === 'wav' || ext === 'mp3' || ext === 'ogg') return 'Audio';
  if (ext === 'bkapp') return 'App package';
  return `${ext.toUpperCase()} File`;
}

const QUICK_ACCESS: ReadonlyArray<{ label: string; path: string; icon: string }> = [
  { label: 'Desktop', path: 'Desktop', icon: '/icons/folder.png' },
  { label: 'Users', path: 'Users', icon: '/icons/folder.png' },
  { label: 'Windows', path: 'Windows', icon: '/icons/folder.png' },
];

export interface ExplorerPaneProps {
  /** Ref to the explorer root element (for context-menu coordinate math). */
  containerRef?: RefObject<HTMLDivElement | null>;
  // State
  path: string;
  entries: DirEntry[];
  loading: boolean;
  error: string | null;
  selected: string | null;
  canBack: boolean;
  canUp: boolean;
  /** Name currently being renamed in-place (renders an input in its row). */
  renaming?: string | null;
  renameRef?: RefObject<HTMLInputElement | null>;
  emptyText?: string;

  // Events
  onNavigate: (target: string) => void;
  onBack: () => void;
  onUp: () => void;
  onRefresh: () => void;
  onSelect: (name: string) => void;
  onOpen: (entry: DirEntry) => void;
  onContextMenu: (e: ReactMouseEvent, entry: DirEntry | null) => void;
  onRenameCommit?: (oldName: string, newName: string) => void;
  onRenameCancel?: () => void;
  onDrop?: (e: ReactDragEvent) => void;

  // Options
  showToolbar?: boolean;
  showNavpane?: boolean;
  showStatusbar?: boolean;
  /** Extra buttons inserted into the toolbar (e.g. New Folder). */
  toolbarExtra?: ReactNode;
  /** Extra bottom content (e.g. the save-as file name row). */
  footer?: ReactNode;
  /** Rendered inside the explorer root (for absolutely-positioned overlays
   *  like context menus / previews that need .sc-explorer as their
   *  positioning context). */
  children?: ReactNode;
}

/**
 * Reusable Windows-Explorer-style file browser pane. Owns the address bar,
 * optional left nav pane, column headers, file rows (with real Windows icons),
 * status bar and drag-drop import highlight. State and business logic stay
 * with the caller; this is pure presentation + navigation plumbing. Used by
 * both the File Explorer app and the Open/Save file dialog.
 */
export function ExplorerPane(props: ExplorerPaneProps): React.JSX.Element {
  const {
    containerRef,
    path,
    entries,
    loading,
    error,
    selected,
    canBack,
    canUp,
    renaming,
    renameRef,
    emptyText = 'This folder is empty.',
    onNavigate,
    onBack,
    onUp,
    onRefresh,
    onSelect,
    onOpen,
    onContextMenu,
    onRenameCommit,
    onRenameCancel,
    onDrop,
    showToolbar = true,
    showNavpane = true,
    showStatusbar = true,
    toolbarExtra,
    footer,
    children,
  } = props;

  // Drag-drop import highlight is pane-local; the actual import is delegated.
  const dragDepth = useRef(0);
  const [dropActive, setDropActive] = useState(false);

  const segments = path.split('/').filter(Boolean);

  const handleDrop = (e: ReactDragEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    dragDepth.current = 0;
    setDropActive(false);
    onDrop?.(e);
  };

  return (
    <div
      ref={containerRef}
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
      onDrop={handleDrop}
    >
      {showToolbar && (
        <div className="sc-explorer-toolbar">
          <button className="sc-explorer-btn" disabled={!canBack} onClick={onBack} aria-label="Back" title="Back">
            <BackIcon size={16} />
          </button>
          <button className="sc-explorer-btn" disabled={!canUp} onClick={onUp} aria-label="Up" title="Up one level">
            <UpIcon size={16} />
          </button>
          <button className="sc-explorer-btn" onClick={onRefresh} aria-label="Refresh" title="Refresh">
            <RefreshIcon size={16} />
          </button>
          {toolbarExtra}
          <div className="sc-explorer-address">
            <span className="sc-explorer-crumb" onClick={() => onNavigate('')}>
              C:
            </span>
            {segments.map((seg, i) => {
              const crumbPath = segments.slice(0, i + 1).join('/');
              return (
                <span key={crumbPath}>
                  <span className="sc-explorer-sep">›</span>
                  <span className="sc-explorer-crumb" onClick={() => onNavigate(crumbPath)}>
                    {seg}
                  </span>
                </span>
              );
            })}
          </div>
        </div>
      )}

      {error && <div className="sc-explorer-error">{error}</div>}

      <div className="sc-explorer-body">
        {showNavpane && (
          <nav className="sc-explorer-navpane" aria-label="Navigation">
            <div className="sc-navpane-section">
              <div className="sc-navpane-header">Quick access</div>
              {QUICK_ACCESS.map((item) => (
                <button
                  key={item.path}
                  className={`sc-navpane-item ${path === item.path ? 'active' : ''}`}
                  onClick={() => onNavigate(item.path)}
                  title={item.path}
                >
                  <img className="sc-navpane-icon" src={item.icon} alt="" draggable={false} />
                  <span className="sc-navpane-label">{item.label}</span>
                </button>
              ))}
            </div>
            <div className="sc-navpane-section">
              <div className="sc-navpane-header">This PC</div>
              <button
                className={`sc-navpane-item ${path === '' ? 'active' : ''}`}
                onClick={() => onNavigate('')}
                title="Local Disk (C:)"
              >
                <img className="sc-navpane-icon" src="/icons/local-disk.png" alt="" draggable={false} />
                <span className="sc-navpane-label">Local Disk (C:)</span>
              </button>
            </div>
          </nav>
        )}

        <div className="sc-explorer-main">
          <div className="sc-explorer-list-head" role="row">
            <span className="col-icon" />
            <span className="col-name">Name</span>
            <span className="col-date">Date modified</span>
            <span className="col-type">Type</span>
            <span className="col-size">Size</span>
          </div>
          <div className="sc-explorer-list" onContextMenu={(e) => onContextMenu(e, null)}>
            {loading && <div className="sc-explorer-empty">Loading…</div>}
            {!loading && entries.length === 0 && <div className="sc-explorer-empty">{emptyText}</div>}
            {!loading &&
              entries.map((entry) => (
                <div
                  key={entry.name}
                  className={`sc-explorer-row ${selected === entry.name ? 'selected' : ''}`}
                  onClick={() => onSelect(entry.name)}
                  onDoubleClick={() => onOpen(entry)}
                  onContextMenu={(e) => onContextMenu(e, entry)}
                >
                  <img className="sc-explorer-icon" src={iconPathFor(entry)} alt="" draggable={false} />
                  {renaming === entry.name && onRenameCommit && onRenameCancel ? (
                    <input
                      ref={renameRef}
                      className="sc-explorer-rename"
                      defaultValue={entry.name}
                      onClick={(e) => e.stopPropagation()}
                      onDoubleClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') onRenameCommit(entry.name, (e.target as HTMLInputElement).value);
                        else if (e.key === 'Escape') onRenameCancel();
                      }}
                      onBlur={(e) => onRenameCommit(entry.name, e.target.value)}
                    />
                  ) : (
                    <span className="sc-explorer-name">{entry.name}</span>
                  )}
                  <span className="sc-explorer-date">
                    {entry.kind === 'directory' ? '' : formatDate(entry.modified)}
                  </span>
                  <span className="sc-explorer-type">
                    {entry.kind === 'directory' ? 'Folder' : typeOf(entry.name)}
                  </span>
                  <span className="sc-explorer-size">
                    {entry.kind === 'directory' ? '' : formatSize(entry.size)}
                  </span>
                </div>
              ))}
          </div>
          {showStatusbar && (
            <div className="sc-explorer-status">
              <span>{entries.length === 1 ? '1 item' : `${entries.length} items`}</span>
            </div>
          )}
          {footer}
        </div>
      </div>

      {children}

      {dropActive && <div className="sc-explorer-drop">Drop files to import into this folder</div>}
    </div>
  );
}