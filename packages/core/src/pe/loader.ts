/**
 * PE32 loader (design doc 4.2.1).
 *
 * Parses MZ/PE headers, the section table, import/export directories and the
 * resource tree. Icon extraction reuses `@specter-core/shared`'s `extractPeIcon`. The
 * returned `PeImage` is consumed by `pe/mapper.ts` to map sections into the
 * WASM linear memory and rewrite the IAT (design 4.2.2).
 */

import type { PeExport, PeImage, PeImport, PeImportFunction, PeLoader, PeSection, PeTls } from '@specter-core/contracts';
import { PE_MAGIC } from '@specter-core/contracts';
import { extractPeIcon } from '@specter-core/shared';

function readU16(data: Uint8Array, offset: number): number {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint16(offset, true);
}

function readU32(data: Uint8Array, offset: number): number {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset, true);
}

function readU64(data: Uint8Array, offset: number): number {
  return Number(new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(offset, true));
}

function readCStr(data: Uint8Array, offset: number): string {
  let end = offset;
  while (end < data.byteLength && data[end] !== 0) end += 1;
  return new TextDecoder('latin1').decode(data.subarray(offset, end));
}

const IMAGE_SCN_MEM_EXECUTE = 0x20000000;
const IMAGE_SCN_MEM_READ = 0x40000000;
const IMAGE_SCN_MEM_WRITE = 0x80000000;

/** IMAGE_DIRECTORY_ENTRY_* indices into the data-directory array. */
const DIR_EXPORT = 0;
const DIR_IMPORT = 1;
const DIR_RESOURCE = 2;
const DIR_BASERELOC = 5;
const DIR_TLS = 9;

const PE32_MAGIC = 0x10b;
const PE32_PLUS_MAGIC = 0x20b;

/** IMAGE_REL_BASED_* types. */
const REL_HIGHLOW = 3;
const REL_DIR64 = 10;

export class PeLoaderImpl implements PeLoader {
  private readonly defaultBase = 0x00400000;

  async load(image: Uint8Array, baseAddress?: number): Promise<PeImage> {
    if (!this.isPe(image)) throw new Error('not a PE file');
    const eLfanew = readU32(image, 0x3c);
    const coff = eLfanew + 4;
    const machine = readU16(image, coff);
    const numberOfSections = readU16(image, coff + 2);
    const sizeOfOptionalHeader = readU16(image, coff + 16);
    const opt = coff + 20;
    const magic = readU16(image, opt);
    if (magic !== PE32_MAGIC && magic !== PE32_PLUS_MAGIC) {
      throw new Error(`unsupported PE magic 0x${magic.toString(16)} (expected PE32 0x10B or PE32+ 0x20B)`);
    }
    const is64 = magic === PE32_PLUS_MAGIC;

    const entryPoint = readU32(image, opt + 16);
    // PE32+: ImageBase is 8 bytes at +24; PE32: 4 bytes at +28.
    const imageBase = is64 ? readU64(image, opt + 24) : readU32(image, opt + 28) || this.defaultBase;
    const sizeOfImage = readU32(image, opt + 56);
    const subsystem = readU16(image, opt + 68);
    // PE32+: NumberOfRvaAndSizes at +108, data dir at +112; PE32: +92/+96.
    const numberOfRvaAndSizes = readU32(image, opt + (is64 ? 108 : 92));
    const dataDirOffset = opt + (is64 ? 112 : 96);

    // sections
    const sectionTable = opt + sizeOfOptionalHeader;
    const sections: PeSection[] = [];
    for (let i = 0; i < numberOfSections; i++) {
      const s = sectionTable + i * 40;
      const rawName = image.subarray(s, s + 8);
      const name = readCStr(rawName, 0);
      const virtualSize = readU32(image, s + 8);
      const virtualAddress = readU32(image, s + 12);
      const rawSize = readU32(image, s + 16);
      const rawPtr = readU32(image, s + 20);
      const characteristics = readU32(image, s + 36);
      sections.push({ name, virtualAddress, virtualSize, rawSize, characteristics });
      void rawPtr;
    }

    const rvaToOffset = (rva: number): number | null => {
      for (const sec of sections) {
        // Sections without raw data (.bss, .tls) must not map to a file offset —
        // their bytes are zero-filled in memory, so a caller reading them gets
        // the raw file bytes (e.g. the MZ header) instead of zeros.
        if (sec.rawSize === 0) continue;
        const span = Math.max(sec.virtualSize, sec.rawSize);
        if (rva >= sec.virtualAddress && rva < sec.virtualAddress + span) {
          const off = rva - sec.virtualAddress + this.rawPointer(image, sec);
          return off >= 0 && off < image.byteLength ? off : null;
        }
      }
      return null;
    };

    // data directory entries (only read if present)
    const dirEntry = (idx: number): { rva: number; size: number } | null => {
      if (idx >= numberOfRvaAndSizes) return null;
      const off = dataDirOffset + idx * 8;
      return { rva: readU32(image, off), size: readU32(image, off + 4) };
    };

    // imports
    const imports = this.parseImports(image, dirEntry(DIR_IMPORT), rvaToOffset, is64);

    // exports
    const exports = this.parseExports(image, dirEntry(DIR_EXPORT), rvaToOffset);

    // base relocations (needed to rebase a PE32+ image below the 4GB WASM memory)
    const relocations = this.parseRelocations(image, dirEntry(DIR_BASERELOC), rvaToOffset);

    // TLS directory (template + index variable) — used to seed per-thread TLS.
    const tls = this.parseTls(image, dirEntry(DIR_TLS), rvaToOffset, imageBase);

    // resources: raw resource-section bytes for later icon extraction
    const resDir = dirEntry(DIR_RESOURCE);
    let resources = new Uint8Array(0);
    if (resDir) {
      const off = rvaToOffset(resDir.rva);
      if (off !== null) resources = image.slice(off, Math.min(off + resDir.size, image.byteLength));
    }

    return {
      path: '',
      baseAddress: baseAddress ?? imageBase,
      entryPoint: entryPoint + imageBase,
      imageSize: sizeOfImage,
      subsystem,
      machine,
      sections,
      imports,
      exports,
      is64,
      relocations,
      tls,
      resources,
      header: image.slice(0, sectionTable),
    };
  }

