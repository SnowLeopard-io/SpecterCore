import { describe, expect, it } from 'vitest';
import { splitWildcard, wildcardMatch } from './pattern';

describe('wildcardMatch', () => {
  it('matches *', () => {
    expect(wildcardMatch('readme.txt', '*')).toBe(true);
    expect(wildcardMatch('anything at all', '*')).toBe(true);
  });

  it('matches *.txt', () => {
    expect(wildcardMatch('readme.txt', '*.txt')).toBe(true);
    expect(wildcardMatch('readme.md', '*.txt')).toBe(false);
    expect(wildcardMatch('txt', '*.txt')).toBe(true);
  });

  it('matches ?', () => {
    expect(wildcardMatch('a.txt', '?.txt')).toBe(true);
    expect(wildcardMatch('ab.txt', '?.txt')).toBe(false);
  });

  it('matches case-insensitively', () => {
    expect(wildcardMatch('README.TXT', '*.txt')).toBe(true);
  });

  it('matches exact names', () => {
    expect(wildcardMatch('readme.txt', 'readme.txt')).toBe(true);
    expect(wildcardMatch('readme.txt', 'readme.md')).toBe(false);
  });
});

describe('splitWildcard', () => {
  it('splits dir and pattern', () => {
    expect(splitWildcard('C:/dir/*.txt')).toEqual({ dir: 'C:/dir', pattern: '*.txt' });
  });

  it('handles bare pattern', () => {
    expect(splitWildcard('*.dll')).toEqual({ dir: '', pattern: '*.dll' });
  });
});