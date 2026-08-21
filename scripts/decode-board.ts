/**
 * Decode the winmine board array (0x1005360, row stride 0x20, rows/cols start
 * at 1) from the probe-sdib-all board dump and print each cell's tile index
 * (board & 0x1f) in a grid.
 */
import { readFileSync } from 'node:fs';

const log = readFileSync(process.argv[2] ?? 'C:/Users/HUAWEI/AppData/Local/Temp/probe-full.log', 'utf8');
const lines = log.split('\n');
const start = lines.findIndex((l) => l.startsWith('[bitblt]'));
if (start < 0) {
  console.error('no bitblt line');
  process.exit(1);
}
// Join wrapped continuation lines until the board array closes.
let bitblt = lines[start];
for (let i = start + 1; i < lines.length; i++) {
  bitblt += lines[i].trim();
  if (/board=\[[0-9a-f|]+\]/.test(bitblt)) break;
}
const m = bitblt.match(/board=\[([0-9a-f|]+)\]/);
if (!m) {
  console.error(`no board dump; joined len=${bitblt.length} tail=${bitblt.slice(-80)}`);
  process.exit(1);
}
const bytes = m[1].split('|').map((h) => Number.parseInt(h, 16));
console.log(`board dump: ${bytes.length} bytes from 0x1005360`);
const cell = (row: number, col: number): number => bytes[(row - 1) * 0x20 + col];
for (let row = 1; row <= 9; row++) {
  const vals: string[] = [];
  const tiles: string[] = [];
  for (let col = 1; col <= 9; col++) {
    const v = cell(row, col);
    vals.push(`0x${v.toString(16).padStart(2, '0')}`);
    tiles.push(`${(v & 0x1f).toString(16).padStart(2, '0')}`);
  }
  console.log(`row${row} board=[${vals.join(' ')}] tile=[${tiles.join(' ')}]`);
}
