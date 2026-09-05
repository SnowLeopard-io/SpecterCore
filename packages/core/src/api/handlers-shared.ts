/**
 * Shared helpers for the default API handlers: stdcall stack-argument access, guest-memory string readers, and result constructors.
 *
 * Split out of handlers.ts (design doc 4.2.x); pure code movement, no logic changes.
 */

import type { ApiCallContext, ApiHost, ApiResult } from '@specter-core/contracts';
import { WinError as E } from '@specter-core/contracts';

/** Windows pseudo-handles for the standard console streams (winbase.h). */
export const STD_INPUT_HANDLE = -10;
export const STD_OUTPUT_HANDLE = -11;
export const STD_ERROR_HANDLE = -12;

export function ok(returnValue: number): ApiResult {
  return { returnValue, errorCode: E.NO_ERROR };
}

export function fail(errorCode: number): ApiResult {
  return { returnValue: 0, errorCode };
}

/** Raw stack argument (stdcall: arg0 is pushed last, at [esp+4]). */
export function raw(ctx: ApiCallContext, index: number): number {
  return ctx.rawArgs[index] ?? 0;
}

/** NUL-terminated string at `address` in the guest linear memory. */
export function memCStr(host: ApiHost, address: number, maxLength = 4096): string {
  if (address === 0) return '';
  const bytes = host.memory.read(address, maxLength);
  let end = 0;
  while (end < bytes.byteLength && bytes[end] !== 0) end += 1;
  return new TextDecoder('latin1').decode(bytes.subarray(0, end));
}

export function numArg(ctx: ApiCallContext, key: string, fallback = 0): number {
  const value = ctx.marshalled?.[key];
  return typeof value === 'number' ? value : fallback;
}

export function strArg(ctx: ApiCallContext, key: string): string {
  const value = ctx.marshalled?.[key];
  return typeof value === 'string' ? value : '';
}

/** NUL-terminated UTF-16 string at `address` in the guest linear memory. */
export function memWStr(host: ApiHost, address: number, maxChars = 2048): string {
  if (!address) return '';
  const bytes = host.memory.read(address, maxChars * 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let s = '';
  for (let i = 0; i + 1 < bytes.byteLength; i += 2) {
    const c = view.getUint16(i, true);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

/** Exactly `count` UTF-16 code units at `address` (no NUL scan). */
export function memWStrLen(host: ApiHost, address: number, count: number): string {
  if (!address || count <= 0) return '';
  const bytes = host.memory.read(address, count * 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let s = '';
  for (let i = 0; i + 1 < bytes.byteLength && i / 2 < count; i += 2) {
    s += String.fromCharCode(view.getUint16(i, true));
  }
  return s;
}

