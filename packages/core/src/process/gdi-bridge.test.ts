import { describe, expect, it } from 'vitest';
import type {
  ClipRegion,
  Color,
  DeviceCaps,
  DibSurface,
  Dispose,
  FontSpec,
  GdiBridge,
  Point,
  Rect,
  WinError,
} from '@specter-core/contracts';
import { WinError as E } from '@specter-core/contracts';
import { ApiInterceptorImpl } from '../api/interceptor';
import { registerDefaultHandlers } from '../api/handlers';
import { PeLoaderImpl } from '../pe/loader';
import { WasmRuntimeImpl } from '../jit/runtime';
import { JitEngineImpl } from '../jit/engine';
import { GuestProcessRunner } from './guest-process';

interface ImportDll {
  dll: string;
  funcs: string[];
}

/**
 * Builds a PE32 with one .text section and import descriptors for multiple
 * DLLs (e.g. kernel32 + user32 + gdi32). `code` is placed at RVA 0x1000
 * (entry point) and `data` at RVA 0x1200. Returns the image plus a map of
 * `proc -> IAT absolute address` for the code to `call [addr]`. Layout is
 * computed dynamically so the code never collides with the import tables.
 */
function buildPeMulti(
  imports: ImportDll[],
  code: Uint8Array,
  data = new Uint8Array(0),
): { image: Uint8Array; iat: Map<string, number> } {
  const img = new Uint8Array(0x700);
  const view = new DataView(img.buffer);
  const u16 = (o: number, v: number) => view.setUint16(o, v, true);
  const u32 = (o: number, v: number) => view.setUint32(o, v, true);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) img[o + i] = s.charCodeAt(i);
  };
  const rva = (raw: number) => raw - 0x200 + 0x1000;
  const align4 = (n: number) => (n + 3) & ~3;

  const totalSlots = imports.reduce((n, d) => n + d.funcs.length + 1, 0);

  // Dynamic layout starting right after the code.
  const descRaw = align4(0x200 + code.byteLength);
  const iltRaw = descRaw + (imports.length + 1) * 20;
  const nameRaw = iltRaw + totalSlots * 4;
  const iatRaw = nameRaw + imports.reduce((n, d) => n + d.dll.length + 1, 0);
  const byNameRaw = 0x500;

  // DOS header
  img[0] = 0x4d;
  img[1] = 0x5a;
  u32(0x3c, 0x40);

  // PE signature + COFF header
  img[0x40] = 0x50;
  img[0x41] = 0x45;
  img[0x42] = 0x00;
  img[0x43] = 0x00;
  u16(0x44, 0x14c); // i386
  u16(0x46, 1); // numberOfSections
  u16(0x54, 0xe0); // sizeOfOptionalHeader
  u16(0x56, 0x0102); // EXECUTABLE | 32BIT

  // Optional header (PE32)
  const opt = 0x58;
  u16(opt + 0, 0x10b);
  u32(opt + 4, code.byteLength); // sizeOfCode
  u32(opt + 16, 0x1000); // addressOfEntryPoint
  u32(opt + 20, 0x1000); // baseOfCode
  u32(opt + 28, 0x400000); // imageBase
  u32(opt + 32, 0x1000); // sectionAlignment
  u32(opt + 36, 0x200); // fileAlignment
  u16(opt + 48, 4); // majorSubsystemVersion
  u32(opt + 56, 0x2000); // sizeOfImage
  u32(opt + 60, 0x200); // sizeOfHeaders
  u16(opt + 68, 3); // subsystem: windows cui
  u32(opt + 72, 0x100000); // sizeOfStackReserve
  u32(opt + 76, 0x1000); // sizeOfStackCommit
  u32(opt + 80, 0x100000); // sizeOfHeapReserve
  u32(opt + 84, 0x1000); // sizeOfHeapCommit
  u32(opt + 92, 16); // numberOfRvaAndSizes

  // data directories: import at the descriptor block
  u32(opt + 96 + 8, rva(descRaw));
  u32(opt + 96 + 12, (imports.length + 1) * 20);

  // section table
  const sec = 0x138;
  str(sec, '.text');
  u32(sec + 8, 0x1400); // virtualSize
  u32(sec + 12, 0x1000); // virtualAddress
  u32(sec + 16, 0x500); // sizeOfRawData
  u32(sec + 20, 0x200); // pointerToRawData
  u32(sec + 36, 0x60000020); // CODE | EXECUTE | READ

  // section raw data at 0x200 (RVA 0x1000)
  img.set(code, 0x200);
  if (data.byteLength > 0) img.set(data, 0x400); // RVA 0x1200

  // Import descriptors, ILTs, names, IATs, by-name entries.
  const iat = new Map<string, number>();
  let iltOff = 0;
  let nameOff = 0;
  let iatOff = 0;
  let byNameOff = 0;
  for (let d = 0; d < imports.length; d++) {
    const { dll, funcs } = imports[d]!;
    const id = descRaw + d * 20;
    u32(id + 0, rva(iltRaw + iltOff * 4)); // OriginalFirstThunk
    u32(id + 12, rva(nameRaw + nameOff)); // Name
    u32(id + 16, rva(iatRaw + iatOff * 4)); // FirstThunk

    for (let f = 0; f < funcs.length; f++) {
      const nameRvaOf = rva(byNameRaw + byNameOff * 0x20);
      u32(iltRaw + (iltOff + f) * 4, nameRvaOf);
      u32(iatRaw + (iatOff + f) * 4, nameRvaOf);
      const off = byNameRaw + byNameOff * 0x20;
      u16(off, 0); // hint
      str(off + 2, funcs[f]!);
      iat.set(funcs[f]!, 0x400000 + rva(iatRaw + (iatOff + f) * 4));
      byNameOff++;
    }
    u32(iltRaw + (iltOff + funcs.length) * 4, 0);
    u32(iatRaw + (iatOff + funcs.length) * 4, 0);

    str(nameRaw + nameOff, dll);
    nameOff += dll.length + 1;
    iltOff += funcs.length + 1;
    iatOff += funcs.length + 1;
  }

  return { image: img, iat };
}

