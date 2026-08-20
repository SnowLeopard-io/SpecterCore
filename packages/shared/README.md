# @specter-core/shared

**Framework-agnostic utilities** shared across layers, kept free of any UI or
layer-specific dependency so they can be unit-tested against the `FileStore` contract.

## Modules

Core utilities (top of `src/`):

| File | Role |
|---|---|
| `path.ts` | Windows-style path helpers: normalize, join, dirname, basename, extname, segments, `toStorePath`, `isWithin`. |
| `pattern.ts` | Windows wildcard matching (`*`, `?`), regex conversion, wildcard-path splitting. |
| `async.ts` | Promise utilities: `createDeferred`, `timeout`, `withTimeout`. |
| `id.ts` | Monotonic ID generator for handles, processes, threads, and string IDs. |
| `typed-array.ts` | `Uint8Array` ↔ `ArrayBuffer`-backed view conversions. |
| `decorator.ts` | Awaitable/promise adapters for sync/async compatibility. |

Shell domain (`src/shell/`):

| File | Role |
|---|---|
| `interpreter.ts` | UI-independent `CommandInterpreter` implementing the basic cmd.exe language (help/dir/cd/cls/rem/echo/pause). |
| `pe.ts` | Lightweight PE header parser: MZ/PE signature, machine type, arch, subsystem, entry point, PE32/PE32+ magic. |
| `pe-icons.ts` | Icon parsing for PE icon resources. |
| `installer.ts` | App install/uninstall: copy files to `Program Files/<packageId>`, manage `Windows/registry.json`, and `.bkapp` packages. |
| `text.ts` | Text decoding with fallback order: UTF-8 strict → GBK → UTF-8 lenient. |
| `path.ts` | Command-interpreter store-path utilities: store↔display, resolve/copy/cwd-aware path resolution. |
| `assoc.ts` | File-association logic by extension (text/image/audio/video) and default-app mapping. |
| `fs-ops.ts` | Recursive `copyRecursive`, `deleteRecursive`, `moveRecursive` over `FileStore`. |

## Why it's separate

Most Windows-logic that is pure and testable (command parsing, PE header reading,
installer/registry, text decoding) lives here rather than inside the JIT or UI. That
keeps it UI-agnostic and unit-testable with a tiny `FileStore` double. See the
`*.test.ts` files alongside each module for the expected behavior across these edge
cases.