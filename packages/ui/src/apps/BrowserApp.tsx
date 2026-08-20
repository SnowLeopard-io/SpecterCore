import { useCallback, useEffect, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { useUi } from '../context';

const DEFAULT_TABS: TabState[] = [
  { id: 'tab-1', title: 'New Tab', url: '', loading: false, history: [], hIndex: -1 },
];
const DEFAULT_ACTIVE = 'tab-1';

interface TabState {
  id: string;
  title: string;
  url: string;
  loading: boolean;
  history: string[];
  hIndex: number;
}

function prettyTitle(url: string): string {
  try {
    const h = new URL(url).hostname;
    return h.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (/^[\w-]+:\/\//.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function I({
  children,
  size = 16,
  className,
}: {
  children: ReactNode;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

const TabCloseIcon = (
  <I size={12}>
    <path d="M4 4 L12 12 M12 4 L4 12" />
  </I>
);

const BackIcon = (
  <I>
    <path d="M9.5 3.5 L5 8 l4.5 4.5" />
  </I>
);

const ForwardIcon = (
  <I>
    <path d="M6.5 3.5 L11 8 l-4.5 4.5" />
  </I>
);

const ReloadIcon = (
  <I>
    <path d="M13.5 8 a5.5 5.5 0 1 1 -1.6 -3.9 M13.5 2.5 v2.6 H10.9" />
  </I>
);

const GoIcon = (
  <I>
    <path d="M3 8 h9 M9 4.5 L12.5 8 9 11.5" />
  </I>
);

const ExternalIcon = (
  <I>
    <path d="M6 3.5 H3.5 V12.5 H12.5 V10" />
    <path d="M8.5 3.5 H12.5 V7.5" />
    <path d="M12.5 3.5 L8 8" />
  </I>
);

const NewTabIcon = (
  <I size={14}>
    <path d="M3 3 H13 V13 H3 Z" transform="scale(1.05) translate(-0.4 -0.4)" />
    <path d="M8 6.2 V9.8 M6.2 8 H9.8" />
  </I>
);

const LockIcon = (
  <I size={12}>
    <rect x="4.5" y="7" width="7" height="5" rx="1" />
    <path d="M6 7 V5.6 a2 2 0 0 1 4 0 V7" />
  </I>
);

const FileGlyph = () => (
  <svg viewBox="0 0 20 20" width="20" height="20" fill="none" aria-hidden>
    <path d="M5 4 a1.2 1.2 0 0 1 1.2-1.2 H12 L15 5.8 V16 a1.2 1.2 0 0 1-1.2 1.2 H6.2 A1.2 1.2 0 0 1 5 16 Z" fill="#e7edf5" />
    <path d="M12 2.8 V5.8 H15" fill="#c7d4e4" />
  </svg>
);

let tabSeq = 1;

export function BrowserApp() {
  const { controller } = useUi();

  const [tabs, setTabs] = useState<TabState[]>(DEFAULT_TABS);
  const [activeId, setActiveId] = useState(DEFAULT_ACTIVE);
  const [address, setAddress] = useState('');
  const [iframeKey, setIframeKey] = useState(0);

  const active = tabs.find((t) => t.id === activeId) ?? tabs[0]!;

  useEffect(() => {
    setAddress(active.url);
  }, [active.url]);

  useEffect(() => {
    const wm = controller.windowManager;
    const winId = wm.getAppWindowId?.('browser');
    if (!winId) return;
    const title = active.url ? `Browser — ${active.title}` : 'Browser';
    if (typeof wm.setTitle === 'function') {
      wm.setTitle(winId, title);
    }
  }, [active.title, active.url]);

  const goto = useCallback(
    (raw: string, opts: { push?: boolean } = {}): void => {
      const url = normalizeUrl(raw);
      const { push = true } = opts;
      setTabs((prev) =>
        prev.map((t) => {
          if (t.id !== activeId) return t;
          const isDup = t.url === url;
          const history = push
            ? isDup
              ? t.history
              : [...t.history.slice(0, t.hIndex + 1), url]
            : t.history;
          const hIndex = push ? (isDup ? t.hIndex : t.history.length) : t.hIndex;
          return { ...t, url, loading: true, history, hIndex, title: prettyTitle(url) };
        }),
      );
      setAddress(url);
      setIframeKey((k) => k + 1);
    },
    [activeId],
  );

  const goBack = (): void => {
    const t = active;
    if (t.hIndex <= 0) return;
    const target = t.history[t.hIndex - 1] ?? '';
    setTabs((prev) =>
      prev.map((x) => (x.id === t.id ? { ...x, url: target, title: prettyTitle(target), hIndex: x.hIndex - 1, loading: true } : x)),
    );
    setAddress(target);
    setIframeKey((k) => k + 1);
  };

  const goForward = (): void => {
    const t = active;
    if (t.hIndex >= t.history.length - 1) return;
    const target = t.history[t.hIndex + 1];
    if (!target) return;
    setTabs((prev) =>
      prev.map((x) => (x.id === t.id ? { ...x, url: target, title: prettyTitle(target), hIndex: x.hIndex + 1, loading: true } : x)),
    );
    setAddress(target);
    setIframeKey((k) => k + 1);
  };

  const canBack = active.hIndex > 0;
  const canForward = active.hIndex < active.history.length - 1;

  const reload = (): void => {
    if (!active.url) return;
    setIframeKey((k) => k + 1);
  };

  const openNewTab = (url = ''): void => {
    const id = `tab-${++tabSeq}`;
    setTabs((prev) => [...prev, { id, title: 'New Tab', url: '', loading: false, history: [], hIndex: -1 }]);
    setActiveId(id);
    if (url) goto(url);
    setAddress('');
    setIframeKey((k) => k + 1);
  };

  const closeTab = (id: string): void => {
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== id);
      if (next.length === 0) {
        const fresh: TabState[] = [
          { id: `tab-${++tabSeq}`, title: 'New Tab', url: '', loading: false, history: [], hIndex: -1 },
        ];
        setActiveId(fresh[0]!.id);
        setAddress('');
        return fresh;
      }
      if (activeId === id) {
        const idx = prev.findIndex((t) => t.id === id);
        const fallback = next[Math.min(idx, next.length - 1)]!;
        setActiveId(fallback.id);
        setAddress(fallback.url);
      }
      return next;
    });
  };

  const onAddressKey = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') goto(address);
  };

  const openExternal = (): void => {
    const url = normalizeUrl(address || active.url);
    if (!url) return;
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  return (
    <div className="sc-browser">
      <div className="sc-browser-tabs">
        {tabs.map((t) => (
          <span
            key={t.id}
            className={`sc-browser-tab ${t.id === activeId ? 'active' : ''}`}
            onClick={() => {
              setActiveId(t.id);
              setAddress(t.url);
            }}
          >
            <FileGlyph />
            <span className="sc-browser-tab-title">{t.title || 'New Tab'}</span>
            {t.loading && <span className="sc-browser-tab-spinner" />}
            <button
              className="sc-browser-tab-close"
              aria-label="Close tab"
              onClick={(e) => {
                e.stopPropagation();
                closeTab(t.id);
              }}
            >
              {TabCloseIcon}
            </button>
          </span>
        ))}
        <button className="sc-browser-tab-new" aria-label="New tab" onClick={() => openNewTab()}>
          {NewTabIcon}
        </button>
      </div>

      <div className="sc-browser-toolbar">
        <div className="sc-browser-nav">
          <button className="sc-browser-btn" aria-label="Back" disabled={!canBack} onClick={goBack}>
            {BackIcon}
          </button>
          <button className="sc-browser-btn" aria-label="Forward" disabled={!canForward} onClick={goForward}>
            {ForwardIcon}
          </button>
          <button className="sc-browser-btn" aria-label="Reload" onClick={reload}>
            {ReloadIcon}
          </button>
        </div>

        <div className="sc-browser-address">
          <span className="sc-browser-address-icon">
            {address.startsWith('https://') ? LockIcon : GoIcon}
          </span>
          <input
            className="sc-browser-address-input"
            value={address}
            placeholder="Search or enter a URL"
            spellCheck={false}
            onChange={(e) => setAddress(e.target.value)}
            onKeyDown={onAddressKey}
          />
          <button className="sc-browser-btn sc-browser-address-go" aria-label="Go" onClick={() => goto(address)}>
            {GoIcon}
          </button>
        </div>

        <div className="sc-browser-actions">
          <button
            className={`sc-browser-btn sc-browser-external ${!active.url && !address ? 'disabled' : ''}`}
            aria-label="Open in new tab"
            title="Open in a real tab (bypasses sites that block iframing)"
            onClick={openExternal}
          >
            {ExternalIcon}
          </button>
        </div>
      </div>

      <div className="sc-browser-stage">
        {active.url ? (
          <iframe
            key={`${active.id}-${iframeKey}`}
            className="sc-browser-frame"
            src={active.url}
            title={active.title}
            ref={(el) => {
              if (!el) return;
              const handler = () => {
                try {
                  const docTitle = el.contentDocument?.title;
                  if (docTitle && docTitle.trim()) {
                    setTabs((prev) =>
                      prev.map((x) => (x.id === active.id ? { ...x, loading: false, title: docTitle.trim() } : x)),
                    );
                  } else {
                    setTabs((prev) =>
                      prev.map((x) => (x.id === active.id ? { ...x, loading: false, title: prettyTitle(x.url) } : x)),
                    );
                  }
                } catch {
                  setTabs((prev) =>
                    prev.map((x) => (x.id === active.id ? { ...x, loading: false, title: prettyTitle(x.url) } : x)),
                  );
                }
              };
              el.addEventListener('load', handler);
              return () => { el.removeEventListener('load', handler); };
            }}
          />
        ) : (
          <div className="sc-browser-empty">
            <div className="sc-browser-empty-globe">
              <svg viewBox="0 0 64 64" aria-hidden>
                <defs>
                  <linearGradient id="sc-browser-globe" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0" stopColor="#6ec1ff" />
                    <stop offset="1" stopColor="#1f6fd6" />
                  </linearGradient>
                </defs>
                <circle cx="32" cy="32" r="26" fill="url(#sc-browser-globe)" />
                <ellipse cx="32" cy="32" rx="11" ry="26" fill="none" stroke="#fff" strokeWidth="2.6" opacity="0.92" />
                <path d="M6 32 H58" stroke="#fff" strokeWidth="2.6" opacity="0.92" />
                <path d="M32 6 a18 19 0 0 1 13 9 M32 58 a18 19 0 0 1-13-9" fill="none" stroke="#fff" strokeWidth="2" opacity="0.55" />
              </svg>
            </div>
            <div className="sc-browser-empty-title">SpecterCore Browser</div>
            <div className="sc-browser-empty-sub">Browse the web.</div>
            <div className="sc-browser-empty-input">
              {address.startsWith('https://') ? LockIcon : GoIcon}
              <input
                autoFocus
                value={address}
                placeholder="Search or enter a URL"
                onChange={(e) => setAddress(e.target.value)}
                onKeyDown={onAddressKey}
              />
              <button className="sc-browser-empty-go" onClick={() => goto(address)}>{GoIcon} Go</button>
            </div>
            <div className="sc-browser-empty-dl">
              <button className="sc-browser-empty-dl-external" onClick={openExternal}>
                {ExternalIcon} Open in a new tab
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
