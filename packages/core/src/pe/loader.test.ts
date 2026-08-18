import { describe, expect, it } from 'vitest';
import { PeLoaderImpl } from './loader';
import { WasmRuntimeImpl } from '../jit/runtime';
import { mapPeImage, STUB_BASE } from './mapper';

/**
 * Builds a minimal PE32 image with one .text section, a single import
 * (kernel32!ExitProcess) and no resources.
 */
function buildMinimalPe(): Uint8Array {
  const img = new Uint8Array(0x700);
  const view = new DataView(img.buffer);
  const u16 = (o: number, v: number) => view.setUint16(o, v, true);
  const u32 = (o: number, v: number) => view.setUint32(o, v, true);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) img[o + i] = s.charCodeAt(i);
  };

  // DOS header
  img[0] = 0x4d; // 'M'
  img[1] = 0x5a; // 'Z'
  u32(0x3c, 0x40); // e_lfanew

  // PE signature + COFF header at 0x40
  img[0x40] = 0x50; // 'P'
  img[0x41] = 0x45; // 'E'
  img[0x42] = 0x00;
  img[0x43] = 0x00;
  u16(0x44, 0x14c); // machine: i386
  u16(0x46, 1); // numberOfSections
  u32(0x48, 0); // timestamp
  u32(0x4c, 0);
  u32(0x50, 0);
  u16(0x54, 0xe0); // sizeOfOptionalHeader
  u16(0x56, 0x0102); // characteristics: EXECUTABLE | 32BIT

  // Optional header (PE32) at 0x58
  const opt = 0x58;
  u16(opt + 0, 0x10b); // magic PE32
  u16(opt + 2, 0);
  u32(opt + 4, 0x200); // sizeOfCode
  u32(opt + 8, 0); // sizeOfInitializedData
  u32(opt + 12, 0); // sizeOfUninitializedData
  u32(opt + 16, 0x1000); // addressOfEntryPoint
  u32(opt + 20, 0x1000); // baseOfCode
  u32(opt + 24, 0); // baseOfData
  u32(opt + 28, 0x400000); // imageBase
  u32(opt + 32, 0x1000); // sectionAlignment
  u32(opt + 36, 0x200); // fileAlignment
  u16(opt + 40, 4); // majorOSVersion
  u16(opt + 42, 0);
  u16(opt + 44, 0);
  u16(opt + 46, 0);
  u16(opt + 48, 4); // majorSubsystemVersion
  u16(opt + 50, 0);
  u32(opt + 52, 0); // Win32VersionValue
  u32(opt + 56, 0x2000); // sizeOfImage
  u32(opt + 60, 0x200); // sizeOfHeaders
  u32(opt + 64, 0); // checksum
  u16(opt + 68, 3); // subsystem: windows cui
  u16(opt + 70, 0); // dllCharacteristics
  u32(opt + 72, 0x100000); // sizeOfStackReserve
  u32(opt + 76, 0x1000); // sizeOfStackCommit
  u32(opt + 80, 0x100000); // sizeOfHeapReserve
  u32(opt + 84, 0x1000); // sizeOfHeapCommit
  u32(opt + 88, 0); // loaderFlags
  u32(opt + 92, 16); // numberOfRvaAndSizes

  // data directories at opt+96
  u32(opt + 96 + 8, 0x1040); // import dir rva
  u32(opt + 96 + 12, 20); // import dir size

  // section table at opt + 0xe0 = 0x138
  const sec = 0x138;
  str(sec, '.text');
  u32(sec + 8, 0x1400); // virtualSize
  u32(sec + 12, 0x1000); // virtualAddress
  u32(sec + 16, 0x500); // sizeOfRawData
  u32(sec + 20, 0x200); // pointerToRawData
  u32(sec + 24, 0);
  u32(sec + 28, 0);
  u16(sec + 32, 0);
  u16(sec + 34, 0);
  u32(sec + 36, 0x60000020); // CODE | EXECUTE | READ

  // section raw data at 0x200 (RVA 0x1000)
  // entry: mov eax, 0x2a; ret
  img[0x200] = 0xb8;
  img[0x201] = 0x2a;
  img[0x202] = 0x00;
  img[0x203] = 0x00;
  img[0x204] = 0x00;
  img[0x205] = 0xc3;

  // import descriptor at raw 0x240 (RVA 0x1040)
  const id = 0x240;
  u32(id, 0x1100); // OriginalFirstThunk (ILT rva)
  u32(id + 4, 0); // timestamp
  u32(id + 8, 0); // forwarder chain
  u32(id + 12, 0x1140); // name rva
  u32(id + 16, 0x1160); // FirstThunk (IAT rva)
  // terminator descriptor at 0x10C0

  // ILT at raw 0x300 (RVA 0x1100)
  u32(0x300, 0x1200); // hint/name rva
  u32(0x304, 0);

  // DLL name at raw 0x340 (RVA 0x1140)
  str(0x340, 'kernel32.dll');

  // IAT at raw 0x360 (RVA 0x1160)
  u32(0x360, 0x1200);
  u32(0x364, 0);

  // IMAGE_IMPORT_BY_NAME at raw 0x400 (RVA 0x1200)
  u16(0x400, 0); // hint
  str(0x402, 'ExitProcess');

  return img;
}

