import { useSyncExternalStore } from 'react';
import type { GuestMenuSection } from '@specter-core/core';

/**
 * Live menu bridge between guest-process (SetMenu/LoadMenuW) and the hosted
 * window UI. guest-process fires onWindowMetaChanged -> setGuestMenu;
 * GuestWindowView reads it via useSyncExternalStore, so a menu attached
 * *after* CreateWindowExW (winmine's Game/Help bar) shows up without the host
 * re-creating the desktop window.
 */
const menus = new Map<number, GuestMenuSection[]>();
/** Stable empty snapshot — useSyncExternalStore requires getSnapshot to
 * return the SAME reference when nothing changed. Returning a fresh `[]`
 * per call puts React into an infinite re-render loop (observed as a black
 * screen for guests whose store entry is absent, e.g. notepad). */
const EMPTY: GuestMenuSection[] = [];
const listeners = new Set<() => void>();

export function setGuestMenu(hwnd: number, menu: GuestMenuSection[]): void {
  menus.set(hwnd, menu);
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function snapshotFor(hwnd: number): () => GuestMenuSection[] {
  return () => menus.get(hwnd) ?? EMPTY;
}

/** React hook: current menu sections of the given guest window (live). */
export function useGuestMenu(hwnd: number): GuestMenuSection[] {
  return useSyncExternalStore(subscribe, snapshotFor(hwnd));
}
