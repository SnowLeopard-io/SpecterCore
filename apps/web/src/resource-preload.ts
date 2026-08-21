/**
 * UI resources preloaded during the boot splash so the desktop (wallpaper,
 * start-menu avatar, app/taskbar icons) renders instantly without first-paint
 * flicker. These live in the Vite `public/` dir and are served relative to the
 * page, so listing them here keeps the boot phase in charge of loading them.
 */
const UI_RESOURCES: readonly string[] = [
  'wallpaper.jpg',
  'avatar.png',
  // App & file-type icons
  'icons/application.svg',
  'icons/audio-file.svg',
  'icons/audio-player.svg',
  'icons/browser.svg',
  'icons/cmd.svg',
  'icons/document.svg',
  'icons/explorer.svg',
  'icons/folder.svg',
  'icons/image-file.svg',
  'icons/local-disk.svg',
  'icons/minesweeper.svg',
  'icons/notepad.svg',
  'icons/package.svg',
  'icons/photos.svg',
  'icons/text-document.svg',
  'icons/this-pc.svg',
  'icons/video-file.svg',
  'icons/video-player.svg',
  // Taskbar tray icons
  'icons/taskbar-battery.svg',
  'icons/taskbar-search.svg',
  'icons/taskbar-volume.svg',
  'icons/taskbar-wifi.svg',
  'icons/taskbar-windows.svg',
];

/**
 * Fetch each UI resource into the browser cache. Never throws: a missing or
 * failed resource is logged but must not abort the boot.
 */
export async function preloadUiResources(): Promise<void> {
  await Promise.all(
    UI_RESOURCES.map((url) =>
      fetch(url, { credentials: 'same-origin' })
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.arrayBuffer();
        })
        .catch((err) => {
          console.warn(`[specter-core] preload failed ${url}: ${String(err)}`);
        }),
    ),
  );
}