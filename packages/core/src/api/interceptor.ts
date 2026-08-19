import type {
  ApiCallContext,
  ApiHandler,
  ApiHost,
  ApiInterceptor,
  ApiResult,
  IEventBus,
  KernelEvents,
} from '@specter-core/contracts';
import { WinError as E } from '@specter-core/contracts';

/**
 * Maps API-Set redirector names (api-ms-win-*) back to the real DLLs so
 * imports like api-ms-win-core-processenvironment-l1-1-0.dll!GetCommandLineW
 * hit the handlers registered for kernel32.dll. Modern Windows exes (e.g.
 * notepad) import through these aliases instead of the DLLs directly.
 */
export function normalizeApiSetModule(module: string): string {
  const m = module.toLowerCase();
  // api-ms-win-core-com-* (COM allocators/CoCreateGuid) belongs to ole32, NOT
  // kernel32 — the generic api-ms-win-core- prefix rule below would misroute
  // CoTaskMemAlloc/CoCreateGuid and their handlers would never be found.
  if (m.startsWith('api-ms-win-core-com-')) return 'ole32.dll';
  if (m.startsWith('api-ms-win-core-')) return 'kernel32.dll';
  if (m.startsWith('api-ms-win-security-') || m.startsWith('api-ms-win-eventing-')) return 'advapi32.dll';
  if (m.startsWith('api-ms-win-com-')) return 'ole32.dll';
  if (m.startsWith('api-ms-win-crt-')) return 'ucrtbase.dll';
  if (m.startsWith('api-ms-win-string-')) return 'user32.dll';
  if (m.startsWith('api-ms-win-')) return 'kernel32.dll'; // fallback for the rest
  return module;
}

/**
 * Windows API interceptor (design doc 4.2).
 * After IAT rewriting (P1), trapped calls are dispatched here. The registry
 * maps "module!proc" to handlers; handlers may read marshalled args and reach
 * the bridge services through ApiHost.
 */
export class ApiInterceptorImpl implements ApiInterceptor {
  private readonly hooks = new Map<string, ApiHandler>();
  private readonly lastErrors = new Map<number, number>();

  constructor(
    private readonly host: ApiHost,
    private readonly events?: IEventBus<KernelEvents>,
  ) {}

  hook(module: string, proc: string, handler: ApiHandler): void {
    this.hooks.set(this.key(module, proc), handler);
  }

  hookBatch(module: string, handlers: Record<string, ApiHandler>): void {
    for (const [proc, handler] of Object.entries(handlers)) this.hook(module, proc, handler);
  }

  unHook(module: string, proc: string): boolean {
    return this.hooks.delete(this.key(module, proc));
  }

  getHandler(module: string, proc: string): ApiHandler | null {
    return this.hooks.get(this.key(module, proc)) ?? null;
  }

  async dispatch(ctx: ApiCallContext): Promise<ApiResult> {
    const module = normalizeApiSetModule(ctx.module);
    this.events?.emit('core:api:call', { module, proc: ctx.proc, args: ctx.rawArgs });
    const handler = this.getHandler(module, ctx.proc);
    let result: ApiResult;
    if (!handler) {
      this.events?.emit('core:api:not-implemented', { module, proc: ctx.proc });
      result = { returnValue: 0, errorCode: E.ERROR_NOT_IMPLEMENTED };
    } else {
      result = await handler(ctx, this.host);
    }
    if (result.errorCode !== E.NO_ERROR) {
      this.lastErrors.set(ctx.pid, result.errorCode);
      ctx.lastError = result.errorCode;
    }
    return result;
  }

  listHooks(): readonly string[] {
    return [...this.hooks.keys()].sort();
  }

  setLastError(pid: number, error: number): void {
    this.lastErrors.set(pid, error);
  }

  getLastError(pid: number): number {
    return this.lastErrors.get(pid) ?? 0;
  }

  private key(module: string, proc: string): string {
    return `${module.toLowerCase()}!${proc.toLowerCase()}`;
  }
}