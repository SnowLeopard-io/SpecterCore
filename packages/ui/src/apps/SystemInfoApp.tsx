import { useEffect, useState } from 'react';
import type { FileStore, SystemInfo } from '@specter-core/contracts';
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

type Section = 'home' | 'system' | 'storage' | 'processes' | 'cleanup';

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
  { id: 'cleanup', label: 'Disk Cleanup', icon: 'cleanup' },
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
    case 'cleanup':
      return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 6 H9 A3 3 0 0 1 15 6 H21" />
          <path d="M19 6 V19 a2 2 0 0 1 -2 2 H7 a2 2 0 0 1 -2 -2 V6" />
          <path d="M10 11 v6 M14 11 v6" />
        </svg>
      );
    default:
      return null;
  }
}

const ZIP_FLAG_UTF8 = 0x0800;

let crcTable: Uint32Array | null = null;
function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  crcTable = t;
  return t;
}
function crc32(data: Uint8Array): number {
  const t = getCrcTable();
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = (t[(c ^ (data[i] ?? 0)) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Build a minimal, uncompressed (STORE) ZIP archive in memory. */
function buildZipBlob(files: { path: string; data: Uint8Array }[]): Blob {
  const enc = new TextEncoder();
  const parts: BlobPart[] = [];
  const central: { offset: number; path: string; crc: number; size: number }[] = [];
  let offset = 0;

  for (const f of files) {
    const name = enc.encode(f.path);
    const crc = crc32(f.data);
    const size = f.data.length;
    const lh = new Uint8Array(30 + name.length);
    const dv = new DataView(lh.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, ZIP_FLAG_UTF8, true);
    dv.setUint16(8, 0, true); // STORE
    dv.setUint32(14, crc, true);
    dv.setUint32(18, size, true);
    dv.setUint32(22, size, true);
    dv.setUint16(26, name.length, true);
    lh.set(name, 30);
    parts.push(lh as BlobPart, f.data as BlobPart);
    central.push({ offset, path: f.path, crc, size });
    offset += 30 + name.length + size;
  }

  const cdStart = offset;
  let cdSize = 0;
  for (const c of central) {
    const name = enc.encode(c.path);
    const cd = new Uint8Array(46 + name.length);
    const dv = new DataView(cd.buffer);
    dv.setUint32(0, 0x02014b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 20, true);
    dv.setUint16(8, ZIP_FLAG_UTF8, true);
    dv.setUint16(10, 0, true);
    dv.setUint32(16, c.crc, true);
    dv.setUint32(20, c.size, true);
    dv.setUint32(24, c.size, true);
    dv.setUint16(28, name.length, true);
    dv.setUint32(42, c.offset, true);
    cd.set(name, 46);
    parts.push(cd);
    cdSize += 46 + name.length;
  }

  const eocd = new Uint8Array(22);
  const edv = new DataView(eocd.buffer);
  edv.setUint32(0, 0x06054b50, true);
  edv.setUint16(8, central.length, true);
  edv.setUint16(10, central.length, true);
  edv.setUint32(12, cdSize, true);
  edv.setUint32(16, cdStart, true);
  parts.push(eocd);

  return new Blob(parts, { type: 'application/zip' });
}

/** Recursively read the entire virtual disk into an in-memory file list. */
async function collectFiles(fs: FileStore, dir: string): Promise<{ path: string; data: Uint8Array }[]> {
  const out: { path: string; data: Uint8Array }[] = [];
  const entries = await fs.listDirectory(dir);
  for (const e of entries) {
    const full = dir === '/' ? e.name : `${dir}/${e.name}`;
    if (e.kind === 'directory') {
      out.push(...(await collectFiles(fs, full)));
    } else if (e.kind === 'file') {
      const h = await fs.openFile(full, 'read');
      try {
        const size = await h.size();
        const data = await h.read(0, size);
        out.push({ path: full, data });
      } finally {
        await h.close();
      }
    }
  }
  return out;
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

/** System information app styled after Windows 11 Settings. */
export function SystemInfoApp() {
  const { controller } = useUi();
  const fs = controller.getFileSystem() as FileStore | null;
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [section, setSection] = useState<Section>('home');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmingWipe, setConfirmingWipe] = useState(false);

  const doBackup = async (): Promise<void> => {
    if (!fs) return;
    setBusy(true);
    setNote(null);
    try {
      const files = await collectFiles(fs, '/');
      const blob = buildZipBlob(files);
      triggerDownload(blob, `spectercore-backup-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.zip`);
      setNote({ ok: true, text: `Backup saved: ${files.length} files, ${fmtBytes(blob.size)}.` });
    } catch (err) {
      setNote({ ok: false, text: `Backup failed: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setBusy(false);
    }
  };

  const doWipe = async (): Promise<void> => {
    if (!fs) return;
    setBusy(true);
    setNote(null);
    try {
      await fs.format();
      // 全套清理干净后重新开机：硬刷新触发完整 bootstrap，磁盘从零重建，
      // 系统文件重新从 web 装载，UI/应用状态全部回到初始状态。
      window.location.reload();
    } catch (err) {
      setNote({ ok: false, text: `Failed to clear disk: ${err instanceof Error ? err.message : String(err)}` });
      setBusy(false);
    }
  };

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
      {section === 'cleanup' && (
          <>
            <h1 className="sc-settings-h1">Disk Cleanup</h1>
            <div className="sc-cleanup-warn">
              <span className="sc-cleanup-warn-icon">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 9 V15 M12 17.2 V17" />
                  <path d="M10.3 4.2 L2.6 17 a2 2 0 0 0 1.7 3 H19.7 a2 2 0 0 0 1.7-3 L13.7 4.2 a2 2 0 0 0 -3.4 0 Z" />
                </svg>
              </span>
              <div className="sc-cleanup-warn-text">
                <strong>Warning</strong>
                <p>Clearing the disk permanently removes <b>all</b> data on the virtual disk — your files in <code>Users/…</code>, the bundled Windows system files, and every installed application. This cannot be undone. Consider a backup before proceeding.</p>
              </div>
            </div>

            <div className="sc-settings-section">
              <h2 className="sc-settings-section-title">Data backup</h2>
              <div className="sc-cleanup-card">
                <div className="sc-cleanup-card-info">
                  <span className="sc-cleanup-card-label">Download a ZIP of the whole virtual disk</span>
                  <span className="sc-cleanup-card-sub">Creates <code>spectercore-backup-*.zip</code> with every file, safe &amp; reversible.</span>
                </div>
                <button className="sc-cleanup-btn-backup" onClick={() => void doBackup()} disabled={busy || !fs}>
                  {busy ? 'Packing…' : 'Download backup'}
                </button>
              </div>
            </div>

            <div className="sc-settings-section">
              <h2 className="sc-settings-section-title">Erase everything</h2>
              <div className="sc-cleanup-card danger">
                <div className="sc-cleanup-card-info">
                  <span className="sc-cleanup-card-label">Clear the entire virtual disk</span>
                  <span className="sc-cleanup-card-sub">Removes all files and restores the disk to its pristine state.</span>
                </div>
                <button
                  className={`sc-cleanup-btn-wipe ${confirmingWipe ? 'confirm' : ''}`}
                  onClick={() => {
                    if (!confirmingWipe) {
                      setConfirmingWipe(true);
                    } else {
                      void doWipe();
                    }
                  }}
                  disabled={busy || !fs}
                >
                  {confirmingWipe ? 'Click again to confirm' : 'Clear disk'}
                </button>
              </div>
              {confirmingWipe && (
                <div className="sc-cleanup-confirm-hint">Tap &ldquo;Clear disk&rdquo; once more to permanently erase all data.</div>
              )}
            </div>

            {note && <div className={`sc-cleanup-note ${note.ok ? 'ok' : 'fail'}`}>{note.text}</div>}
          </>
        )}
      </main>
    </div>
  );
}
