/**
 * Minimal ICO → PNG-or-fallback decoder.
 *
 * Windows Vista+ .ico files contain one ICONDIR followed by N ICONDIRENTRY
 * (16 bytes each) and N image payloads. Each payload is either a PNG (when
 * the entry was authored for Vista+) or a BMP DIB. <img> can't render ICO
 * directly in Chromium/Edge, so we pick the largest-size PNG entry and hand
 * back its blob URL. If the .ico has no PNG entry we return null and the
 * caller falls back to an emoji/character icon.
 */
const ICO_MAGIC = 0; // ICONDIR.reserved must be 0
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A decoded .ico payload: either a PNG blob URL or null (caller fallbacks). */
export interface DecodedIco {
  pngUrl: string | null;
  /** Largest entry width/height (0 means 256). */
  size: number;
}

export async function fetchIcoAsPng(url: string): Promise<DecodedIco> {
  const res = await fetch(url);
  if (!res.ok) return { pngUrl: null, size: 0 };
  const buf = new Uint8Array(await res.arrayBuffer());
  return decodeIco(buf);
}

export function decodeIco(buf: Uint8Array): DecodedIco {
  if (buf.byteLength < 6 + 16) return { pngUrl: null, size: 0 };
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (view.getUint16(0, true) !== ICO_MAGIC) return { pngUrl: null, size: 0 };
  if (view.getUint16(2, true) !== 1) return { pngUrl: null, size: 0 }; // 1 = icon
  const count = view.getUint16(4, true);
  if (count === 0) return { pngUrl: null, size: 0 };

  let bestIdx = -1;
  let bestSize = 0;
  for (let i = 0; i < count; i++) {
    const off = 6 + i * 16;
    if (off + 16 > buf.byteLength) break;
    const w = view.getUint8(off) || 256;
    const h = view.getUint8(off + 1) || 256;
    // Pick largest by area; tiebreak by bit depth (more colours renders cleaner).
    const bits = view.getUint16(off + 6, true);
    const area = w * h;
    const score = area * 1024 + bits;
    if (bestIdx === -1 || score > bestSize) {
      bestSize = score;
      bestIdx = i;
    }
  }
  if (bestIdx < 0) return { pngUrl: null, size: 0 };

  const eOff = 6 + bestIdx * 16;
  const dataOff = view.getUint32(eOff + 12, true);
  const dataSize = view.getUint32(eOff + 8, true);
  if (dataOff + dataSize > buf.byteLength) return { pngUrl: null, size: 0 };
  const payload = buf.subarray(dataOff, dataOff + dataSize);

  // PNG-in-ICO? Pass through as a blob URL — browsers render PNG natively.
  if (payload.byteLength >= 8 && isPng(payload)) {
    // Copy into a fresh Uint8Array<ArrayBuffer>: TS 5.7's BlobPart rejects
    // Uint8Array<ArrayBufferLike> (SharedArrayBuffer possibility).
    const blob = new Blob([new Uint8Array(payload)], { type: 'image/png' });
    return { pngUrl: URL.createObjectURL(blob), size: bestSize };
  }

  // BMP-in-ICO (DIB): not implemented — most modern .ico files (extracted
  // from shell32/imageres since Windows 7) include a PNG payload, so callers
  // can fall back to the emoji glyph without visible loss.
  return { pngUrl: null, size: 0 };
}

function isPng(b: Uint8Array): boolean {
  for (let i = 0; i < PNG_SIG.length; i++) if (b[i] !== PNG_SIG[i]!) return false;
  return true;
}