const raw = buildMinimalPe();

describe('PeLoaderImpl', () => {
  const loader = new PeLoaderImpl();

  it('recognises the MZ magic', () => {
    expect(loader.isPe(raw)).toBe(true);
    expect(loader.isPe(new Uint8Array([0x90, 0x90]))).toBe(false);
  });

  it('parses the full PE structure', async () => {
    const pe = await loader.load(raw);
    expect(pe.machine).toBe(0x14c);
    expect(pe.subsystem).toBe(3);
    expect(pe.imageSize).toBe(0x2000);
    expect(pe.entryPoint).toBe(0x401000);
    expect(pe.baseAddress).toBe(0x400000);
    expect(pe.sections).toHaveLength(1);
    expect(pe.sections[0]).toMatchObject({
      name: '.text',
      virtualAddress: 0x1000,
      virtualSize: 0x1400,
    });
  });

  it('parses imports with IAT RVA', async () => {
    const pe = await loader.load(raw);
    expect(pe.imports).toHaveLength(1);
    const imp = pe.imports[0]!;
    expect(imp.moduleName).toBe('kernel32.dll');
    expect(imp.functions).toEqual([{ name: 'ExitProcess' }]);
    expect(imp.iatRva).toBe(0x1160);
  });

  it('extracts no icon from a resource-less image', async () => {
    const icon = await loader.extractIcon(raw);
    expect(icon).toBeNull();
  });

  it('rejects non-PE input', async () => {
    await expect(loader.load(new Uint8Array(16))).rejects.toThrow('not a PE file');
  });
});

describe('mapPeImage', () => {
  it('maps sections, rewrites the IAT and allocates trap stubs', async () => {
    const runtime = new WasmRuntimeImpl(64);
    const loader = new PeLoaderImpl();
    const pe = await loader.load(raw);

    const mapped = mapPeImage(runtime, raw, pe);
    expect(mapped.entryPoint).toBe(0x401000);
    expect(mapped.baseAddress).toBe(0x400000);

    // section bytes landed at imageBase + 0x1000
    expect(Array.from(runtime.readBytes(0x401000, 6))).toEqual([
      0xb8, 0x2a, 0x00, 0x00, 0x00, 0xc3,
    ]);

    // IAT slot rewritten to the stub
    const iatAddress = 0x400000 + 0x1160;
    expect(runtime.readInt32(iatAddress)).toBe(STUB_BASE);

    // stub bytes: mov eax, 0; int 0x2E; ret 4
    // (32-bit APIs are stdcall — the stub pops the caller's 1 argument so the
    // guest stack stays balanced; a plain `ret` leaks 4 bytes per call.)
    expect(Array.from(runtime.readBytes(STUB_BASE, 10))).toEqual([
      0xb8, 0x00, 0x00, 0x00, 0x00, 0xcd, 0x2e, 0xc2, 0x04, 0x00,
    ]);

    expect(mapped.stubs).toEqual([
      { index: 0, module: 'kernel32.dll', proc: 'ExitProcess', stubAddress: STUB_BASE, iatAddress },
    ]);
  });

  it('returns an empty stub table for import-free images', () => {
    const runtime = new WasmRuntimeImpl(64);
    const pe = {
      baseAddress: 0x400000,
      entryPoint: 0x401000,
      sections: [
        {
          name: '.text',
          virtualAddress: 0x1000,
          virtualSize: 0x100,
          rawSize: 0x100,
          characteristics: 0x60000020,
        },
      ],
      imports: [],
      exports: [],
      is64: false,
      relocations: [],
      resources: new Uint8Array(0),
      path: '',
      imageSize: 0x2000,
      subsystem: 3,
      machine: 0x14c,
      header: new Uint8Array(0),
    };
    const mapped = mapPeImage(runtime, raw, pe);
    expect(mapped.stubs).toEqual([]);
  });
});
