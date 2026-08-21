/**
 * Headless render probe for notepad-x64: attaches a logging GDI bridge and
 * hooks PostQuitMessage/ExitProcess to discover whether the guest
 * (a) pumps WM_PAINT and issues GDI draws through the bridge, or
 * (b) exits on its own immediately (XAML/WinUI content we don't emulate).
 *
 *   node node_modules/.cache/probe-render.mjs apps/web/public/win/notepad-x64.exe
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ApiHost, FileSystemBridge, GdiBridge } from '@specter-core/contracts';
import {
  ApiInterceptorImpl,
  GuestProcessRunner,
  JitEngineImpl,
  PeLoaderImpl,
  registerDefaultHandlers,
  WasmRuntimeImpl,
} from '@specter-core/core';

const notFound = 2 as unknown as never;

function buildFs(): FileSystemBridge {
  return {
    async createFile() { return { handle: 0, error: notFound }; },
    async readFile() { return { bytesRead: 0, data: new Uint8Array(0), error: notFound }; },
    async writeFile() { return { bytesWritten: 0, error: notFound }; },
    async setFilePointer() { return { newPointer: 0xffffffff, error: notFound }; },
    async getFileSize() { return 0; },
    getFilePointer() { return 0; },
    async closeHandle() { return notFound; },
    async findFirstFile() { return { searchHandle: 0, entries: [], error: notFound }; },
    async findNextFile() { return { entries: [], error: notFound }; },
    async findClose() {},
    async createDirectory() { return notFound; },
    async removeDirectory() { return notFound; },
    async deleteFile() { return notFound; },
    async getFileAttributes() { return { attributes: 0x20, error: notFound }; },
    async setFileAttributes() { return notFound; },
    async moveFile() { return notFound; },
    async lockFile() { return notFound; },
    async unlockFile() { return notFound; },
    async releaseAll() {},
    onChange() { return () => {}; },
  };
}

class LogBridge implements GdiBridge {
  hwnd: number;
  constructor(hwnd: number) { this.hwnd = hwnd; }
  async createDC(name: string) { console.error(`[gdi] hwnd=0x${this.hwnd.toString(16)} createDC name=${name}`); return 1; }
  async createCompatibleDC(_dc: number) { return 2; }
  async deleteDC() {}
  async textOut(dc: number, x: number, y: number, text: string) { console.error(`[gdi] hwnd=0x${this.hwnd.toString(16)} TextOut dc=${dc} (${x},${y}) "${text.slice(0, 24)}"`); return 0 as unknown as never; }
  async setTextColor() { return 0 as unknown as never; }
  async setBkColor() { return 0 as unknown as never; }
  async setBkMode() { return 0 as unknown as never; }
  async lineTo(dc: number, x0: number, y0: number, x1: number, y1: number) { console.error(`[gdi] hwnd=0x${this.hwnd.toString(16)} lineTo dc=${dc} (${x0},${y0})-(${x1},${y1})`); return 0 as unknown as never; }
  async fillRect(dc: number, rect: { x: number; y: number; width: number; height: number }, color: { r: number; g: number; b: number }) { console.error(`[gdi] hwnd=0x${this.hwnd.toString(16)} FillRect dc=${dc} (${rect.x},${rect.y},${rect.width},${rect.height}) rgb(${color.r},${color.g},${color.b})`); return 0 as unknown as never; }
  async frameRect(dc: number, rect: { x: number; y: number; width: number; height: number }) { console.error(`[gdi] hwnd=0x${this.hwnd.toString(16)} frameRect dc=${dc} (${rect.x},${rect.y},${rect.width},${rect.height})`); return 0 as unknown as never; }
  async ellipse(dc: number, b: unknown) { console.error(`[gdi] hwnd=0x${this.hwnd.toString(16)} ellipse dc=${dc}`); return 0 as unknown as never; }
  async frameEllipse(dc: number, b: unknown) { return 0 as unknown as never; }
  async roundRect(dc: number, b: unknown) { return 0 as unknown as never; }
  async polyline(dc: number, pts: unknown) { console.error(`[gdi] hwnd=0x${this.hwnd.toString(16)} polyline dc=${dc} pts=${JSON.stringify(pts)}`); return 0 as unknown as never; }
  async polygon(dc: number, pts: unknown) { console.error(`[gdi] hwnd=0x${this.hwnd.toString(16)} polygon dc=${dc}`); return 0 as unknown as never; }
  async setPixel(dc: number, x: number, y: number) { console.error(`[gdi] hwnd=0x${this.hwnd.toString(16)} setPixel dc=${dc} (${x},${y})`); return 0 as unknown as never; }
  async setClip() {}
  async getClip() { return null; }
  async saveDC() { return 1; }
  async restoreDC() { return 0 as unknown as never; }
  async bitBlt(dc: number, dr: unknown, sdc: number, sr: unknown) { console.error(`[gdi] hwnd=0x${this.hwnd.toString(16)} BitBlt dc=${dc} src=${sdc}`); return 0 as unknown as never; }
  async stretchBlt() { return 0 as unknown as never; }
  async patBlt(dc: number, rect: unknown, color: unknown) { console.error(`[gdi] hwnd=0x${this.hwnd.toString(16)} PatBlt dc=${dc}`); return 0 as unknown as never; }
  async getDeviceCaps(dc: number) { console.error(`[gdi] hwnd=0x${this.hwnd.toString(16)} getDeviceCaps dc=${dc}`); return { bitsPerPixel: 32, width: 800, height: 560 } as unknown as never; }
  async flush(dc: number) { console.error(`[gdi] hwnd=0x${this.hwnd.toString(16)} flush dc=${dc}`); }
  onInvalidate(_l: (dc: number, rect: unknown) => void) { return () => {}; }
}

const bridges = new Map<number, GdiBridge>();

async function main(): Promise<void> {
  const [file] = process.argv.slice(2);
  if (!file) { console.error('usage: probe-render <exe>'); process.exit(2); }

  const image = new Uint8Array(await readFile(file));
  const modulePath = resolve(file);
  const runtime = new WasmRuntimeImpl();
  const host = {
    memory: {
      read: (a: number, l: number) => runtime.readBytes(a, l),
      write: (a: number, d: Uint8Array) => runtime.writeBytes(a, d),
    },
    fs: buildFs(),
  } as unknown as ApiHost;

  const interceptor = new ApiInterceptorImpl(host);
  registerDefaultHandlers(interceptor);
  interceptor.hook('user32.dll', 'PostQuitMessage', () => {
    console.error('[probe] PostQuitMessage called (wParam=?)');
    return { returnValue: 0, errorCode: 0 };
  });
  interceptor.hook('kernel32.dll', 'ExitProcess', () => {
    console.error('[probe] ExitProcess called');
    return { returnValue: 0, errorCode: 0 };
  });

  const runner = new GuestProcessRunner(
    runtime,
    new JitEngineImpl(runtime),
    new PeLoaderImpl(),
    interceptor,
  );

  let waits = 0;
  const result = await runner.run(image, {
    createEngine: (mode) => new JitEngineImpl(runtime, mode),
    modulePath,
    interactive: true,
    readFile: async () => null,
    onOutput: () => {},
    gdiBridge: (hwnd) => {
      let b = bridges.get(hwnd);
      if (!b) { b = new LogBridge(hwnd); bridges.set(hwnd, b); console.error(`[probe] bridge attached hwnd=0x${hwnd.toString(16)}`); }
      return b;
    },
    onMessageWait: () => {
      waits++;
      const wins = runner.getWindows();
      console.error(`[probe] GetMessageW blocked (wait #${waits}) windows=${wins.length}`);
      if (waits <= 3) {
        for (const w of wins) runner.postMessage({ hwnd: w.hwnd, msg: 0x000f /* WM_PAINT */, wParam: 0, lParam: 0 });
      } else {
        console.error('[probe] giving up — posting WM_QUIT');
        runner.postMessage({ hwnd: 0, msg: 0x0012 /* WM_QUIT */, wParam: 0, lParam: 0 });
      }
    },
  });

  console.log(`[probe] status=${result.status} eip=0x${result.eip.toString(16)} exitCode=${result.exitCode} waits=${waits}`);
}

main().catch((e) => { console.error('[probe] failed', e); process.exit(1); });