import type { FileStore } from '@specter-core/contracts';

/**
 * Bundled Windows tools copied into the virtual disk so the guest runs with
 * real MUI satellite resources (notepad's strings/menus live in
 * notepad.exe.mui, not the exe itself). Provisioned lazily on first launch
 * (and by the web bootstrap), so the disk is always usable even if the
 * startup provision failed or the user wiped storage.
 */
export const BUILTIN_WIN_FILES: Array<{ url: string; storePath: string }> = [
  { url: 'win/notepad.exe', storePath: 'Windows/SysWOW64/notepad.exe' },
  { url: 'win/en-US/notepad.exe.mui', storePath: 'Windows/SysWOW64/en-US/notepad.exe.mui' },
  { url: 'win/zh-CN/notepad.exe.mui', storePath: 'Windows/SysWOW64/zh-CN/notepad.exe.mui' },
  // Real cmd.exe (+ MUI) so the desktop "Command Prompt" app runs the actual
  // guest binary instead of a JS reimplementation (see launchGuestConsole).
  { url: 'win/cmd.exe', storePath: 'Windows/SysWOW64/cmd.exe' },
  { url: 'win/en-US/cmd.exe.mui', storePath: 'Windows/SysWOW64/en-US/cmd.exe.mui' },
  { url: 'win/zh-CN/cmd.exe.mui', storePath: 'Windows/SysWOW64/zh-CN/cmd.exe.mui' },
  // Real files copied from the host C: drive so the virtual disk (and the
  // file explorer / notepad open dialog) has genuine content by default.
  { url: 'win/win.ini', storePath: 'Windows/win.ini' },
  { url: 'win/hosts', storePath: 'Windows/System32/drivers/etc/hosts' },
  { url: 'win/readme.txt', storePath: 'Users/Public/Documents/readme.txt' },
  // A handful of real Windows system fonts (small subset; copied from the
  // host at build time) so guest apps that load fonts via AddFontResource/
  // GDI have real glyph data instead of broken placeholder TTF stubs.
  { url: 'win/Fonts/arial.ttf', storePath: 'Windows/Fonts/arial.ttf' },
  { url: 'win/Fonts/arialbd.ttf', storePath: 'Windows/Fonts/arialbd.ttf' },
  { url: 'win/Fonts/tahoma.ttf', storePath: 'Windows/Fonts/tahoma.ttf' },
  { url: 'win/Fonts/consola.ttf', storePath: 'Windows/Fonts/consola.ttf' },
];

/**
 * Bundled music seeded into the virtual disk's Music folder so the Audio
 * Player app has real playable content out of the box.
 *
 * Source files live under apps/web/public/media/music/. Add your own songs by
 * dropping the file into that folder and appending one entry here:
 *
 *   { url: 'media/music/my-song.mp3', storePath: 'Users/Public/Music/my-song.mp3' },
 *
 * The Audio Player opens any audio file via the file association in
 * @specter-core/shared (mp3/wav/ogg/flac/aac/m4a -> audio-player).
 *
 * See apps/web/public/media/README.md for the full guide on extending the
 * default multimedia content (music / images / videos).
 */
export const BUILTIN_MUSIC_FILES: Array<{ url: string; storePath: string }> = [
  { url: 'media/music/Dream It Possible.mp3', storePath: 'Users/Public/Music/Dream It Possible.mp3' },
  { url: 'media/music/Over the Horizon.mp3', storePath: 'Users/Public/Music/Over the Horizon.mp3' },
  { url: 'media/music/We Are The Brave.mp3', storePath: 'Users/Public/Music/We Are The Brave.mp3' },
  { url: 'media/music/Windows95.mp3', storePath: 'Users/Public/Music/Windows95.mp3' },
];

/**
 * Bundled images seeded into the virtual disk's Pictures folder so the Photos
 * app has real content out of the box. Drop images into
 * apps/web/public/media/images/ and append one entry here:
 *
 *   { url: 'media/images/my-photo.jpg', storePath: 'Users/Public/Pictures/my-photo.jpg' },
 *
 * The Photos app opens any image via the file association in @specter-core/shared
 * (png/jpg/jpeg/gif/bmp/webp/ico -> image-viewer).
 *
 * See apps/web/public/media/README.md for the full guide.
 */

/** Expand a contiguous `NN.jpg` sequence (01..14) into builtin image entries. */
function imageRange(from: number, to: number): Array<{ url: string; storePath: string }> {
  const out: Array<{ url: string; storePath: string }> = [];
  for (let i = from; i <= to; i++) {
    const name = `${String(i).padStart(2, '0')}.jpg`;
    out.push({ url: `media/images/${name}`, storePath: `Users/Public/Pictures/${name}` });
  }
  return out;
}

