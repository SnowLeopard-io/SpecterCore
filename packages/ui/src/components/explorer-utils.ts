import type { DirEntry } from '@specter-core/contracts';

/** Real Windows file-type icon (extracted from the OS via SHGetFileInfo). */
export function iconPathFor(entry: DirEntry): string {
  if (entry.kind === 'directory') return 'icons/folder.svg';
  const lower = entry.name.toLowerCase();
  if (lower.endsWith('.exe') || lower.endsWith('.dll')) return 'icons/application.svg';
  if (lower.endsWith('.txt') || lower.endsWith('.md') || lower.endsWith('.log') || lower.endsWith('.ini') || lower.endsWith('.json'))
    return 'icons/text-document.svg';
  if (lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.gif') || lower.endsWith('.bmp'))
    return 'icons/image-file.svg';
  if (lower.endsWith('.mp3') || lower.endsWith('.wav') || lower.endsWith('.ogg') || lower.endsWith('.flac') || lower.endsWith('.aac') || lower.endsWith('.m4a')) return 'icons/audio-file.svg';
  if (lower.endsWith('.mp4') || lower.endsWith('.webm') || lower.endsWith('.mov') || lower.endsWith('.mkv') || lower.endsWith('.avi')) return 'icons/video-file.svg';
  if (lower.endsWith('.bkapp')) return 'icons/package.svg';
  return 'icons/document.svg';
}

export function formatSize(bytes: number): string {
  if (bytes >= 1 << 30) return `${(bytes / (1 << 30)).toFixed(2)} GB`;
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(2)} MB`;
  if (bytes >= 1 << 10) return `${(bytes / (1 << 10)).toFixed(1)} KB`;
  return `${bytes} B`;
}

/** Format a Unix timestamp the way File Explorer shows it in the details view. */
export function formatDate(ms: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  const pad = (n: number): string => n.toString().padStart(2, '0');
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function typeOf(name: string): string {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot < 0) return 'File';
  const ext = lower.slice(dot + 1);
  if (ext === 'exe') return 'Application';
  if (ext === 'dll') return 'Application extension';
  if (ext === 'txt' || ext === 'md' || ext === 'log' || ext === 'ini' || ext === 'json') return 'Text Document';
  if (ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'gif' || ext === 'bmp') return 'Image';
  if (ext === 'wav' || ext === 'mp3' || ext === 'ogg') return 'Audio';
  if (ext === 'bkapp') return 'App package';
  return `${ext.toUpperCase()} File`;
}
