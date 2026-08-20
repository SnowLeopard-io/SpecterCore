import type { FileStore } from '@specter-core/contracts';

/**
 * Bundled Windows tools copied into the virtual disk so the guest runs with
 * real MUI satellite resources (notepad's strings/menus live in
 * notepad.exe.mui, not the exe itself). Provisioned lazily on first launch
 * (and by the web bootstrap), so the disk is always usable even if the
 * startup provision failed or the user wiped storage.
 */
export const BUILTIN_WIN_FILES: Array<{ url: string; storePath: string }> = [
  { url: '/win/notepad.exe', storePath: 'Windows/SysWOW64/notepad.exe' },
  { url: '/win/en-US/notepad.exe.mui', storePath: 'Windows/SysWOW64/en-US/notepad.exe.mui' },
  { url: '/win/zh-CN/notepad.exe.mui', storePath: 'Windows/SysWOW64/zh-CN/notepad.exe.mui' },
  // Real cmd.exe (+ MUI) so the desktop "Command Prompt" app runs the actual
  // guest binary instead of a JS reimplementation (see launchGuestConsole).
  { url: '/win/cmd.exe', storePath: 'Windows/SysWOW64/cmd.exe' },
  { url: '/win/en-US/cmd.exe.mui', storePath: 'Windows/SysWOW64/en-US/cmd.exe.mui' },
  { url: '/win/zh-CN/cmd.exe.mui', storePath: 'Windows/SysWOW64/zh-CN/cmd.exe.mui' },
  // Real files copied from the host C: drive so the virtual disk (and the
  // file explorer / notepad open dialog) has genuine content by default.
  { url: '/win/win.ini', storePath: 'Windows/win.ini' },
  { url: '/win/hosts', storePath: 'Windows/System32/drivers/etc/hosts' },
  { url: '/win/readme.txt', storePath: 'Users/Public/Documents/readme.txt' },
  // A handful of real Windows system fonts (small subset; copied from the
  // host at build time) so guest apps that load fonts via AddFontResource/
  // GDI have real glyph data instead of broken placeholder TTF stubs.
  { url: '/win/Fonts/arial.ttf', storePath: 'Windows/Fonts/arial.ttf' },
  { url: '/win/Fonts/arialbd.ttf', storePath: 'Windows/Fonts/arialbd.ttf' },
  { url: '/win/Fonts/tahoma.ttf', storePath: 'Windows/Fonts/tahoma.ttf' },
  { url: '/win/Fonts/consola.ttf', storePath: 'Windows/Fonts/consola.ttf' },
];

/** Idempotent: writes each bundled file when missing/empty (fetch + write). */
export async function ensureBuiltinWinFiles(fs: FileStore): Promise<void> {
  for (const f of BUILTIN_WIN_FILES) {
    // Skip only when a real (non-empty) copy already exists — a stale empty
    // file (e.g. created by an old openFile('read') bug) must be overwritten.
    let existing = null;
    try {
      existing = await fs.stat(f.storePath);
    } catch {
      // missing directory tree or other FS error — rewrite below
    }
    if (existing && existing.kind === 'file' && existing.size > 0) continue;
    const res = await fetch(f.url);
    if (!res.ok) {
      console.warn(`[specter-core] builtin fetch failed ${f.url}: ${res.status}`);
      continue;
    }
    const data = new Uint8Array(await res.arrayBuffer());
    const dirs = f.storePath.split('/').slice(0, -1);
    let cur = '';
    for (const d of dirs) {
      cur = cur ? `${cur}/${d}` : d;
      try {
        await fs.createDirectory(cur);
      } catch {
        // already exists
      }
    }
    const file = await fs.openFile(f.storePath, 'write');
    try {
      await file.write(0, data);
    } finally {
      await file.close();
    }
    console.warn(`[specter-core] provisioned ${f.storePath} (${data.byteLength} bytes)`);
  }
}
