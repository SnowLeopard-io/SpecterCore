/**
 * Shared "copy/paste" clipboard for the desktop UI.
 *
 * A module-level singleton so a file copied in File Explorer can be pasted on
 * the Desktop (and vice versa) — each app keeps its own component state
 * otherwise. Paste is only offered on EMPTY areas (folder view / desktop
 * background), never on a file entry; the FileContextMenu has no Paste item.
 */
export interface UiClipboardEntry {
  /** Store path (relative to the virtual disk root), e.g. "Desktop/a.txt". */
  path: string;
  name: string;
  isDir: boolean;
}

type Listener = () => void;

let current: UiClipboardEntry | null = null;
const listeners = new Set<Listener>();

export const uiClipboard = {
  get(): UiClipboardEntry | null {
    return current;
  },
  set(entry: UiClipboardEntry | null): void {
    current = entry;
    for (const fn of listeners) fn();
  },
  subscribe(fn: Listener): () => void {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
};
