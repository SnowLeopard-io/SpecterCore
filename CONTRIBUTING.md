# Contributing to SpecterCore

Thanks for taking the time to contribute. SpecterCore is a browser-based
Windows compatibility layer: the goal is to run Windows x86 applications in the
browser through WASM + high-level emulation (HLE), plus an L6 Windows-style
desktop shell.

## Development environment

- **Node.js** >= 20.19.0
- **pnpm** >= 10 (see `packageManager` in `package.json`)
- **Chrome / Edge** >= 120 (OPFS, WebUSB, WebGPU, AudioWorklet)

Install dependencies and start the dev server:

```bash
pnpm install
pnpm dev        # serves apps/web on http://localhost:5173
```

> The app requires a secure context (HTTPS or localhost). The dev server runs
> on localhost, which satisfies this. COOP/COEP headers are set automatically
> so SharedArrayBuffer works.

## Repository layout

```
apps/web        Vite entry (builds the browser app)
packages/
  contracts     Cross-layer interfaces, DI tokens (single source of truth)
  shared        Framework-agnostic utilities (paths, cmd interpreter, PE, installer)
  host          L1: OPFS, worker pool, WebUSB/WebGPU/WebAudio adapters
  bridges       L2: syscall bridge adapters (fs, graphics, audio, usb)
  core          L3: process/memory/object management, API interceptor, PE/JIT stubs
  drivers       L4: USB/graphics driver abstractions
  kernel        Kernel assembler: plugin lifecycle, DI container, event bus
  ui            L6: React desktop shell, window manager, apps
```

Layer dependencies follow the design in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): each package may
only depend on `@specter-core/contracts` and the layers below it.

## Code style

- TypeScript strict; run `pnpm typecheck` before pushing.
- ESLint (`pnpm lint`) with the repository config; keep it at 0 errors.
- UI text, comments, and all documentation are written in English.
- No emoji in generated content unless the user explicitly requests it.

## Testing

```bash
pnpm test           # vitest, all packages
pnpm test:watch
pnpm test:coverage
```

Core Windows logic (cmd interpreter, installer/registry, PE parsing, text
decoding) lives in `@specter-core/shared` and is unit-tested against the `FileStore`
contract — UI-agnostic by design.

## Commands and workflow

```bash
pnpm lint        # eslint
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest run
pnpm build       # vite build of apps/web into apps/web/dist
```

Before opening a PR:

1. Run `pnpm lint` and fix all errors.
2. Run `pnpm typecheck` and `pnpm test` — all green.
3. Update the milestone table in `docs/PROGRESS.md` if your change moves a milestone forward.
4. Keep PRs focused on a single layer or feature.

## Branching and CI

- `main` is the default branch; pushes to it trigger GitHub Actions
  (typecheck + lint + tests + build) and deploy the web app to GitHub Pages.
- Features go through short-lived branches with a PR into `main`.

## Reporting issues

Include:

- Browser and version, OS.
- What you did, what you expected, and what happened (screenshots help).
- Console errors if any.
