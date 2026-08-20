# SpecterCore — Progress Notes

> Short handover notes for recent work. Full details live in `docs/PROGRESS.md`.

## 2026-08-20 — Session 18 round

### Virtual disk auto-refresh (guest writes)
- **Problem**: notepad saving a file did not appear on the desktop / in an open
  Explorer folder until a manual refresh.
- **Fix**: `FileSystemBridgeImpl` now exposes `onChange(listener)` firing
  `FsChange { path, kind, to? }` (store paths) on every mutation (create /
  write / truncate / delete / move). `Desktop.tsx` refreshes when a change hits
  the Desktop dir; `FileExplorerApp.tsx` reloads the current folder. The guest's
  `ApiHost.fs` is the same bridge singleton, so guest writes flow straight in.

### Built-in multimedia
- Source files under `apps/web/public/media/`:
  - `music/` → virtual disk `Users/Public/Music` (4 mp3s)
  - `images/` → virtual disk `Users/Public/Pictures` (14 jpgs, `01.jpg`..`14.jpg`)
- `BUILTIN_MUSIC_FILES` / `BUILTIN_IMAGE_FILES` in `packages/ui/src/builtin-win.ts`
  drive provisioning; File Explorer quick access gained Music + Pictures entries.
- Guide for extending: `apps/web/public/media/README.md`.

### Boot is never blocked by media
- `bootstrap.ts` mounts the desktop FIRST, then fires
  `provisionBundledFilesInBackground(fs)` (void, no await). System tools →
  music → images, each idempotent and deduped via `provisionInFlight`.
- Guest apps lazily re-ensure win files if launched before provisioning ends.

### OPFS dirty-data self-heal
- Symptom: `Not a directory` / `NotFoundError` on `Users/Public/Pictures`
  (stale file entry left by an interrupted provisioning).
- Fix: `ensureDirectory(fs, path)` walks every path segment, deletes a stale
  file entry and recreates the directory (recursive parent creation).
  Used by all provisioning paths. Explorer shows a friendly hint on
  `not a directory` errors.

### Verified
- tsc 0 · eslint 0 · vitest 260/260 · notepad open/dialog checks PASS ·
  cmd-cwd-check PASS · vite build includes all media.
