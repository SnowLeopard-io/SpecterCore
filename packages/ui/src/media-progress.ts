/**
 * Progress for the background media provisioning (music / pictures).
 *
 * The boot provision creates the two public media folders up front and then
 * streams files into them in the background. File Explorer subscribes to this
 * store so that opening Music/Pictures shows a Win11-style fill progress bar
 * ("n of total · <current file>") while the default media is still landing.
 */

export interface MediaProgress {
  /** Store path of the media folder being filled, or null when idle. */
  folder: string | null;
  running: boolean;
  done: number;
  total: number;
  /** Last file name written so far. */
  current: string | null;
}

type Listener = (progress: MediaProgress) => void;

/** Store paths of the two public media folders provisioned at boot. */
export const MUSIC_FOLDER = 'Users/Public/Music';
export const PICTURES_FOLDER = 'Users/Public/Pictures';

const IDLE: MediaProgress = { folder: null, running: false, done: 0, total: 0, current: null };

let state: MediaProgress = IDLE;
const listeners = new Set<Listener>();

export function getMediaProgress(): MediaProgress {
  return state;
}

export function subscribeMediaProgress(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Report a per-file tick from a media provision run. */
export function reportMediaProgress(next: Partial<MediaProgress>): void {
  state = { ...state, ...next };
  for (const l of listeners) l(state);
}