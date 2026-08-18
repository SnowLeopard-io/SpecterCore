import { describe, expect, it } from 'vitest';
import { extractPeIcon } from './pe-icons';

function w16(b: Uint8Array, o: number, v: number): void {
  new DataView(b.buffer).setUint16(o, v, true);
}
function w32(b: Uint8Array, o: number, v: number): void {
  new DataView(b.buffer).setUint32(o, v, true);
}

/**
 * 构造一个含单节 .rsrc 的最小 PE32：资源树含 RT_GROUP_ICON(14)/RT_ICON(3)，
 * 图标为一个 1x1 32bpp BMP DIB。布局：
 *   0x400 资源目录树，0x800 GRPICONDIR（rva 0x1400），0x840 图标 DIB（rva 0x1440）。
 */
function makePeWithIcon(): Uint8Array {
  const buf = new Uint8Array(0xc00);
  // DOS 头
  buf[0] = 0x4d;
  buf[1] = 0x5a;
  w32(buf, 0x3c, 0x80); // e_lfanew
  // PE 头
  buf[0x80] = 0x50;
  buf[0x81] = 0x45;
  const coff = 0x84;
  w16(buf, coff, 0x14c); // Machine: x86
  w16(buf, coff + 2, 1); // NumberOfSections
  w16(buf, coff + 16, 0xe0); // SizeOfOptionalHeader
  const opt = coff + 20;
  w16(buf, opt, 0x10b); // OptionalHeader Magic: PE32
  w32(buf, opt + 96 + 16, 0x1000); // DataDirectory[2] (resource) .VirtualAddress
  w32(buf, opt + 96 + 16 + 4, 0x800); // .Size
  // 节表
  const sec = opt + 0xe0;
  buf.set([0x2e, 0x72, 0x73, 0x72, 0x63, 0, 0, 0], sec); // ".rsrc"
  w32(buf, sec + 8, 0x800); // VirtualSize
  w32(buf, sec + 12, 0x1000); // VirtualAddress
  w32(buf, sec + 16, 0x800); // SizeOfRawData
  w32(buf, sec + 20, 0x400); // PointerToRawData

  const R = 0x400; // 资源区文件基址
  // L1: type 目录，2 个 ID 项
  w16(buf, R + 12, 2);
  w32(buf, R + 16, 14); // RT_GROUP_ICON
  w32(buf, R + 20, 0x80000020); // → 0x420
  w32(buf, R + 24, 3); // RT_ICON
  w32(buf, R + 28, 0x800000a0); // → 0x4A0
  // L2 组图标: id=1
  w16(buf, 0x420 + 12, 1);
  w32(buf, 0x430, 1);
  w32(buf, 0x434, 0x80000040); // → 0x440
  // L3 语言: id=0
  w16(buf, 0x440 + 12, 1);
  w32(buf, 0x450, 0);
  w32(buf, 0x454, 0x60); // → 数据项 0x460
  // 组图标数据项
  w32(buf, 0x460, 0x1400);
  w32(buf, 0x464, 20);
  // L2 图标: id=1
  w16(buf, 0x4a0 + 12, 1);
  w32(buf, 0x4b0, 1);
  w32(buf, 0x4b4, 0x800000c0); // → 0x4C0
  // L3 图标语言: id=0
  w16(buf, 0x4c0 + 12, 1);
  w32(buf, 0x4d0, 0);
  w32(buf, 0x4d4, 0xe0); // → 数据项 0x4E0
  // 图标数据项
  w32(buf, 0x4e0, 0x1440);
  w32(buf, 0x4e4, 44);

  // GRPICONDIR @0x800
  w16(buf, 0x800, 0);
  w16(buf, 0x802, 1); // type icon
  w16(buf, 0x804, 1); // count
  buf[0x806] = 1; // width
  buf[0x807] = 1; // height
  w16(buf, 0x80a, 1); // planes
  w16(buf, 0x80c, 32); // bit count
  w32(buf, 0x80e, 44); // bytes in res
  w16(buf, 0x812, 1); // id

  // 1x1 32bpp DIB @0x840
  w32(buf, 0x840, 40); // biSize
  w32(buf, 0x844, 1); // biWidth
  w32(buf, 0x848, 1); // biHeight
  w16(buf, 0x84c, 1); // biPlanes
  w16(buf, 0x84e, 32); // biBitCount
  w32(buf, 0x854, 4); // biSizeImage
  buf[0x840 + 40] = 0x00; // B
  buf[0x840 + 41] = 0x00; // G
  buf[0x840 + 42] = 0xff; // R
  buf[0x840 + 43] = 0x00; // A

  return buf;
}

describe('extractPeIcon', () => {
  it('extracts a valid .ico from a PE with RT_GROUP_ICON/RT_ICON resources', () => {
    const ico = extractPeIcon(makePeWithIcon());
    expect(ico).not.toBeNull();
    if (!ico) return;
    // ICONDIR：reserved=0, type=1, count=1
    expect(new DataView(ico.buffer).getUint16(0, true)).toBe(0);
    expect(new DataView(ico.buffer).getUint16(2, true)).toBe(1);
    expect(new DataView(ico.buffer).getUint16(4, true)).toBe(1);
    // ICONDIRENTRY：1x1, 32bpp, 44 bytes, offset 22
    expect(ico[6]).toBe(1);
    expect(ico[7]).toBe(1);
    expect(new DataView(ico.buffer).getUint16(6 + 6, true)).toBe(32);
    expect(new DataView(ico.buffer).getUint32(6 + 8, true)).toBe(44);
    expect(new DataView(ico.buffer).getUint32(6 + 12, true)).toBe(22);
    // 数据体与源 DIB 一致
    expect(ico.byteLength).toBe(22 + 44);
    expect(ico[22 + 42]).toBe(0xff);
    expect(ico[22 + 43]).toBe(0x00);
  });

  it('returns null for non-PE data', () => {
    expect(extractPeIcon(new TextEncoder().encode('not a pe'))).toBeNull();
    expect(extractPeIcon(new Uint8Array(8))).toBeNull();
  });

  it('returns null when the resource directory is missing', () => {
    const buf = makePeWithIcon();
    // 清掉资源目录 RVA
    new DataView(buf.buffer).setUint32(0x98 + 96 + 16, 0, true);
    expect(extractPeIcon(buf)).toBeNull();
  });
});
