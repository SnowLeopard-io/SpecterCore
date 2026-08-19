/**
 * Headless CLI: run a Windows x86 PE through the SpecterCore JIT.
 *
 *   pnpm run:exe -- path/to/app.exe
 *
 * The exe is loaded and mapped into the shared WASM linear memory, executed by
 * the x86->WASM JIT, and its API traps are dispatched to the interceptor.
 * stdout/stderr (WriteFile on the console pseudo-handles) are printed live.
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
  UnsupportedError,
  WasmRuntimeImpl,
  X86Decoder,
} from '@specter-core/core';

/**
 * Minimal read-only fs bridge serving the exe itself — enough for the guest
 * (e.g. Inno Setup) to reopen its own file and read the archive overlay.
 */
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

async function main(): Promise<void> {
  const [file, ...args] = process.argv.slice(2);
  if (!file) {
    console.error('usage: run:exe <path-to.exe> [args...]');
    process.exit(2);
  }
  void args; // command line marshalling is not implemented yet (P2)

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

  const label =
    result.status === 'exit'
      ? result.cleanExit
        ? `exit code ${result.exitCode}`
        : `entry returned WITHOUT ExitProcess (startup aborted, eip=0x${result.eip.toString(16)})`
      : result.status === 'fault'
        ? 'fault'
        : result.status === 'trap'
          ? 'trapped'
          : 'step limit reached';
  console.error(`\n[run-exe] ${label} (eip=0x${result.eip.toString(16)}, stubs=${result.stubs.length})`);
  if (result.output.byteLength > 0) console.error(`[run-exe] captured stdout: ${JSON.stringify(new TextDecoder().decode(result.output))}`);
  if (result.stderrOutput.byteLength > 0) console.error(`[run-exe] captured stderr: ${JSON.stringify(new TextDecoder().decode(result.stderrOutput))}`);

  if (result.status !== 'exit') {
    if (result.error) console.error(`[run-exe] error:`, result.error);
    diagnose(runtime, result.eip, is64(image));
    process.exit(1);
  }
}

/** Sniffs whether `image` is a 64-bit PE32+ from its optional-header magic. */
function is64(image: Uint8Array): boolean {
  try {
    const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
    if (view.getUint16(0, true) !== 0x5a4d) return false;
    const eLfanew = view.getUint32(0x3c, true);
    return view.getUint16(eLfanew + 4 + 20, true) === 0x20b;
  } catch {
    return false;
  }
}

/** Decodes the instruction at `eip` to explain why execution stopped. */
function diagnose(runtime: WasmRuntimeImpl, eip: number, is64: boolean): void {
  const decoder = new X86Decoder(is64 ? 'x64' : 'x86');
  const bytes = runtime.readBytes(eip, 1024);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(' ');
  console.error(`[run-exe] at 0x${eip.toString(16)}: ${hex}`);
  try {
    const decoded = decoder.decode(bytes, eip);
    for (const di of decoded.instructions) {
      console.error(`[run-exe]   ${di.inst.op} (len ${di.length})`);
    }
  } catch (error) {
    if (error instanceof UnsupportedError) {
      console.error(`[run-exe]   unsupported: ${error.message}`);
    } else {
      console.error(`[run-exe]   decode error: ${String(error)}`);
    }
  }
}

main().catch((error) => {
  console.error('[run-exe] failed', error);
  process.exit(1);
});
