/**
 * Probe: log EVERY SetDIBitsToDevice call (args + BITMAPINFO header) so we can
 * see how winmine draws the scoreboard vs the board tiles, and whether the
 * board path ever reaches SetDIBitsToDevice at all.
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
  private n = 0;
  constructor(host: ApiHost, rt: WasmRuntimeImpl) {
    super(host);
    this.rt = rt;
  }
  override async dispatch(ctx: ApiCallContext): Promise<ApiResult> {
    if (/SetDIBitsToDevice/i.test(ctx.proc)) {
      this.n++;
      const [hdc, xd, yd, dw, dh, xs, ys, us, cs, bits, bmi] = ctx.rawArgs ?? [];
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
      const biBitCount = rd((bmi ?? 0) + 14);
      sync(
        `[sdib#${this.n}] eip=0x${(ctx.eip ?? 0).toString(16)} hdc=0x${(hdc ?? 0).toString(16)} dest=(${xd},${yd}) ` +
          `src=${dw}x${dh} srcOff=(${xs},${ys}) scan=${us}..${us + cs - 1} bits=0x${(bits ?? 0).toString(16)} ` +
          `bmi=0x${(bmi ?? 0).toString(16)} bmiHeader=${biWidth}x${biHeight}@${biBitCount}bpp`,
      );
    } else if (/BitBlt/i.test(ctx.proc)) {
      const [d, x, y, w, h, s, sx, sy] = ctx.rawArgs ?? [];
      // Dump the 16 memDC handles at 0x1005a20 and the board cell at 0x1005340.
      let memdc = '';
      try {
        const arr = this.rt.readBytes(0x1005a20, 0x40);
        const v = new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
        const parts: string[] = [];
        for (let i = 0; i < 16; i++) parts.push(`0x${v.getUint32(i * 4, true).toString(16)}`);
        memdc = parts.join(',');
      } catch {
        memdc = '?';
      }
      let board = '';
      try {
        const arr = this.rt.readBytes(0x1005360, 0x140);
        const v = new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
        const parts: string[] = [];
        for (let i = 0; i < 0x140; i++) parts.push(v.getUint8(i).toString(16));
        board = parts.join('|');
      } catch {
        board = '?';
      }
      sync(
        `[bitblt] eip=0x${(ctx.eip ?? 0).toString(16)} dest=0x${(d ?? 0).toString(16)} (${x},${y} ${w}x${h}) ` +
          `src=0x${(s ?? 0).toString(16)} (${sx},${sy}) rop=0x${((ctx.rawArgs?.[8] ?? 0) >>> 0).toString(16)} memDC=[${memdc}] board=[${board}]`,
      );
    } else if (/CreateCompatibleDC/i.test(ctx.proc)) {
      sync(`[ccdc] eip=0x${(ctx.eip ?? 0).toString(16)} src=0x${((ctx.rawArgs?.[0] ?? 0) >>> 0).toString(16)}`);
    } else if (/CreateCompatibleBitmap/i.test(ctx.proc)) {
      sync(`[ccbm] eip=0x${(ctx.eip ?? 0).toString(16)} dc=0x${((ctx.rawArgs?.[0] ?? 0) >>> 0).toString(16)} ${ctx.rawArgs?.[1]}x${ctx.rawArgs?.[2]}`);
    } else if (/SelectObject/i.test(ctx.proc)) {
      sync(`[selobj] eip=0x${(ctx.eip ?? 0).toString(16)} dc=0x${((ctx.rawArgs?.[0] ?? 0) >>> 0).toString(16)} obj=0x${((ctx.rawArgs?.[1] ?? 0) >>> 0).toString(16)}`);
    } else if (/DeleteDC/i.test(ctx.proc)) {
      sync(`[deldc] eip=0x${(ctx.eip ?? 0).toString(16)} dc=0x${((ctx.rawArgs?.[0] ?? 0) >>> 0).toString(16)}`);
    } else if (/GetDC/i.test(ctx.proc)) {
      sync(`[getdc] eip=0x${(ctx.eip ?? 0).toString(16)} hwnd=0x${((ctx.rawArgs?.[0] ?? 0) >>> 0).toString(16)}`);
    } else if (/ReleaseDC/i.test(ctx.proc)) {
      sync(`[reldc] eip=0x${(ctx.eip ?? 0).toString(16)} hwnd=0x${((ctx.rawArgs?.[0] ?? 0) >>> 0).toString(16)} dc=0x${((ctx.rawArgs?.[1] ?? 0) >>> 0).toString(16)}`);
    } else if (/BeginPaint/i.test(ctx.proc)) {
      sync(`[beginpaint] eip=0x${(ctx.eip ?? 0).toString(16)} hwnd=0x${((ctx.rawArgs?.[0] ?? 0) >>> 0).toString(16)}`);
    } else if (/EndPaint/i.test(ctx.proc)) {
      sync(`[endpaint] eip=0x${(ctx.eip ?? 0).toString(16)} hwnd=0x${((ctx.rawArgs?.[0] ?? 0) >>> 0).toString(16)}`);
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
  sync(`[run] status=${result.status} eip=0x${result.eip.toString(16)} api=${interceptor.apiCount} sdib=${interceptor['n']}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
