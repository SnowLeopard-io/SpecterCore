/**
 * Headless interactive verification for real x64 guests: runs the image with
 * `interactive: true` and drives the message loop from `onMessageWait` — posts
 * WM_CLOSE to the top-level window, then WM_QUIT as a fallback — so a guest
 * that reaches its message loop actually exits instead of blocking forever.
 *
 *   node node_modules/.cache/interact-x64.mjs apps/web/public/win/notepad-x64.exe
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ApiHost, FileSystemBridge } from '@specter-core/contracts';
import {
  ApiInterceptorImpl,
  GuestProcessRunner,
  JitEngineImpl,
  PeLoaderImpl,
  registerDefaultHandlers,
  WasmRuntimeImpl,
} from '@specter-core/core';

const WM_CLOSE = 0x0010;
const WM_QUIT = 0x0012;

function buildFs(exePath: string): FileSystemBridge {
  const notFound = 2 as unknown as never;
  return {
    async createFile() {
      return { handle: 0, error: notFound };
    },
    async readFile() {
      return { bytesRead: 0, data: new Uint8Array(0), error: notFound };
    },
    async writeFile() {
      return { bytesWritten: 0, error: notFound };
    },
    async setFilePointer() {
      return { newPointer: 0xffffffff, error: notFound };
    },
    async getFileSize() {
      return 0;
    },
    getFilePointer() {
      return 0;
    },
    async closeHandle() {
      return notFound;
    },
    async findFirstFile() {
      return { searchHandle: 0, entries: [], error: notFound };
    },
    async findNextFile() {
      return { entries: [], error: notFound };
    },
    async findClose() {},
    async createDirectory() {
      return notFound;
    },
    async removeDirectory() {
      return notFound;
    },
    async deleteFile() {
      return notFound;
    },
    async getFileAttributes() {
      return { attributes: 0x20, error: notFound };
    },
    async setFileAttributes() {
      return notFound;
    },
    async moveFile() {
      return notFound;
    },
    async lockFile() {
      return notFound;
    },
    async unlockFile() {
      return notFound;
    },
    async releaseAll() {},
    onChange() {
      return () => {};
    },
  };
}

async function main(): Promise<void> {
  const [file] = process.argv.slice(2);
  if (!file) {
    console.error('usage: interact-x64 <path-to.exe>');
    process.exit(2);
  }

  const image = new Uint8Array(await readFile(file));
  const modulePath = resolve(file);

  const runtime = new WasmRuntimeImpl();
  const host = {
    memory: {
      read: (address: number, length: number) => runtime.readBytes(address, length),
      write: (address: number, data: Uint8Array) => runtime.writeBytes(address, data),
    },
    fs: buildFs(modulePath),
  } as unknown as ApiHost;

  const interceptor = new ApiInterceptorImpl(host);
  registerDefaultHandlers(interceptor);
  const runner = new GuestProcessRunner(
    runtime,
    new JitEngineImpl(runtime),
    new PeLoaderImpl(),
    interceptor,
  );

  let waits = 0;
  let postedClose = false;
  const result = await runner.run(image, {
    createEngine: (mode) => new JitEngineImpl(runtime, mode),
    modulePath,
    interactive: true,
    readFile: async () => null,
    onOutput: () => {},
    onMessageWait: () => {
      waits++;
      const wins = runner.getWindows();
      const top = [...wins].find((w) => w.parent === 0) ?? wins[0];
      if (top && !postedClose) {
        postedClose = true;
        console.error(`[interact] wait #${waits} posting WM_CLOSE to hwnd=0x${top.hwnd.toString(16)} (${top.className})`);
        runner.postMessage({ hwnd: top.hwnd, msg: WM_CLOSE, wParam: 0, lParam: 0 });
      } else {
        console.error(`[interact] wait #${waits} posting WM_QUIT (windows=${wins.length})`);
        runner.postMessage({ hwnd: 0, msg: WM_QUIT, wParam: 0, lParam: 0 });
      }
    },
  });

  console.log(`[interact] status=${result.status} eip=0x${result.eip.toString(16)} exitCode=${result.exitCode} waits=${waits} windows=${runner.getWindows().length}`);
  if (result.error) console.error(`[interact] error: ${(result.error as Error).message}`);
}

main().catch((error) => {
  console.error('[interact] failed', error);
  process.exit(1);
});