import { useEffect, useState } from 'react';
import type { SystemInfo } from '@specter-core/contracts';
import { useUi } from '../context';

function fmtBytes(bytes: number): string {
  if (bytes >= 1 << 30) return `${(bytes / (1 << 30)).toFixed(2)} GB`;
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(2)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function fmtUptime(ts: number): string {
  if (!ts) return '—';
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sec % 60}s`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m`;
}

type Section = 'home' | 'system' | 'storage' | 'processes';

interface NavItem {
  id: Section;
  label: string;
  icon: string;
}

const NAV_ITEMS: NavItem[] = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'system', label: 'System', icon: 'system' },
  { id: 'storage', label: 'Storage', icon: 'storage' },
  { id: 'processes', label: 'Processes', icon: 'processes' },
];

function NavIcon({ name }: { name: string }) {
  switch (name) {
    case 'home':
      return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 11 L12 4 L21 11 V20 a1 1 0 0 1 -1 1 H15 V14 H9 V21 H4 a1 1 0 0 1 -1 -1 Z" />
        </svg>
      );
    case 'system':
      return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="4" width="18" height="13" rx="1.5" />
          <path d="M8 21 H16 M12 17 V21" />
        </svg>
      );
    case 'storage':
      return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <path d="M7 9 H17 M7 13 H13" />
          <circle cx="17" cy="13" r="0.8" fill="currentColor" />
        </svg>
      );
    case 'processes':
      return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="6" height="6" rx="1" />
          <rect x="15" y="3" width="6" height="6" rx="1" />
          <rect x="3" y="15" width="6" height="6" rx="1" />
          <rect x="15" y="15" width="6" height="6" rx="1" />
        </svg>
      );
    default:
      return null;
  }
}

/** System information app styled after Windows 11 Settings. */
export function SystemInfoApp() {
  const { controller } = useUi();
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [section, setSection] = useState<Section>('home');

  useEffect(() => {
    let active = true;
    void controller.getSystemInfo().then((value) => {
      if (active) setInfo(value);
    });
    return () => {
      active = false;
    };
  }, [controller]);

  if (!info) {
    return <div className="sc-app-body sc-sysinfo">Loading…</div>;
  }

  const diskPct = info.diskCapacity > 0 ? Math.round((info.diskUsed / info.diskCapacity) * 100) : 0;

  return (
    <div className="sc-settings">
      <aside className="sc-settings-nav">
        <div className="sc-settings-nav-user">
          <img className="sc-settings-avatar" src="avatar.png" alt="Avatar" />
          <div className="sc-settings-nav-user-info">
            <span className="sc-settings-nav-user-name">SpecterCore</span>
            <span className="sc-settings-nav-user-sub">Virtual Desktop Environment</span>
          </div>
        </div>
        <nav className="sc-settings-nav-list">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              className={`sc-settings-nav-item ${section === item.id ? 'active' : ''}`}
              onClick={() => setSection(item.id)}
            >
              <span className="sc-settings-nav-icon"><NavIcon name={item.icon} /></span>
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
      </aside>

      <main className="sc-settings-main">
        {section === 'home' && (
          <>
            <div className="sc-settings-device-card">
              <img className="sc-settings-device-thumb" src="wallpaper.jpg" alt="" />
              <div className="sc-settings-device-info">
                <span className="sc-settings-device-name">SpecterCore</span>
                <span className="sc-settings-device-model">Virtual x86 Compatibility Layer</span>
              </div>
              <div className="sc-settings-device-status">
                <div className="sc-settings-status-item">
                  <span className="sc-settings-status-dot ok" />
                  <span>{info.processCount} processes running</span>
                </div>
                <div className="sc-settings-status-item">
                  <span className="sc-settings-status-dot ok" />
                  <span>Disk {diskPct}% used</span>
                </div>
              </div>
            </div>

            <div className="sc-settings-section">
              <h2 className="sc-settings-section-title">Recommended</h2>
              <button className="sc-settings-row" onClick={() => setSection('system')}>
                <span className="sc-settings-row-icon"><NavIcon name="system" /></span>
                <span className="sc-settings-row-text">System Info</span>
                <span className="sc-settings-row-chevron">›</span>
              </button>
              <button className="sc-settings-row" onClick={() => setSection('storage')}>
                <span className="sc-settings-row-icon"><NavIcon name="storage" /></span>
                <span className="sc-settings-row-text">Storage</span>
                <span className="sc-settings-row-chevron">›</span>
              </button>
              <button className="sc-settings-row" onClick={() => setSection('processes')}>
                <span className="sc-settings-row-icon"><NavIcon name="processes" /></span>
                <span className="sc-settings-row-text">Processes</span>
                <span className="sc-settings-row-chevron">›</span>
              </button>
            </div>
          </>
        )}

        {section === 'system' && (
          <>
            <h1 className="sc-settings-h1">System</h1>
            <div className="sc-settings-cards">
              <div className="sc-settings-card">
                <span className="sc-settings-card-label">Kernel Version</span>
                <span className="sc-settings-card-value">{info.version}</span>
              </div>
              <div className="sc-settings-card">
                <span className="sc-settings-card-label">Running Processes</span>
                <span className="sc-settings-card-value">{info.processCount}</span>
              </div>
              <div className="sc-settings-card">
                <span className="sc-settings-card-label">Disk Usage</span>
                <span className="sc-settings-card-value">{fmtBytes(info.diskUsed)} / {fmtBytes(info.diskCapacity)}</span>
              </div>
            </div>
            {info.capabilities.length > 0 && (
              <div className="sc-settings-section">
                <h2 className="sc-settings-section-title">Capabilities</h2>
                <div className="sc-settings-caps">
                  {info.capabilities.map((cap) => (
                    <span key={cap} className="sc-settings-cap">{cap}</span>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {section === 'storage' && (
          <>
            <h1 className="sc-settings-h1">Storage</h1>
            <div className="sc-settings-storage-card">
              <div className="sc-settings-storage-header">
                <span className="sc-settings-storage-title">Virtual Disk</span>
                <span className="sc-settings-storage-sub">{fmtBytes(info.diskUsed)} used / {fmtBytes(info.diskCapacity)} total</span>
              </div>
              <div className="sc-settings-storage-bar">
                <div className="sc-settings-storage-fill" style={{ width: `${diskPct}%` }} />
              </div>
              <div className="sc-settings-storage-meta">
                <span>{diskPct}% used</span>
                <span>{fmtBytes(info.diskCapacity - info.diskUsed)} available</span>
              </div>
            </div>
          </>
        )}

        {section === 'processes' && (
          <>
            <h1 className="sc-settings-h1">Processes <span className="sc-settings-h1-count">{info.processes.length}</span></h1>
            <div className="sc-settings-proc-list">
              <div className="sc-settings-proc-head">
                <span>Name</span>
                <span>PID</span>
                <span>State</span>
                <span>Threads</span>
                <span>Memory</span>
                <span>Uptime</span>
              </div>
              {info.processes.map((p) => (
                <div key={p.pid} className="sc-settings-proc-row">
                  <span className="sc-settings-proc-name">{p.name}</span>
                  <span className="sc-settings-proc-pid">{p.pid}</span>
                  <span className={`sc-settings-proc-state ${p.state}`}>{p.state}</span>
                  <span>{p.threadCount}</span>
                  <span>{fmtBytes(p.memoryBytes)}</span>
                  <span className="sc-settings-proc-time">{fmtUptime(p.startTime)}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
