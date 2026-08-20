import { useEffect, useState } from 'react';
import type { WindowHandle } from '@specter-core/contracts';
import { useUi } from '../context';
import { AppIcon } from '../AppIcon';

interface TaskbarProps {
 windows: WindowHandle[];
 openStart: boolean;
 onToggleStart: () => void;
}

function useClock(): string {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000 * 10);
    return () => window.clearInterval(id);
  }, []);
  const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const date = now.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return `${time}\n${date}`;
}

/** Bottom taskbar (Windows 11 style): centered cluster of icons + system tray. */
export function Taskbar({ windows, openStart, onToggleStart }: TaskbarProps) {
  const { controller } = useUi();
  const clock = useClock();

  const focusOrRestore = (win: WindowHandle): void => {
    if (win.state === 'minimized') void controller.windowManager.restore(win.id);
    void controller.windowManager.focusWindow(win.id);
  };

  return (
    <div className="sc-taskbar">
      <div className="sc-taskbar-cluster">
        <button
          className={`sc-task-btn start ${openStart ? 'open' : ''}`}
          aria-label="Start"
          onClick={onToggleStart}
        >
          <img className="sc-taskbar-sys-icon large" src="/icons/taskbar-windows.svg" alt="" draggable={false} />
        </button>
        <button className="sc-task-btn" aria-label="Search">
          <img className="sc-taskbar-sys-icon" src="/icons/taskbar-search.svg" alt="" draggable={false} />
        </button>
        <span className="sc-task-sep" />
        {windows.map((win) => (
          <button
            key={win.id}
            className={`sc-task-btn ${win.state !== 'minimized' ? 'active' : ''}`}
            aria-label={win.title}
            title={win.title}
            onClick={() => focusOrRestore(win)}
          >
            <AppIcon icon={win.options.icon ?? '▣'} className="sc-taskbar-icon" />
          </button>
        ))}
      </div>

      <div className="sc-tray">
        <span className="sc-tray-icon"><img src="/icons/taskbar-wifi.svg" alt="" draggable={false} /></span>
        <span className="sc-tray-icon"><img src="/icons/taskbar-volume.svg" alt="" draggable={false} /></span>
        <span className="sc-tray-icon"><img src="/icons/taskbar-battery.svg" alt="" draggable={false} /></span>
        <span className="sc-tray-clock">
          {clock.split('\n').map((line, i) => (
            <span key={i} style={i === 0 ? { fontWeight: 600 } : { fontSize: 11 }}>
              {line}
            </span>
          ))}
        </span>
      </div>
    </div>
  );
}
