/**
 * Shared run state and result helpers for the guest-process subsystem modules.
 *
 * Split out of guest-process.ts (design doc 4.2.x); pure code movement, no logic changes.
 */

import type { ApiResult } from '@specter-core/contracts';
import { WinError as E } from '@specter-core/contracts';

/** Per-run mutable state shared between the runner and its subsystem modules. */
export interface RunState {
  /** Set when the guest called ExitProcess (or a handler forced termination). */
  exitRequested: boolean;
  /** ExitProcess exit code (valid only when exitRequested is true). */
  exitCode: number;
  /** Current working directory (Get/SetCurrentDirectory). */
  cwd: string;
  /** Absolute path of the module being run (GetModuleFileNameW/A). */
  modulePath: string;
  /** Command line reported by GetCommandLineW/A. */
  commandLine: string;
  /** MUI satellite-resource reader (see GuestProcessOptions.readFile). */
  readFile?: (path: string) => Promise<Uint8Array | null>;
  /** True when MUI satellite resources were merged (real strings/menus). */
  muiLoaded: boolean;
  /** Path of the .mui file that was merged (diagnostics). */
  muiSource: string;
  /** Wide environment block pointer (GetEnvironmentStringsW). */
  wideEnvBlock: number;
  /** Narrow environment block pointer (GetEnvironmentStringsA). */
  narrowEnvBlock: number;
  /** Heap bump allocator installed by the startup handlers. */
  guestHeapAlloc: ((size: number) => number) | null;
}

/** Small helper: BOOL TRUE with NO_ERROR. */
export function ok1(): ApiResult {
  return { returnValue: 1, errorCode: E.NO_ERROR };
}
