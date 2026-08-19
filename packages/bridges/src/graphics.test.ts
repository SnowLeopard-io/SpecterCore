import { describe, expect, it } from 'vitest';
import type { Color } from '@bk/contracts';
import { CanvasGdiBridge, NullGdiBridge } from './graphics';

const red: Color = { r: 255, g: 0, b: 0, a: 255 };

function makeDisplay(): HTMLCanvasElement {
  return {} as unknown as HTMLCanvasElement;
}

describe('CanvasGdiBridge', () => {
  it('DC 生命周期：create/createCompatible/delete', async () => {
    const bridge = new CanvasGdiBridge(makeDisplay());
    const dc = await bridge.createDC('DISPLAY');
    expect(dc).toBeGreaterThan(0);
    const mem = await bridge.createCompatibleDC(dc);
    expect(mem).not.toBe(dc);
    await bridge.deleteDC(dc);
    await bridge.deleteDC(mem);
  });

  it('getDeviceCaps 报告 32bpp 与表面尺寸', async () => {
    const bridge = new CanvasGdiBridge(makeDisplay());
    const dc = await bridge.createDC('DISPLAY');
    const caps = await bridge.getDeviceCaps(dc);
    expect(caps.bitsPerPixel).toBe(32);
    expect(caps.width).toBe(800);
    expect(caps.height).toBe(600);
  });

  it('onInvalidate 在绘制后触发', async () => {
    const bridge = new CanvasGdiBridge(makeDisplay());
    const dc = await bridge.createDC('DISPLAY');
    const rects: unknown[] = [];
    bridge.onInvalidate((_, rect) => rects.push(rect));
    await bridge.fillRect(dc, { x: 1, y: 2, width: 3, height: 4 }, red);
    expect(rects).toHaveLength(1);
    expect(rects[0]).toEqual({ x: 1, y: 2, width: 3, height: 4 });
  });

  it('bitBlt 在两个 DC 间复制并触发失效', async () => {
    const bridge = new CanvasGdiBridge(makeDisplay());
    const a = await bridge.createDC('A');
    const b = await bridge.createDC('B');
    const invalidated: number[] = [];
    bridge.onInvalidate((dc) => invalidated.push(dc));
    await bridge.fillRect(a, { x: 0, y: 0, width: 10, height: 10 }, red);
    const err = await bridge.bitBlt(
      b,
      { x: 5, y: 5, width: 10, height: 10 },
      a,
      { x: 0, y: 0, width: 10, height: 10 },
      0x00cc0020,
    );
    expect(err).toBe(0);
    expect(invalidated).toContain(b);
  });

  it('saveDC/restoreDC 保存并恢复状态', async () => {
    const bridge = new CanvasGdiBridge(makeDisplay());
    const dc = await bridge.createDC('DISPLAY');
    await bridge.setClip(dc, { type: 'rect', rect: { x: 0, y: 0, width: 4, height: 4 } });
    const saved = await bridge.saveDC(dc);
    await bridge.setClip(dc, { type: 'rect', rect: { x: 0, y: 0, width: 16, height: 16 } });
    expect((await bridge.getClip(dc))?.rect.width).toBe(16);
    await bridge.restoreDC(dc, saved);
    expect((await bridge.getClip(dc))?.rect.width).toBe(4);
  });

  it('setTextColor/setBkMode 返回旧值', async () => {
    const bridge = new CanvasGdiBridge(makeDisplay());
    const dc = await bridge.createDC('DISPLAY');
    const prevColor = await bridge.setTextColor(dc, red);
    expect(prevColor).toBe(0); // 默认黑 0x000000
    const prevMode = await bridge.setBkMode(dc, 2);
    expect(prevMode).toBe(1); // 默认 TRANSPARENT
  });

  it('textOut 在 node 环境下返回成功（no-op）', async () => {
    const bridge = new CanvasGdiBridge(makeDisplay());
    const dc = await bridge.createDC('DISPLAY');
    const err = await bridge.textOut(dc, 0, 0, 'hello');
    expect(err).toBe(0);
  });

  it('setPixel/getPixel 不可见，但 setPixel 触发失效', async () => {
    const bridge = new CanvasGdiBridge(makeDisplay());
    const dc = await bridge.createDC('DISPLAY');
    const fired: number[] = [];
    bridge.onInvalidate((d) => fired.push(d));
    await bridge.setPixel(dc, 3, 3, red);
    expect(fired).toHaveLength(1);
  });

  it('setClip/getClip 往返', async () => {
    const bridge = new CanvasGdiBridge(makeDisplay());
    const dc = await bridge.createDC('DISPLAY');
    expect(await bridge.getClip(dc)).toBeNull();
    await bridge.setClip(dc, { type: 'ellipse', rect: { x: 0, y: 0, width: 8, height: 8 } });
    expect(await bridge.getClip(dc)).toEqual({
      type: 'ellipse',
      rect: { x: 0, y: 0, width: 8, height: 8 },
    });
  });

  it('非法 DC 抛错', async () => {
    const bridge = new CanvasGdiBridge(makeDisplay());
    await expect(bridge.fillRect(999, { x: 0, y: 0, width: 1, height: 1 }, red)).rejects.toThrow(
      /Invalid DC/,
    );
  });
});

describe('NullGdiBridge', () => {
  it('全部操作返回 NOT_IMPLEMENTED(120) 或合理默认', async () => {
    const bridge = new NullGdiBridge();
    const dc = await bridge.createDC('DISPLAY');
    expect(dc).toBe(0);
    expect(await bridge.textOut(dc, 0, 0, 'x')).toBe(120);
    expect(await bridge.fillRect(dc, { x: 0, y: 0, width: 1, height: 1 }, red)).toBe(120);
    expect(
      await bridge.bitBlt(
        dc,
        { x: 0, y: 0, width: 1, height: 1 },
        dc,
        { x: 0, y: 0, width: 1, height: 1 },
        0,
      ),
    ).toBe(120);
    expect((await bridge.getDeviceCaps(dc)).bitsPerPixel).toBe(32);
    expect(await bridge.getClip(dc)).toBeNull();
  });
});
