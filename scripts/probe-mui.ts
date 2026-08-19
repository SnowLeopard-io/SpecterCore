/**
 * Temporary probe: simulate the browser path end-to-end — bundled notepad +
 * MUI provisioned into a MemoryFileStore "virtual disk", then run the guest
 * with modulePath + a readFile that resolves from that disk (exactly what
 * RunExecutableApp/launchGuestWindow do). Prints the MUI merge status and
 * the parsed menu bar.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { MemoryFileStore } from '@specter-core/host';
import { toStorePath } from '@specter-core/shared';
import { GuestProcessRunner, JitEngineImpl, WasmRuntimeImpl, PeLoaderImpl, ApiInterceptorImpl, registerDefaultHandlers } from '@specter-core/core';

const root = 'C:/Users/HUAWEI/Desktop/windows/apps/web/dist/win';
const exeBytes = new Uint8Array(await readFile(resolve(root, 'notepad.exe')));
const muiEn = new Uint8Array(await readFile(resolve(root, 'en-US/notepad.exe.mui')));
const muiZh = new Uint8Array(await readFile(resolve(root, 'zh-CN/notepad.exe.mui')));

const disk = new MemoryFileStore('C');
const filesToWrite: Array<[string, Uint8Array]> = [
  ['Windows/SysWOW64/notepad.exe', exeBytes],
  ['Windows/SysWOW64/en-US/notepad.exe.mui', muiEn],
  ['Windows/SysWOW64/zh-CN/notepad.exe.mui', muiZh],
];
const allDirs = new Set<string>();
for (const [p] of filesToWrite) {
  const dirs = p.split('/').slice(0, -1);
  let cur = '';
  for (const d of dirs) {
    cur = cur ? `${cur}/${d}` : d;
    allDirs.add(cur);
  }
}
for (const d of allDirs) await disk.createDirectory(d);
for (const [p, data] of filesToWrite) {
  const f = await disk.openFile(p, 'create');
  try {
    await f.write(0, data);
  } finally {
    await f.close();
  }
}
console.log('[probe] virtual disk provisioned');

const runtime = new WasmRuntimeImpl();
const loader = new PeLoaderImpl();
const interceptor = new ApiInterceptorImpl({
  fs: undefined as never,
  gdi: undefined as never,
  audio: undefined as never,
  usb: undefined as never,
  process: undefined as never,
  memory: {
    read: (a, n) => runtime.readBytes(a, n),
    write: (a, d) => runtime.writeBytes(a, d),
  },
});
registerDefaultHandlers(interceptor);
const runner = new GuestProcessRunner(runtime, new JitEngineImpl(runtime), loader, interceptor);
const result = await runner.run(exeBytes, {
  maxSteps: 8_000_000,
  createEngine: (mode) => new JitEngineImpl(runtime, mode),
  modulePath: 'C:/Windows/SysWOW64/notepad.exe',
  readFile: async (p) => {
    const sp = toStorePath(p);
    try {
      const f = await disk.openFile(sp, 'read');
      try {
        const size = await f.size();
        return await f.read(0, size);
      } finally {
        await f.close();
      }
    } catch {
      return null;
    }
  },
});
console.log(`[probe] status=${result.status} cleanExit=${result.cleanExit} muiLoaded=${result.muiLoaded} muiSource=${result.muiSource}`);
for (const w of result.windows) {
  console.log(`[probe] win ${w.hwnd.toString(16)} class=${w.className} parent=${w.parent.toString(16)} text="${w.text}"`);
  for (const s of w.menu) {
    console.log(`[probe]   menu "${s.title}": ${s.items.map((i) => `${i.id}:${i.label}`).join(' | ')}`);
  }
}
