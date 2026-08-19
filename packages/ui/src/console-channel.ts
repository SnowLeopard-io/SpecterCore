/**
 * Bridges a running guest console process (owned by DesktopController) and the
 * CmdGuestTerminal React component. DesktopController owns the GuestProcessRunner
 * and drives `runner.run(...)`; the component registers its renderer via
 * `onOutput` and feeds keystrokes through `runner.postInput`. Bytes emitted
 * before the component mounts are buffered so no early output (cmd's banner /
 * prompt) is lost.
 */
export class CmdConsoleChannel {
  private buffer: Array<{ bytes: Uint8Array; stderr: boolean }> = [];
  private renderer: ((bytes: Uint8Array, stderr: boolean) => void) | null = null;
  private exitCode: number | null = null;
  private exitMessage: string | null = null;
  private exitRenderer: ((code: number, message: string | null) => void) | null = null;

  /** Called by DesktopController from GuestProcessRunner's onOutput. */
  push(bytes: Uint8Array, stderr: boolean): void {
    this.buffer.push({ bytes, stderr });
    this.renderer?.(bytes, stderr);
  }

  /** Called by CmdGuestTerminal on mount: replays buffered bytes, then streams. */
  attach(renderer: (bytes: Uint8Array, stderr: boolean) => void): void {
    this.renderer = renderer;
    for (const { bytes, stderr } of this.buffer) renderer(bytes, stderr);
    this.buffer = [];
  }

  detach(): void {
    this.renderer = null;
  }

  /** Called by DesktopController once the guest process exits. */
  markExited(code: number, message: string | null = null): void {
    this.exitCode = code;
    this.exitMessage = message;
    this.exitRenderer?.(code, message);
  }

  /** Called by CmdGuestTerminal on mount; fires immediately if already exited. */
  onExit(cb: (code: number, message: string | null) => void): void {
    this.exitRenderer = cb;
    if (this.exitCode !== null) cb(this.exitCode, this.exitMessage);
  }
}
