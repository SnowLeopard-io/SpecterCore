import { useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import type { WindowHandle } from '@specter-core/contracts';
import { useUi } from '../context';
import type { UiController } from '../types';

interface WindowFrameProps {
  window: WindowHandle;
  controller: UiController;
  focused: boolean;
  renderContent: () => ReactNode;
}

const MinimizeIcon = (
  <svg viewBox="0 0 12 12" aria-hidden>
    <line x1="2.5" y1="9" x2="9.5" y2="9" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
  </svg>
);

const MaximizeIcon = (
  <svg viewBox="0 0 12 12" aria-hidden>
    <rect x="2.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1.1" />
  </svg>
);

const RestoreIcon = (
  <svg viewBox="0 0 12 12" aria-hidden>
    <rect x="2.5" y="2.5" width="5.5" height="5.5" fill="none" stroke="currentColor" strokeWidth="1.1" />
    <rect x="4" y="4" width="5.5" height="5.5" fill="var(--sc-titlebar)" stroke="currentColor" strokeWidth="1.1" />
  </svg>
);

const CloseIcon = (
  <svg viewBox="0 0 12 12" aria-hidden>
    <line x1="3" y1="3" x2="9" y2="9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    <line x1="9" y1="3" x2="3" y2="9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
  </svg>
);

/**
 * Window frame: title bar (icon, title, min/max/close), draggable and resizable
 * body. Content is supplied by the window's content renderer.
 */
export function WindowFrame({ window: win, controller, focused, renderContent }: WindowFrameProps) {
  const { kernel } = useUi();
  const [dragging, setDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });

  void kernel;

  if (win.state === 'minimized') return null;

  const isMaximized = win.state === 'maximized';
  const bounds = isMaximized
    ? { x: 0, y: 0, width: '100%' as const, height: 'calc(100% - 48px)' as const }
    : win.bounds;

  const onPointerDown = (e: ReactPointerEvent): void => {
    void controller.focus(win.id);
    // Clicks on caption buttons (min/max/close) must not start a drag or
    // capture the pointer, otherwise their click events get swallowed.
    if ((e.target as HTMLElement).closest('.sc-title-controls')) return;
    if (isMaximized) return;
    setDragging(true);
    setDragStart({ x: e.clientX - win.bounds.x, y: e.clientY - win.bounds.y });
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: ReactPointerEvent): void => {
    if (!dragging) return;
    void controller.moveWindow(win.id, e.clientX - dragStart.x, e.clientY - dragStart.y);
  };

  const onPointerUp = (e: ReactPointerEvent): void => {
    if (!dragging) return;
    setDragging(false);
    const el = e.currentTarget as HTMLElement;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
  };

  return (
    <div
      className={`sc-window ${focused ? 'focused' : ''} ${isMaximized ? 'maximized' : ''}`}
      style={{ left: bounds.x, top: bounds.y, width: bounds.width, height: bounds.height, zIndex: win.zIndex }}
      onPointerDown={() => void controller.focus(win.id)}
    >
      <div
        className="sc-titlebar"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <span className="sc-title-icon">{win.options.icon ?? '▣'}</span>
        <span className="sc-title">{win.title}</span>
        <span className="sc-title-controls">
          {win.options.minimizable !== false && (
            <button className="sc-caption-btn" aria-label="Minimize" onClick={() => void controller.minimize(win.id)}>
              {MinimizeIcon}
            </button>
          )}
          {win.options.maximizable !== false && (
            <button
              className="sc-caption-btn"
              aria-label={isMaximized ? 'Restore' : 'Maximize'}
              onClick={() => void (isMaximized ? controller.restore(win.id) : controller.maximize(win.id))}
            >
              {isMaximized ? RestoreIcon : MaximizeIcon}
            </button>
          )}
          {win.options.closable !== false && (
            <button className="sc-caption-btn close" aria-label="Close" onClick={() => void controller.close(win.id)}>
              {CloseIcon}
            </button>
          )}
        </span>
      </div>
      <div className="sc-window-body">{renderContent()}</div>
      {win.options.resizable !== false && !isMaximized && (
        <div
          className="sc-resizer"
          onPointerDown={(e) => {
            e.stopPropagation();
            const startX = e.clientX;
            const startY = e.clientY;
            const startW = win.bounds.width;
            const startH = win.bounds.height;
            const move = (ev: PointerEvent): void => {
              void controller.resizeWindow(win.id, startW + (ev.clientX - startX), startH + (ev.clientY - startY));
            };
            const up = (): void => {
              window.removeEventListener('pointermove', move);
              window.removeEventListener('pointerup', up);
            };
            window.addEventListener('pointermove', move);
            window.addEventListener('pointerup', up);
          }}
        />
      )}
    </div>
  );
}
