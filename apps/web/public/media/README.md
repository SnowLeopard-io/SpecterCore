# Extending the default multimedia content

SpecterCore seeds the virtual disk with bundled media so the built-in apps
(Audio Player, Photos, Video Player) have real content on first boot. This
guide explains where files live and how to add your own.

## Directory layout

```
apps/web/public/
├── media/                  <- multimedia source files (this folder)
│   ├── music/              <- audio files (mp3, wav, ogg, flac, aac, m4a)
│   ├── images/             <- image files (png, jpg, jpeg, gif, bmp, webp, ico)
│   └── videos/             <- (optional) video files (mp4, webm, mov, mkv, avi)
├── win/                    <- bundled Windows tools (do not touch)
└── icons/                  <- desktop/app icons (do not touch)
```

The virtual disk mirrors these files under `C:\Users\Public\`:

| Source folder          | Virtual disk folder      | Opens with        |
|------------------------|--------------------------|-------------------|
| `media/music/`         | `C:\Users\Public\Music`  | Audio Player      |
| `media/images/`        | `C:\Users\Public\Pictures` | Photos          |
| `media/videos/`        | `C:\Users\Public\Videos` | Video Player      |

## How provisioning works

At startup, `apps/web/src/bootstrap.ts` copies the files listed in
`packages/ui/src/builtin-win.ts` into the virtual disk:

- `BUILTIN_MUSIC_FILES` -> `ensureBuiltinMusicFiles()`
- `BUILTIN_IMAGE_FILES` -> `ensureBuiltinImageFiles()`
- `BUILTIN_WIN_FILES`   -> `ensureBuiltinWinFiles()` (system tools, leave alone)

All three run through `provisionBundledFilesInBackground()`, which the bootstrap
**fires AFTER the desktop mounts** so a cold boot is never blocked by fetching
and writing the ~40 MB of bundled content. On a first visit the Music/Pictures
folders may briefly appear empty while the background provisioning fills them;
navigate away and back (or hit Refresh) to see the latest files. Guest apps
(notepad/cmd) lazily re-ensure the win files if launched before provisioning
finishes.

The provisioning is **idempotent**: a file is only copied when it is missing or
empty on the virtual disk. Concurrent provisions of the same path are deduped
(`provisionInFlight`). See `provisionFiles()` in `builtin-win.ts`.

## Adding a new song

1. Copy the audio file into `apps/web/public/media/music/`.
2. Add one entry to `BUILTIN_MUSIC_FILES` in `packages/ui/src/builtin-win.ts`:

```ts
{ url: 'media/music/my-song.mp3', storePath: 'Users/Public/Music/my-song.mp3' },
```

3. Reload the browser. The file appears in File Explorer -> Music and plays
   when double-clicked (or opened from Audio Player).

## Adding a new image

1. Copy the image into `apps/web/public/media/images/`.
2. Add one entry to `BUILTIN_IMAGE_FILES`:

```ts
{ url: 'media/images/my-photo.jpg', storePath: 'Users/Public/Pictures/my-photo.jpg' },
```

3. Reload. The image appears in File Explorer -> Pictures and opens in Photos.

## Adding a video (optional)

Videos are not registered by default. To add them:

1. Create `apps/web/public/media/videos/` and copy the video there.
2. Add a `BUILTIN_VIDEO_FILES` array plus an `ensureBuiltinVideoFiles()`
   function in `builtin-win.ts` (same shape as the music/images arrays), then
   call it from `bootstrap.ts`.

## Supported formats (file associations)

| Category | Extensions                                  | App           |
|----------|---------------------------------------------|---------------|
| Audio    | mp3, wav, ogg, flac, aac, m4a               | Audio Player  |
| Image    | png, jpg, jpeg, gif, bmp, webp, ico         | Photos        |
| Video    | mp4, webm, mov, mkv, avi                    | Video Player  |

The associations live in `packages/shared/src/shell/assoc.ts` (appForFile).

## Notes

- **Replacing a file with the same name**: the virtual disk keeps the old copy
  because provisioning only writes missing/empty files. Either delete the file
  from the virtual disk (File Explorer) first, use a new file name, or wipe the
  virtual disk (Settings -> Wipe Virtual Disk) to force a full re-provision.
- **Large libraries**: every bundled file is fetched from the web server and
  written into the browser's OPFS storage on first boot, so a huge media folder
  slows the initial load. Keep the bundled set small.
