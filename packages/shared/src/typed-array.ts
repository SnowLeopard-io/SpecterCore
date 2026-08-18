/**
 * Typed array helpers.
 * TS 5.7+ types Uint8Array as generic over ArrayBufferLike, which conflicts
 * with DOM BufferSource (requires ArrayBuffer-backed views). This helper copies
 * data into an ArrayBuffer-backed view at the browser API boundary.
 */

export function toArrayBufferView(data: Uint8Array): Uint8Array<ArrayBuffer> {
  if (data.buffer instanceof ArrayBuffer && data.byteOffset === 0 && data.byteLength === data.buffer.byteLength) {
    return data as Uint8Array<ArrayBuffer>;
  }
  const buffer = new ArrayBuffer(data.byteLength);
  new Uint8Array(buffer).set(data);
  return new Uint8Array(buffer);
}

/** Copies into a standalone ArrayBuffer (for postMessage / structured clones). */
export function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(data.byteLength);
  new Uint8Array(buffer).set(data);
  return buffer;
}