import type { ReactNode } from 'react';
import type { AppLaunchArgs } from '@specter-core/contracts';

/** Renders a React node from a window's content, used across the desktop shell. */
export type { ReactNode };

/** Window operations exposed to frames and window content. */
export interface UiController {
  close(id: string): Promise<void>;
  focus(id: string): Promise<void>;
  minimize(id: string): Promise<void>;
  maximize(id: string): Promise<void>;
  restore(id: string): Promise<void>;
  moveWindow(id: string, x: number, y: number): Promise<void>;
  resizeWindow(id: string, width: number, height: number): Promise<void>;
}

/** Demo application definition for the desktop. */
export interface AppDefinition {
  appId: string;
  name: string;
  icon: string;
  description: string;
  group: string;
  render: (args?: AppLaunchArgs) => ReactNode;
}