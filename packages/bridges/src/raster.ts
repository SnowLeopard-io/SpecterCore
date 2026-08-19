/**
 * GDI 软件光栅化器（32 位色深）。
 *
 * 设计文档 3.2.1 / 3.2.9 的基础设施：
 *  - `GdiSurface`：32 位 ARGB 像素缓冲，提供形状绘制、位块传输（ROP 感知）、裁剪。
 *  - `applyRop`：三元光栅操作按真值表逐位求值（ROP2 二元 + ROP3 三元，全 256 种）。
 *  - 纯 TypeScript、零浏览器依赖，可在 node 中单测。
 *
 * ROP 语义（与 Windows 一致）：
 *  - ROP3 三元操作码：真值表索引 = `(rop >>> 16) & 0xff`，位 k = f(D bit0, S bit1, P bit2)。
 *  - ROP2 二元操作码：索引 = `rop & 0xff`，只使用位 k∈[0,4)（pattern 视为 0）。
 *  - 结果为逐通道的 0/255（单色平面语义，GDI 32bpp 即 8 位/通道）。
 *
 * 操作数绑定约定（桥接层接收归一化后的 8 位真值表索引）：
 *  - 填充形状（fillRect/ellipse/roundRect/fillPolygon）：dest = f(D, 黑, color)，默认 PATCOPY（0xF0）。
 *  - 描边形状与线条（line/polyline/polygon/frameRect/frameEllipse/frameRoundRect）：dest = f(D, color, 黑)，默认 COPY（0xCC）。
 *  - patBlt：color 作为 PATTERN（无 source），默认 PATCOPY。
 *  - bitBlt/stretchBlt：src 表面像素为 SOURCE，pattern=白；桥接层用 `ropIndex(dwRop)` 归一化 32 位 ROP3 码。
 */

import type { ClipRegion, Color, Point, Rect } from '@bk/contracts';

export const WHITE_COLOR: Color = { r: 255, g: 255, b: 255, a: 255 };
export const BLACK_COLOR: Color = { r: 0, g: 0, b: 0, a: 255 };

/**
 * 由 ROP3 32 位操作码解析三元真值表索引（取 0x16-0x23 位）：如 SRCCOPY → 0xCC。
 * handler 在调用桥接层前用本函数把 dwRop 归一化为索引。
 */
export function ropIndex(rop: number): number {
  return (rop >>> 16) & 0xff;
}

/**
 * 解析 Windows SetROP2 的 R2_* 枚举值（1-16）为 8 位真值表索引。
 */
const ROP2_ID_TO_INDEX: readonly number[] = [
  0x00, // R2_BLACK
  0x11, // R2_NOTMERGEPEN
  0x02, // R2_MASKNOTPEN
  0x33, // R2_NOTCOPYPEN
  0x04, // R2_MASKPENNOT
  0x55, // R2_NOT
  0x66, // R2_XORPEN
  0x77, // R2_NOTMASKPEN
  0x88, // R2_MASKPEN
  0x99, // R2_NOTXORPEN
  0xaa, // R2_NOP
  0xbb, // R2_MERGENOTPEN
  0xcc, // R2_COPYPEN
  0xdd, // R2_MERGEPENNOT
  0xee, // R2_MERGEPEN
  0xff, // R2_WHITE
];

export function rop2Index(r2Value: number): number {
  if (r2Value >= 1 && r2Value <= 16) return ROP2_ID_TO_INDEX[r2Value - 1] ?? 0xcc;
  return r2Value & 0xff;
}

/** ROP 真值表默认索引：SRCCOPY/COPYPEN（dest=源）与 PATCOPY（dest=pattern）。 */
export const ROP_INDEX_COPY = 0xcc;
export const ROP_INDEX_PATCOPY = 0xf0;

/**
 * 对完整 32 位像素逐位应用三元真值表，返回结果像素。
 * `rop` 为已归一化的 8 位真值表索引；布尔运算作用于像素值的每一位（8 位/通道 × 4 通道）。
 */
export function applyRopPixels(destPx: number, srcPx: number, patternPx: number, rop: number): number {
  const index = rop & 0xff;
  let out = 0;
  for (let bit = 0; bit < 32; bit++) {
    const combo =
      ((destPx >>> bit) & 1) | (((srcPx >>> bit) & 1) << 1) | (((patternPx >>> bit) & 1) << 2);
    if ((index >>> combo) & 1) out |= 1 << bit;
  }
  return out >>> 0;
}

