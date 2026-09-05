/**
 * File-system helpers for the API handlers: volume serial hashing, find-pattern splitting, and WIN32_FIND_DATAW writing.
 *
 * Split out of handlers.ts (design doc 4.2.x); pure code movement, no logic changes.
 */

import type { ApiHost } from '@specter-core/contracts';

/**
 * Stable 32-bit volume serial derived from the root path name. Real Windows
 * derives it from volume creation time/format info; here we hash the path so
 * the same drive always reports the same serial and cmd's "%04X-%04X"
 * formatting shows something other than the placeholder.
 */
export function volumeSerial(rootPath: string): number {
  let h = 5381 >>> 0;
  for (let i = 0; i < rootPath.length; i++) {
    h = (((h << 5) + h) ^ rootPath.charCodeAt(i)) >>> 0;
  }
  // Fold to 16 bits per half so the printed "HHHH-HHHH" stays short.
  return ((h ^ (h >>> 16)) & 0xffff) | (((h >>> 16) ^ (h & 0xffff)) << 16);
}

/** Splits 'C:\\Windows\\*.txt' into { dir: 'C:\\Windows', pattern: '*.txt' }. */
export function splitFindPattern(path: string): { dir: string; pattern: string } {
  // Normalize trailing separators: "C:\Windows\" -> "C:\Windows" (cmd's `cd`
  // probes the target dir itself via FindFirstFileW with a trailing backslash;
  // an empty pattern after the last separator would match nothing -> err 18).
  const p = path.replace(/[\\/]+$/, '');
  // Bare drive: "C:" enumerates the drive root (match everything).
  if (/^[A-Za-z]:$/.test(p)) return { dir: '', pattern: '*' };
  if (p === '') return { dir: '', pattern: '*' };
  const idx = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  if (idx === -1) return { dir: '', pattern: p };
  return { dir: p.slice(0, idx), pattern: p.slice(idx + 1) };
}

/** Writes a WIN32_FIND_DATAW record (592 bytes) from a bridge FindData. */
export function writeFindData(host: ApiHost, address: number, data: { attributes: number; size: number; name: string }): void {
  if (!address) return;
  const w = new Uint8Array(592);
  const view = new DataView(w.buffer);
  view.setUint32(0, data.attributes ?? 0, true); // dwFileAttributes
  view.setUint32(32, data.size >>> 0, true); // nFileSizeLow
  const name = data.name ?? '';
  for (let i = 0; i < name.length && i < 259; i++) {
    view.setUint16(44 + i * 2, name.charCodeAt(i), true); // cFileName
  }
  host.memory.write(address, w);
}

