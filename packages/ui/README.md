# @specter-core/ui

The **L6 desktop shell** — the React/TypeScript Windows‑style desktop that the browser
user actually sees and interacts with: window manager, desktop, taskbar, start menu,
and the bundled apps (notepad, command prompt, file explorer, media players, …).

## Modules

| File | Role |
|---|---|
| `src/plugin.ts` | `UiLayerPlugin` — wires the desktop shell, window manager, and built‑in apps into the kernel. |
| `src/window-manager.ts` | Draggable / resizable / z‑ordered guest‑window management and the desktop surface. |
| `src/builtin-win.ts` | `BUILTIN_WIN_FILES` / `BUILTIN_MUSIC_FILES` / `BUILTIN_IMAGE_FILES` + background provisioning of bundled Windows tools and media into the virtual disk. |
| `src/apps.tsx` | `AppDefinition` registry — the catalogue of launchable apps (notepad, command‑prompt x86/x64, explorer, media…). **Add new desktop apps here.** |
| `src/console-channel.ts` | Console I/O channel bridging a guest `cmd.exe`/`notepad` to an on‑screen console window (stdin/stdout round‑trip). |
| `src/gdi-bridge-registry.ts` | Selects the active `GdiBridge` implementation (`NullGdiBridge` ↔ `CanvasGdiBridge`) for guest window paint. |
| `src/guest-text.ts` / `src/ico.ts` | Guest text rendering + `.ico` extraction for app/desktop icons. |
| `src/import-files.ts` / `src/download.ts` / `src/media-progress.ts` | Host file‑import, download, and media‑provision progress UI. |
| `src/ui-clipboard.ts` / `src/types.ts` | Clipboard bridge and shared UI types. |
| `src/apps/installer-packages.ts` | `.bkapp` package install/uninstall wiring into the shell. |
| `src/components/` | Presentational React components (windows, taskbar, start menu, dialogs). |

## Notes

- The shell launches real guest programs (e.g. `notepad.exe`, `cmd.exe`) by calling into
  the L3 `GuestProcessRunner`; it does **not** re‑implement Windows logic itself.
- Guest paint flows through the GDI bridge selected in `gdi-bridge-registry.ts` into the
  L6 guest‑window canvas.
- The x64 guest path runs the guest `WndProc` through a nested x64 executor
  (`rcx/rdx/r8/r9` + shadow space + 8‑byte sentinel return).
