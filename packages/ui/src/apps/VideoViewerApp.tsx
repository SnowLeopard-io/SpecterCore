import { useCallback, useEffect, useRef, useState } from 'react';
import { useUi } from '../context';

interface VideoViewerProps {
  initialFile?: string;
}

const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'ogg', 'mov', 'mkv', 'avi', 'wav', 'mp3']);

function parentOf(storePath: string): string {
  const segs = storePath.split('/').filter(Boolean);
  segs.pop();
  return segs.join('/');
}

function basenameOf(storePath: string): string {
  const segs = storePath.split('/').filter(Boolean);
  return segs[segs.length - 1] ?? storePath;
}

function fmtTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function fmtSize(bytes: number): string {
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(1)} MB`;
  if (bytes >= 1 << 10) return `${(bytes / (1 << 10)).toFixed(1)} KB`;
  return `${bytes} B`;
}

function VIcon({ name }: { name: string }) {
  const p = {
    width: 18,
    height: 18,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  switch (name) {
    case 'play':
      return (
        <svg {...p} viewBox="0 0 24 24" fill="currentColor" stroke="none">
          <path d="M8 5v14l11-7z" />
        </svg>
      );
    case 'pause':
      return (
        <svg {...p} viewBox="0 0 24 24" fill="currentColor" stroke="none">
          <rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" />
        </svg>
      );
    case 'stop':
      return (
        <svg {...p} viewBox="0 0 24 24" fill="currentColor" stroke="none">
          <rect x="6" y="6" width="12" height="12" rx="1" />
        </svg>
      );
    case 'volume':
      return (
        <svg {...p} viewBox="0 0 24 24">
          <path d="M11 5 6 9H2v6h4l5 4V5z" /><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
        </svg>
      );
    case 'mute':
      return (
        <svg {...p} viewBox="0 0 24 24">
          <path d="M11 5 6 9H2v6h4l5 4V5z" /><path d="m23 9-6 6m0-6 6 6" />
        </svg>
      );
    case 'fullscreen':
      return (
        <svg {...p} viewBox="0 0 24 24">
          <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3m13-5v3a2 2 0 0 1-2 2h-3" />
        </svg>
      );
    case 'exit-fullscreen':
      return (
        <svg {...p} viewBox="0 0 24 24">
          <path d="M3 8h3a2 2 0 0 0 2-2V3m6 0v3a2 2 0 0 0 2 2h3M3 16h3a2 2 0 0 1 2 2v3m6 0v-3a2 2 0 0 1 2-2h3" />
        </svg>
      );
    case 'chevron-left':
      return (
        <svg {...p} viewBox="0 0 24 24">
          <path d="m15 18-6-6 6-6" />
        </svg>
      );
    case 'chevron-right':
      return (
        <svg {...p} viewBox="0 0 24 24">
          <path d="m9 18 6-6-6-6" />
        </svg>
      );
    case 'speed':
      return (
        <svg {...p} viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" />
        </svg>
      );
    case 'pip':
      return (
        <svg {...p} viewBox="0 0 24 24">
          <rect x="2" y="4" width="20" height="16" rx="2" /><rect x="12" y="11" width="8" height="7" rx="1" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'film':
      return (
        <svg {...p} viewBox="0 0 24 24">
          <rect x="3" y="3" width="18" height="18" rx="2" /><path d="M7 3v18M17 3v18M3 12h18M3 8h4M3 16h4M17 8h4M17 16h4" />
        </svg>
      );
    default:
      return null;
  }
}

/** Video Viewer with dark cinema-style player controls. */
export function VideoViewerApp({ initialFile }: VideoViewerProps) {
  const { controller } = useUi();
  const fs = controller.getFileSystem();

  const [path, setPath] = useState<string | null>(initialFile ?? null);
  const [url, setUrl] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [siblings, setSiblings] = useState<string[]>([]);
  const [index, setIndex] = useState(-1);
  const [fileSize, setFileSize] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [rate, setRate] = useState(1);
  const [showRateMenu, setShowRateMenu] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [isAudio, setIsAudio] = useState(false);

  const urlRef = useRef<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const hideTimer = useRef<number | null>(null);

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
        const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
        const mime = ext === 'mp4' ? 'video/mp4'
          : ext === 'webm' ? 'video/webm'
          : ext === 'ogg' ? 'video/ogg'
          : ext === 'mp3' ? 'audio/mpeg'
          : ext === 'wav' ? 'audio/wav'
          : 'application/octet-stream';
        const blob = new Blob([data as BlobPart], { type: mime });
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        urlRef.current = URL.createObjectURL(blob);
        setUrl(urlRef.current);
        setName(basenameOf(path));
        setError(null);
        setFileSize(size);
        setIsAudio(['mp3', 'wav', 'ogg'].includes(ext));
        setPlaying(false);
        setCurrentTime(0);
        setDuration(0);

        const parent = parentOf(path);
        const entries = await fs.listDirectory(parent);
        if (cancelled) return;
        const vids = entries
          .filter((e) => e.kind === 'file' && VIDEO_EXTENSIONS.has(e.name.slice(e.name.lastIndexOf('.') + 1).toLowerCase()))
          .map((e) => e.name)
          .sort((a, b) => a.localeCompare(b));
        setSiblings(vids);
        setIndex(vids.indexOf(basenameOf(path)));
      } catch (err: unknown) {
        if (!cancelled) setError(`Cannot open file: ${String(err)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path, fs]);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      void v.play();
    } else {
      v.pause();
    }
  }, []);

  const toggleMute = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !v.muted;
    setMuted(v.muted);
  }, []);

  const onVolumeChange = useCallback((val: number) => {
    setVolume(val);
    const v = videoRef.current;
    if (v) {
      v.volume = val;
      v.muted = val === 0;
      setMuted(val === 0);
    }
  }, []);

  const onSeek = useCallback((val: number) => {
    const v = videoRef.current;
    if (v) {
      v.currentTime = val;
      setCurrentTime(val);
    }
  }, []);

  const toggleFullscreen = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    if (!document.fullscreenElement) {
      void el.requestFullscreen?.();
    } else {
      void document.exitFullscreen?.();
    }
  }, []);

  useEffect(() => {
    const onFsChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  const changeRate = useCallback((r: number) => {
    setRate(r);
    if (videoRef.current) videoRef.current.playbackRate = r;
    setShowRateMenu(false);
  }, []);

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

  const showControls = useCallback(() => {
    setControlsVisible(true);
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      if (playing) setControlsVisible(false);
    }, 3000);
  }, [playing]);

  useEffect(() => {
    if (!playing) setControlsVisible(true);
  }, [playing]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') step(-1);
      else if (e.key === 'ArrowRight') step(1);
      else if (e.key === ' ') {
        e.preventDefault();
        togglePlay();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step, togglePlay]);

  return (
    <div
      className="sc-vv"
      ref={containerRef}
      onMouseMove={showControls}
      onMouseLeave={() => playing && setControlsVisible(false)}
    >
      {/* Video stage */}
      <div className="sc-vv-stage">
        {error && <div className="sc-vv-error">{error}</div>}
        {!error && url && (
          isAudio ? (
            <div className="sc-vv-audio-visual">
              <VIcon name="film" />
              <span className="sc-vv-audio-name">{name}</span>
              <audio
                ref={videoRef as React.RefObject<HTMLAudioElement>}
                src={url}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
                onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
                onEnded={() => setPlaying(false)}
              />
            </div>
          ) : (
            <video
              ref={videoRef}
              className="sc-vv-video"
              src={url}
              onClick={togglePlay}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
              onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
              onEnded={() => setPlaying(false)}
              onVolumeChange={(e) => {
                setVolume(e.currentTarget.volume);
                setMuted(e.currentTarget.muted);
              }}
            />
          )
        )}
        {!error && !url && (
          <div className="sc-vv-empty">
            <VIcon name="film" />
            <span>Open a video from the virtual disk</span>
          </div>
        )}
      </div>

      {/* Center play overlay */}
      {url && !isAudio && !playing && !error && (
        <button className="sc-vv-play-overlay" onClick={togglePlay} title="Play">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="currentColor">
            <path d="M8 5v14l11-7z" />
          </svg>
        </button>
      )}

      {/* Bottom controls */}
      {url && !error && (
        <footer className={`sc-vv-controls ${controlsVisible ? '' : 'hidden'}`}>
          {/* Progress bar */}
          <div className="sc-vv-progress">
            <span className="sc-vv-time">{fmtTime(currentTime)}</span>
            <input
              className="sc-vv-seek"
              type="range"
              min="0"
              max={duration || 0}
              step="0.1"
              value={currentTime}
              onChange={(e) => onSeek(Number(e.target.value))}
            />
            <span className="sc-vv-time">{fmtTime(duration)}</span>
          </div>

          {/* Button row */}
          <div className="sc-vv-btn-row">
            <div className="sc-vv-btn-group">
              <button className="sc-vv-btn" title="Previous" disabled={index <= 0} onClick={() => step(-1)}>
                <VIcon name="chevron-left" />
              </button>
              <button className="sc-vv-btn" title={playing ? 'Pause' : 'Play'} onClick={togglePlay}>
                {playing ? <VIcon name="pause" /> : <VIcon name="play" />}
              </button>
              <button className="sc-vv-btn" title="Stop" onClick={() => {
                const v = videoRef.current;
                if (v) { v.pause(); v.currentTime = 0; }
              }}>
                <VIcon name="stop" />
              </button>
              <button className="sc-vv-btn" title="Next" disabled={index < 0 || index >= siblings.length - 1} onClick={() => step(1)}>
                <VIcon name="chevron-right" />
              </button>
            </div>

            <div className="sc-vv-info">
              <span className="sc-vv-filename">{name}</span>
              {fileSize > 0 && <span className="sc-vv-size">{fmtSize(fileSize)}</span>}
              {index >= 0 && <span className="sc-vv-counter">{index + 1} / {siblings.length}</span>}
            </div>

            <div className="sc-vv-btn-group">
              <div className="sc-vv-volume-group">
                <button className="sc-vv-btn" title={muted ? 'Unmute' : 'Mute'} onClick={toggleMute}>
                  {muted || volume === 0 ? <VIcon name="mute" /> : <VIcon name="volume" />}
                </button>
                <input
                  className="sc-vv-volume-slider"
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={muted ? 0 : volume}
                  onChange={(e) => onVolumeChange(Number(e.target.value))}
                />
              </div>

              <div className="sc-vv-rate-group">
                <button className="sc-vv-btn" title="Playback speed" onClick={() => setShowRateMenu((v) => !v)}>
                  <VIcon name="speed" />
                </button>
                {showRateMenu && (
                  <div className="sc-vv-rate-menu" onMouseLeave={() => setShowRateMenu(false)}>
                    {[0.5, 0.75, 1, 1.25, 1.5, 2].map((r) => (
                      <button
                        key={r}
                        className={`sc-vv-rate-item ${rate === r ? 'active' : ''}`}
                        onClick={() => changeRate(r)}
                      >
                        {r === 1 ? 'Normal' : `${r}×`}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <button className="sc-vv-btn" title="Picture in picture" onClick={() => {
                const v = videoRef.current;
                if (v && document.pictureInPictureEnabled) {
                  if (document.pictureInPictureElement) {
                    void document.exitPictureInPicture();
                  } else {
                    void v.requestPictureInPicture?.();
                  }
                }
              }}>
                <VIcon name="pip" />
              </button>

              <button className="sc-vv-btn" title="Fullscreen" onClick={toggleFullscreen}>
                {isFullscreen ? <VIcon name="exit-fullscreen" /> : <VIcon name="fullscreen" />}
              </button>
            </div>
          </div>
        </footer>
      )}
    </div>
  );
}
