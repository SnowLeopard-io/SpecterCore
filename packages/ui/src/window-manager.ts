import type { Dispose, WindowHandle, WindowManager, WindowOptions } from '@specter-core/contracts';
import { nextStringId } from '@specter-core/shared';

export interface WindowManagerOptions {
  defaultWindowSize?: { width?: number; height?: number };
}

const DEFAULT_WINDOW = { width: 720, height: 480 };

/**
 * Framework-agnostic window manager (design doc 6.2/6.3).
 * Owns window state (bounds, z-order, visibility); rendering is delegated to
 * the React shell via onChange notifications.
 */
export class WindowManagerImpl implements WindowManager {
  private readonly windows = new Map<string, WindowHandle>();
  private readonly appBinding = new Map<string, string>();
  private readonly createdListeners = new Set<(window: WindowHandle) => void>();
  private readonly closedListeners = new Set<(id: string) => void>();
  private readonly changeListeners = new Set<() => void>();
  private nextZ = 10;

  private constructor(private readonly options: WindowManagerOptions = {}) {}

  static create(options?: WindowManagerOptions): WindowManagerImpl {
    return new WindowManagerImpl(options);
  }

  async createWindow(options: WindowOptions): Promise<WindowHandle> {
    const width = options.width ?? this.options.defaultWindowSize?.width ?? DEFAULT_WINDOW.width;
    const height = options.height ?? this.options.defaultWindowSize?.height ?? DEFAULT_WINDOW.height;
    const id = nextStringId('win-');
    const handle: WindowHandle = {
      id,
      title: options.title,
      bounds: {
        x: options.x ?? 80 + (this.windows.size % 8) * 28,
        y: options.y ?? 60 + (this.windows.size % 8) * 24,
        width,
        height,
      },
      state: 'normal',
      zIndex: this.nextZ++,
      visible: true,
      options: { ...options, width, height },
    };
    this.windows.set(id, handle);
    this.notifyCreated(handle);
    this.notifyChange();
    return handle;
  }

  async closeWindow(id: string): Promise<void> {
    const handle = this.windows.get(id);
    if (!handle) return;
    this.windows.delete(id);
    for (const [appId, windowId] of this.appBinding) {
      if (windowId === id) this.appBinding.delete(appId);
    }
    this.notifyClosed(id);
    this.notifyChange();
  }

  async moveWindow(id: string, x: number, y: number): Promise<void> {
    const handle = this.windows.get(id);
    if (!handle || handle.state === 'maximized') return;
    handle.bounds.x = Math.max(0, x);
    handle.bounds.y = Math.max(0, y);
    this.notifyChange();
  }

  async resizeWindow(id: string, width: number, height: number): Promise<void> {
    const handle = this.windows.get(id);
    if (!handle || handle.state === 'maximized') return;
    handle.bounds.width = Math.max(160, width);
    handle.bounds.height = Math.max(100, height);
    this.notifyChange();
  }

  async minimize(id: string): Promise<void> {
    const handle = this.windows.get(id);
    if (!handle) return;
    handle.state = 'minimized';
    this.notifyChange();
  }

  async maximize(id: string): Promise<void> {
    const handle = this.windows.get(id);
    if (!handle) return;
    handle.state = 'maximized';
    handle.zIndex = this.nextZ++;
    this.notifyChange();
  }

  async restore(id: string): Promise<void> {
    const handle = this.windows.get(id);
    if (!handle) return;
    handle.state = 'normal';
    this.notifyChange();
  }

  async focusWindow(id: string): Promise<void> {
    const handle = this.windows.get(id);
    if (!handle) return;
    handle.state = handle.state === 'minimized' ? 'normal' : handle.state;
    handle.zIndex = this.nextZ++;
    this.notifyChange();
  }

  setTitle(id: string, title: string): void {
    const handle = this.windows.get(id);
    if (!handle) return;
    handle.title = title;
    this.notifyChange();
  }

  getWindow(id: string): WindowHandle | null {
    return this.windows.get(id) ?? null;
  }

  listWindows(): WindowHandle[] {
    return [...this.windows.values()].sort((a, b) => a.zIndex - b.zIndex);
  }

  onWindowCreated(listener: (window: WindowHandle) => void): Dispose {
    this.createdListeners.add(listener);
    return () => {
      this.createdListeners.delete(listener);
    };
  }

  onWindowClosed(listener: (id: string) => void): Dispose {
    this.closedListeners.add(listener);
    return () => {
      this.closedListeners.delete(listener);
    };
  }

  onChange(listener: () => void): Dispose {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  bindApp(appId: string, windowId: string): void {
    this.appBinding.set(appId, windowId);
  }

  getAppWindowId(appId: string): string | undefined {
    return this.appBinding.get(appId);
  }

  get focusedWindow(): WindowHandle | null {
    const list = this.listWindows().filter((w) => w.state !== 'minimized');
    return list.length > 0 ? list[list.length - 1]! : null;
  }

  private notifyCreated(handle: WindowHandle): void {
    for (const listener of this.createdListeners) listener(handle);
  }

  private notifyClosed(id: string): void {
    for (const listener of this.closedListeners) listener(id);
  }

  private notifyChange(): void {
    for (const listener of this.changeListeners) listener();
  }
}