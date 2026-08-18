import { useSyncExternalStore } from 'react';

/**
 * Shared text bridge between the guest EDIT control and the hosted window UI:
 * guest-process fires onTextChanged -> setGuestText; GuestWindowView reads it
 * via useSyncExternalStore, so notepad's own WM_SETTEXT (New/Paste/...) is
 * visible in the textarea without a per-window callback plumbing.
 */
const texts = new Map<number, string>();
const listeners = new Set<() => void>();

export function setGuestText(hwnd: number, text: string): void {
  if (texts.get(hwnd) === text) return;
  texts.set(hwnd, text);
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function snapshotFor(hwnd: number): () => string {
  return () => texts.get(hwnd) ?? '';
}

/** React hook: current text of the given guest EDIT window (live). */
export function useGuestText(hwnd: number | null): string {
  return useSyncExternalStore(subscribe, hwnd === null ? () => '' : snapshotFor(hwnd));
}
