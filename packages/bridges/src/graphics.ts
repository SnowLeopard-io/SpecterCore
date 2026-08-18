import type {
  Color,
  DeviceCaps,
  Dispose,
  D3DBridge,
  FontSpec,
  GdiBridge,
  OglBridge,
  Rect,
} from '@bk/contracts';
import { WinError as E } from '@bk/contracts';
import { nextId } from '@bk/shared';

const NOT_IMPLEMENTED = E.ERROR_NOT_IMPLEMENTED;

/**
 * A GDI bridge that returns ERROR_NOT_IMPLEMENTED for every operation.
 * Serves as the P0 placeholder until the real canvas/WebGPU renderer lands (P3).
 */
export class NullGdiBridge implements GdiBridge {
  async createDC(_name: string): Promise<number> {
    return 0;
  }
  async deleteDC(_dc: number): Promise<void> {}
  async textOut(_dc: number, _x: number, _y: number, _text: string, _font?: FontSpec): Promise<number> {
    return NOT_IMPLEMENTED;
  }
  async bitBlt(
    _destDc: number,
    _destRect: Rect,
    _srcDc: number,
    _srcRect: Rect,
    _rop: number,
  ): Promise<number> {
    return NOT_IMPLEMENTED;
  }
  async stretchBlt(
    _destDc: number,
    _destRect: Rect,
    _srcDc: number,
    _srcRect: Rect,
    _rop: number,
  ): Promise<number> {
    return NOT_IMPLEMENTED;
  }
  async patBlt(_dc: number, _rect: Rect, _color: Color, _rop: number): Promise<number> {
    return NOT_IMPLEMENTED;
  }
  async setPixel(_dc: number, _x: number, _y: number, _color: Color): Promise<number> {
    return NOT_IMPLEMENTED;
  }
  async getDeviceCaps(_dc: number): Promise<DeviceCaps> {
    return { bitsPerPixel: 32, width: 0, height: 0, colorPlanes: 1, horizontalResolution: 0, verticalResolution: 0 };
  }
  async flush(_dc: number): Promise<void> {}
  onInvalidate(_listener: (dc: number, rect: Rect) => void): Dispose {
    return () => {};
  }
}

/**
 * Minimal GDI bridge rendered onto a 2D canvas.
 * Demonstrates the DC/text/bitblt pipeline end-to-end; full GDI raster ops are P3.
 */
export class CanvasGdiBridge implements GdiBridge {
  private readonly dcs = new Map<number, HTMLCanvasElement>();
  private readonly invalidateHandlers = new Set<(dc: number, rect: Rect) => void>();

  constructor(private readonly surface: HTMLCanvasElement) {}

  async createDC(name: string): Promise<number> {
    if (typeof document === 'undefined') return 0;
    const canvas = document.createElement('canvas');
    canvas.width = 800;
    canvas.height = 600;
    canvas.dataset.dcName = name;
    const handle = nextId();
    this.dcs.set(handle, canvas);
    return handle;
  }

  async deleteDC(dc: number): Promise<void> {
    this.dcs.delete(dc);
  }

  private getCtx(dc: number): CanvasRenderingContext2D {
    const canvas = this.dcs.get(dc);
    if (!canvas) throw new Error(`Invalid DC: ${dc}`);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error(`Cannot get 2D context for DC ${dc}`);
    return ctx;
  }

  async textOut(dc: number, x: number, y: number, text: string, font?: FontSpec): Promise<number> {
    const ctx = this.getCtx(dc);
    ctx.font = `${font?.italic ? 'italic ' : ''}${font?.weight === 'bold' ? 'bold ' : ''}${font?.size ?? 12}px ${font?.name ?? 'sans-serif'}`;
    ctx.fillText(text, x, y);
    this.notify(dc, { x, y, width: ctx.measureText(text).width, height: font?.size ?? 16 });
    return E.NO_ERROR;
  }

  async bitBlt(
    destDc: number,
    destRect: Rect,
    srcDc: number,
    srcRect: Rect,
    _rop: number,
  ): Promise<number> {
    const dest = this.getCtx(destDc);
    const srcCanvas = this.dcs.get(srcDc);
    if (!srcCanvas) return E.ERROR_INVALID_HANDLE;
    dest.drawImage(
      srcCanvas,
      srcRect.x,
      srcRect.y,
      srcRect.width,
      srcRect.height,
      destRect.x,
      destRect.y,
      destRect.width,
      destRect.height,
    );
    this.notify(destDc, destRect);
    return E.NO_ERROR;
  }

  async stretchBlt(
    destDc: number,
    destRect: Rect,
    srcDc: number,
    srcRect: Rect,
    rop: number,
  ): Promise<number> {
    return this.bitBlt(destDc, destRect, srcDc, srcRect, rop);
  }

  async patBlt(dc: number, rect: Rect, color: Color, _rop: number): Promise<number> {
    const ctx = this.getCtx(dc);
    const prev = ctx.fillStyle;
    ctx.fillStyle = `rgb(${color.r},${color.g},${color.b})`;
    ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
    ctx.fillStyle = prev;
    this.notify(dc, rect);
    return E.NO_ERROR;
  }

  async setPixel(dc: number, x: number, y: number, color: Color): Promise<number> {
    const ctx = this.getCtx(dc);
    ctx.fillStyle = `rgb(${color.r},${color.g},${color.b})`;
    ctx.fillRect(x, y, 1, 1);
    return E.NO_ERROR;
  }

  async getDeviceCaps(_dc: number): Promise<DeviceCaps> {
    return {
      bitsPerPixel: 32,
      width: this.surface.width,
      height: this.surface.height,
      colorPlanes: 1,
      horizontalResolution: this.surface.width,
      verticalResolution: this.surface.height,
    };
  }

  async flush(_dc: number): Promise<void> {
    const ctx = this.surface.getContext('2d');
    if (!ctx) return;
    for (const dc of this.dcs.values()) {
      ctx.drawImage(dc, 0, 0);
    }
    this.notify(0, { x: 0, y: 0, width: this.surface.width, height: this.surface.height });
  }

  onInvalidate(listener: (dc: number, rect: Rect) => void): Dispose {
    this.invalidateHandlers.add(listener);
    return () => {
      this.invalidateHandlers.delete(listener);
    };
  }

  private notify(dc: number, rect: Rect): void {
    for (const handler of this.invalidateHandlers) handler(dc, rect);
  }
}

/** Placeholder D3D fixed-pipeline bridge (implemented at P5). */
export class NullD3DBridge implements D3DBridge {
  async createDevice(_w: number, _h: number): Promise<number> {
    return 0;
  }
  async beginScene(_device: number): Promise<void> {}
  async endScene(_device: number): Promise<void> {}
  async drawPrimitive(_device: number, _type: number, _vertices: Float32Array): Promise<number> {
    return NOT_IMPLEMENTED;
  }
  async setTransform(_device: number, _state: number, _matrix: Float32Array): Promise<void> {}
  async createTexture(_w: number, _h: number, _data: Uint8Array): Promise<number> {
    return 0;
  }
  async deleteTexture(_texture: number): Promise<void> {}
  async releaseDevice(_device: number): Promise<void> {}
}

/** Placeholder OpenGL 1.x bridge (implemented at P5). */
export class NullOglBridge implements OglBridge {
  async createContext(_w: number, _h: number): Promise<number> {
    return 0;
  }
  async makeCurrent(_context: number): Promise<void> {}
  async swapBuffers(_context: number): Promise<void> {}
  async destroyContext(_context: number): Promise<void> {}
}