/** Records every GDI bridge call for assertions (L6 pixel-path stub). */
class RecordingGdiBridge implements GdiBridge {
  calls: string[] = [];
  private next = 0x300;
  async createDC(name: string): Promise<number> {
    this.calls.push(`createDC:${name}`);
    return ++this.next;
  }
  async createCompatibleDC(_dc: number): Promise<number> {
    this.calls.push('createCompatibleDC');
    return ++this.next;
  }
  async deleteDC(dc: number): Promise<void> {
    this.calls.push(`deleteDC:${dc}`);
  }
  async textOut(
    dc: number,
    x: number,
    y: number,
    text: string,
    _font?: FontSpec,
  ): Promise<WinError> {
    this.calls.push(`textOut:${dc}:${x},${y}:${text}`);
    return E.NO_ERROR;
  }
  async setTextColor(dc: number, color: Color): Promise<WinError> {
    this.calls.push(`setTextColor:${dc}:${rgb(color)}`);
    return E.NO_ERROR;
  }
  async setBkColor(dc: number, color: Color): Promise<WinError> {
    this.calls.push(`setBkColor:${dc}:${rgb(color)}`);
    return E.NO_ERROR;
  }
  async setBkMode(dc: number, mode: number): Promise<WinError> {
    this.calls.push(`setBkMode:${dc}:${mode}`);
    return E.NO_ERROR;
  }
  async lineTo(
    dc: number,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    color: Color,
  ): Promise<WinError> {
    this.calls.push(`lineTo:${dc}:${x0},${y0}->${x1},${y1}:${rgb(color)}`);
    return E.NO_ERROR;
  }
  async fillRect(dc: number, rect: Rect, color: Color): Promise<WinError> {
    this.calls.push(
      `fillRect:${dc}:${rect.x},${rect.y},${rect.width},${rect.height}:${rgb(color)}`,
    );
    return E.NO_ERROR;
  }
  async frameRect(dc: number, rect: Rect, color: Color): Promise<WinError> {
    this.calls.push(
      `frameRect:${dc}:${rect.x},${rect.y},${rect.width},${rect.height}:${rgb(color)}`,
    );
    return E.NO_ERROR;
  }
  async ellipse(dc: number, bounds: Rect, color: Color): Promise<WinError> {
    this.calls.push(`ellipse:${dc}:${rgb(color)}`);
    return E.NO_ERROR;
  }
  async frameEllipse(dc: number, bounds: Rect, color: Color): Promise<WinError> {
    this.calls.push(`frameEllipse:${dc}:${rgb(color)}`);
    return E.NO_ERROR;
  }
  async roundRect(
    dc: number,
    bounds: Rect,
    _rx: number,
    _ry: number,
    color: Color,
  ): Promise<WinError> {
    this.calls.push(`roundRect:${dc}:${rgb(color)}`);
    return E.NO_ERROR;
  }
  async polyline(dc: number, _points: Point[], color: Color): Promise<WinError> {
    this.calls.push(`polyline:${dc}:${rgb(color)}`);
    return E.NO_ERROR;
  }
  async polygon(dc: number, _points: Point[], color: Color): Promise<WinError> {
    this.calls.push(`polygon:${dc}:${rgb(color)}`);
    return E.NO_ERROR;
  }
  async setPixel(dc: number, _x: number, _y: number, color: Color): Promise<WinError> {
    this.calls.push(`setPixel:${dc}:${rgb(color)}`);
    return E.NO_ERROR;
  }
  async setClip(_dc: number, _region: ClipRegion | null): Promise<void> {}
  async getClip(_dc: number): Promise<ClipRegion | null> {
    return null;
  }
  async saveDC(dc: number): Promise<number> {
    this.calls.push(`saveDC:${dc}`);
    return 1;
  }
  async restoreDC(dc: number, _saved?: number): Promise<number> {
    this.calls.push(`restoreDC:${dc}`);
    return 1;
  }
  async bitBlt(
    destDc: number,
    destRect: Rect,
    srcDc: number,
    srcRect: Rect,
    rop: number,
  ): Promise<WinError> {
    this.calls.push(`bitBlt:${destDc}<-${srcDc}:${destRect.width}x${destRect.height}:${rop}`);
    return E.NO_ERROR;
  }
  async stretchBlt(
    destDc: number,
    destRect: Rect,
    srcDc: number,
    srcRect: Rect,
    rop: number,
  ): Promise<WinError> {
    this.calls.push(`stretchBlt:${destDc}<-${srcDc}:${destRect.width}x${destRect.height}:${rop}`);
    return E.NO_ERROR;
  }
  async patBlt(dc: number, rect: Rect, color: Color, rop: number): Promise<WinError> {
    this.calls.push(`patBlt:${dc}:${rect.width}x${rect.height}:${rop}`);
    return E.NO_ERROR;
  }
  async getDeviceCaps(_dc: number): Promise<DeviceCaps> {
    return {
      bitsPerPixel: 32,
      width: 640,
      height: 480,
      colorPlanes: 1,
      horizontalResolution: 96,
      verticalResolution: 96,
    };
  }
  async setDIBitsToDevice(
    dc: number,
    x: number,
    y: number,
    dib: DibSurface,
  ): Promise<WinError> {
    this.calls.push(
      `setDIBitsToDevice:${dc}:${x},${y}:${dib.drawWidth}x${dib.drawHeight}:${dib.bitCount}bpp`,
    );
    return E.NO_ERROR;
  }
  async flush(dc: number): Promise<void> {
    this.calls.push(`flush:${dc}`);
  }
  onInvalidate(_listener: (dc: number, rect: Rect) => void): Dispose {
    return () => {};
  }
}

