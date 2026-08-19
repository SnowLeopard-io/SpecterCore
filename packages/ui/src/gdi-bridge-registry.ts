import type { GdiBridge } from '@specter-core/contracts';

/**
 * Shared GDI bridge registry: maps guest HWND → CanvasGdiBridge.
 *
 * GuestWindowView registers its bridge (backed by a <canvas>) on mount;
 * the gdiBridge provider passed to GuestProcessRunner reads from here so
 * that BeginPaint/GetDC during WM_PAINT dispatch reaches the real canvas.
 */
const bridges = new Map<number, GdiBridge>();

export function setGuestGdiBridge(hwnd: number, bridge: GdiBridge | null): void {
  if (bridge) bridges.set(hwnd, bridge);
  else bridges.delete(hwnd);
}

export function guestGdiBridgeProvider(hwnd: number): GdiBridge | null {
  return bridges.get(hwnd) ?? null;
}
