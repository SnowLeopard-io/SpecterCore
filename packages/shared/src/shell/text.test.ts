import { describe, expect, it } from 'vitest';
import { decodeText } from './text';

describe('decodeText (Windows ANSI/UTF-8 compatibility)', () => {
  it('decodes UTF-8 text unchanged', () => {
    const data = new TextEncoder().encode('hello 世界');
    expect(decodeText(data)).toBe('hello 世界');
  });

  it('decodes plain ASCII', () => {
    expect(decodeText(new TextEncoder().encode('line one'))).toBe('line one');
  });

  it('falls back to GBK for ANSI bytes (Chinese Windows notepad)', () => {
    // '中文' 的 GBK 编码：0xD6D0 0xCEC4
    const gbk = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]);
    expect(decodeText(gbk)).toBe('中文');
  });

  it('handles empty input', () => {
    expect(decodeText(new Uint8Array(0))).toBe('');
  });
});