const rgb = (c: Color): string => `${c.r},${c.g},${c.b}`;

function makeRunner() {
  const runtime = new WasmRuntimeImpl(64);
  const loader = new PeLoaderImpl();
  const host = {
    fs: {} as never,
    gdi: {} as never,
    audio: {} as never,
    usb: {} as never,
    process: {} as never,
    memory: {
      read: (address: number, length: number) => runtime.readBytes(address, length),
      write: (address: number, data: Uint8Array) => runtime.writeBytes(address, data),
    },
  };
  const interceptor = new ApiInterceptorImpl(host as never, undefined);
  registerDefaultHandlers(interceptor);
  const runner = new GuestProcessRunner(runtime, new JitEngineImpl(runtime), loader, interceptor);
  return { runtime, runner, interceptor };
}

describe('GDI pixel path (L6 image bridge, 设计文档 3.2)', () => {
  it('forwards BeginPaint/draw/EndPaint to the per-window bridge', async () => {
    const { runner, interceptor } = makeRunner();
    const bridge = new RecordingGdiBridge();
    const providers: number[] = [];
    interceptor.setLastError(0, 0);

    // data: RVA 0x1200 = "hello" (wide), RVA 0x1220 = RECT{0,0,100,50},
    // RVA 0x1240 = PAINTSTRUCT scratch.
    const data = new Uint8Array(0x100);
    const dv = new DataView(data.buffer);
    for (let i = 0; i < 5; i++) dv.setUint16(i * 2, 'hello'.charCodeAt(i), true);
    dv.setUint32(0x20, 0, true);
    dv.setUint32(0x24, 0, true);
    dv.setUint32(0x28, 100, true);
    dv.setUint32(0x2c, 50, true);

    const imports: ImportDll[] = [
      { dll: 'kernel32.dll', funcs: ['ExitProcess'] },
      { dll: 'user32.dll', funcs: ['BeginPaint', 'EndPaint'] },
      { dll: 'gdi32.dll', funcs: ['CreateSolidBrush', 'SetTextColor', 'TextOutW', 'FillRect'] },
    ];
    // Two passes: the code's `call [IAT]` operands need the IAT addresses, but
    // those depend on the code length. Each call is a fixed 6 bytes, so build
    // with placeholders first, then rebuild with real addresses.
    const push = (v: number) => [0x68, ...le32(v)];

    const buildCode = (addr: (proc: string) => number) =>
      new Uint8Array([
        ...push(0x0000ff00),
        ...[0xff, 0x15, ...le32(addr('CreateSolidBrush'))],
        0x89,
        0xc6, // mov esi, eax (brush)
        ...push(0x401240), // &ps
        ...push(0x10001),
        ...[0xff, 0x15, ...le32(addr('BeginPaint'))],
        0x89,
        0xc3, // mov ebx, eax (hdc)
        ...push(0x00ff0000), // SetTextColor(hdc, color)
        0x53, // push ebx (hdc)
        ...[0xff, 0x15, ...le32(addr('SetTextColor'))],
        ...push(5), // cch
        ...push(0x401200), // &str
        ...push(10), // y
        ...push(5), // x
        0x53, // push ebx (hdc)
        ...[0xff, 0x15, ...le32(addr('TextOutW'))],
        0x56, // push esi (brush)
        ...push(0x401220), // &rc
        0x53, // push ebx (hdc)
        ...[0xff, 0x15, ...le32(addr('FillRect'))],
        ...push(0x401240), // &ps
        ...push(0x10001),
        ...[0xff, 0x15, ...le32(addr('EndPaint'))],
        ...push(0),
        ...[0xff, 0x15, ...le32(addr('ExitProcess'))],
      ]);

    const first = buildPeMulti(
      imports,
      buildCode(() => 0x401000),
      data,
    );
    const real = new Map<string, number>();
    for (const [p, a] of first.iat) real.set(p, a);
    const image = buildPeMulti(
      imports,
      buildCode((p) => real.get(p)!),
      data,
    ).image;

    const result = await runner.run(image, {
      gdiBridge: (hwnd) => {
        providers.push(hwnd);
        return hwnd === 0x10001 ? bridge : null;
      },
    });

    expect(result.status).toBe('exit');
    expect(result.exitCode).toBe(0);
    expect(providers).toContain(0x10001);
    // pixel path: no PaintCommand capture, all drawing goes to the bridge
    expect(result.paintCommands ?? []).toEqual([]);
    expect(bridge.calls).toEqual([
      'createDC:DISPLAY',
      'setTextColor:769:0,0,255',
      'textOut:769:5,10:hello',
      'fillRect:769:0,0,100,50:0,255,0',
      'flush:769',
    ]);
  });

  it('falls back to PaintCommand capture when no bridge is provided', async () => {
    const { runner } = makeRunner();
    const data = new Uint8Array(0x100);
    const dv = new DataView(data.buffer);
    for (let i = 0; i < 5; i++) dv.setUint16(i * 2, 'hello'.charCodeAt(i), true);

    const imports: ImportDll[] = [
      { dll: 'kernel32.dll', funcs: ['ExitProcess'] },
      { dll: 'user32.dll', funcs: ['BeginPaint', 'EndPaint'] },
      { dll: 'gdi32.dll', funcs: ['CreateSolidBrush', 'TextOutW'] },
    ];
    const push = (v: number) => [0x68, ...le32(v)];
    const buildCode = (addr: (proc: string) => number) =>
      new Uint8Array([
        ...push(0x0000ff00),
        ...[0xff, 0x15, ...le32(addr('CreateSolidBrush'))],
        0x89,
        0xc6, // mov esi, eax (brush)
        ...push(0x401240), // &ps
        ...push(0x10001),
        ...[0xff, 0x15, ...le32(addr('BeginPaint'))],
        0x89,
        0xc3, // mov ebx, eax (hdc)
        ...push(5), // cch
        ...push(0x401200), // &str
        ...push(10), // y
        ...push(5), // x
        0x53, // push ebx (hdc)
        ...[0xff, 0x15, ...le32(addr('TextOutW'))],
        ...push(0x401240), // &ps
        ...push(0x10001),
        ...[0xff, 0x15, ...le32(addr('EndPaint'))],
        ...push(0),
        ...[0xff, 0x15, ...le32(addr('ExitProcess'))],
      ]);

    const first = buildPeMulti(
      imports,
      buildCode(() => 0x401000),
      data,
    );
    const real = new Map<string, number>();
    for (const [p, a] of first.iat) real.set(p, a);
    const image = buildPeMulti(
      imports,
      buildCode((p) => real.get(p)!),
      data,
    ).image;

    const result = await runner.run(image);

    expect(result.status).toBe('exit');
    expect(result.exitCode).toBe(0);
    const paints = result.paintCommands ?? [];
    expect(paints.some((p) => p.op === 'text' && p.text === 'hello')).toBe(true);
  });
});

const le32 = (v: number): number[] => [
  v & 0xff,
  (v >>> 8) & 0xff,
  (v >>> 16) & 0xff,
  (v >>> 24) & 0xff,
];
