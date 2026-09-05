/**
 * Console I/O: WriteFile/WriteConsole capture on the STD_* pseudo-handles plus the host-feedable stdin buffer (ReadConsoleW/A, ReadFile).
 *
 * Split out of guest-process.ts (design doc 4.2.x); pure code movement, no logic changes.
 */

import type { ApiCallContext, ApiHost, ApiInterceptor, ApiResult } from '@specter-core/contracts';
import { WinError as E } from '@specter-core/contracts';
import { STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE } from '../api/handlers';

/** Dependencies for the console I/O install. */
export interface ConsoleIoDeps {
  interceptor: ApiInterceptor;
  interactive: () => boolean;
}

export class ConsoleIo {
  private readonly deps: ConsoleIoDeps;
  private readonly stdout: number[] = [];
  private readonly stderr: number[] = [];
  /** Host-fed stdin buffer (UTF-16 code units as a JS string). */
  private stdinBuffer = '';
  /** Resolver for a blocked ReadConsoleW/A in interactive mode. */
  private pendingInputResolve: (() => void) | null = null;
  /** Host output callback (see GuestProcessOptions.onOutput). */
  onOutput?: (bytes: Uint8Array, stderr: boolean) => void;

  constructor(deps: ConsoleIoDeps) {
    this.deps = deps;
  }

  /** Resets the per-run console state (run() start). */
  reset(): void {
    this.stdout.length = 0;
    this.stderr.length = 0;
    this.stdinBuffer = '';
    this.pendingInputResolve = null;
  }

  /** Bytes written to the console stdout stream. */
  get output(): Uint8Array {
    return new Uint8Array(this.stdout);
  }

  /** Bytes written to the console stderr stream. */
  get stderrOutput(): Uint8Array {
    return new Uint8Array(this.stderr);
  }

  /**
   * Routes WriteFile on the console pseudo-handles into the output buffers.
   * Non-console handles fall through to the fs bridge (same path as the
   * default handler).
   */
  install(): void {
    this.installConsoleRead();

    // WriteFile on the console pseudo-handles (STD_OUTPUT / STD_ERROR) is
    // captured into the output stream; other handles fall through to the
    // pre-existing file I/O handler (handlers.ts) if one is registered.
    const prevWriteFile = this.deps.interceptor.getHandler('kernel32.dll', 'WriteFile');
    this.deps.interceptor.hook('kernel32.dll', 'WriteFile', (ctx, host) => {
      const handle = (ctx.rawArgs[0] ?? 0) | 0; // normalize to int32 (handles may arrive as 0xFFFFFFF2+)
      const buffer = ctx.rawArgs[1] ?? 0;
      const bytes = host.memory.read(buffer, ctx.rawArgs[2] ?? 0);
      if (
        handle === STD_OUTPUT_HANDLE ||
        handle === STD_ERROR_HANDLE ||
        handle === STD_INPUT_HANDLE
      ) {
        if (handle !== STD_INPUT_HANDLE) {
          // Capture the raw bytes verbatim. cmd's `echo` and `dir` go through
          // the CRT (printf/fprintf) which calls WriteFile(STD_OUTPUT, ...) with
          // the line as the CRT encoded it (UTF-16LE for this Unicode cmd).
          // We don't try to re-decode here — WriteConsoleW is the wide path
          // (UTF-16) and WriteFile is the narrow/CRT path; mixing them strips
          // bytes that don't fit a single encoding. The terminal TextDecoder
          // (utf-8, lossy) renders the stream.
          this.capture(handle === STD_ERROR_HANDLE, bytes);
        }
        return { returnValue: bytes.byteLength, errorCode: E.NO_ERROR };
      }
      if (prevWriteFile) return prevWriteFile(ctx, host);
      // Fallback if no file WriteFile handler is registered yet: mirror
      // handlers.ts WriteFile via the fs bridge directly.
      return host.fs
        .writeFile(handle, bytes)
        .then((r) =>
          r.error === E.NO_ERROR
            ? { returnValue: r.bytesWritten, errorCode: E.NO_ERROR }
            : { returnValue: 0, errorCode: r.error },
        );
    });

    // WriteConsoleW/A(console, buf, nChars, *written, reserved): cmd writes its
    // listings through these (console handles are UTF-16). Convert to UTF-8 so
    // the host output is readable; NUL padding past nChars is dropped.
    const installWriteConsole = (wide: boolean): void => {
      const name = wide ? 'WriteConsoleW' : 'WriteConsoleA';
      this.deps.interceptor.hook('kernel32.dll', name, (ctx, host) => {
        const handle = (ctx.rawArgs[0] ?? 0) | 0; // normalize to int32
        const buffer = ctx.rawArgs[1] ?? 0;
        const nChars = ctx.rawArgs[2] ?? 0;
        const written = ctx.rawArgs[3] ?? 0;
        if (handle === STD_INPUT_HANDLE) return { returnValue: 1, errorCode: E.NO_ERROR };
        let out: Uint8Array;
        if (wide) {
          const raw = host.memory.read(buffer, nChars * 2);
          const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
          let s = '';
          for (let i = 0; i + 1 < raw.byteLength; i += 2) {
            const c = view.getUint16(i, true);
            if (c === 0) break;
            s += String.fromCharCode(c);
          }
          out = new TextEncoder().encode(s);
        } else {
          out = host.memory.read(buffer, nChars);
        }
        const stderr = handle === STD_ERROR_HANDLE;
        this.capture(stderr, out);
        if (written) {
          const w = new Uint8Array(4);
          new DataView(w.buffer).setUint32(0, nChars, true);
          host.memory.write(written, w);
        }
        return { returnValue: 1, errorCode: E.NO_ERROR };
      });
    };
    installWriteConsole(true);
    installWriteConsole(false);
  }

