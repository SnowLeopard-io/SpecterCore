import { createContext, useContext } from 'react';
import type { KernelRuntime } from '@specter-core/contracts';
import type { DesktopController } from '@specter-core/contracts';

export interface UiContextValue {
  kernel: KernelRuntime;
  controller: DesktopController;
}

export const UiContext = createContext<UiContextValue | null>(null);

export function useUi(): UiContextValue {
  const value = useContext(UiContext);
  if (!value) throw new Error('useUi must be used within a <UiProvider>');
  return value;
}