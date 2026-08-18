import type { Dispose, GpuAdapter, GpuAdapterInfo } from '@bk/contracts';

/**
 * WebGPU 适配器：初始化设备，暴露适配器信息与帧循环。
 * 图形命令渲染（GDI/D3D → WebGPU 通道）在 P3 里程碑接入。
 */

declare global {
  interface GPUAdapterInfo {
    readonly vendor: string;
    readonly architecture: string;
    readonly device: string;
    readonly description: string;
  }
  interface GPUSupportedLimits {
    readonly maxTextureDimension2D: number;
    readonly maxBufferSize: number;
  }
  interface GPUDevice {
    readonly limits: GPUSupportedLimits;
    destroy(): void;
  }
  interface GPUAdapter {
    readonly info?: GPUAdapterInfo;
    requestDevice(): Promise<GPUDevice>;
  }
  interface GPU {
    requestAdapter(): Promise<GPUAdapter | null>;
  }
  interface Navigator {
    gpu?: GPU;
  }
}
export class WebGpuAdapter implements GpuAdapter {
  readonly available = typeof navigator !== 'undefined' && Boolean((navigator as { gpu?: unknown }).gpu);

  private gpuAdapter: GPUAdapter | null = null;
  private gpuDevice: GPUDevice | null = null;
  private frameHandlers = new Set<(frame: number) => void>();
  private frame = 0;
  private rafId: number | null = null;

  get adapterInfo(): GpuAdapterInfo | null {
    const adapter = this.gpuAdapter as unknown as { info?: GPUAdapterInfo } | null;
    const info = adapter?.info;
    return info
      ? {
          vendor: info.vendor,
          architecture: info.architecture,
          device: info.device,
          description: info.description,
          limits: {
            maxTextureDimension2D: this.gpuDevice?.limits.maxTextureDimension2D ?? 0,
            maxBufferSize: this.gpuDevice?.limits.maxBufferSize ?? 0,
          },
        }
      : null;
  }

  async init(): Promise<void> {
    if (!this.available) throw new Error('WebGPU is not available');
    const gpu = navigator as unknown as { gpu: GPU };
    this.gpuAdapter = await gpu.gpu.requestAdapter();
    if (!this.gpuAdapter) throw new Error('No WebGPU adapter found');
    this.gpuDevice = await this.gpuAdapter.requestDevice();
    this.frame = 0;
    const loop = (): void => {
      this.frame += 1;
      for (const handler of this.frameHandlers) handler(this.frame);
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  submit(_commandBuffer: unknown): void {
    // P3：接收 GDI/D3D 生成的渲染命令缓冲并提交
  }

  onFrame(listener: (frame: number) => void): Dispose {
    this.frameHandlers.add(listener);
    return () => {
      this.frameHandlers.delete(listener);
    };
  }

  async destroy(): Promise<void> {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    this.frameHandlers.clear();
    this.gpuDevice?.destroy();
    this.gpuDevice = null;
    this.gpuAdapter = null;
  }
}