import { describe, expect, it, vi } from 'vitest';
import { WindowManagerImpl } from './window-manager';

function makeManager() {
  const manager = WindowManagerImpl.create({ defaultWindowSize: { width: 400, height: 300 } });
  return manager;
}

describe('WindowManagerImpl', () => {
  it('creates windows with defaults and increments z-order', async () => {
    const manager = makeManager();
    const a = await manager.createWindow({ title: 'A' });
    const b = await manager.createWindow({ title: 'B' });
    expect(a.zIndex).toBeLessThan(b.zIndex);
    expect(manager.listWindows()).toHaveLength(2);
    expect(a.bounds.width).toBe(400);
  });

  it('close removes a window', async () => {
    const manager = makeManager();
    const win = await manager.createWindow({ title: 'A' });
    await manager.closeWindow(win.id);
    expect(manager.getWindow(win.id)).toBeNull();
    expect(manager.listWindows()).toHaveLength(0);
  });

  it('move/resize update bounds', async () => {
    const manager = makeManager();
    const win = await manager.createWindow({ title: 'A' });
    await manager.moveWindow(win.id, 50, 60);
    expect(manager.getWindow(win.id)?.bounds.x).toBe(50);
    await manager.resizeWindow(win.id, 500, 400);
    expect(manager.getWindow(win.id)?.bounds.width).toBe(500);
  });

  it('minimize hides and restore shows', async () => {
    const manager = makeManager();
    const win = await manager.createWindow({ title: 'A' });
    await manager.minimize(win.id);
    expect(manager.getWindow(win.id)?.state).toBe('minimized');
    await manager.restore(win.id);
    expect(manager.getWindow(win.id)?.state).toBe('normal');
  });

  it('focus brings window to the top', async () => {
    const manager = makeManager();
    const a = await manager.createWindow({ title: 'A' });
    await manager.createWindow({ title: 'B' });
    await manager.focusWindow(a.id);
    const windows = manager.listWindows();
    expect(windows[windows.length - 1]!.id).toBe(a.id);
    expect(manager.focusedWindow?.id).toBe(a.id);
  });

  it('notifies created/closed/change listeners', async () => {
    const manager = makeManager();
    const created = vi.fn();
    const closed = vi.fn();
    const changed = vi.fn();
    manager.onWindowCreated(created);
    manager.onWindowClosed(closed);
    manager.onChange(changed);

    const win = await manager.createWindow({ title: 'A' });
    expect(created).toHaveBeenCalled();
    expect(changed).toHaveBeenCalled();
    await manager.closeWindow(win.id);
    expect(closed).toHaveBeenCalled();
  });

  it('bindApp associates appId with window', async () => {
    const manager = makeManager();
    const win = await manager.createWindow({ title: 'A' });
    manager.bindApp('notepad', win.id);
    // binding is internal; closing the window should not throw
    await manager.closeWindow(win.id);
  });

  it('clamping and state guards', async () => {
    const manager = makeManager();
    const win = await manager.createWindow({ title: 'A' });
    await manager.moveWindow(win.id, -100, -50);
    expect(manager.getWindow(win.id)?.bounds.x).toBe(0);
    expect(manager.getWindow(win.id)?.bounds.y).toBe(0);
    await manager.maximize(win.id);
    await manager.resizeWindow(win.id, 10, 10);
    expect(manager.getWindow(win.id)?.bounds.width).toBe(400);
  });
});