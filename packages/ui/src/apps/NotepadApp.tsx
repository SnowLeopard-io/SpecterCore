import { useEffect, useRef, useState } from 'react';
import type { FileStore } from '@specter-core/contracts';
import { decodeText } from '@specter-core/shared';
import { useUi } from '../context';
import { downloadBytes } from '../download';

type MenuName = 'file' | 'edit' | 'format' | 'view' | 'help';
type DialogMode = 'open' | 'save' | null;

interface MenuEntry {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  run: () => void;
}

const ENCODER = new TextEncoder();

interface NotepadProps {
  /** 启动即打开的文件（store 路径），来自文件资源管理器/桌面 open 动词。 */
  initialFile?: string;
}

/** Notepad (Windows 11 style): a real file-backed editor over the virtual disk. */
export function NotepadApp({ initialFile }: NotepadProps) {
  const { controller } = useUi();
  const fs = controller.getFileSystem() as FileStore | null;

  const [text, setText] = useState('');
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [openMenu, setOpenMenu] = useState<MenuName | null>(null);
  const [dialog, setDialog] = useState<DialogMode>(null);
  const [dialogPath, setDialogPath] = useState('');
  const [wordWrap, setWordWrap] = useState(true);
  const [status, setStatus] = useState<string>('Ready');
  const [error, setError] = useState<string | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Close the menu when clicking outside the menubar.
  useEffect(() => {
    if (!openMenu) return;
    const onDown = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpenMenu(null);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [openMenu]);

  // Open an initial file when launched via the open verb.
  useEffect(() => {
    if (initialFile && fs) void openFile(initialFile).catch(showErr);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialFile, fs]);

  const saveFile = async (path: string, content: string): Promise<void> => {
    if (!fs) throw new Error('No virtual disk available');
    const data = ENCODER.encode(content);
    // 自动补建父目录（如 Documents/notes.txt 里的 Documents）。
    const parent = path.split('/').filter(Boolean).slice(0, -1).join('/');
    if (parent) await fs.createDirectory(parent).catch(() => {});
    let file;
    try {
      file = await fs.openFile(path, 'write');
    } catch {
      file = await fs.openFile(path, 'create');
    }
    try {
      await file.write(0, data);
      await file.truncate(data.byteLength);
    } finally {
      await file.close();
    }
    setCurrentPath(path);
    setDirty(false);
    setStatus(`Saved to C:\\${path}`);
  };

  const openFile = async (path: string): Promise<void> => {
    if (!fs) throw new Error('No virtual disk available');
    const file = await fs.openFile(path, 'read');
    try {
      const size = await file.size();
      const data = await file.read(0, size);
      setText(decodeText(data));
      setCurrentPath(path);
      setDirty(false);
      setStatus(`Opened C:\\${path}`);
    } finally {
      await file.close();
    }
  };

  const doNew = (): void => {
    if (dirty && !confirm('Discard current changes?')) return;
    setText('');
    setCurrentPath(null);
    setDirty(false);
    setStatus('New document');
  };

  const doOpen = (): void => {
    setDialogPath(currentPath ?? 'Documents/notes.txt');
    setDialog('open');
  };

  const doSave = (): void => {
    if (currentPath) void saveFile(currentPath, text).catch(showErr);
    else doSaveAs();
  };

  const doSaveAs = (): void => {
    setDialogPath(currentPath ?? 'Documents/notes.txt');
    setDialog('save');
  };

  const doDownload = async (): Promise<void> => {
    if (!currentPath) return;
    try {
      const file = await fs?.openFile(currentPath, 'read');
      if (!file) return;
      try {
        const size = await file.size();
        const data = await file.read(0, size);
        downloadBytes(currentPath.split('/').filter(Boolean).pop() ?? 'file.txt', data);
      } finally {
        await file.close();
      }
    } catch (err: unknown) {
      showErr(err);
    }
  };

  const showErr = (err: unknown): void => {
    setError(`Error: ${String(err)}`);
    setStatus('Operation failed');
  };

  const onConfirmDialog = (): void => {
    const path = dialogPath.trim();
    if (!path) return;
    if (dialog === 'save') void saveFile(path, text).then(() => setDialog(null)).catch(showErr);
    else void openFile(path).then(() => setDialog(null)).catch(showErr);
  };

  // ----- Edit operations (native textarea) -----
  const exec = (cmd: string): void => {
    textareaRef.current?.focus();
    void document.execCommand(cmd);
  };
  const selectAll = (): void => textareaRef.current?.select();

  const fileMenu: MenuEntry[] = [
    { label: 'New', shortcut: 'Ctrl+N', run: doNew },
    { label: 'Open…', shortcut: 'Ctrl+O', run: doOpen },
    { label: 'Save', shortcut: 'Ctrl+S', run: doSave },
    { label: 'Save As…', run: doSaveAs },
    { label: 'Download', shortcut: 'Ctrl+J', disabled: !currentPath, run: () => void doDownload() },
  ];

  const editMenu: MenuEntry[] = [
    { label: 'Undo', shortcut: 'Ctrl+Z', run: () => exec('undo') },
    { label: 'Cut', shortcut: 'Ctrl+X', run: () => exec('cut') },
    { label: 'Copy', shortcut: 'Ctrl+C', run: () => exec('copy') },
    { label: 'Paste', shortcut: 'Ctrl+V', run: () => exec('paste') },
    { label: 'Select All', shortcut: 'Ctrl+A', run: selectAll },
  ];

  const formatMenu: MenuEntry[] = [
    {
      label: wordWrap ? 'Word Wrap: On' : 'Word Wrap: Off',
      run: () => setWordWrap((w) => !w),
    },
  ];

  const viewMenu: MenuEntry[] = [
    { label: 'About Notepad', run: () => setStatus('BK Windows — Notepad (virtual disk edition)') },
  ];

  const helpMenu: MenuEntry[] = [
    { label: 'About', run: () => setStatus('Files are saved to the C: virtual disk (OPFS).') },
  ];

  const menus: Record<MenuName, { title: string; items: MenuEntry[] }> = {
    file: { title: 'File', items: fileMenu },
    edit: { title: 'Edit', items: editMenu },
    format: { title: 'Format', items: formatMenu },
    view: { title: 'View', items: viewMenu },
    help: { title: 'Help', items: helpMenu },
  };

  const toggle = (name: MenuName): void => setOpenMenu((m) => (m === name ? null : name));

  const title = currentPath ? `Notepad — ${currentPath.split('/').pop()}` : 'Notepad';

  return (
    <div className="sc-app-body sc-nt">
      <div className="sc-nt-menubar" ref={menuRef}>
        {(Object.keys(menus) as MenuName[]).map((name) => (
          <div key={name} className="sc-nt-menu">
            <button
              className={`sc-nt-menu-title ${openMenu === name ? 'open' : ''}`}
              onClick={() => toggle(name)}
            >
              {menus[name].title}
            </button>
            {openMenu === name && (
              <div className="sc-nt-dropdown">
                {menus[name].items.map((item) => (
                  <button
                    key={item.label}
                    className="sc-nt-item"
                    disabled={item.disabled}
                    onClick={() => {
                      setOpenMenu(null);
                      item.run();
                    }}
                  >
                    <span className="sc-nt-item-label">{item.label}</span>
                    {item.shortcut && <span className="sc-nt-item-shortcut">{item.shortcut}</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {error && <div className="sc-nt-error" onClick={() => setError(null)}>{error}</div>}

      <textarea
        ref={textareaRef}
        className="sc-notepad"
        style={{
          // 内联样式：颜色随 JS 打包，不受样式表缓存/加载顺序影响。
          color: '#1b1b1b',
          background: '#ffffff',
          caretColor: '#1b1b1b',
          whiteSpace: wordWrap ? 'pre-wrap' : 'pre',
          overflowWrap: wordWrap ? 'break-word' : 'normal',
        }}
        value={text}
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value);
          setDirty(true);
        }}
        placeholder="Type here… Save with File ▸ Save (Ctrl+S) to the C: virtual disk."
      />

      <div className="sc-nt-statusbar">
        <span>{title}</span>
        <span>{text.length} chars</span>
        <span>{dirty ? '● unsaved' : 'saved'}</span>
        <span>{status}</span>
      </div>

      {dialog && (
        <div className="sc-nt-modal-backdrop" onClick={() => setDialog(null)}>
          <div className="sc-nt-modal" onClick={(e) => e.stopPropagation()}>
            <div className="sc-nt-modal-title">{dialog === 'save' ? 'Save As' : 'Open'}</div>
            <div className="sc-nt-modal-hint">Path on C: (e.g. Documents/notes.txt)</div>
            <input
              className="sc-nt-modal-input"
              autoFocus
              value={dialogPath}
              onChange={(e) => setDialogPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onConfirmDialog();
                if (e.key === 'Escape') setDialog(null);
              }}
            />
            <div className="sc-nt-modal-actions">
              <button className="sc-nt-btn" onClick={() => setDialog(null)}>
                Cancel
              </button>
              <button className="sc-nt-btn primary" onClick={onConfirmDialog}>
                {dialog === 'save' ? 'Save' : 'Open'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
