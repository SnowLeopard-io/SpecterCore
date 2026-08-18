import type { DesktopAppInfo } from '@bk/contracts';

interface StartMenuProps {
  open: boolean;
  apps: DesktopAppInfo[];
  onLaunch: (appId: string) => void;
  onShutdown: () => void;
}

const SearchIcon = (
  <svg viewBox="0 0 20 20" aria-hidden>
    <circle cx="8.5" cy="8.5" r="6" fill="none" stroke="currentColor" strokeWidth="2" />
    <line x1="13" y1="13" x2="17.5" y2="17.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
);

const PowerIcon = (
  <svg viewBox="0 0 20 20" aria-hidden>
    <path d="M10 2.5v7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    <path
      d="M5.5 6.5a6.5 6.5 0 1 0 9 0"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    />
  </svg>
);

/** Start menu (Windows 11 style): centered acrylic panel with pinned app grid. */
export function StartMenu({ open, apps, onLaunch, onShutdown }: StartMenuProps) {
  if (!open) return null;
  return (
    <div className="bk-start-menu">
      <div className="bk-start-search">
        {SearchIcon}
        <span>Search for apps, settings and documents</span>
      </div>

      <div className="bk-start-section-title">Pinned</div>
      <div className="bk-start-grid">
        {apps.map((app) => (
          <button key={app.appId} className="bk-start-tile" onClick={() => onLaunch(app.appId)} title={app.description}>
            <span className="bk-start-tile-icon">{app.icon}</span>
            <span className="bk-start-tile-label">{app.name}</span>
          </button>
        ))}
      </div>

      <div className="bk-start-footer">
        <button className="bk-start-user">
          <span className="bk-start-avatar">BK</span>
          <span>Browser Kernel</span>
        </button>
        <button className="bk-start-power" aria-label="Shut down" onClick={onShutdown}>
          {PowerIcon}
        </button>
      </div>
    </div>
  );
}
