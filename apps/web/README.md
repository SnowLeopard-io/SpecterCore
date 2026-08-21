# apps/web

The **browser entry point** for SpecterCore — a Vite app that assembles the `Kernel`
with all six layer plugins, mounts the L6 desktop shell, and serves the page with the
COOP/COEP cross‑origin‑isolation headers required for `SharedArrayBuffer` / OPFS /
WebUSB / WebGPU.

## Layout

```
apps/web/
  src/
    bootstrap.ts        System bootstrap: build the Kernel, register layer plugins,
                        mount the desktop, fire background virtual-disk provisioning.
    resource-preload.ts Preload bundled Windows tools / media before first paint.
  public/
    win/                Bundled Windows tool images (notepad.exe, cmd.exe, MUI…).
    media/              Bundled multimedia (music / images / videos) — see media/README.md.
    icons/              Desktop / app icons.
  index.html            Vite entry; loads the COOP/COEP headers via the dev/preview server.
```

## Running

```bash
pnpm dev       # Vite dev server on http://localhost:5173 (localhost = secure context)
pnpm build     # static build into apps/web/dist (deployable to GitHub Pages)
pnpm preview   # serve the production build
```

The desktop launches the bundled `notepad.exe` (x86 and x64 PE32+) and can run
`cmd.exe` through the JIT. Guest files live in the OPFS‑backed virtual disk
(`C:\…`), seeded from `public/win`, `public/media`, and `public/icons`.

See the root [`README.md`](../../README.md) for the full architecture and milestones.
