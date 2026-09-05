/**
 * Architecture backend registry.
 *
 * Both backend instances are stateless (they take the guest runtime as an
 * argument), so the two singletons below are shared by every guest run. Pick
 * the right one with `archForPe(pe)` — the only place in the codebase that still
 * needs to know the guest bitness up front.
 */

import type { PeImage } from '@specter-core/contracts';
import type { ArchBackend } from './types';
import { X86Backend } from './x86';
import { X64Backend } from './x64';

export const x86Backend = new X86Backend();
export const x64Backend = new X64Backend();

/** Select the architecture backend for a parsed PE image. */
export function archForPe(pe: PeImage): ArchBackend {
  return pe.is64 ? x64Backend : x86Backend;
}

export type { ArchBackend, ArchMode, OpenFileNameOffsets, WndClassExOffsets } from './types';
export { X86Backend, X64Backend };
export { X86_API_ARG_COUNT } from '../pe/mapper';
