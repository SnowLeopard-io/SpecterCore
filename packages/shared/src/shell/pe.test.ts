import { describe, expect, it } from 'vitest';
import { parsePe } from './pe';

function writeU16(data: Uint8Array, offset: number, value: number): void {
  new DataView(data.buffer, data.byteOffset, data.byteLength).setUint16(offset, value, true);
}

function writeU32(data: Uint8Array, offset: number, value: number): void {
  new DataView(data.buffer, data.byteOffset, data.byteLength).setUint32(offset, value, true);
}

/** 构造一个最小合法 PE32 映像头（GUI 子系统，x86）。 */
function makePe32(opts: { machine?: number; subsystem?: number; magic?: number; entryRva?: number } = {}): Uint8Array {
  const { machine = 0x14c, subsystem = 2, magic = 0x10b, entryRva = 0x1000 } = opts;
  const buf = new Uint8Array(0x200);
  buf[0] = 0x4d; // M
  buf[1] = 0x5a; // Z
  const pe = 0x40;
  writeU32(buf, 0x3c, pe); // e_lfanew
  buf[pe] = 0x50; // P
  buf[pe + 1] = 0x45; // E
  const coff = pe + 4;
  writeU16(buf, coff, machine); // Machine
  writeU16(buf, coff + 2, 2); // NumberOfSections
  writeU32(buf, coff + 4, 0x60000000); // TimeDateStamp
  const opt = coff + 20;
  writeU16(buf, opt, magic); // OptionalHeader Magic
  writeU32(buf, opt + 16, entryRva); // AddressOfEntryPoint
  // Subsystem：PE32 在 0x44(68)，PE32+ 在 0x4C(76)。
  writeU16(buf, opt + (magic === 0x20b ? 76 : 68), subsystem);
  return buf;
}

describe('parsePe', () => {
  it('parses a real x86 GUI PE32', () => {
    const info = parsePe(makePe32());
    expect(info).not.toBeNull();
    expect(info?.isPe).toBe(true);
    expect(info?.arch).toBe('x86');
    expect(info?.magic).toBe(0x10b);
    expect(info?.numberOfSections).toBe(2);
    expect(info?.subsystemName).toBe('Windows GUI');
    expect(info?.entryPointRva).toBe(0x1000);
  });

  it('parses x64 PE32+ with console subsystem', () => {
    const info = parsePe(makePe32({ machine: 0x8664, magic: 0x20b, subsystem: 3 }));
    expect(info?.arch).toBe('x64');
    expect(info?.subsystemName).toBe('Windows Console');
  });

  it('returns null for non-PE data', () => {
    expect(parsePe(new Uint8Array([1, 2, 3, 4]))).toBeNull();
    expect(parsePe(new TextEncoder().encode('hello world not a pe file'))).toBeNull();
  });

  it('returns null when the PE signature is missing', () => {
    const buf = makePe32();
    // 破坏 PE 签名
    buf[0x40] = 0x58;
    expect(parsePe(buf)).toBeNull();
  });
});