export const BUILTIN_IMAGE_FILES: Array<{ url: string; storePath: string }> = [
  ...imageRange(1, 14),
];

/** Store paths currently being provisioned (dedupes concurrent writes). */
const provisionInFlight = new Set<string>();

/**
 * Make sure `path` exists as a directory. If a stale file entry is sitting
 * there (can happen if a previous provisioning run was interrupted and the
 * openFile write landed on the parent path by mistake), delete it first and
 * create the directory fresh. This is the self-heal path the background
 * music/image provision runs at every boot.
 */
async function ensureDirectory(fs: FileStore, path: string): Promise<void> {
  const existing = await fs.stat(path).catch(() => null);
  if (existing && existing.kind === 'file') {
    console.warn(`[specter-core] replacing stale file with directory: ${path}`);
    await fs.deleteFile(path);
  }
  try {
    await fs.createDirectory(path);
  } catch (err) {
    console.warn(`[specter-core] ensureDirectory failed for ${path}: ${String(err)}`);
  }
}

/** Idempotent: writes each bundled file when missing/empty (fetch + write). */
async function provisionFiles(fs: FileStore, files: Array<{ url: string; storePath: string }>): Promise<void> {
  for (const f of files) {
    // Dedupe concurrent provisions of the same path (e.g. the background boot
    // provision racing a lazy ensureBuiltinWinFiles from launchGuestWindow).
    if (provisionInFlight.has(f.storePath)) continue;
    provisionInFlight.add(f.storePath);
    try {
      // Ensure the parent directory tree exists (self-healing: replaces a
      // stale file entry with a directory so the write below can land).
      const dirs = f.storePath.split('/').slice(0, -1);
      let cur = '';
      for (const d of dirs) {
        cur = cur ? `${cur}/${d}` : d;
        await ensureDirectory(fs, cur);
      }
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
      const file = await fs.openFile(f.storePath, 'write');
      try {
        await file.write(0, data);
      } finally {
        await file.close();
      }
      console.warn(`[specter-core] provisioned ${f.storePath} (${data.byteLength} bytes)`);
    } finally {
      provisionInFlight.delete(f.storePath);
    }
  }
}

export async function ensureBuiltinWinFiles(fs: FileStore): Promise<void> {
  await provisionFiles(fs, BUILTIN_WIN_FILES);
}

export async function ensureBuiltinMusicFiles(fs: FileStore): Promise<void> {
  // Create the folder up front (self-healing if a stale file is sitting
  // there) so the File Explorer quick-access entry and any guest open dialog
  // resolve even while the music is still being written.
  await ensureDirectory(fs, 'Users/Public/Music');
  await provisionFiles(fs, BUILTIN_MUSIC_FILES);
}

export async function ensureBuiltinImageFiles(fs: FileStore): Promise<void> {
  // Self-heal: if a previous run left a stale file at the Pictures path,
  // delete it and recreate the directory. The quick-access entry and Photos
  // app then resolve even when no default images have been bundled yet.
  await ensureDirectory(fs, 'Users/Public/Pictures');
  await provisionFiles(fs, BUILTIN_IMAGE_FILES);
}

/**
 * Provision all bundled files (system tools, music, images) in the background.
 * Called AFTER the desktop mounts so a cold boot is never blocked by the
 * ~40 MB of fetch+write. Errors are logged, never thrown.
 *
 * Order matters: system tools first (guest apps such as notepad/cmd need them
 * to launch), then multimedia. If the user opens a guest app before this
 * finishes, launchGuestWindow/launchGuestConsole re-ensure the win files
 * lazily, so nothing breaks.
 */
export async function provisionBundledFilesInBackground(fs: FileStore): Promise<void> {
  await ensureBuiltinWinFiles(fs)
    .then(() => console.warn('[specter-core] builtin win files ready'))
    .catch((err) => console.warn('[specter-core] builtin win files failed:', err));
  await ensureBuiltinMusicFiles(fs)
    .then(() => console.warn('[specter-core] builtin music files ready'))
    .catch((err) => console.warn('[specter-core] builtin music files failed:', err));
  await ensureBuiltinImageFiles(fs)
    .then(() => console.warn('[specter-core] builtin image files ready'))
    .catch((err) => console.warn('[specter-core] builtin image files failed:', err));
}
