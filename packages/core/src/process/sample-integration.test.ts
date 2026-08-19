import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ApiHost, FileSystemBridge, WinError } from '@specter-core/contracts';
import { ApiInterceptorImpl } from '../api/interceptor';
import { registerDefaultHandlers } from '../api/handlers';
import { PeLoaderImpl } from '../pe/loader';
import { WasmRuntimeImpl } from '../jit/runtime';
import { JitEngineImpl } from '../jit/engine';
import { GuestProcessRunner } from './guest-process';

const SAMPLE = join('sample', 'hello.exe');
const skip = !existsSync(SAMPLE);

/**
 * 9.4 集成测试：把 `sample/hello.exe` 走完 PE 加载 → JIT → API 拦截 →
 * 控制台输出的全链路，验证 "hello from specter-core!" 与退出码 7。
 * 其余 7.2 兼容性应用（notepad/cmd 等）在跑通后逐个加入本文件。
 */
describe.skipIf(skip)('sample/hello.exe（全链路集成，设计文档 9.4）', () => {
  it('打印消息并以退出码 7 结束', async () => {
    const image = new Uint8Array(await readFile(SAMPLE));
    const runtime = new WasmRuntimeImpl(64);

    const host = {
      fs: buildExeFs(resolve(SAMPLE), image),
      memory: {
        read: (address: number, length: number) => runtime.readBytes(address, length),
        write: (address: number, data: Uint8Array) => runtime.writeBytes(address, data),
      },
    } as unknown as ApiHost;

    const interceptor = new ApiInterceptorImpl(host);
    registerDefaultHandlers(interceptor);
    const runner = new GuestProcessRunner(
      runtime,
      new JitEngineImpl(runtime),
      new PeLoaderImpl(),
      interceptor,
    );

    const stdout: Uint8Array[] = [];
    const result = await runner.run(image, {
      createEngine: (mode) => new JitEngineImpl(runtime, mode),
      modulePath: resolve(SAMPLE),
      onOutput: (bytes, stderr) => {
        if (!stderr) stdout.push(bytes);
      },
    });

    expect(result.status).toBe('exit');
    expect(result.cleanExit).toBe(true);
    expect(result.exitCode).toBe(7);
    expect(new TextDecoder().decode(result.output)).toBe('hello from browser-kernel!\n');
    expect(stdout.length).toBeGreaterThan(0);
    expect(result.stubs.map((s) => s.proc)).toEqual([
      'GetTickCount',
      'GetStdHandle',
      'WriteFile',
      'ExitProcess',
    ]);
  });
});

/** 只读文件桥：仅允许 exe 重开自身（与 scripts/run-exe.ts 一致）。 */
function buildExeFs(exePath: string, exeBytes: Uint8Array): FileSystemBridge {
  const handles = new Map<number, { ptr: number }>();
  let next = 1;
  const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();
  const self = norm(exePath);
  const ok0 = 0 as WinError;
  const notFound = 2 as WinError;
  const denied = 5 as WinError;
  const invalidHandle = 6 as WinError;
  const notImpl = 120 as WinError;
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
      return notImpl;
    },
    async unlockFile() {
      return notImpl;
    },
    async releaseAll() {
      handles.clear();
    },
  };
}
