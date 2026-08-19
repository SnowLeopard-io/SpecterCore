import { describe, expect, it } from 'vitest';
import type { ApiHost, ApiInterceptor } from '@specter-core/contracts';
import { WinError as E } from '@specter-core/contracts';
import { ApiInterceptorImpl } from './interceptor';
import { registerDefaultHandlers } from './handlers';

function makeHost(): ApiHost {
  const fsBridge = {
    createFile: async () => ({ handle: 42, error: E.NO_ERROR }),
    readFile: async (_h: number, n: number) => ({
      bytesRead: n,
      data: new Uint8Array(n),
      error: E.NO_ERROR,
    }),
    writeFile: async (_h: number, data: Uint8Array) => ({
      bytesWritten: data.byteLength,
      error: E.NO_ERROR,
    }),
    closeHandle: async () => E.NO_ERROR,
    getFileSize: async () => 100,
  } as unknown as ApiHost['fs'];
  const noop = {
    createDC: async () => 0,
    deleteDC: async () => {},
    textOut: async () => E.NO_ERROR,
    bitBlt: async () => E.NO_ERROR,
    stretchBlt: async () => E.NO_ERROR,
    patBlt: async () => E.NO_ERROR,
    setPixel: async () => E.NO_ERROR,
    getDeviceCaps: async () => ({}),
    flush: async () => {},
    onInvalidate: () => () => {},
  } as unknown as ApiHost['gdi'];
  return {
    fs: fsBridge,
    gdi: noop,
    audio: {} as ApiHost['audio'],
    usb: {} as ApiHost['usb'],
    process: {} as ApiHost['process'],
    memory: {
      read: (_address: number, length: number) => new Uint8Array(length),
      write: () => {},
    },
  };
}

function makeInterceptor(): ApiInterceptor {
  const interceptor = new ApiInterceptorImpl(makeHost());
  registerDefaultHandlers(interceptor);
  return interceptor;
}

const ctx = (module: string, proc: string, marshalled?: Record<string, unknown>) => ({
  module,
  proc,
  pid: 1,
  tid: 2,
  rawArgs: [],
  marshalled,
  lastError: 0,
});

describe('ApiInterceptorImpl', () => {
  it('dispatches registered handlers', async () => {
    const interceptor = makeInterceptor();
    const result = await interceptor.dispatch(ctx('kernel32.dll', 'GetTickCount'));
    expect(result.errorCode).toBe(E.NO_ERROR);
    expect(result.returnValue).toBeGreaterThan(0);
  });

  it('returns NOT_IMPLEMENTED for unknown APIs', async () => {
    const interceptor = makeInterceptor();
    const result = await interceptor.dispatch(ctx('kernel32.dll', 'DoSomethingWeird'));
    expect(result.errorCode).toBe(E.ERROR_NOT_IMPLEMENTED);
    expect(result.returnValue).toBe(0);
  });

  it('CreateFileA reaches the fs bridge with marshalled args', async () => {
    const interceptor = makeInterceptor();
    const result = await interceptor.dispatch(
      ctx('kernel32.dll', 'CreateFileA', {
        path: 'C:/a.txt',
        desiredAccess: 0x80000000,
        shareMode: 0,
        creationDisposition: 3,
      }),
    );
    expect(result.errorCode).toBe(E.NO_ERROR);
    expect(result.returnValue).toBe(42);
  });

  it('closeHandle maps fs result', async () => {
    const interceptor = makeInterceptor();
    const result = await interceptor.dispatch(ctx('kernel32.dll', 'CloseHandle', { handle: 42 }));
    expect(result.errorCode).toBe(E.NO_ERROR);
    expect(result.returnValue).toBe(1);
  });

  it('hook/unHook/listHooks', async () => {
    const interceptor = makeInterceptor();
    interceptor.hook('ntdll.dll', 'NtQuerySystemInformation', () => ({
      returnValue: 0,
      errorCode: E.NO_ERROR,
    }));
    expect(interceptor.getHandler('ntdll.dll', 'NtQuerySystemInformation')).toBeTruthy();
    expect(interceptor.unHook('ntdll.dll', 'NtQuerySystemInformation')).toBe(true);
    expect(interceptor.getHandler('ntdll.dll', 'NtQuerySystemInformation')).toBeNull();
    expect(interceptor.listHooks().length).toBeGreaterThan(0);
  });

  it('getLastError persists errors per pid', async () => {
    const interceptor = makeInterceptor();
    interceptor.setLastError(7, E.ERROR_ACCESS_DENIED);
    expect(interceptor.getLastError(7)).toBe(E.ERROR_ACCESS_DENIED);
    expect(interceptor.getLastError(8)).toBe(0);
  });

  it('sets lastError from a failing dispatch', async () => {
    const interceptor = makeInterceptor();
    await interceptor.dispatch(ctx('kernel32.dll', 'Unknown.Api'));
    expect(interceptor.getLastError(1)).toBe(E.ERROR_NOT_IMPLEMENTED);
  });
});
