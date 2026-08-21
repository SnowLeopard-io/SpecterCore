/**
 * L2 图形桥接契约：GDI / Direct3D 固定管线 / OpenGL 1.x → 宿主渲染后端。
 *
 * 设计文档 3.2：
 *  - 3.2.1  GDI 32 位色深渲染（BitBlt/StretchBlt/PatBlt，全 ROP）
 *  - 3.2.2  GDI 文本渲染（TextOut，字体规格）
 *  - 3.2.3  GDI 区域裁剪（矩形/椭圆）
 *  - 3.2.4  窗口 DC 与内存 DC 双缓冲（createCompatibleDC + BitBlt + flush）
 *  - 3.2.8  窗口事件映射由 L3/L6 承担（本层只负责绘制）
 *  - 3.2.9  光栅操作（ROP2 全 16 种 + ROP3 三元光栅操作，按真值表位运算）
 */

import type { Dispose } from '../kernel';
import type { WinError } from './fs';

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Color {
  r: number;
  g: number;
  b: number;
  a: number;
}

// ---------------------------------------------------------------------------
// ROP（光栅操作）
// ---------------------------------------------------------------------------

/**
 * ROP2 二元光栅操作（目标 + 源）。值为 8 位真值表：
 * 位 k = f(dest 的第 (k&1) 位, source 的第 ((k>>1)&1) 位)，k∈[0,4)（pattern 为无关操作数）。
 * R2_COPYPEN(0xCC)=源、R2_XORPEN(0x66)=dest^源、R2_NOP(0xAA)=目标不变…
 */
export const Rop2 = {
  BLACK: 0x00,
  NOTMERGEPEN: 0x11,
  MASKNOTPEN: 0x02,
  NOTCOPYPEN: 0x33,
  MASKPENNOT: 0x04,
  NOT: 0x55,
  XORPEN: 0x66,
  NOTMASKPEN: 0x77,
  MASKPEN: 0x88,
  NOTXORPEN: 0x99,
  NOP: 0xaa,
  MERGENOTPEN: 0xbb,
  COPYPEN: 0xcc,
  MERGEPENNOT: 0xdd,
  MERGEPEN: 0xee,
  WHITE: 0xff,
} as const;

/**
 * Windows `SetROP2` 的 R2_* 枚举值（1-16）→ 8 位真值表索引。
 * 例如 R2_COPYPEN=13 → 0xCC。handler 在调用桥接层前用 `rop2ToIndex` 转换。
 */
export const Rop2Id = {
  R2_BLACK: 1,
  R2_NOTMERGEPEN: 2,
  R2_MASKNOTPEN: 3,
  R2_NOTCOPYPEN: 4,
  R2_MASKPENNOT: 5,
  R2_NOT: 6,
  R2_XORPEN: 7,
  R2_NOTMASKPEN: 8,
  R2_MASKPEN: 9,
  R2_NOTXORPEN: 10,
  R2_NOP: 11,
  R2_MERGENOTPEN: 12,
  R2_COPYPEN: 13,
  R2_MERGEPENNOT: 14,
  R2_MERGEPEN: 15,
  R2_WHITE: 16,
} as const;

/**
 * ROP3 三元光栅操作码（Windows 32 位码值）。三元真值表索引取 `(rop >>> 16) & 0xff`：
 * 位 k = f(D bit0, S bit1, P bit2)。
 */
export const Rop3 = {
  BLACKNESS: 0x00000042,
  DSTINVERT: 0x00550009,
  MERGECOPY: 0x00c000ca,
  MERGEPAINT: 0x00bb0226,
  NOTSRCCOPY: 0x00330008,
  NOTSRCERASE: 0x001100a6,
  PATCOPY: 0x00f00021,
  PATINVERT: 0x005a0049,
  PATPAINT: 0x00fb0a09,
  SRCAND: 0x008800c6,
  SRCCOPY: 0x00cc0020,
  SRCERASE: 0x00440328,
  SRCINVERT: 0x00660046,
  SRCPAINT: 0x00ee0086,
  WHITENESS: 0x00ff0062,
} as const;

/** 背景模式（SetBkMode）。 */
export const BkMode = {
  TRANSPARENT: 1,
  OPAQUE: 2,
} as const;

// ---------------------------------------------------------------------------
// 裁剪区域
// ---------------------------------------------------------------------------

export interface ClipRegion {
  type: 'rect' | 'ellipse';
  rect: Rect;
}

// ---------------------------------------------------------------------------
// GDI
// ---------------------------------------------------------------------------

export interface FontSpec {
  name: string;
  size: number;
  weight: 'normal' | 'bold' | 'bolder' | 'lighter' | number;
  italic: boolean;
}

export interface DeviceCaps {
  bitsPerPixel: number;
  width: number;
  height: number;
  colorPlanes: number;
  horizontalResolution: number;
  verticalResolution: number;
}