  getExports(_image: PeImage): Map<string, PeExport> {
    return new Map(_image.exports.map((e) => [e.name, e]));
  }

  getImports(image: PeImage): PeImport[] {
    return image.imports;
  }

  async extractIcon(rawImage: Uint8Array): Promise<Uint8Array | null> {
    try {
      return extractPeIcon(rawImage);
    } catch {
      return null;
    }
  }

  isPe(buffer: Uint8Array): boolean {
    if (buffer.byteLength < 2) return false;
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    return view.getUint16(0, true) === PE_MAGIC;
  }

  // -------------------------------------------------------------------------

  private rawPointer(image: Uint8Array, sec: PeSection): number {
    // section raw offset = pointerToRawData; the section table holds it at +20.
    const sectionTable = this.locateSectionTable(image);
    for (let i = 0; i < this.sectionCount(image); i++) {
      const s = sectionTable + i * 40;
      if (readU32(image, s + 12) === sec.virtualAddress) return readU32(image, s + 20);
    }
    return 0;
  }

  private locateSectionTable(image: Uint8Array): number {
    const eLfanew = readU32(image, 0x3c);
    const coff = eLfanew + 4;
    const sizeOfOptionalHeader = readU16(image, coff + 16);
    return coff + 20 + sizeOfOptionalHeader;
  }

  private sectionCount(image: Uint8Array): number {
    const eLfanew = readU32(image, 0x3c);
    return readU16(image, eLfanew + 4 + 2);
  }

  private parseImports(image: Uint8Array, dir: { rva: number; size: number } | null, rvaToOffset: (rva: number) => number | null, is64: boolean): PeImport[] {
    if (!dir || dir.rva === 0) return [];
    const base = rvaToOffset(dir.rva);
    if (base === null) return [];
    const out: PeImport[] = [];
    const thunkSize = is64 ? 8 : 4;
    for (let i = 0; ; i++) {
      const d = base + i * 20;
      if (d + 20 > image.byteLength) break;
      const origThunkRva = readU32(image, d);
      const nameRva = readU32(image, d + 12);
      const firstThunkRva = readU32(image, d + 16);
      if (origThunkRva === 0 && nameRva === 0 && firstThunkRva === 0) break;
      const nameOff = rvaToOffset(nameRva);
      if (nameOff === null) continue;
      const moduleName = readCStr(image, nameOff);
      const thunkRva = origThunkRva !== 0 ? origThunkRva : firstThunkRva;
      const thunkOff = rvaToOffset(thunkRva);
      if (thunkOff === null) continue;
      const functions: PeImportFunction[] = [];
      for (let t = 0; ; t++) {
        const entry = is64 ? readU64(image, thunkOff + t * thunkSize) : readU32(image, thunkOff + t * thunkSize);
        if (entry === 0) break;
        // JS bitwise ops truncate to int32, so `entry & 0x8000000000000000` is
        // always 0 for 64-bit ordinals with all-zero low bits; test the value.
        const isOrdinal = is64 ? entry >= 0x8000000000000000 : (entry & 0x80000000) !== 0;
        if (isOrdinal) {
          functions.push({ ordinal: entry & 0xffff, index: t });
        } else {
          const byNameOff = rvaToOffset(entry);
          if (byNameOff === null) continue;
          const name = readCStr(image, byNameOff + 2);
          functions.push({ name, index: t });
        }
      }
      if (functions.length > 0) out.push({ moduleName, functions, iatRva: firstThunkRva });
    }
    return out;
  }

