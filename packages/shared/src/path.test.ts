import { describe, expect, it } from 'vitest';
import { basename, dirname, isAbsolute, join, normalizePath, segments, toStorePath } from './path';

describe('normalizePath', () => {
  it('converts backslashes to forward slashes', () => {
    expect(normalizePath('C:\\Windows\\System32\\drivers')).toBe('C:/Windows/System32/drivers');
  });

  it('normalizes drive letter to upper case', () => {
    expect(normalizePath('c:/program files/app')).toBe('C:/program files/app');
  });

  it('collapses duplicate slashes', () => {
    expect(normalizePath('C:////a///b')).toBe('C:/a/b');
  });

  it('strips trailing slash', () => {
    expect(normalizePath('C:/a/b/')).toBe('C:/a/b');
  });

  it('keeps root as-is', () => {
    expect(normalizePath('C:/')).toBe('C:');
  });
});

describe('join', () => {
  it('joins and normalizes', () => {
    expect(join('C:\\', 'Windows', 'System32')).toBe('C:/Windows/System32');
  });
});

describe('dirname / basename', () => {
  it('splits correctly', () => {
    expect(dirname('C:/a/b.txt')).toBe('C:/a');
    expect(basename('C:/a/b.txt')).toBe('b.txt');
  });

  it('handles root', () => {
    expect(dirname('C:/a')).toBe('C:');
  });
});

describe('segments', () => {
  it('splits including drive', () => {
    expect(segments('C:/a/b.txt')).toEqual(['C:', 'a', 'b.txt']);
  });
});

describe('toStorePath', () => {
  it('strips drive prefix', () => {
    expect(toStorePath('C:/a/b.txt')).toBe('a/b.txt');
  });

  it('returns empty for root', () => {
    expect(toStorePath('C:')).toBe('');
  });
});

describe('isAbsolute', () => {
  it('detects absolute paths', () => {
    expect(isAbsolute('C:/foo')).toBe(true);
    expect(isAbsolute('foo/bar')).toBe(false);
  });
});