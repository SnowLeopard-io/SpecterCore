/**
 * Probe: dump the FULL runtime DIB (24x120, 4bpp) from guest memory at the
 * first SetDIBitsToDevice call, rendered bottom-up with biWidth stride (12B).
 * This reveals the true sprite-sheet layout winmine draws from.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ApiCallContext, ApiHost, ApiInterceptor, ApiResult, FileSystemBridge, WinError } from '@specter-core/contracts';
import {
  ApiInterceptorImpl,
  GuestProcessRunner,
  JitEngineImpl,
  PeLoaderImpl,
  registerDefaultHandlers,
  WasmRuntimeImpl,
} from '@specter-core/core';

const sync = (line: string): void => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('node:fs').writeSync(2, `${line}\n`);
  } catch {
    console.error(line);
  }
};

function buildExeFs(exePath: string, exeBytes: Uint8Array): FileSystemBridge {
  const handles = new Map<number, { ptr: number }>();
  let next = 1;
  const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();
  const self = norm(exePath);
  const ok0 = 0 as WinError;
  const notFound = 2 as WinError;
  const denied = 5 as WinError;
  const invalidHandle = 6 as WinError;
  return {
    async createFile(path) {
      if (norm(path) === self) {
        handles.set(next, { ptr: 0 });
        return { handle: next++, error: ok0 };
      }
      return { handle: 0, error: notFound };
    },
    async readFile(handle, bytesToRead) {
      const rec = handles.get(handle);
      if (!rec) return { bytesRead: 0, data: new Uint8Array(0), error: invalidHandle };
      const end = Math.min(rec.ptr + bytesToRead, exeBytes.length);
      const data = exeBytes.slice(rec.ptr, end);
      rec.ptr = end;
      return { bytesRead: data.length, data, error: ok0 };
    },
    async writeFile() {
      return { bytesWritten: 0, error: denied };
    },
    async setFilePointer(handle, distance, moveMethod) {
      const rec = handles.get(handle);
      if (!rec) return { newPointer: 0xffffffff, error: invalidHandle };
      const base = moveMethod === 2 ? exeBytes.length : moveMethod === 1 ? rec.ptr : 0;
      rec.ptr = Math.max(0, base + distance);
      return { newPointer: rec.ptr, error: ok0 };
    },
    async getFileSize() {
      return exeBytes.length;
    },
    getFilePointer(handle) {
      return handles.get(handle)?.ptr ?? 0;
    },
    async closeHandle(handle) {
      handles.delete(handle);
      return ok0;
    },
    async findFirstFile() {
      return { searchHandle: 0, entries: [], error: notFound };
    },
    async findNextFile() {
      return { entries: [], error: notFound };
    },
    async findClose() {},
    async createDirectory() {
      return denied;
    },
    async removeDirectory() {
      return notFound;
    },
    async deleteFile() {
      return denied;
    },
    async getFileAttributes() {
      return { attributes: 0x20, error: ok0 };
    },
    async setFileAttributes() {
      return denied;
    },
    async moveFile() {
      return denied;
    },
    async lockFile() {
      return 120 as WinError;
    },
    async unlockFile() {
      return 120 as WinError;
    },
    async releaseAll() {
      handles.clear();
    },
    onChange() {
      return () => {};
    },
  };
}

class ProbeInterceptor extends ApiInterceptorImpl implements ApiInterceptor {
  private readonly rt: WasmRuntimeImpl;
  private done = false;
  constructor(host: ApiHost, rt: WasmRuntimeImpl) {
    super(host);
    this.rt = rt;
  }
  override async dispatch(ctx: ApiCallContext): Promise<ApiResult> {
    if (/SetDIBitsToDevice/i.test(ctx.proc) && !this.done) {
      this.done = true;
      const bits = ctx.rawArgs?.[9] ?? 0;
      const bmi = ctx.rawArgs?.[10] ?? 0;
      const rd = (a: number): number => {
        try {
          const b = this.rt.readBytes(a >>> 0, 4);
          return new DataView(b.buffer, b.byteOffset, 4).getInt32(0, true);
        } catch {
          return -1;
        }
      };
      const biWidth = rd((bmi ?? 0) + 4);
      const biHeight = rd((bmi ?? 0) + 8);
      sync(`[dump] bits=0x${(bits ?? 0).toString(16)} bmi=0x${(bmi ?? 0).toString(16)} w=${biWidth} h=${biHeight}`);
      const CHARS = ' .:-=+*#%@';
      const stride = Math.floor((biWidth * 4 + 31) / 32) * 4;
      // bottom-up: memory row 0 = bottom of image
      for (let row = biHeight - 1; row >= 0; row--) {
        const base = (bits >>> 0) + row * stride;
        const bytes = this.rt.readBytes(base, stride);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        let line = '';
        for (let c = 0; c < biWidth; c++) {
          const byte = view.getUint8((c / 2) | 0);
          const idx = c % 2 === 0 ? (byte >> 4) & 0xf : byte & 0xf;
          line += CHARS[Math.min(idx, CHARS.length - 1)] ?? '?';
        }
        sync(`  ${line}`);
      }
    }
    return super.dispatch(ctx);
  }
}

async function main(): Promise<void> {
  const file = resolve(process.argv[2] ?? 'C:/Users/HUAWEI/Desktop/windows/apps/web/public/win/winmine.exe');
  const image = new Uint8Array(await readFile(file));
  const modulePath = resolve(file);

  const runtime = new WasmRuntimeImpl();
  const host = {
    memory: {
      read: (address: number, length: number) => runtime.readBytes(address, length),
      write: (address: number, data: Uint8Array) => runtime.writeBytes(address, data),
    },
    fs: buildExeFs(modulePath, image),
  } as unknown as ApiHost;

  const interceptor = new ProbeInterceptor(host, runtime);
  registerDefaultHandlers(interceptor);
  const runner = new GuestProcessRunner(runtime, new JitEngineImpl(runtime), new PeLoaderImpl(), interceptor);

  const result = await runner.run(image, {
    createEngine: (mode) => new JitEngineImpl(runtime, mode),
    modulePath,
    readFile: async (p) => {
      try {
        return new Uint8Array(await readFile(p));
      } catch {
        return null;
      }
    },
  });
  sync(`[run] status=${result.status} eip=0x${result.eip.toString(16)} api=${interceptor.apiCount}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
