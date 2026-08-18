/**
 * L2 图形桥接契约：GDI / Direct3D 固定管线 / OpenGL 1.x → WebGPU。
 */

import type { Dispose } from '../kernel';
import type { WinError } from './fs';

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

export interface GdiBridge {
  /** 创建内存 DC，返回 DC 句柄 */
  createDC(name: string): Promise<number>;
  deleteDC(dc: number): Promise<void>;
  textOut(dc: number, x: number, y: number, text: string, font?: FontSpec): Promise<WinError>;
  bitBlt(destDc: number, destRect: Rect, srcDc: number, srcRect: Rect, rop: number): Promise<WinError>;
  stretchBlt(
    destDc: number,
    destRect: Rect,
    srcDc: number,
    srcRect: Rect,
    rop: number,
  ): Promise<WinError>;
  patBlt(dc: number, rect: Rect, color: Color, rop: number): Promise<WinError>;
  setPixel(dc: number, x: number, y: number, color: Color): Promise<WinError>;
  getDeviceCaps(dc: number): Promise<DeviceCaps>;
  flush(dc: number): Promise<void>;
  /** GDI 内容失效时通知（双缓冲提交） */
  onInvalidate(listener: (dc: number, rect: Rect) => void): Dispose;
}

// ---------------------------------------------------------------------------
// Direct3D 固定管线（D3D7/8/9 → WebGPU）
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
// OpenGL 1.1-1.5
// ---------------------------------------------------------------------------

export interface OglBridge {
  createContext(width: number, height: number): Promise<number>;
  makeCurrent(context: number): Promise<void>;
  swapBuffers(context: number): Promise<void>;
  destroyContext(context: number): Promise<void>;
}