/**
 * 对目标、源、pattern 三个颜色应用 ROP（按 32 位像素逐位）。
 * `rop` 为已归一化的 8 位真值表索引；operand 绑定（源/pattern 哪个有效）由调用方决定。
 */
export function applyRop(dest: Color, src: Color, pattern: Color, rop: number): Color {
  return fromPixel(applyRopPixels(toPixel(dest), toPixel(src), toPixel(pattern), rop));
}

export function toPixel(color: Color): number {
  return (
    (((color.a & 0xff) << 24) | ((color.r & 0xff) << 16) | ((color.g & 0xff) << 8) | (color.b & 0xff)) >>>
    0
  );
}

export function fromPixel(pixel: number): Color {
  return {
    r: (pixel >>> 16) & 0xff,
    g: (pixel >>> 8) & 0xff,
    b: pixel & 0xff,
    a: (pixel >>> 24) & 0xff,
  };
}

export interface GdiSurfaceOptions {
  width: number;
  height: number;
}

/**
 * 32 位 GDI 表面：像素缓冲 + 裁剪 + 形状绘制 + ROP 感知的位块传输。
 */
export class GdiSurface {
  readonly width: number;
  readonly height: number;
  /** 0xAARRGGBB */
  readonly pixels: Uint32Array;
  clip: ClipRegion | null = null;

  constructor(width: number, height: number) {
    if (width <= 0 || height <= 0) throw new Error(`Invalid surface size ${width}x${height}`);
    this.width = width;
    this.height = height;
    this.pixels = new Uint32Array(width * height);
    // 初始化为不透明黑（GDI 内存 DC 的确定性初值；getPixel 越界仍返回 null）
    this.pixels.fill(0xff000000);
  }

  // -------------------------------------------------------------------------
  // 基础像素访问
  // -------------------------------------------------------------------------

  clear(color: Color = BLACK_COLOR): void {
    const px = toPixel(color);
    this.pixels.fill(px);
  }

  clipContains(x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return false;
    const clip = this.clip;
    if (!clip) return true;
    const { x: cx, y: cy, width: cw, height: ch } = clip.rect;
    if (x < cx || x >= cx + cw || y < cy || y >= cy + ch) return false;
    if (clip.type === 'ellipse') {
      const rx = cw / 2;
      const ry = ch / 2;
      const nx = (x - (cx + rx)) / rx;
      const ny = (y - (cy + ry)) / ry;
      return nx * nx + ny * ny <= 1;
    }
    return true;
  }

  getPixel(x: number, y: number): Color | null {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return null;
    return fromPixel(this.pixels[y * this.width + x] ?? 0);
  }

  setPixel(x: number, y: number, color: Color, rop: number = ROP_INDEX_COPY): void {
    if (!this.clipContains(x, y)) return;
    const dest = this.pixels[y * this.width + x] ?? 0;
    // 画笔语义：dest = f(D, pen, 0)
    this.pixels[y * this.width + x] = applyRopPixels(dest, toPixel(color), 0, rop);
  }

  /** 画刷语义（填充）：dest = f(D, 黑, pattern)。 */
  setPixelPattern(x: number, y: number, color: Color, rop: number = ROP_INDEX_PATCOPY): void {
    if (!this.clipContains(x, y)) return;
    const dest = this.pixels[y * this.width + x] ?? 0;
    this.pixels[y * this.width + x] = applyRopPixels(dest, 0, toPixel(color), rop);
  }

  // -------------------------------------------------------------------------
  // 形状
  // -------------------------------------------------------------------------

  fillRect(rect: Rect, color: Color, rop: number = ROP_INDEX_PATCOPY): void {
    for (let y = Math.max(0, rect.y); y < Math.min(this.height, rect.y + rect.height); y++) {
      for (let x = Math.max(0, rect.x); x < Math.min(this.width, rect.x + rect.width); x++) {
        this.setPixelPattern(x, y, color, rop);
      }
    }
  }

  frameRect(rect: Rect, color: Color, rop: number = ROP_INDEX_COPY, width = 1): void {
    const top = Math.min(rect.height, width);
    const left = Math.min(rect.width, width);
    const x1 = rect.x + rect.width;
    const y1 = rect.y + rect.height;
    for (let y = rect.y; y < rect.y + top; y++) {
      for (let x = rect.x; x < x1; x++) this.setPixel(x, y, color, rop);
    }
    for (let y = y1 - top; y < y1; y++) {
      for (let x = rect.x; x < x1; x++) this.setPixel(x, y, color, rop);
    }
    for (let y = rect.y + top; y < y1 - top; y++) {
      for (let x = rect.x; x < rect.x + left; x++) this.setPixel(x, y, color, rop);
      for (let x = x1 - left; x < x1; x++) this.setPixel(x, y, color, rop);
    }
  }