  private parseRelocations(image: Uint8Array, dir: { rva: number; size: number } | null, rvaToOffset: (rva: number) => number | null): { rva: number; type: number }[] {
    if (!dir || dir.rva === 0) return [];
    const base = rvaToOffset(dir.rva);
    if (base === null) return [];
    const out: { rva: number; type: number }[] = [];
    let off = base;
    while (off + 8 <= image.byteLength && off - base < dir.size) {
      const pageRva = readU32(image, off);
      const blockSize = readU32(image, off + 4);
      if (pageRva === 0 && blockSize === 0) break;
      const count = (blockSize - 8) / 2;
      for (let i = 0; i < count; i++) {
        const word = readU16(image, off + 8 + i * 2);
        const type = (word >> 12) & 0xf;
        if (type === REL_HIGHLOW || type === REL_DIR64) {
          out.push({ rva: pageRva + (word & 0xfff), type });
        }
      }
      off += blockSize;
    }
    return out;
  }

  private parseTls(image: Uint8Array, dir: { rva: number; size: number } | null, rvaToOffset: (rva: number) => number | null, imageBase: number): PeTls | null {
    if (!dir || dir.rva === 0) return null;
    const off = rvaToOffset(dir.rva);
    if (off === null) return null;
    const startRaw = readU32(image, off);
    const endRaw = readU32(image, off + 4);
    const index = readU32(image, off + 8);
    const callbacks = readU32(image, off + 12);
    const zeroFill = readU32(image, off + 16);
    const templateRva = startRaw - imageBase;
    const templateSize = endRaw - startRaw;
    if (templateSize < 0 || templateSize > 0x100000) return null;
    const template = new Uint8Array(templateSize);
    const tOff = rvaToOffset(templateRva);
    if (tOff !== null) {
      const n = Math.min(templateSize, image.byteLength - tOff);
      if (n > 0) template.set(image.subarray(tOff, tOff + n));
    }
    return {
      templateRva,
      templateSize,
      indexRva: index ? index - imageBase : 0,
      callbacksRva: callbacks ? callbacks - imageBase : 0,
      zeroFillSize: zeroFill,
      template,
    };
  }

  private parseExports(image: Uint8Array, dir: { rva: number; size: number } | null, rvaToOffset: (rva: number) => number | null): PeExport[] {
    if (!dir || dir.rva === 0) return [];
    const base = rvaToOffset(dir.rva);
    if (base === null) return [];
    const numFunctions = readU32(image, base + 20);
    const numNames = readU32(image, base + 24);
    const funcsRva = readU32(image, base + 28);
    const namesRva = readU32(image, base + 32);
    const ordinalsRva = readU32(image, base + 36);
    const funcsOff = rvaToOffset(funcsRva);
    const namesOff = rvaToOffset(namesRva);
    const ordinalsOff = rvaToOffset(ordinalsRva);
    if (funcsOff === null || namesOff === null || ordinalsOff === null) return [];
    const out: PeExport[] = [];
    for (let i = 0; i < numNames; i++) {
      const nameRva = readU32(image, namesOff + i * 4);
      const nameOff = rvaToOffset(nameRva);
      if (nameOff === null) continue;
      const name = readCStr(image, nameOff);
      const ordinal = readU16(image, ordinalsOff + i * 2);
      if (ordinal >= numFunctions) continue;
      const addressRva = readU32(image, funcsOff + ordinal * 4);
      out.push({ name, ordinal, address: addressRva });
    }
    return out;
  }
}

export const IMAGE_SCN = { MEM_EXECUTE: IMAGE_SCN_MEM_EXECUTE, MEM_READ: IMAGE_SCN_MEM_READ, MEM_WRITE: IMAGE_SCN_MEM_WRITE } as const;
