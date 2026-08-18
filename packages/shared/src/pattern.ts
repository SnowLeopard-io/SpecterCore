/**
 * Windows 通配符匹配：支持 *（任意长度，含空）与 ?（单字符）。
 */

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function wildcardToRegExp(pattern: string): RegExp {
  // Windows quirk: '*.ext' also matches a bare 'ext' (no dot), because '*'
  // may absorb the separating dot before a literal extension suffix.
  const starSuffix = pattern.match(/^\*\.([^*?]+)$/);
  if (starSuffix) {
    const suffix = escapeRegExp(starSuffix[1]!);
    return new RegExp(`^(?:.*\\.)?${suffix}$`, 'i');
  }
  let out = '^';
  for (const ch of pattern) {
    if (ch === '*') out += '.*';
    else if (ch === '?') out += '.';
    else out += escapeRegExp(ch);
  }
  out += '$';
  return new RegExp(out, 'i');
}

export function wildcardMatch(name: string, pattern: string): boolean {
  if (pattern === '*') return true;
  return wildcardToRegExp(pattern).test(name);
}

/** 从路径提取目录与文件名通配：'C:/dir/*.txt' -> { dir: 'C:/dir', pattern: '*.txt' } */
export function splitWildcard(path: string): { dir: string; pattern: string } {
  const lastSlash = path.lastIndexOf('/');
  const dir = lastSlash === -1 ? '' : path.slice(0, lastSlash);
  const pattern = lastSlash === -1 ? path : path.slice(lastSlash + 1);
  return { dir, pattern };
}