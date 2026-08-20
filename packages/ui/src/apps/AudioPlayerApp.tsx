import { useCallback, useEffect, useRef, useState } from 'react';
import { useUi } from '../context';

interface AudioPlayerProps {
  initialFile?: string;
}

const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a']);

function parentOf(storePath: string): string {
  const segs = storePath.split('/').filter(Boolean);
  segs.pop();
  return segs.join('/');
}

function basenameOf(storePath: string): string {
  const segs = storePath.split('/').filter(Boolean);
  return segs[segs.length - 1] ?? storePath;
}

function stripExt(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
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

function AIcon({ name }: { name: string }) {
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
    case 'prev':
      return (
        <svg {...p} viewBox="0 0 24 24" fill="currentColor" stroke="none">
          <path d="M6 6h2v12H6zM20 6v12l-10-6z" />
        </svg>
      );
    case 'next':
      return (
        <svg {...p} viewBox="0 0 24 24" fill="currentColor" stroke="none">
          <path d="M16 6h2v12h-2zM4 6l10 6-10 6z" />
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
    case 'shuffle':
      return (
        <svg {...p} viewBox="0 0 24 24">
          <path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5" />
        </svg>
      );
    case 'repeat':
      return (
        <svg {...p} viewBox="0 0 24 24">
          <path d="m17 2 4 4-4 4" /><path d="M3 11v-1a4 4 0 0 1 4-4h14M7 22l-4-4 4-4" /><path d="M21 13v1a4 4 0 0 1-4 4H3" />
        </svg>
      );
    case 'list':
      return (
        <svg {...p} viewBox="0 0 24 24">
          <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
        </svg>
      );
    case 'music':
      return (
        <svg {...p} viewBox="0 0 24 24">
          <path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
        </svg>
      );
    default:
      return null;
  }
}

interface PlaylistEntry {
  name: string;
  path: string;
}

/** Audio Player with Win11 Media Player style dark UI. */
export function AudioPlayerApp({ initialFile }: AudioPlayerProps) {
  const { controller } = useUi();
  const fs = controller.getFileSystem();

  const [path, setPath] = useState<string | null>(initialFile ?? null);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playlist, setPlaylist] = useState<PlaylistEntry[]>([]);
  const [currentIndex, setCurrentIndex] = useState(-1);
  const [fileSize, setFileSize] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [shuffle, setShuffle] = useState(false);
  const [repeat, setRepeat] = useState(false);
  const [showPlaylist, setShowPlaylist] = useState(true);

  const urlRef = useRef<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    return () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
  }, []);

  const loadTrack = useCallback(
    (trackPath: string, trackName: string, list: PlaylistEntry[], idx: number) => {
      if (!fs) return;
      void (async () => {
        try {
          const file = await fs.openFile(trackPath, 'read');
          let data: Uint8Array;
          let size: number;
          try {
            size = await file.size();
            data = await file.read(0, size);
          } finally {
            await file.close();
          }
          const ext = trackPath.slice(trackPath.lastIndexOf('.') + 1).toLowerCase();
          const mime = ext === 'mp3' ? 'audio/mpeg'
            : ext === 'wav' ? 'audio/wav'
            : ext === 'ogg' ? 'audio/ogg'
            : ext === 'flac' ? 'audio/flac'
            : ext === 'aac' ? 'audio/aac'
            : ext === 'm4a' ? 'audio/mp4'
            : 'audio/mpeg';
          const blob = new Blob([data as BlobPart], { type: mime });
          if (urlRef.current) URL.revokeObjectURL(urlRef.current);
          urlRef.current = URL.createObjectURL(blob);
          setUrl(urlRef.current);
          setError(null);
          setFileSize(size);
          setPlaylist(list);
          setCurrentIndex(idx);
          setCurrentTime(0);
          setDuration(0);
        } catch (err: unknown) {
          setError(`Cannot open audio: ${String(err)}`);
        }
      })();
    },
    [fs],
  );

  useEffect(() => {
    if (!path || !fs) return;
    let cancelled = false;
    void (async () => {
      try {
        const parent = parentOf(path);
        const entries = await fs.listDirectory(parent);
        if (cancelled) return;
        const audios: PlaylistEntry[] = entries
          .filter((e) => e.kind === 'file' && AUDIO_EXTENSIONS.has(e.name.slice(e.name.lastIndexOf('.') + 1).toLowerCase()))
          .map((e) => ({
            name: e.name,
            path: parent === '' ? e.name : `${parent}/${e.name}`,
          }))
          .sort((a, b) => a.name.localeCompare(b.name));
        const idx = audios.findIndex((a) => a.name === basenameOf(path));
        const found = idx >= 0 ? audios[idx] : undefined;
        if (found) {
          loadTrack(found.path, found.name, audios, idx);
        }
      } catch {
        if (!cancelled) setError('Failed to load audio');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path, fs, loadTrack]);

  const togglePlay = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) void a.play();
    else a.pause();
  }, []);

  const onSeek = useCallback((val: number) => {
    const a = audioRef.current;
    if (a) {
      a.currentTime = val;
      setCurrentTime(val);
    }
  }, []);

  const onVolumeChange = useCallback((val: number) => {
    setVolume(val);
    const a = audioRef.current;
    if (a) {
      a.volume = val;
      a.muted = val === 0;
      setMuted(val === 0);
    }
  }, []);

  const toggleMute = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    a.muted = !a.muted;
    setMuted(a.muted);
  }, []);

  const skip = useCallback(
    (dir: -1 | 1) => {
      if (playlist.length === 0) return;
      let next: number;
      if (shuffle) {
        next = Math.floor(Math.random() * playlist.length);
        if (next === currentIndex) next = (next + 1) % playlist.length;
      } else {
        next = currentIndex + dir;
        if (next < 0) next = playlist.length - 1;
        if (next >= playlist.length) next = 0;
      }
      const t = playlist[next];
      if (t) setPath(t.path);
    },
    [playlist, currentIndex, shuffle],
  );

  const onEnded = useCallback(() => {
    if (repeat) {
      const a = audioRef.current;
      if (a) {
        a.currentTime = 0;
        void a.play();
      }
    } else {
      skip(1);
    }
  }, [repeat, skip]);

  const selectTrack = useCallback(
    (idx: number) => {
      if (idx >= 0 && idx < playlist.length) {
        const t = playlist[idx];
        if (t) setPath(t.path);
      }
    },
    [playlist],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === ' ') {
        e.preventDefault();
        togglePlay();
      } else if (e.key === 'ArrowLeft') {
        skip(-1);
      } else if (e.key === 'ArrowRight') {
        skip(1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePlay, skip]);

  const progressPct = duration > 0 ? (currentTime / duration) * 100 : 0;
  const currentName = currentIndex >= 0 ? playlist[currentIndex]?.name ?? '' : '';

  return (
    <div className="sc-ap">
      <audio
        ref={audioRef}
        src={url ?? undefined}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
        onEnded={onEnded}
        onVolumeChange={(e) => {
          setVolume(e.currentTarget.volume);
          setMuted(e.currentTarget.muted);
        }}
      />

      <div className={`sc-ap-main ${showPlaylist ? '' : 'full'}`}>
        {/* Album art area */}
        <div className="sc-ap-art">
          {url ? (
            <div className="sc-ap-art-disc">
              <div className={`sc-ap-disc-inner ${playing ? 'spinning' : ''}`}>
                <div className="sc-ap-disc-label">
                  <AIcon name="music" />
                </div>
              </div>
            </div>
          ) : (
            <div className="sc-ap-art-empty">
              <AIcon name="music" />
              <span>Open an audio file from the virtual disk</span>
            </div>
          )}
          {error && <div className="sc-ap-error">{error}</div>}
        </div>

        {/* Track info */}
        <div className="sc-ap-info">
          <div className="sc-ap-title">{stripExt(currentName)}</div>
          <div className="sc-ap-subtitle">
            {fileSize > 0 && <span>{fmtSize(fileSize)}</span>}
            {currentIndex >= 0 && <span>{currentIndex + 1} / {playlist.length}</span>}
          </div>
        </div>

        {/* Progress bar */}
        <div className="sc-ap-progress">
          <span className="sc-ap-time">{fmtTime(currentTime)}</span>
          <div className="sc-ap-seek-wrap" onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const pct = (e.clientX - rect.left) / rect.width;
            onSeek(pct * duration);
          }}>
            <div className="sc-ap-seek-track">
              <div className="sc-ap-seek-fill" style={{ width: `${progressPct}%` }} />
              <div className="sc-ap-seek-thumb" style={{ left: `${progressPct}%` }} />
            </div>
          </div>
          <span className="sc-ap-time">{fmtTime(duration)}</span>
        </div>

        {/* Controls */}
        <div className="sc-ap-controls">
          <button
            className={`sc-ap-btn small ${shuffle ? 'active' : ''}`}
            title="Shuffle"
            onClick={() => setShuffle((v) => !v)}
          >
            <AIcon name="shuffle" />
          </button>
          <button className="sc-ap-btn" title="Previous" onClick={() => skip(-1)}>
            <AIcon name="prev" />
          </button>
          <button className="sc-ap-btn play" title={playing ? 'Pause' : 'Play'} onClick={togglePlay}>
            {playing ? <AIcon name="pause" /> : <AIcon name="play" />}
          </button>
          <button className="sc-ap-btn" title="Next" onClick={() => skip(1)}>
            <AIcon name="next" />
          </button>
          <button
            className={`sc-ap-btn small ${repeat ? 'active' : ''}`}
            title="Repeat"
            onClick={() => setRepeat((v) => !v)}
          >
            <AIcon name="repeat" />
          </button>
        </div>

        {/* Volume */}
        <div className="sc-ap-volume">
          <button className="sc-ap-btn small" title={muted ? 'Unmute' : 'Mute'} onClick={toggleMute}>
            {muted || volume === 0 ? <AIcon name="mute" /> : <AIcon name="volume" />}
          </button>
          <input
            className="sc-ap-volume-slider"
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={muted ? 0 : volume}
            onChange={(e) => onVolumeChange(Number(e.target.value))}
          />
        </div>
      </div>

      {/* Playlist sidebar */}
      {showPlaylist && (
        <div className="sc-ap-playlist">
          <div className="sc-ap-playlist-header">
            <span>Up Next</span>
            <button className="sc-ap-btn small" title="Hide playlist" onClick={() => setShowPlaylist(false)}>
              <AIcon name="list" />
            </button>
          </div>
          <div className="sc-ap-playlist-items">
            {playlist.map((track, i) => (
              <button
                key={i}
                className={`sc-ap-playlist-item ${i === currentIndex ? 'active' : ''}`}
                onClick={() => selectTrack(i)}
              >
                <span className="sc-ap-pl-icon">
                  {i === currentIndex && playing ? <AIcon name="pause" /> : <AIcon name="music" />}
                </span>
                <span className="sc-ap-pl-name">{stripExt(track.name)}</span>
                <span className="sc-ap-pl-index">{i + 1}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Show playlist toggle when hidden */}
      {!showPlaylist && (
        <button className="sc-ap-show-playlist" title="Show playlist" onClick={() => setShowPlaylist(true)}>
          <AIcon name="list" />
        </button>
      )}
    </div>
  );
}
