import type { DisplayDriver, DisplayMode, Dispose } from '@bk/contracts';

/**
 * WebGPU-backed display driver (design doc 5.2). Placeholder until P5;
 * mode enumeration is functional, present() is wired to the swapchain later.
 */
export class WebGpuDisplayDriver implements DisplayDriver {
  readonly id = 'webgpu-display';
  readonly name = 'WebGPU Virtual Display';

  private current: DisplayMode = { width: 1024, height: 768, refreshRate: 60, colorDepth: 32 };
  private readonly vsyncHandlers = new Set<(frame: number) => void>();
  private frame = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly adapterAvailable: () => boolean = () => false) {}

  async enumerateModes(): Promise<DisplayMode[]> {
    return [
      { width: 800, height: 600, refreshRate: 60, colorDepth: 32 },
      { width: 1024, height: 768, refreshRate: 60, colorDepth: 32 },
      { width: 1280, height: 720, refreshRate: 60, colorDepth: 32 },
      { width: 1920, height: 1080, refreshRate: 60, colorDepth: 32 },
    ];
  }

  async setMode(mode: DisplayMode): Promise<void> {
    this.current = { ...mode };
  }

  getCurrentMode(): DisplayMode {
    return { ...this.current };
  }

  onVsync(listener: (frame: number) => void): Dispose {
    if (!this.timer) {
      this.timer = setInterval(() => {
        this.frame += 1;
        for (const handler of this.vsyncHandlers) handler(this.frame);
      }, 1000 / this.current.refreshRate);
    }
    this.vsyncHandlers.add(listener);
    return () => {
      this.vsyncHandlers.delete(listener);
      if (this.vsyncHandlers.size === 0 && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    };
  }

  async present(_frameBuffer: Uint8Array): Promise<void> {
    // TODO(P5): upload frame buffer to a WebGPU swapchain texture
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.vsyncHandlers.clear();
  }
}