import { basename, dirname, normalizePath, toStorePath } from '../path';

/**
 * Windows 命令解释器相关的路径工具（底层、UI 无关）。
 *
 * 本系统内部以「store 路径」表示虚拟盘内的位置：无盘符前缀，
 * 例如根目录为 ''，'Documents/notes.txt' 表示 C:\Documents\notes.txt。
 * 仅在向用户展示时转换为 C:\ 形式。
 */

/** 把 store 路径（无盘符，如 'a/b'）渲染为 cmd 显示路径（C:\a\b）。 */
export function storeToDisplay(storePath: string): string {
  return storePath === '' ? 'C:\\' : `C:\\${storePath.replace(/\//g, '\\')}`;
}

/** 取 store 路径的目录名（最后一段）。 */
export function storeBasename(storePath: string): string {
  return basename(storePath);
}

/** 取 store 路径的父目录（根目录返回 ''）。 */
export function storeDirname(storePath: string): string {
  const d = dirname(storePath);
  return d === '/' ? '' : d;
}

/**
 * 把用户输入（可能含 C: 前缀或反斜杠）规范为 store 路径。
 * 'C:\a\b' -> 'a/b'，'a\b' -> 'a/b'，'' -> ''。
 */
export function displayToStore(input: string): string {
  return toStorePath(normalizePath(input));
}

/**
 * 在 cwd 基础上解析一个（可能相对、可能带盘符、可能含 . / ..）的路径，
 * 返回规范化的 store 路径。
 */
export function resolveStorePath(cwd: string, arg: string): string {
  const raw = arg.trim().replace(/^[a-zA-Z]:[\\/]?/, '');
  if (raw === '' || raw === '.') return cwd;
  if (raw === '\\' || raw === '/') return '';
  const segs = cwd ? cwd.split('/') : [];
  for (const part of raw.split(/[\\/]/).filter(Boolean)) {
    if (part === '.') continue;
    if (part === '..') segs.pop();
    else segs.push(part);
  }
  return segs.join('/');
}

/** 拼接 store 路径段。 */
export function joinStorePath(base: string, name: string): string {
  return base === '' ? name : `${base}/${name}`;
}
