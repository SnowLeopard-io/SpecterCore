import type {
  BkMode,
  ClipRegion,
  Color,
  D3DBridge,
  DeviceCaps,
  Dispose,
  FontSpec,
  GdiBridge,
  OglBridge,
  Point,
  Rect,
  WinError,
} from '@bk/contracts';
import { WinError as E } from '@bk/contracts';
import { nextId } from '@bk/shared';
import { GdiSurface, ROP_INDEX_COPY, ROP_INDEX_PATCOPY, ropIndex } from './raster';

const NOT_IMPLEMENTED = E.ERROR_NOT_IMPLEMENTED;

/**
 * 空 GDI 桥接：全部返回 NOT_IMPLEMENTED（占位，直到真实渲染器接入）。
 */
export class NullGdiBridge implements GdiBridge {
  async createDC(_name: string): Promise<number> {
    return 0;
  }
  async createCompatibleDC(_dc: number): Promise<number> {
    return 0;
  }
  async deleteDC(_dc: number): Promise<void> {}
  async textOut(_dc: number, _x: number, _y: number, _text: string, _font?: FontSpec): Promise<WinError> {
    return NOT_IMPLEMENTED;
  }
  async setTextColor(_dc: number, _color: Color): Promise<WinError> {
    return NOT_IMPLEMENTED;
  }
  async setBkColor(_dc: number, _color: Color): Promise<WinError> {
    return NOT_IMPLEMENTED;
  }
  async setBkMode(_dc: number, _mode: number): Promise<WinError> {
    return NOT_IMPLEMENTED;
  }
  async lineTo(_dc: number, _x0: number, _y0: number, _x1: number, _y1: number, _color: Color, _rop?: number): Promise<WinError> {
    return NOT_IMPLEMENTED;
  }
  async fillRect(_dc: number, _rect: Rect, _color: Color, _rop?: number): Promise<WinError> {
    return NOT_IMPLEMENTED;
  }
  async frameRect(_dc: number, _rect: Rect, _color: Color, _rop?: number): Promise<WinError> {
    return NOT_IMPLEMENTED;
  }
  async ellipse(_dc: number, _bounds: Rect, _color: Color, _rop?: number): Promise<WinError> {
    return NOT_IMPLEMENTED;
  }
  async frameEllipse(_dc: number, _bounds: Rect, _color: Color, _rop?: number): Promise<WinError> {
    return NOT_IMPLEMENTED;
  }
  async roundRect(_dc: number, _bounds: Rect, _rx: number, _ry: number, _color: Color, _rop?: number): Promise<WinError> {
    return NOT_IMPLEMENTED;
  }
  async polyline(_dc: number, _points: Point[], _color: Color, _rop?: number): Promise<WinError> {
    return NOT_IMPLEMENTED;
  }
  async polygon(_dc: number, _points: Point[], _color: Color, _rop?: number): Promise<WinError> {
    return NOT_IMPLEMENTED;
  }
  async setPixel(_dc: number, _x: number, _y: number, _color: Color): Promise<WinError> {
    return NOT_IMPLEMENTED;
  }
  async setClip(_dc: number, _region: ClipRegion | null): Promise<void> {}
  async getClip(_dc: number): Promise<ClipRegion | null> {
    return null;
  }
  async saveDC(_dc: number): Promise<number> {
    return 0;
  }
  async restoreDC(_dc: number, _saved?: number): Promise<number> {
    return 0;
  }
  async bitBlt(_destDc: number, _destRect: Rect, _srcDc: number, _srcRect: Rect, _rop: number): Promise<WinError> {
    return NOT_IMPLEMENTED;
  }
  async stretchBlt(
    _destDc: number,
    _destRect: Rect,
    _srcDc: number,
    _srcRect: Rect,
    _rop: number,
  ): Promise<WinError> {
    return NOT_IMPLEMENTED;
  }
  async patBlt(_dc: number, _rect: Rect, _color: Color, _rop: number): Promise<WinError> {
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

interface GdiDcState {
  textColor: Color;
  bkColor: Color;
  bkMode: number;
  font: FontSpec | null;
  penColor: Color;
  clip: ClipRegion | null;
}

interface GdiDc {
  surface: GdiSurface;
  state: GdiDcState;
  saveStack: GdiDcState[];
  canvas: HTMLCanvasElement | null;
}

const DEFAULT_STATE: GdiDcState = {
  textColor: { r: 0, g: 0, b: 0, a: 255 },
  bkColor: { r: 255, g: 255, b: 255, a: 255 },
  bkMode: 1, // BkMode.TRANSPARENT
  font: null,
  penColor: { r: 0, g: 0, b: 0, a: 255 },
  clip: null,
};

function cloneState(state: GdiDcState): GdiDcState {
  return {
    textColor: { ...state.textColor },
    bkColor: { ...state.bkColor },
    bkMode: state.bkMode,
    font: state.font ? { ...state.font } : null,
    penColor: { ...state.penColor },
    clip: state.clip ? { type: state.clip.type, rect: { ...state.clip.rect } } : null,
  };
}

const RGB = (c: Color): string => `rgb(${c.r & 0xff},${c.g & 0xff},${c.b & 0xff})`;

/**
 * 基于软件光栅化器（GdiSurface）的 GDI 桥接，通过 2D canvas 呈现。
 * 全 ROP（ROP2/ROP3）、裁剪、双缓冲（内存 DC）、形状与文本绘制。
 */
export class CanvasGdiBridge implements GdiBridge {
  private readonly dcs = new Map<number, GdiDc>();
  private readonly invalidateHandlers = new Set<(dc: number, rect: Rect) => void>();
  private readonly textCtx: CanvasRenderingContext2D | null;

  constructor(private readonly display: HTMLCanvasElement) {
    this.textCtx = typeof document !== 'undefined' ? display.getContext('2d') : null;
  }

  private requireDc(dc: number): GdiDc {
    const rec = this.dcs.get(dc);
    if (!rec) throw new Error(`Invalid DC: ${dc}`);
    return rec;
  }

  private fullRect(dc: number): Rect {
    const { surface } = this.requireDc(dc);
    return { x: 0, y: 0, width: surface.width, height: surface.height };
  }

  private notify(dc: number, rect: Rect): void {
    for (const handler of this.invalidateHandlers) handler(dc, rect);
  }

  async createDC(name: string): Promise<number> {
    const surface = new GdiSurface(800, 600);
    const handle = nextId();
    this.dcs.set(handle, { surface, state: cloneState(DEFAULT_STATE), saveStack: [], canvas: null });
    void name;
    return handle;
  }

  async createCompatibleDC(dc: number): Promise<number> {
    const { surface } = this.requireDc(dc);
    const handle = nextId();
    this.dcs.set(handle, {
      surface: new GdiSurface(surface.width, surface.height),
      state: cloneState(DEFAULT_STATE),
      saveStack: [],
      canvas: null,
    });
    return handle;
  }

  async deleteDC(dc: number): Promise<void> {
    this.dcs.delete(dc);
  }

  // -- 文本（3.2.2） ---------------------------------------------------------

  async setTextColor(dc: number, color: Color): Promise<WinError> {
    const rec = this.requireDc(dc);
    const prev = rec.state.textColor;
    rec.state.textColor = color;
    return toRgb(prev);
  }

  async setBkColor(dc: number, color: Color): Promise<WinError> {
    const rec = this.requireDc(dc);
    const prev = rec.state.bkColor;
    rec.state.bkColor = color;
    return toRgb(prev);
  }

  async setBkMode(dc: number, mode: number): Promise<WinError> {
    const rec = this.requireDc(dc);
    const prev = rec.state.bkMode;
    rec.state.bkMode = mode;
    return prev;
  }

  async textOut(dc: number, x: number, y: number, text: string, font?: FontSpec): Promise<WinError> {
    const rec = this.requireDc(dc);
    if (!this.textCtx) return E.NO_ERROR; // node 无 canvas：文本为 no-op
    const { surface } = rec;
    const f = font ?? rec.state.font;
    const ctx = this.textCtx;
    ctx.font = toCanvasFont(f);
    const metrics = ctx.measureText(text);
    const width = Math.ceil(metrics.width) + 2;
    const height = Math.ceil((f?.size ?? 12) * 1.4);
    const scratch = document.createElement('canvas');
    scratch.width = width;
    scratch.height = height;
    const sctx = scratch.getContext('2d');
    if (!sctx) return E.NO_ERROR;
    sctx.font = ctx.font;
    if (rec.state.bkMode === 2 /* BkMode.OPAQUE */) {
      sctx.fillStyle = RGB(rec.state.bkColor);
      sctx.fillRect(0, 0, width, height);
    }
    sctx.fillStyle = RGB(rec.state.textColor);
    sctx.textBaseline = 'top';
    sctx.fillText(text, 0, 0);
    const image = sctx.getImageData(0, 0, width, height);
    blitRgbaIntoSurface(surface, x, y, image.data, width, height, ROP_INDEX_COPY);
    this.notify(dc, { x, y, width, height });
    return E.NO_ERROR;
  }

  // -- 形状（3.2.1 扩展） -----------------------------------------------------

  async lineTo(dc: number, x0: number, y0: number, x1: number, y1: number, color: Color, rop?: number): Promise<WinError> {
    const { surface } = this.requireDc(dc);
    surface.line(x0, y0, x1, y1, color, rop ?? ROP_INDEX_COPY);
    this.notify(dc, { x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.abs(x1 - x0) + 1, height: Math.abs(y1 - y0) + 1 });
    return E.NO_ERROR;
  }

  async fillRect(dc: number, rect: Rect, color: Color, rop?: number): Promise<WinError> {
    const { surface } = this.requireDc(dc);
    surface.fillRect(rect, color, rop ?? ROP_INDEX_PATCOPY);
    this.notify(dc, rect);
    return E.NO_ERROR;
  }

  async frameRect(dc: number, rect: Rect, color: Color, rop?: number): Promise<WinError> {
    const { surface } = this.requireDc(dc);
    surface.frameRect(rect, color, rop ?? ROP_INDEX_COPY);
    this.notify(dc, rect);
    return E.NO_ERROR;
  }

  async ellipse(dc: number, bounds: Rect, color: Color, rop?: number): Promise<WinError> {
    const { surface } = this.requireDc(dc);
    surface.ellipse(bounds, color, rop ?? ROP_INDEX_PATCOPY);
    this.notify(dc, bounds);
    return E.NO_ERROR;
  }

  async frameEllipse(dc: number, bounds: Rect, color: Color, rop?: number): Promise<WinError> {
    const { surface } = this.requireDc(dc);
    surface.frameEllipse(bounds, color, rop ?? ROP_INDEX_COPY);
    this.notify(dc, bounds);
    return E.NO_ERROR;
  }

  async roundRect(dc: number, bounds: Rect, rx: number, ry: number, color: Color, rop?: number): Promise<WinError> {
    const { surface } = this.requireDc(dc);
    surface.roundRect(bounds, rx, ry, color, rop ?? ROP_INDEX_PATCOPY);
    this.notify(dc, bounds);
    return E.NO_ERROR;
  }

  async polyline(dc: number, points: Point[], color: Color, rop?: number): Promise<WinError> {
    const { surface } = this.requireDc(dc);
    surface.polyline(points, color, rop ?? ROP_INDEX_COPY);
    this.notify(dc, boundsOf(points));
    return E.NO_ERROR;
  }

  async polygon(dc: number, points: Point[], color: Color, rop?: number): Promise<WinError> {
    const { surface } = this.requireDc(dc);
    surface.fillPolygon(points, color, rop ?? ROP_INDEX_PATCOPY);
    this.notify(dc, boundsOf(points));
    return E.NO_ERROR;
  }

  async setPixel(dc: number, x: number, y: number, color: Color): Promise<WinError> {
    const { surface } = this.requireDc(dc);
    surface.setPixel(x, y, color);
    this.notify(dc, { x, y, width: 1, height: 1 });
    return E.NO_ERROR;
  }

  // -- 裁剪（3.2.3） ---------------------------------------------------------

  async setClip(dc: number, region: ClipRegion | null): Promise<void> {
    const rec = this.requireDc(dc);
    rec.state.clip = region;
    rec.surface.clip = region;
  }

  async getClip(dc: number): Promise<ClipRegion | null> {
    return this.requireDc(dc).state.clip;
  }

  // -- DC 状态保存/恢复 ------------------------------------------------------

  async saveDC(dc: number): Promise<number> {
    const rec = this.requireDc(dc);
    rec.saveStack.push(cloneState(rec.state));
    return rec.saveStack.length;
  }

  async restoreDC(dc: number, saved?: number): Promise<number> {
    const rec = this.requireDc(dc);
    if (saved === undefined) {
      const state = rec.saveStack.pop();
      if (state) {
        rec.state = state;
        rec.surface.clip = state.clip;
      }
      return rec.saveStack.length;
    }
    // 恢复到指定层级
    const target = Math.max(0, Math.min(rec.saveStack.length, saved));
    while (rec.saveStack.length > target) rec.saveStack.pop();
    const state = rec.saveStack[target - 1];
    if (state) {
      rec.state = state;
      rec.surface.clip = state.clip;
    }
    return target;
  }

  // -- 位块传输（3.2.1） -----------------------------------------------------

  async bitBlt(destDc: number, destRect: Rect, srcDc: number, srcRect: Rect, rop: number): Promise<WinError> {
    const dest = this.requireDc(destDc);
    const src = this.requireDc(srcDc);
    dest.surface.blit(destRect, src.surface, srcRect, rop);
    this.notify(destDc, destRect);
    return E.NO_ERROR;
  }

  async stretchBlt(destDc: number, destRect: Rect, srcDc: number, srcRect: Rect, rop: number): Promise<WinError> {
    return this.bitBlt(destDc, destRect, srcDc, srcRect, rop);
  }

  async patBlt(dc: number, rect: Rect, color: Color, rop: number): Promise<WinError> {
    const { surface } = this.requireDc(dc);
    const index = ropIndex(rop);
    for (let y = rect.y; y < rect.y + rect.height; y++) {
      for (let x = rect.x; x < rect.x + rect.width; x++) {
        surface.setPixelPattern(x, y, color, index);
      }
    }
    this.notify(dc, rect);
    return E.NO_ERROR;
  }

  async getDeviceCaps(dc: number): Promise<DeviceCaps> {
    const { surface } = this.requireDc(dc);
    return {
      bitsPerPixel: 32,
      width: surface.width,
      height: surface.height,
      colorPlanes: 1,
      horizontalResolution: surface.width,
      verticalResolution: surface.height,
    };
  }

  async flush(dc: number): Promise<void> {
    const { surface } = this.requireDc(dc);
    if (this.textCtx) {
      const image = this.textCtx.createImageData(surface.width, surface.height);
      image.data.set(surface.toRgba());
      this.textCtx.putImageData(image, 0, 0);
    }
    this.notify(dc, this.fullRect(dc));
  }

  onInvalidate(listener: (dc: number, rect: Rect) => void): Dispose {
    this.invalidateHandlers.add(listener);
    return () => {
      this.invalidateHandlers.delete(listener);
    };
  }
}

function toRgb(color: Color): number {
  return (((color.r & 0xff) << 16) | ((color.g & 0xff) << 8) | (color.b & 0xff)) >>> 0;
}

function toCanvasFont(font: FontSpec | null): string {
  if (!font) return '12px sans-serif';
  const italic = font.italic ? 'italic ' : '';
  const weight = typeof font.weight === 'number' ? String(font.weight) : font.weight;
  const size = `${font.size ?? 12}px`;
  return `${italic}${weight} ${size} ${font.name ?? 'sans-serif'}`;
}

function boundsOf(points: Point[]): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  if (points.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** 把 RGBA 字节块按 SRCCOPY 写入表面（文本栅格化结果）。 */
function blitRgbaIntoSurface(
  surface: GdiSurface,
  x: number,
  y: number,
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  rop: number,
): void {
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const i = (row * width + col) * 4;
      surface.setPixel(x + col, y + row, {
        r: rgba[i] ?? 0,
        g: rgba[i + 1] ?? 0,
        b: rgba[i + 2] ?? 0,
        a: rgba[i + 3] ?? 0,
      }, rop);
    }
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