  /**
   * Console STD_INPUT reader (see installConsoleWriteFile for the writer).
   * Adds a host-feedable stdin buffer plus ReadConsoleW/A and ReadFile on the
   * STD_INPUT pseudo-handle. In interactive mode an empty buffer BLOCKS the
   * read (await) until the host posts input via postInput — the same
   * suspend/resume pattern used by GetMessageW, so the executor stays alive
   * while cmd waits for the next command line. Non-interactive runs (e.g.
   * `cmd /c dir`) get an immediate EOF (0 bytes) and never block.
   */
  private installConsoleRead(): void {
    // Preserve any pre-existing ReadFile handler (file I/O) and only intercept
    // the STD_INPUT pseudo-handle; everything else delegates to the original.
    const prevReadFile = this.deps.interceptor.getHandler('kernel32.dll', 'ReadFile');
    this.deps.interceptor.hook('kernel32.dll', 'ReadFile', async (ctx, host) => {
      const handle = (ctx.rawArgs[0] ?? 0) | 0; // normalize to int32
      if (handle === STD_INPUT_HANDLE) return this.consoleRead(ctx, host, false);
      return prevReadFile
        ? prevReadFile(ctx, host)
        : { returnValue: 0, errorCode: E.ERROR_NOT_IMPLEMENTED };
    });

    this.deps.interceptor.hook('kernel32.dll', 'ReadConsoleW', (ctx, host) =>
      this.consoleRead(ctx, host, true),
    );
    this.deps.interceptor.hook('kernel32.dll', 'ReadConsoleA', (ctx, host) =>
      this.consoleRead(ctx, host, false),
    );
  }

  /**
   * Drains the host-fed stdin buffer. `wide` true = ReadConsoleW (UTF-16LE,
   * `count` is CHARACTERS); false = ReadConsoleA / ReadFile(STD_INPUT) (bytes,
   * `count` is BYTES, ASCII-only for v1). Blocks in interactive mode until at
   * least one character is available.
   */
  private async consoleRead(ctx: ApiCallContext, host: ApiHost, wide: boolean): Promise<ApiResult> {
    const buffer = ctx.rawArgs[1] ?? 0;
    const count = ctx.rawArgs[2] ?? 0;
    const pCount = ctx.rawArgs[3] ?? 0;
    if (this.stdinBuffer.length === 0 && this.deps.interactive()) {
      await new Promise<void>((resolve) => {
        this.pendingInputResolve = resolve;
      });
    }
    if (this.stdinBuffer.length === 0) {
      // EOF: no input and not interactive (or host closed the stream).
      if (pCount) {
        const w = new Uint8Array(4);
        new DataView(w.buffer).setUint32(0, 0, true);
        host.memory.write(pCount, w);
      }
      return { returnValue: 1, errorCode: E.NO_ERROR };
    }
    const take = Math.min(count, this.stdinBuffer.length);
    const chunk = this.stdinBuffer.slice(0, take);
    this.stdinBuffer = this.stdinBuffer.slice(take);
    if (wide) {
      const bytes = new Uint8Array(take * 2);
      const view = new DataView(bytes.buffer);
      for (let i = 0; i < take; i++) view.setUint16(i * 2, chunk.charCodeAt(i), true);
      host.memory.write(buffer, bytes);
    } else {
      const bytes = new Uint8Array(take);
      for (let i = 0; i < take; i++) bytes[i] = chunk.charCodeAt(i) & 0xff;
      host.memory.write(buffer, bytes);
    }
    if (pCount) {
      const w = new Uint8Array(4);
      new DataView(w.buffer).setUint32(0, take, true);
      host.memory.write(pCount, w);
    }
    return { returnValue: 1, errorCode: E.NO_ERROR };
  }

  /** Host → guest console input. Appends `text` (caller supplies the line
   * terminator, e.g. "dir\r\n") and wakes any ReadConsoleW/A blocked in
   * interactive mode. */
  postInput(text: string): void {
    this.stdinBuffer += text;
    if (this.pendingInputResolve) {
      const r = this.pendingInputResolve;
      this.pendingInputResolve = null;
      r();
    }
  }

  private capture(stderr: boolean, bytes: Uint8Array): void {
    const sink = stderr ? this.stderr : this.stdout;
    for (const b of bytes) sink.push(b);
    this.onOutput?.(bytes, stderr);
  }
}
