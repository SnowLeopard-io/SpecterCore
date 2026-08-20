/**
 * Diagnostic: run a Windows x86 PE (32-bit VSCode installer) through the
 * SpecterCore JIT and dump the full API call sequence + UI state so we can see
 * exactly where startup aborts. New file — does NOT modify any JIT-core file.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ApiHost, FileSystemBridge, WinError } from '@specter-core/contracts';
import {
  ApiInterceptorImpl,
  GuestProcessRunner,
  JitEngineImpl,
  PeLoaderImpl,
  registerDefaultHandlers,
  WasmRuntimeImpl,
} from '@specter-core/core';

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

async function main(): Promise<void> {
  const [file] = process.argv.slice(2);
  if (!file) {
    console.error('usage: diag-vscode <path-to.exe>');
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
    fs: buildExeFs(modulePath, image),
  } as unknown as ApiHost;

  const interceptor = new ApiInterceptorImpl(host);
  registerDefaultHandlers(interceptor);
  const runner = new GuestProcessRunner(
    runtime,
    new JitEngineImpl(runtime),
    new PeLoaderImpl(),
    interceptor,
  );

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
    onOutput: (bytes, stderr) => {
      process[stderr ? 'stderr' : 'stdout'].write(Buffer.from(bytes));
    },
  });

  console.error(`\n[diag] status=${result.status} cleanExit=${result.cleanExit} eip=0x${result.eip.toString(16)} exitCode=${result.exitCode}`);
  console.error(`[diag] stubs(${result.stubs.length}) windows(${result.windows.length}) paint(${result.paintCommands.length}) muiLoaded=${result.muiLoaded} muiSource=${result.muiSource}`);
  if (result.output.byteLength > 0) console.error(`[diag] stdout: ${JSON.stringify(new TextDecoder().decode(result.output))}`);
  if (result.stderrOutput.byteLength > 0) console.error(`[diag] stderr: ${JSON.stringify(new TextDecoder().decode(result.stderrOutput))}`);
  if (result.windows.length) {
    for (const w of result.windows) console.error(`[diag]   window: title=${JSON.stringify(w.text)} parent=${w.parent} menuSections=${w.menu.length}`);
  }

  console.error(`\n[diag] === API call sequence (${result.stubs.length}) ===`);
  result.stubs.forEach((s, i) => {
    console.error(`  ${String(i).padStart(3, ' ')}  ${s.module}.${s.proc}`);
  });
  if (result.error) console.error(`\n[diag] error:`, result.error);
}

main().catch((error) => {
  console.error('[diag] failed', error);
  process.exit(1);
});
