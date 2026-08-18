import { describe, expect, it } from 'vitest';
import { ApiInterceptorImpl } from '../api/interceptor';
import { registerDefaultHandlers } from '../api/handlers';
import { PeLoaderImpl } from '../pe/loader';
import { WasmRuntimeImpl } from '../jit/runtime';
import { JitEngineImpl } from '../jit/engine';
import { GuestProcessRunner } from './guest-process';

/**
 * Builds a PE32 with one .text section and a single kernel32.dll import
 * descriptor exposing the given functions in order. `code` is placed at RVA
 * 0x1000 (entry point) and `data` at RVA 0x1200 (message area).
 */
function buildPe(functions: string[], code: Uint8Array, data = new Uint8Array(0)): Uint8Array {
  const img = new Uint8Array(0x700);
  const view = new DataView(img.buffer);
  const u16 = (o: number, v: number) => view.setUint16(o, v, true);
  const u32 = (o: number, v: number) => view.setUint32(o, v, true);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) img[o + i] = s.charCodeAt(i);
  };

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

  // data directories: import at RVA 0x1040
  u32(opt + 96 + 8, 0x1040);
  u32(opt + 96 + 12, 20 * 2);

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

  // import descriptor at raw 0x240 (RVA 0x1040)
  const id = 0x240;
  u32(id, 0x1100); // OriginalFirstThunk (ILT)
  u32(id + 12, 0x1140); // name rva
  u32(id + 16, 0x1160); // FirstThunk (IAT)
  // terminator descriptor (all zero) at 0x254

  // ILT at raw 0x300 (RVA 0x1100)
  const names: number[] = [];
  for (let i = 0; i < functions.length; i++) {
    const nameRva = 0x1300 + i * 0x20;
    u32(0x300 + i * 4, nameRva);
    names.push(nameRva);
  }
  u32(0x300 + functions.length * 4, 0);

  // DLL name at raw 0x340 (RVA 0x1140)
  str(0x340, 'kernel32.dll');

  // IAT at raw 0x360 (RVA 0x1160)
  for (let i = 0; i < functions.length; i++) u32(0x360 + i * 4, names[i]!);
  u32(0x360 + functions.length * 4, 0);

  // IMAGE_IMPORT_BY_NAME entries at RVA 0x1300 (raw 0x500)
  for (let i = 0; i < functions.length; i++) {
    const off = 0x500 + i * 0x20;
    u16(off, 0); // hint
    str(off + 2, functions[i]!);
  }

  return img;
}

function makeRunner(): { runtime: WasmRuntimeImpl; runner: GuestProcessRunner } {
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
  return { runtime, runner };
}

const text = new TextDecoder();
const encoder = new TextEncoder();

describe('GuestProcessRunner', () => {
  it('runs a PE that calls APIs and exits with a code', async () => {
    const { runtime, runner } = makeRunner();

    // entry (0x401000):
    //   call [IAT GetTickCount];  store result
    //   push -11; call [IAT GetStdHandle];  store handle
    //   push 0; push 0; push 6; push 0x401200; push eax; call [IAT WriteFile]; store n
    //   push 42; call [IAT ExitProcess]
    const code = new Uint8Array([
      0xff,
      0x15,
      0x60,
      0x11,
      0x40,
      0x00, // call [0x401160] GetTickCount
      0xa3,
      0x40,
      0x12,
      0x40,
      0x00, // mov [0x401240], eax
      0x68,
      0xf5,
      0xff,
      0xff,
      0xff, // push -11 (STD_OUTPUT_HANDLE)
      0xff,
      0x15,
      0x64,
      0x11,
      0x40,
      0x00, // call [0x401164] GetStdHandle
      0xa3,
      0x44,
      0x12,
      0x40,
      0x00, // mov [0x401244], eax
      0x6a,
      0x00, // push 0
      0x6a,
      0x00, // push 0
      0x6a,
      0x06, // push 6
      0x68,
      0x00,
      0x12,
      0x40,
      0x00, // push 0x401200
      0x50, // push eax
      0xff,
      0x15,
      0x68,
      0x11,
      0x40,
      0x00, // call [0x401168] WriteFile
      0xa3,
      0x48,
      0x12,
      0x40,
      0x00, // mov [0x401248], eax
      0x6a,
      0x2a, // push 42
      0xff,
      0x15,
      0x6c,
      0x11,
      0x40,
      0x00, // call [0x40116c] ExitProcess
    ]);
    const image = buildPe(
      ['GetTickCount', 'GetStdHandle', 'WriteFile', 'ExitProcess'],
      code,
      encoder.encode('hello\n'),
    );

    const result = await runner.run(image);

    expect(result.status).toBe('exit');
    expect(result.exitCode).toBe(42);
    expect(result.output.byteLength).toBe(6);
    expect(text.decode(result.output)).toBe('hello\n');
    expect(result.stderrOutput.byteLength).toBe(0);
    expect(result.stubs).toHaveLength(4);
    expect(result.stubs.map((s) => s.proc)).toEqual([
      'GetTickCount',
      'GetStdHandle',
      'WriteFile',
      'ExitProcess',
    ]);

    // guest-visible results
    expect(runtime.readInt32(0x401240)).toBeGreaterThan(0); // GetTickCount > 0
    expect(runtime.readInt32(0x401244)).toBe(-11); // GetStdHandle == STD_OUTPUT_HANDLE
    expect(runtime.readInt32(0x401248)).toBe(6); // WriteFile wrote 6 bytes
  });

  it('ends cleanly when the entry point returns directly', async () => {
    const { runner } = makeRunner();
    // mov eax, 5; ret  — ret pops the null return address -> eip 0
    const image = buildPe(['ExitProcess'], new Uint8Array([0xb8, 0x05, 0x00, 0x00, 0x00, 0xc3]));

    const result = await runner.run(image);

    expect(result.status).toBe('exit');
    expect(result.exitCode).toBe(0);
    expect(result.output.byteLength).toBe(0);
  });

  it('reports a fault for unsupported instructions', async () => {
    const { runner } = makeRunner();
    // 0f a2 = cpuid (not implemented) -> fault block
    const image = buildPe(['ExitProcess'], new Uint8Array([0x0f, 0xa2]));

    const result = await runner.run(image);

    expect(result.status).toBe('fault');
  });

  it('routes unknown imports through the default NOT_IMPLEMENTED path', async () => {
    const { runner } = makeRunner();
    // call [IAT DoSomethingWeird] then ExitProcess(0)
    const code = new Uint8Array([
      0xff,
      0x15,
      0x60,
      0x11,
      0x40,
      0x00, // call [0x401160] DoSomethingWeird
      0x6a,
      0x00, // push 0
      0xff,
      0x15,
      0x64,
      0x11,
      0x40,
      0x00, // call [0x401164] ExitProcess
    ]);
    const image = buildPe(['DoSomethingWeird', 'ExitProcess'], code);

    const result = await runner.run(image);
    expect(result.status).toBe('exit');
    expect(result.exitCode).toBe(0);
  });
});
