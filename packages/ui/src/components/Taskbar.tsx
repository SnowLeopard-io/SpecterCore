import { useEffect, useState } from 'react';
import type { WindowHandle } from '@bk/contracts';
import { useUi } from '../context';

interface TaskbarProps {
  windows: WindowHandle[];
  openStart: boolean;
  onToggleStart: () => void;
}

const WindowsLogo = (
  <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden>
    <rect x="1.5" y="1.5" width="7.5" height="7.5" rx="1" fill="currentColor" />
    <rect x="11" y="1.5" width="7.5" height="7.5" rx="1" fill="currentColor" />
    <rect x="1.5" y="11" width="7.5" height="7.5" rx="1" fill="currentColor" />
    <rect x="11" y="11" width="7.5" height="7.5" rx="1" fill="currentColor" />
  </svg>
);

const SearchIcon = (
  <svg viewBox="0 0 20 20" aria-hidden>
    <circle cx="8.5" cy="8.5" r="6" fill="none" stroke="currentColor" strokeWidth="2" />
    <line x1="13" y1="13" x2="17.5" y2="17.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
);

const WifiIcon = (
  <svg viewBox="0 0 20 20" aria-hidden>
    <path d="M10 14.5a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 0 0 0-3.2z" fill="currentColor" />
    <path
      d="M5.5 10.2a6.5 6.5 0 0 1 9 0M3 7.4a10 10 0 0 1 14 0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
    />
  </svg>
);

const VolumeIcon = (
  <svg viewBox="0 0 20 20" aria-hidden>
    <path d="M3 8h3l3-3v10l-3-3H3z" fill="currentColor" />
    <path d="M12 7a4 4 0 0 1 0 6M14 5a7 7 0 0 1 0 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);

const BatteryIcon = (
  <svg viewBox="0 0 22 20" aria-hidden>
    <rect x="1.5" y="6.5" width="16" height="7" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
    <rect x="3" y="8.5" width="10" height="3" rx="0.8" fill="currentColor" />
    <rect x="18.5" y="9" width="2" height="2" rx="1" fill="currentColor" />
  </svg>
);

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
    <div className="bk-taskbar">
      <div className="bk-taskbar-cluster">
        <button
          className={`bk-task-btn start ${openStart ? 'open' : ''}`}
          aria-label="Start"
          onClick={onToggleStart}
        >
          {WindowsLogo}
        </button>
        <button className="bk-task-btn" aria-label="Search">
          {SearchIcon}
        </button>
        <span className="bk-task-sep" />
        {windows.map((win) => (
          <button
            key={win.id}
            className={`bk-task-btn ${win.state !== 'minimized' ? 'active' : ''}`}
            aria-label={win.title}
            title={win.title}
            onClick={() => focusOrRestore(win)}
          >
            <span>{win.options.icon ?? '▣'}</span>
          </button>
        ))}
      </div>

      <div className="bk-tray">
        <span className="bk-tray-icon">{WifiIcon}</span>
        <span className="bk-tray-icon">{VolumeIcon}</span>
        <span className="bk-tray-icon">{BatteryIcon}</span>
        <span className="bk-tray-clock">
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
