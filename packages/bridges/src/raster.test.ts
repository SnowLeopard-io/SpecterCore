import { describe, expect, it } from 'vitest';
import type { Color } from '@specter-core/contracts';
import { Rop2, Rop2Id, Rop3 } from '@specter-core/contracts';
import {
  applyRop,
  applyRopPixels,
  GdiSurface,
  rop2Index,
  ropIndex,
  toPixel,
  WHITE_COLOR,
} from './raster';

const red: Color = { r: 255, g: 0, b: 0, a: 255 };
const blue: Color = { r: 0, g: 0, b: 255, a: 255 };
const black: Color = { r: 0, g: 0, b: 0, a: 255 };
// GdiSurface 初始背景 = 不透明白（Windows COLOR_WINDOW 默认），未绘制区域断言白。
const white: Color = { r: 255, g: 255, b: 255, a: 255 };
const transparentBlack: Color = { r: 0, g: 0, b: 0, a: 0 };

describe('ropIndex（ROP3 32 位码 → 8 位真值表索引）', () => {
  it('取 0x16-0x23 位', () => {
    expect(ropIndex(Rop3.SRCCOPY)).toBe(0xcc);
    expect(ropIndex(Rop3.SRCINVERT)).toBe(0x66);
    expect(ropIndex(Rop3.PATCOPY)).toBe(0xf0);
    expect(ropIndex(Rop3.BLACKNESS)).toBe(0x00);
    expect(ropIndex(Rop3.WHITENESS)).toBe(0xff);
  });
});

describe('rop2Index（Windows SetROP2 枚举 1-16 → 真值表索引）', () => {
  it('R2_COPYPEN(13) → 0xCC、R2_XORPEN(7) → 0x66、R2_BLACK(1) → 0x00、R2_WHITE(16) → 0xFF', () => {
    expect(rop2Index(Rop2Id.R2_COPYPEN)).toBe(0xcc);
    expect(rop2Index(Rop2Id.R2_XORPEN)).toBe(0x66);
    expect(rop2Index(Rop2Id.R2_BLACK)).toBe(0x00);
    expect(rop2Index(Rop2Id.R2_WHITE)).toBe(0xff);
  });

  it('Rop2 常量本身就是真值表索引，无需 ropIndex 归一化', () => {
    expect(Rop2.COPYPEN).toBe(0xcc);
    expect(Rop2.XORPEN).toBe(0x66);
    expect(Rop2.NOP).toBe(0xaa);
    expect(rop2Index(Rop2.COPYPEN)).toBe(0xcc);
  });
});

describe('applyRop（按 32 位逐位求值，rop 为 8 位真值表索引）', () => {
  const dest: Color = { r: 0x80, g: 0x80, b: 0x80, a: 0xff };
  const src: Color = { r: 0x40, g: 0x40, b: 0x40, a: 0xff };

  it('SRCCOPY 完整复制源像素', () => {
    expect(applyRop(dest, src, WHITE_COLOR, ropIndex(Rop3.SRCCOPY))).toEqual(src);
  });

  it('SRCINVERT = dest ^ src', () => {
    const d = toPixel(dest);
    const s = toPixel(src);
    expect(toPixel(applyRop(dest, src, WHITE_COLOR, ropIndex(Rop3.SRCINVERT)))).toBe((d ^ s) >>> 0);
  });

  it('SRCAND = dest & src', () => {
    const d = toPixel(dest);
    const s = toPixel(src);
    expect(toPixel(applyRop(dest, src, WHITE_COLOR, ropIndex(Rop3.SRCAND)))).toBe((d & s) >>> 0);
  });

  it('SRCPAINT = dest | src', () => {
    const d = toPixel(dest);
    const s = toPixel(src);
    expect(toPixel(applyRop(dest, src, WHITE_COLOR, ropIndex(Rop3.SRCPAINT)))).toBe((d | s) >>> 0);
  });

  it('DSTINVERT = ~dest', () => {
    const d = toPixel(dest);
    expect(toPixel(applyRop(dest, black, WHITE_COLOR, ropIndex(Rop3.DSTINVERT)))).toBe(~d >>> 0);
  });

  it('索引 0x00 / 0xFF 恒 0 / 恒 FF', () => {
    expect(toPixel(applyRop(dest, src, WHITE_COLOR, 0x00))).toBe(0);
    expect(toPixel(applyRop(dest, src, WHITE_COLOR, 0xff))).toBe(0xffffffff);
  });

  it('PATCOPY = pattern、PATINVERT = dest ^ pattern', () => {
    expect(toPixel(applyRop(dest, black, red, ropIndex(Rop3.PATCOPY)))).toBe(toPixel(red));
    const d = toPixel(dest);
    expect(toPixel(applyRop(dest, black, red, ropIndex(Rop3.PATINVERT)))).toBe(
      (d ^ toPixel(red)) >>> 0,
    );
  });

  it('ROP2：源参与、pattern 置黑（二元语义）', () => {
    expect(applyRop(dest, src, transparentBlack, Rop2.COPYPEN)).toEqual(src);
    const d = toPixel(dest);
    const s = toPixel(src);
    expect(toPixel(applyRop(dest, src, transparentBlack, Rop2.XORPEN))).toBe((d ^ s) >>> 0);
    expect(toPixel(applyRop(dest, src, transparentBlack, Rop2.BLACK))).toBe(0);
    expect(toPixel(applyRop(dest, src, transparentBlack, Rop2.WHITE))).toBe(0xffffffff);
  });

  it('applyRopPixels 与 applyRop 等价', () => {
    const idx = ropIndex(Rop3.SRCINVERT);
    expect(applyRopPixels(toPixel(dest), toPixel(src), toPixel(WHITE_COLOR), idx)).toBe(
      toPixel(applyRop(dest, src, WHITE_COLOR, idx)),
    );
  });
});

