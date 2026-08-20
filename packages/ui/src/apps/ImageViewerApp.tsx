import { useCallback, useEffect, useRef, useState } from 'react';
import { useUi } from '../context';

interface ImageViewerProps {
  initialFile?: string;
}

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico']);

function parentOf(storePath: string): string {
  const segs = storePath.split('/').filter(Boolean);
  segs.pop();
  return segs.join('/');
}

function basenameOf(storePath: string): string {
  const segs = storePath.split('/').filter(Boolean);
  return segs[segs.length - 1] ?? storePath;
}

interface ImageMeta {
  width: number;
  height: number;
  size: number;
}

function ToolbarIcon({ name }: { name: string }) {
  const props = {
    width: 18,
    height: 18,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  switch (name) {
    case 'edit':
      return (
        <svg {...props} viewBox="0 0 24 24">
          <path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
        </svg>
      );
    case 'search':
      return (
        <svg {...props} viewBox="0 0 24 24">
          <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
        </svg>
      );
    case 'trash':
      return (
        <svg {...props} viewBox="0 0 24 24">
          <path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
        </svg>
      );
    case 'print':
      return (
        <svg {...props} viewBox="0 0 24 24">
          <path d="M6 9V2h12v7" /><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" /><path d="M6 14h12v8H6z" />
        </svg>
      );
    case 'share':
      return (
        <svg {...props} viewBox="0 0 24 24">
          <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" /><path d="m16 6-4-4-4 4" /><path d="M12 2v13" />
        </svg>
      );
    case 'crop':
      return (
        <svg {...props} viewBox="0 0 24 24">
          <path d="M6 2v14a2 2 0 0 0 2 2h14" /><path d="M18 22V8a2 2 0 0 0-2-2H2" />
        </svg>
      );
    case 'more':
      return (
        <svg {...props} viewBox="0 0 24 24">
          <circle cx="5" cy="12" r="1" fill="currentColor" /><circle cx="12" cy="12" r="1" fill="currentColor" /><circle cx="19" cy="12" r="1" fill="currentColor" />
        </svg>
      );
    case 'grid':
      return (
        <svg {...props} viewBox="0 0 24 24">
          <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
        </svg>
      );
    case 'heart':
      return (
        <svg {...props} viewBox="0 0 24 24">
          <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 0 0 0-7.78z" />
        </svg>
      );
    case 'info':
      return (
        <svg {...props} viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="10" /><path d="M12 16v-4" /><path d="M12 8h.01" />
        </svg>
      );
    case 'rotate-left':
      return (
        <svg {...props} viewBox="0 0 24 24">
          <path d="M3 12a9 9 0 1 0 9-9" /><path d="M3 4v5h5" />
        </svg>
      );
    case 'rotate-right':
      return (
        <svg {...props} viewBox="0 0 24 24">
          <path d="M21 12a9 9 0 1 1-9-9" /><path d="M21 4v5h-5" />
        </svg>
      );
    case 'zoom-actual':
      return (
        <svg {...props} viewBox="0 0 24 24">
          <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" /><path d="M11 8v6M8 11h6" />
        </svg>
      );
    case 'zoom-out':
      return (
        <svg {...props} viewBox="0 0 24 24">
          <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" /><path d="M8 11h6" />
        </svg>
      );
    case 'zoom-in':
      return (
        <svg {...props} viewBox="0 0 24 24">
          <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" /><path d="M11 8v6M8 11h6" />
        </svg>
      );
    case 'fullscreen':
      return (
        <svg {...props} viewBox="0 0 24 24">
          <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3m13-5v3a2 2 0 0 1-2 2h-3" />
        </svg>
      );
    case 'chevron-left':
      return (
        <svg {...props} viewBox="0 0 24 24">
          <path d="m15 18-6-6 6-6" />
        </svg>
      );
    case 'chevron-right':
      return (
        <svg {...props} viewBox="0 0 24 24">
          <path d="m9 18 6-6-6-6" />
        </svg>
      );
    default:
      return null;
  }
}

function fmtSize(bytes: number): string {
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(1)} MB`;
  if (bytes >= 1 << 10) return `${(bytes / (1 << 10)).toFixed(1)} KB`;
  return `${bytes} B`;
}

/** Image Viewer styled after modern Windows 11 Photos app. */
export function ImageViewerApp({ initialFile }: ImageViewerProps) {
  const { controller } = useUi();
  const fs = controller.getFileSystem();

  const [path, setPath] = useState<string | null>(initialFile ?? null);
  const [url, setUrl] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [siblings, setSiblings] = useState<string[]>([]);
  const [index, setIndex] = useState(-1);
  const [meta, setMeta] = useState<ImageMeta | null>(null);
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [panX, setPanX] = useState(0);
  const [panY, setPanY] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [fileSize, setFileSize] = useState(0);
  const urlRef = useRef<string | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(null);

  useEffect(() => {
    return () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
  }, []);

  useEffect(() => {
    if (!path || !fs) return;
    let cancelled = false;
    void (async () => {
      try {
        const file = await fs.openFile(path, 'read');
        let data: Uint8Array;
        let size: number;
        try {
          size = await file.size();
          data = await file.read(0, size);
        } finally {
          await file.close();
        }
        if (cancelled) return;
        const blob = new Blob([data as BlobPart]);
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        urlRef.current = URL.createObjectURL(blob);
        setUrl(urlRef.current);
        setName(basenameOf(path));
        setError(null);
        setFileSize(size);
        setZoom(1);
        setRotation(0);
        setPanX(0);
        setPanY(0);

        const parent = parentOf(path);
        const entries = await fs.listDirectory(parent);
        if (cancelled) return;
        const images = entries
          .filter((e) => e.kind === 'file' && IMAGE_EXTENSIONS.has(e.name.slice(e.name.lastIndexOf('.') + 1).toLowerCase()))
          .map((e) => e.name)
          .sort((a, b) => a.localeCompare(b));
        setSiblings(images);
        setIndex(images.indexOf(basenameOf(path)));
      } catch (err: unknown) {
        if (!cancelled) setError(`Cannot open image: ${String(err)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path, fs]);

  const onImgLoad = useCallback(() => {
    const img = imgRef.current;
    if (img) {
      setMeta({ width: img.naturalWidth, height: img.naturalHeight, size: fileSize });
    }
  }, [fileSize]);

  const step = useCallback(
    (dir: -1 | 1) => {
      if (!path) return;
      const next = siblings[index + dir];
      if (!next) return;
      const parent = parentOf(path);
      setPath(parent === '' ? next : `${parent}/${next}`);
    },
    [path, siblings, index],
  );

  const zoomPct = Math.round(zoom * 100);
  const fitToScreen = useCallback(() => {
    const img = imgRef.current;
    if (!img || !meta) return;
    const container = img.parentElement;
    if (!container) return;
    const cw = container.clientWidth - 32;
    const ch = container.clientHeight - 32;
    const scale = Math.min(cw / meta.width, ch / meta.height, 1);
    setZoom(scale);
    setPanX(0);
    setPanY(0);
  }, [meta]);

  const rotate = useCallback((dir: -1 | 1) => {
    setRotation((r) => (r + dir * 90 + 360) % 360);
  }, []);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startY: e.clientY, baseX: panX, baseY: panY };
    setIsDragging(true);
  }, [panX, panY]);

  useEffect(() => {
    if (!isDragging) return;
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      setPanX(d.baseX + (e.clientX - d.startX));
      setPanY(d.baseY + (e.clientY - d.startY));
    };
    const onUp = () => {
      dragRef.current = null;
      setIsDragging(false);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [isDragging]);

  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      imgRef.current?.parentElement?.requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen?.().catch(() => {});
    }
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') step(-1);
      else if (e.key === 'ArrowRight') step(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step]);

  return (
    <div className="sc-iv">
      {/* Top toolbar */}
      <header className="sc-iv-toolbar">
        <div className="sc-iv-toolbar-center">
          <button className="sc-iv-nav-btn" disabled={index <= 0} onClick={() => step(-1)} title="Previous">
            <ToolbarIcon name="chevron-left" />
          </button>
          <span className="sc-iv-filename">{name}</span>
          <span className="sc-iv-counter">{index >= 0 ? `${index + 1} / ${siblings.length}` : ''}</span>
          <button className="sc-iv-nav-btn" disabled={index < 0 || index >= siblings.length - 1} onClick={() => step(1)} title="Next">
            <ToolbarIcon name="chevron-right" />
          </button>
        </div>
      </header>

      {/* Image stage */}
      <div className="sc-iv-stage">
        {error && <div className="sc-iv-error">{error}</div>}
        {!error && url && (
          <img
            ref={imgRef}
            className="sc-iv-img"
            src={url}
            alt={name}
            draggable={false}
            onLoad={onImgLoad}
            onMouseDown={onMouseDown}
            style={{
              transform: `translate(${panX}px, ${panY}px) scale(${zoom}) rotate(${rotation}deg)`,
              cursor: isDragging ? 'grabbing' : 'grab',
            }}
          />
        )}
        {!error && !url && (
          <div className="sc-iv-empty">
            <ToolbarIcon name="grid" />
            <span>Open an image from the virtual disk</span>
          </div>
        )}
      </div>

      {/* Bottom status bar */}
      <footer className="sc-iv-statusbar">
        <div className="sc-iv-status-meta">
          {meta && <span>{meta.width} × {meta.height}</span>}
          {fileSize > 0 && <span>{fmtSize(fileSize)}</span>}
        </div>

        <div className="sc-iv-status-right">
          <button className="sc-iv-btn" title="Rotate left" onClick={() => rotate(-1)}>
            <ToolbarIcon name="rotate-left" />
          </button>
          <button className="sc-iv-btn" title="Rotate right" onClick={() => rotate(1)}>
            <ToolbarIcon name="rotate-right" />
          </button>
          <button className="sc-iv-btn" title="Actual size" onClick={() => { setZoom(1); setPanX(0); setPanY(0); }}>
            <ToolbarIcon name="zoom-actual" />
          </button>
          <button className="sc-iv-zoom-pct" title="Zoom level" onClick={fitToScreen}>
            {zoomPct}%
          </button>
          <button className="sc-iv-btn" title="Zoom out" onClick={() => setZoom((z) => Math.max(0.1, z - 0.1))}>
            <ToolbarIcon name="zoom-out" />
          </button>
          <input
            className="sc-iv-zoom-slider"
            type="range"
            min="10"
            max="300"
            value={zoomPct}
            onChange={(e) => setZoom(Number(e.target.value) / 100)}
          />
          <button className="sc-iv-btn" title="Zoom in" onClick={() => setZoom((z) => Math.min(3, z + 0.1))}>
            <ToolbarIcon name="zoom-in" />
          </button>
          <button className="sc-iv-btn" title="Fullscreen" onClick={toggleFullscreen}>
            <ToolbarIcon name="fullscreen" />
          </button>
        </div>
      </footer>
    </div>
  );
}
