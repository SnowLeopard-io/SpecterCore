import { useEffect, useState } from 'react';
import type { WindowHandle } from '@specter-core/contracts';
import { useUi } from '../context';
import { AppIcon } from '../AppIcon';

interface TaskbarProps {
  windows: WindowHandle[];
  openStart: boolean;
  onToggleStart: () => void;
}

const WindowsLogo = (
  <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden>
    <rect x="1.5" y="1.5" width="7.5" height="7.5" rx="1.2" fill="currentColor" />
    <rect x="11" y="1.5" width="7.5" height="7.5" rx="1.2" fill="currentColor" />
    <rect x="1.5" y="11" width="7.5" height="7.5" rx="1.2" fill="currentColor" />
    <rect x="11" y="11" width="7.5" height="7.5" rx="1.2" fill="currentColor" />
  </svg>
);

const SearchIcon = (
  <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden>
    <circle cx="8.5" cy="8.5" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
    <line x1="12.5" y1="12.5" x2="17" y2="17" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
);

const WifiIcon = (
  <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden>
    <path d="M10 14a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z" fill="currentColor" />
    <path d="M5.5 9.5a6.5 6.5 0 0 1 9 0" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    <path d="M2.5 6a10 10 0 0 1 15 0" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);

const VolumeIcon = (
  <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden>
    <path d="M3 7.5h3l3-3v11l-3-3H3z" fill="currentColor" />
    <path d="M12 6.5a4.5 4.5 0 0 1 0 7M14 4a7.5 7.5 0 0 1 0 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);

const BatteryIcon = (
  <svg viewBox="0 0 22 20" aria-hidden>
    <rect x="1.5" y="6" width="16" height="8" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
    <rect x="3" y="8" width="10" height="4" rx="0.8" fill="currentColor" />
    <rect x="18.5" y="8.5" width="2.5" height="3" rx="0.8" fill="currentColor" />
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
    <div className="sc-taskbar">
      <div className="sc-taskbar-cluster">
        <button
          className={`sc-task-btn start ${openStart ? 'open' : ''}`}
          aria-label="Start"
          onClick={onToggleStart}
        >
          {WindowsLogo}
        </button>
        <button className="sc-task-btn" aria-label="Search">
          {SearchIcon}
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
        <span className="sc-tray-icon">{WifiIcon}</span>
        <span className="sc-tray-icon">{VolumeIcon}</span>
        <span className="sc-tray-icon">{BatteryIcon}</span>
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