describe('GdiSurface', () => {
  it('fillRect 填充颜色', () => {
    const s = new GdiSurface(16, 16);
    s.fillRect({ x: 2, y: 3, width: 5, height: 4 }, red);
    expect(s.getPixel(2, 3)).toEqual(red);
    expect(s.getPixel(6, 6)).toEqual(red);
    expect(s.getPixel(1, 3)).toEqual(white);
    expect(s.getPixel(7, 6)).toEqual(white);
  });

  it('fillRect 带 PATINVERT 执行 XOR（画刷/pattern 语义）', () => {
    const s = new GdiSurface(8, 8);
    s.fillRect({ x: 0, y: 0, width: 4, height: 4 }, red);
    s.fillRect({ x: 2, y: 0, width: 4, height: 4 }, red, ropIndex(Rop3.PATINVERT));
    expect(s.getPixel(3, 1)).toEqual(transparentBlack); // 重叠区：red ^ red = 0
    expect(s.getPixel(1, 1)).toEqual(red); // 非重叠区仍为 red
  });

  it('line 绘制对角线（Bresenham）', () => {
    const s = new GdiSurface(8, 8);
    s.line(0, 0, 5, 5, blue);
    expect(s.getPixel(0, 0)).toEqual(blue);
    expect(s.getPixel(2, 2)).toEqual(blue);
    expect(s.getPixel(5, 5)).toEqual(blue);
    expect(s.getPixel(3, 1)).toEqual(white);
  });

  it('ellipse 填充中心着色、外部不着色', () => {
    const s = new GdiSurface(20, 20);
    s.ellipse({ x: 2, y: 2, width: 12, height: 12 }, red);
    expect(s.getPixel(8, 8)).toEqual(red); // 中心
    expect(s.getPixel(2, 8)).toEqual(red); // 左边界
    expect(s.getPixel(1, 8)).toEqual(white); // 外
  });

  it('frameEllipse 画椭圆边框（中心为空洞）', () => {
    const s = new GdiSurface(20, 20);
    s.frameEllipse({ x: 2, y: 2, width: 12, height: 12 }, red);
    expect(s.getPixel(2, 8)).toEqual(red);
    expect(s.getPixel(8, 8)).toEqual(white); // 中心不填充
  });

  it('polygon 扫描线填充三角形', () => {
    const s = new GdiSurface(16, 16);
    s.fillPolygon(
      [
        { x: 4, y: 2 },
        { x: 12, y: 2 },
        { x: 8, y: 12 },
      ],
      red,
    );
    expect(s.getPixel(8, 4)).toEqual(red);
    expect(s.getPixel(8, 10)).toEqual(red);
    expect(s.getPixel(2, 6)).toEqual(white);
  });

  it('roundRect 填充圆角矩形', () => {
    const s = new GdiSurface(16, 16);
    s.roundRect({ x: 2, y: 2, width: 12, height: 12 }, 3, 3, red);
    expect(s.getPixel(4, 4)).toEqual(red);
    expect(s.getPixel(12, 12)).toEqual(red);
    expect(s.getPixel(2, 2)).toEqual(white); // 角被切
  });

  it('frameRect 只画边框', () => {
    const s = new GdiSurface(10, 10);
    s.frameRect({ x: 1, y: 1, width: 6, height: 6 }, red);
    expect(s.getPixel(1, 1)).toEqual(red);
    expect(s.getPixel(6, 6)).toEqual(red);
    expect(s.getPixel(3, 3)).toEqual(white); // 中心空洞
  });

  it('blit SRCCOPY 复制整块', () => {
    const a = new GdiSurface(16, 16);
    const b = new GdiSurface(16, 16);
    a.fillRect({ x: 0, y: 0, width: 8, height: 8 }, red);
    b.blit(
      { x: 4, y: 4, width: 8, height: 8 },
      a,
      { x: 0, y: 0, width: 8, height: 8 },
      Rop3.SRCCOPY,
    );
    expect(b.getPixel(5, 5)).toEqual(red);
    expect(b.getPixel(0, 0)).toEqual(white);
  });

  it('blit SRCINVERT = 目标 XOR 源', () => {
    const a = new GdiSurface(8, 8);
    const b = new GdiSurface(8, 8);
    a.fillRect({ x: 0, y: 0, width: 4, height: 4 }, red);
    b.fillRect({ x: 0, y: 0, width: 4, height: 4 }, red);
    b.blit(
      { x: 0, y: 0, width: 4, height: 4 },
      a,
      { x: 0, y: 0, width: 4, height: 4 },
      Rop3.SRCINVERT,
    );
    expect(b.getPixel(1, 1)).toEqual(transparentBlack); // red ^ red
  });

  it('blit 支持缩放（stretchBlt 语义）', () => {
    const a = new GdiSurface(4, 4);
    const b = new GdiSurface(16, 16);
    a.fillRect({ x: 0, y: 0, width: 4, height: 4 }, red);
    b.blit(
      { x: 0, y: 0, width: 16, height: 16 },
      a,
      { x: 0, y: 0, width: 4, height: 4 },
      Rop3.SRCCOPY,
    );
    expect(b.getPixel(0, 0)).toEqual(red);
    expect(b.getPixel(4, 4)).toEqual(red);
    expect(b.getPixel(12, 12)).toEqual(red);
    expect(b.getPixel(15, 15)).toEqual(red);
  });

  it('setPixelPattern 按 PATCOPY 填充（patBlt 语义）', () => {
    const s = new GdiSurface(8, 8);
    for (let y = 0; y < 3; y++) {
      for (let x = 0; x < 3; x++) {
        s.setPixelPattern(x, y, red, ropIndex(Rop3.PATCOPY));
      }
    }
    expect(s.getPixel(1, 1)).toEqual(red);
    expect(s.getPixel(5, 5)).toEqual(white);
  });

  it('clip 矩形裁剪：只画裁剪区内', () => {
    const s = new GdiSurface(16, 16);
    s.clip = { type: 'rect', rect: { x: 2, y: 2, width: 6, height: 6 } };
    s.fillRect({ x: 0, y: 0, width: 16, height: 16 }, red);
    expect(s.getPixel(4, 4)).toEqual(red);
    expect(s.getPixel(1, 1)).toEqual(white);
    expect(s.getPixel(8, 8)).toEqual(white);
  });

  it('clip 椭圆裁剪', () => {
    const s = new GdiSurface(16, 16);
    s.clip = { type: 'ellipse', rect: { x: 2, y: 2, width: 12, height: 12 } };
    s.fillRect({ x: 0, y: 0, width: 16, height: 16 }, red);
    expect(s.getPixel(8, 8)).toEqual(red); // 椭圆内
    expect(s.getPixel(2, 2)).toEqual(white); // 角在椭圆外
  });

  it('clear 清空为指定颜色', () => {
    const s = new GdiSurface(4, 4);
    s.clear(red);
    expect(s.getPixel(3, 3)).toEqual(red);
    s.clear();
    expect(s.getPixel(3, 3)).toEqual(black); // clear() 默认清为黑色
  });

  it('toRgba 输出 RGBA 字节序', () => {
    const s = new GdiSurface(1, 1);
    s.setPixel(0, 0, red);
    const rgba = s.toRgba();
    expect([...rgba]).toEqual([255, 0, 0, 255]);
  });
});