  line(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    color: Color,
    rop: number = ROP_INDEX_COPY,
  ): void {
    let cx = x0;
    let cy = y0;
    const dx = Math.abs(x1 - x0);
    const sx = x0 < x1 ? 1 : -1;
    const dy = -Math.abs(y1 - y0);
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      this.setPixel(cx, cy, color, rop);
      if (cx === x1 && cy === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        cx += sx;
      }
      if (e2 <= dx) {
        err += dx;
        cy += sy;
      }
    }
  }

  /** 椭圆（填充），bounds 为外接矩形。 */
  ellipse(bounds: Rect, color: Color, rop: number = ROP_INDEX_PATCOPY): void {
    const cx = bounds.x + bounds.width / 2;
    const cy = bounds.y + bounds.height / 2;
    const rx = Math.max(0, bounds.width / 2);
    const ry = Math.max(0, bounds.height / 2);
    if (rx === 0 || ry === 0) return;
    for (let y = Math.max(0, bounds.y); y < Math.min(this.height, bounds.y + bounds.height); y++) {
      const ny = (y + 0.5 - cy) / ry;
      const hw = rx * Math.sqrt(Math.max(0, 1 - ny * ny));
      for (let x = Math.max(0, Math.floor(cx - hw)); x <= Math.min(this.width - 1, Math.ceil(cx + hw)); x++) {
        this.setPixelPattern(x, y, color, rop);
      }
    }
  }

  /** 椭圆边框。 */
  frameEllipse(bounds: Rect, color: Color, rop: number = ROP_INDEX_COPY): void {
    const cx = bounds.x + bounds.width / 2;
    const cy = bounds.y + bounds.height / 2;
    const rx = Math.max(0, bounds.width / 2);
    const ry = Math.max(0, bounds.height / 2);
    if (rx === 0 || ry === 0) return;
    for (let y = Math.max(0, bounds.y); y < Math.min(this.height, bounds.y + bounds.height); y++) {
      const ny = (y + 0.5 - cy) / ry;
      const hw = rx * Math.sqrt(Math.max(0, 1 - ny * ny));
      if (hw < 0.5) {
        this.setPixel(Math.round(cx), y, color, rop);
        continue;
      }
      this.setPixel(Math.floor(cx - hw), y, color, rop);
      this.setPixel(Math.ceil(cx + hw), y, color, rop);
    }
  }

  /** 圆角矩形内部判定。 */
  private roundRectContains(bounds: Rect, rx: number, ry: number, x: number, y: number): boolean {
    const { x: bx, y: by, width: w, height: h } = bounds;
    if (x < bx || x >= bx + w || y < by || y >= by + h) return false;
    const rx0 = Math.min(rx, w / 2);
    const ry0 = Math.min(ry, h / 2);
    if (x >= bx + rx0 && x < bx + w - rx0) return true;
    if (y >= by + ry0 && y < by + h - ry0) return true;
    // 位于四角之一：用角圆判定
    const cx = x < bx + rx0 ? bx + rx0 : bx + w - rx0 - 1;
    const cy = y < by + ry0 ? by + ry0 : by + h - ry0 - 1;
    const nx = (x - cx) / rx0;
    const ny = (y - cy) / ry0;
    return nx * nx + ny * ny <= 1;
  }

  roundRect(bounds: Rect, rx: number, ry: number, color: Color, rop: number = ROP_INDEX_PATCOPY): void {
    for (let y = Math.max(0, bounds.y); y < Math.min(this.height, bounds.y + bounds.height); y++) {
      for (let x = Math.max(0, bounds.x); x < Math.min(this.width, bounds.x + bounds.width); x++) {
        if (this.roundRectContains(bounds, rx, ry, x, y)) this.setPixelPattern(x, y, color, rop);
      }
    }
  }

  frameRoundRect(
    bounds: Rect,
    rx: number,
    ry: number,
    color: Color,
    rop: number = ROP_INDEX_COPY,
  ): void {
    const contains = (x: number, y: number): boolean =>
      this.roundRectContains(bounds, rx, ry, x, y);
    for (let y = Math.max(0, bounds.y); y < Math.min(this.height, bounds.y + bounds.height); y++) {
      for (let x = Math.max(0, bounds.x); x < Math.min(this.width, bounds.x + bounds.width); x++) {
        if (
          contains(x, y) &&
          (!contains(x - 1, y) || !contains(x + 1, y) || !contains(x, y - 1) || !contains(x, y + 1))
        ) {
          this.setPixel(x, y, color, rop);
        }
      }
    }
  }

  polyline(points: Point[], color: Color, rop: number = ROP_INDEX_COPY): void {
    for (let i = 0; i + 1 < points.length; i++) {
      const a = points[i]!;
      const b = points[i + 1]!;
      this.line(a.x, a.y, b.x, b.y, color, rop);
    }
  }

  polygon(points: Point[], color: Color, rop: number = ROP_INDEX_COPY): void {
    if (points.length < 2) return;
    this.polyline(points, color, rop);
    const last = points[points.length - 1]!;
    const first = points[0]!;
    this.line(last.x, last.y, first.x, first.y, color, rop);
  }

  fillPolygon(points: Point[], color: Color, rop: number = ROP_INDEX_PATCOPY): void {
    if (points.length < 3) return;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of points) {
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    const y0 = Math.max(0, Math.floor(minY));
    const y1 = Math.min(this.height - 1, Math.ceil(maxY));
    for (let y = y0; y <= y1; y++) {
      const hits: number[] = [];
      for (let i = 0; i < points.length; i++) {
        const a = points[i]!;
        const b = points[(i + 1) % points.length]!;
        const ya = a.y;
        const yb = b.y;
        if ((ya <= y && y < yb) || (yb <= y && y < ya)) {
          const t = (y - ya) / (yb - ya);
          hits.push(a.x + t * (b.x - a.x));
        }
      }
      hits.sort((m, n) => m - n);
      for (let i = 0; i + 1 < hits.length; i += 2) {
        const from = Math.max(0, Math.floor(hits[i]!));
        const to = Math.min(this.width - 1, Math.ceil(hits[i + 1]!));
        for (let x = from; x <= to; x++) this.setPixelPattern(x, y, color, rop);
      }
    }
  }

  // -------------------------------------------------------------------------
  // 位块传输（3.2.1 / 3.2.9）
  // -------------------------------------------------------------------------

  /**
   * 将 `src` 表面按 srcRect 复制到本表面 destRect，应用三元 ROP。
   * srcRect/destRect 尺寸可不同（stretchBlt 语义）。
   */
  blit(destRect: Rect, src: GdiSurface, srcRect: Rect, rop: number): void {
    const index = ropIndex(rop);
    const scaleX = srcRect.width / destRect.width;
    const scaleY = srcRect.height / destRect.height;
    for (let y = Math.max(0, destRect.y); y < Math.min(this.height, destRect.y + destRect.height); y++) {
      const sy = Math.min(src.height - 1, Math.max(0, Math.floor(srcRect.y + (y - destRect.y) * scaleY)));
      for (let x = Math.max(0, destRect.x); x < Math.min(this.width, destRect.x + destRect.width); x++) {
        if (!this.clipContains(x, y)) continue;
        const sx = Math.min(src.width - 1, Math.max(0, Math.floor(srcRect.x + (x - destRect.x) * scaleX)));
        const srcPixel = src.pixels[sy * src.width + sx] ?? 0;
        const destPixel = this.pixels[y * this.width + x] ?? 0;
        this.pixels[y * this.width + x] = applyRopPixels(destPixel, srcPixel, toPixel(WHITE_COLOR), index);
      }
    }
  }

  // -------------------------------------------------------------------------
  // 宿主输出
  // -------------------------------------------------------------------------

  /** 导出为 RGBA 字节序的 Uint8ClampedArray（供 putImageData 使用）。 */
  toRgba(): Uint8ClampedArray {
    const out = new Uint8ClampedArray(this.width * this.height * 4);
    for (let i = 0; i < this.pixels.length; i++) {
      const px = this.pixels[i] ?? 0;
      out[i * 4] = (px >>> 16) & 0xff;
      out[i * 4 + 1] = (px >>> 8) & 0xff;
      out[i * 4 + 2] = px & 0xff;
      out[i * 4 + 3] = (px >>> 24) & 0xff;
    }
    return out;
  }
}