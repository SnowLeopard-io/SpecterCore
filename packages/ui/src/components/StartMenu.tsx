import type { DesktopAppInfo } from '@specter-core/contracts';

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
    <div className="sc-start-menu">
      <div className="sc-start-search">
        {SearchIcon}
        <span>Search for apps, settings and documents</span>
      </div>

      <div className="sc-start-section-title">Pinned</div>
      <div className="sc-start-grid">
        {apps.map((app) => (
          <button key={app.appId} className="sc-start-tile" onClick={() => onLaunch(app.appId)} title={app.description}>
            <span className="sc-start-tile-icon">{app.icon}</span>
            <span className="sc-start-tile-label">{app.name}</span>
          </button>
        ))}
      </div>

      <div className="sc-start-footer">
        <button className="sc-start-user">
          <span className="sc-start-avatar">BK</span>
          <span>SpecterCore</span>
        </button>
        <button className="sc-start-power" aria-label="Shut down" onClick={onShutdown}>
          {PowerIcon}
        </button>
      </div>
    </div>
  );
}
