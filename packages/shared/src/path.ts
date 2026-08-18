/**
 * Windows 风格路径工具。
 * 约定虚拟盘内路径以 "C:/" 形式表达（统一正斜杠），存储层转小写以达成分区大小写不敏感语义。
 */

const SEP = '/';

/** 规范化：反斜杠→正斜杠、去尾部斜杠、大小写归一（保留盘符前缀） */
export function normalizePath(path: string): string {
  let p = path.replace(/\\/g, '/');
  p = p.replace(/\/+/g, '/');
  if (p !== '/' && p.endsWith('/')) p = p.slice(0, -1);
  if (/^[A-Za-z]:/.test(p)) p = p[0]!.toUpperCase() + p.slice(1);
  return p;
}

export function isAbsolute(path: string): boolean {
  return /^[A-Za-z]:\//.test(normalizePath(path));
}

export function join(...parts: string[]): string {
  return normalizePath(parts.join('/'));
}

export function dirname(path: string): string {
  const p = normalizePath(path);
  const idx = p.lastIndexOf(SEP);
  if (idx <= 0) return idx === 0 ? '/' : '';
  return p.slice(0, idx);
}

export function basename(path: string): string {
  const p = normalizePath(path);
  const idx = p.lastIndexOf(SEP);
  return idx === -1 ? p : p.slice(idx + 1);
}

export function extname(path: string): string {
  const base = basename(path);
  const idx = base.lastIndexOf('.');
  return idx > 0 ? base.slice(idx + 1).toLowerCase() : '';
}

/** 拆分路径段：'C:/a/b.txt' -> ['C:', 'a', 'b.txt'] */
export function segments(path: string): string[] {
  const p = normalizePath(path).replace(/\/$/, '');
  return p.split(SEP).filter(Boolean);
}

/** 从 store 根路径（不含盘符）映射：'C:/a/b.txt' -> 'a/b.txt' */
export function toStorePath(path: string): string {
  const segs = segments(path);
  if (segs.length === 0) return '';
  if (/^[A-Za-z]:$/.test(segs[0]!)) return segs.slice(1).join(SEP);
  return segs.join(SEP);
}

export function isWithin(child: string, parent: string): boolean {
  const c = segments(child);
  const p = segments(parent);
  if (c.length <= p.length) return false;
  return p.every((seg, i) => c[i] === seg);
}