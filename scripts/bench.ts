/**
 * 性能基准（设计文档 9.5）：对软件光栅化器（GdiSurface / ROP）建立回归基线。
 *
 *   pnpm bench
 *
 * 每次输出 ops/sec 与 ms/op，作为性能回归的基准线（CI 中下降 >5% 应阻断）。
 * 目前覆盖图形桥接 3.2 的关键热路径；后续加入 JIT 翻译吞吐量、系统调用延迟等。
 */
import { GdiSurface, ropIndex, applyRopPixels, toPixel } from '@bk/bridges';
import { Rop3 } from '@bk/contracts';
import type { Color } from '@bk/contracts';

const ITERS = 50;
const N = 200000;

const red: Color = { r: 255, g: 0, b: 0, a: 255 };
const white: Color = { r: 255, g: 255, b: 255, a: 255 };

function bench(name: string, work: () => void, count = N): void {
  const start = process.hrtime.bigint();
  for (let i = 0; i < count; i++) work();
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  const opsPerSec = count / (ms / 1000);
  const rate = opsPerSec >= 1000 ? String(opsPerSec | 0) : opsPerSec.toFixed(1);
  const line = `  ${name.padEnd(36)} ${rate.padStart(12)} ops/sec  ${ms.toFixed(1).padStart(8)} ms`;
  console.log(line);
}

function main(): void {
  console.log(`bench: ${ITERS}x 填充分辨率 640x480 表面，每基准 ${N} 次操作\n`);

  // ROP 逐位求值（位块传输热路径）
  const destPx = toPixel({ r: 0x80, g: 0x80, b: 0x80, a: 0xff });
  const srcPx = toPixel({ r: 0x40, g: 0x40, b: 0x40, a: 0xff });
  const patternPx = toPixel(white);
  const copyIdx = ropIndex(Rop3.SRCCOPY);
  const invertIdx = ropIndex(Rop3.SRCINVERT);
  bench('applyRopPixels SRCCOPY', () => {
    applyRopPixels(destPx, srcPx, patternPx, copyIdx);
  });
  bench('applyRopPixels SRCINVERT', () => {
    applyRopPixels(destPx, srcPx, patternPx, invertIdx);
  });

  // 形状绘制
  const shape = new GdiSurface(640, 480);
  bench(
    'fillRect (640x480 全幅)',
    () => {
      for (let i = 0; i < ITERS; i++) {
        shape.fillRect({ x: 0, y: 0, width: 640, height: 480 }, red);
      }
    },
    1,
  );
  bench(
    'line (对角 640 长)',
    () => {
      for (let i = 0; i < ITERS; i++) shape.line(0, 0, 639, 479, red);
    },
    1,
  );
  bench(
    'ellipse (300x300)',
    () => {
      for (let i = 0; i < ITERS; i++) {
        shape.ellipse({ x: 170, y: 90, width: 300, height: 300 }, red);
      }
    },
    1,
  );
  bench(
    'frameRect (640x480)',
    () => {
      for (let i = 0; i < ITERS; i++) {
        shape.frameRect({ x: 0, y: 0, width: 640, height: 480 }, red);
      }
    },
    1,
  );

  // 位块传输
  const src = new GdiSurface(640, 480);
  src.fillRect({ x: 0, y: 0, width: 640, height: 480 }, red);
  const dst = new GdiSurface(640, 480);
  bench(
    'blit SRCCOPY 1:1 (640x480)',
    () => {
      for (let i = 0; i < ITERS; i++) {
        dst.blit({ x: 0, y: 0, width: 640, height: 480 }, src, { x: 0, y: 0, width: 640, height: 480 }, Rop3.SRCCOPY);
      }
    },
    1,
  );
  bench(
    'blit SRCINVERT 1:1 (640x480)',
    () => {
      for (let i = 0; i < ITERS; i++) {
        dst.blit({ x: 0, y: 0, width: 640, height: 480 }, src, { x: 0, y: 0, width: 640, height: 480 }, Rop3.SRCINVERT);
      }
    },
    1,
  );
  bench(
    'blit SRCCOPY 4x 放大 (160x120→640x480)',
    () => {
      for (let i = 0; i < ITERS; i++) {
        dst.blit({ x: 0, y: 0, width: 640, height: 480 }, src, { x: 0, y: 0, width: 160, height: 120 }, Rop3.SRCCOPY);
      }
    },
    1,
  );

  console.log('\n基准完成。请与 .benchmark 基线比较，下降 >5% 应阻断合并。');
}

main();