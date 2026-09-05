import type { ApiHandler, ApiInterceptor } from '@specter-core/contracts';

import { ok } from './handlers-shared';
import { randImpl, srandImpl } from './handlers-crt';
import { kernel32Handlers } from './handlers-kernel32';
import { user32Handlers } from './handlers-user32';
import { ucrtbaseHandlers } from './handlers-ucrt';

export { STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE } from './handlers-shared';

/**
 * Default kernel32/user32/gdi32 handlers (design doc 4.2.x).
 *
 * Until the L3 marshaller lands, handlers read raw stdcall stack arguments
 * (`ctx.rawArgs`) and dereference pointers through `host.memory`. Console
 * streams (WriteFile on STD_OUTPUT_HANDLE) are routed by the guest-process
 * runner via `core:console:write` events or its output callback.
 */
export function registerDefaultHandlers(interceptor: ApiInterceptor): void {
  interceptor.hookBatch('kernel32.dll', kernel32Handlers());
  interceptor.hookBatch('user32.dll', user32Handlers());
  const gdi32: Record<string, ApiHandler> = {
    GetDeviceCaps: () => ok(32),
  };
  interceptor.hookBatch('gdi32.dll', gdi32);

  // UCRT (ucrtbase) memory/string primitives. Modern CRT code imports these
  // through the api-ms-win-crt-* API-Set names (normalized to ucrtbase.dll
  // by the interceptor). Without them, CRT init memory ops silently no-op.
  interceptor.hookBatch('ucrtbase.dll', ucrtbaseHandlers());
  // Legacy msvcrt.dll: winmine (VC6-era) imports rand/srand/__p__fmode etc.
  // from msvcrt.dll directly, which normalizeApiSetModule does NOT map to
  // ucrtbase — without these, msvcrt.dll.rand falls to the default stub and
  // returns 0 forever, spinning winmine's mine-placement loop.
  interceptor.hookBatch('msvcrt.dll', {
    rand: randImpl,
    _o_rand: randImpl,
    srand: srandImpl,
    _o_srand: srandImpl,
  });
}

export type { ApiHost, ApiResult, ApiCallContext } from '@specter-core/contracts';