/**
 * SetDIBitsToDevice 的 DIB 载荷：BITMAPINFO 头部解析结果 + 调色板 + 像素位。
 * `height` 为正表示 bottom-up（内存首行是图像底行），为负表示 top-down。
 * `palette` 为索引色格式（1/4/8bpp）的 ARGB 调色板，直接色格式为 null。
 * `bits` 只含 `cLines` 条扫描线（从 `startScan` 起）；`xSrc/ySrc` 是 DIB 内
 * 源矩形的左下角，`drawWidth/drawHeight` 是要绘制的 w×h 区域。
 */
export interface DibSurface {
  width: number;
  height: number;
  bitCount: number;
  palette: Uint32Array | null;
  bits: Uint8Array;
  xSrc: number;
  ySrc: number;
  drawWidth: number;
  drawHeight: number;
  startScan: number;
  cLines: number;
}

export interface GdiBridge {
  /** 创建 DC（name 为设备名，如 "DISPLAY"、内存 DC 名），返回 DC 句柄 */
  createDC(name: string): Promise<number>;
  /** 创建与指定 DC 兼容的内存 DC（双缓冲的目标，3.2.4） */
  createCompatibleDC(dc: number): Promise<number>;
  deleteDC(dc: number): Promise<void>;

  // -- 文本（3.2.2） ---------------------------------------------------------
  textOut(dc: number, x: number, y: number, text: string, font?: FontSpec): Promise<WinError>;
  setTextColor(dc: number, color: Color): Promise<WinError>;
  setBkColor(dc: number, color: Color): Promise<WinError>;
  setBkMode(dc: number, mode: number): Promise<WinError>;

  // -- 形状（3.2.1 扩展） -----------------------------------------------------
  lineTo(
    dc: number,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    color: Color,
    rop?: number,
  ): Promise<WinError>;
  fillRect(dc: number, rect: Rect, color: Color, rop?: number): Promise<WinError>;
  frameRect(dc: number, rect: Rect, color: Color, rop?: number): Promise<WinError>;
  ellipse(dc: number, bounds: Rect, color: Color, rop?: number): Promise<WinError>;
  frameEllipse(dc: number, bounds: Rect, color: Color, rop?: number): Promise<WinError>;
  roundRect(
    dc: number,
    bounds: Rect,
    rx: number,
    ry: number,
    color: Color,
    rop?: number,
  ): Promise<WinError>;
  polyline(dc: number, points: Point[], color: Color, rop?: number): Promise<WinError>;
  polygon(dc: number, points: Point[], color: Color, rop?: number): Promise<WinError>;
  setPixel(dc: number, x: number, y: number, color: Color): Promise<WinError>;

  // -- 裁剪（3.2.3） ---------------------------------------------------------
  setClip(dc: number, region: ClipRegion | null): Promise<void>;
  getClip(dc: number): Promise<ClipRegion | null>;

  // -- DC 状态保存/恢复 ------------------------------------------------------
  saveDC(dc: number): Promise<number>;
  restoreDC(dc: number, saved?: number): Promise<number>;

  // -- 位块传输（3.2.1） -----------------------------------------------------
  bitBlt(
    destDc: number,
    destRect: Rect,
    srcDc: number,
    srcRect: Rect,
    rop: number,
  ): Promise<WinError>;

  /** DIB 位图数据（SetDIBitsToDevice 的像素载荷，已从客户机内存读出）。 */
  setDIBitsToDevice(dc: number, xDest: number, yDest: number, dib: DibSurface): Promise<WinError>;
  stretchBlt(
    destDc: number,
    destRect: Rect,
    srcDc: number,
    srcRect: Rect,
    rop: number,
  ): Promise<WinError>;
  patBlt(dc: number, rect: Rect, color: Color, rop: number): Promise<WinError>;

  getDeviceCaps(dc: number): Promise<DeviceCaps>;
  /** 提交 DC 内容到目标表面（双缓冲 SwapBuffers 语义） */
  flush(dc: number): Promise<void>;
  /** GDI 内容失效时通知（增量重绘） */
  onInvalidate(listener: (dc: number, rect: Rect) => void): Dispose;
}

// ---------------------------------------------------------------------------
// Direct3D 固定管线（D3D7/8/9 → WebGPU，P5）
// ---------------------------------------------------------------------------

export interface D3DBridge {
  createDevice(width: number, height: number): Promise<number>;
  beginScene(device: number): Promise<void>;
  endScene(device: number): Promise<void>;
  drawPrimitive(device: number, primitiveType: number, vertices: Float32Array): Promise<WinError>;
  setTransform(device: number, state: number, matrix: Float32Array): Promise<void>;
  createTexture(width: number, height: number, data: Uint8Array): Promise<number>;
  deleteTexture(texture: number): Promise<void>;
  releaseDevice(device: number): Promise<void>;
}

// ---------------------------------------------------------------------------
// OpenGL 1.1-1.5（P5）
// ---------------------------------------------------------------------------

export interface OglBridge {
  createContext(width: number, height: number): Promise<number>;
  makeCurrent(context: number): Promise<void>;
  swapBuffers(context: number): Promise<void>;
  destroyContext(context: number): Promise<void>;
}
