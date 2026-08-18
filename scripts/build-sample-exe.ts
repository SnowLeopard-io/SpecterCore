/**
 * Generates `sample/hello.exe` — a hand-assembled PE32 that calls
 * GetTickCount / GetStdHandle / WriteFile through the trap stubs, prints a
 * message to stdout and exits with code 7. Used to demo `pnpm run:exe`.
 */
import { mkdir, writeFile } from 'node:fs/promises';

function buildPe(functions: string[], code: Uint8Array, data = new Uint8Array(0)): Uint8Array {
  const img = new Uint8Array(0x700);
  const view = new DataView(img.buffer);
  const u16 = (o: number, v: number) => view.setUint16(o, v, true);
  const u32 = (o: number, v: number) => view.setUint32(o, v, true);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) img[o + i] = s.charCodeAt(i);
  };

  img[0] = 0x4d;
  img[1] = 0x5a;
  u32(0x3c, 0x40);

  img[0x40] = 0x50;
  img[0x41] = 0x45;
  u16(0x44, 0x14c);
  u16(0x46, 1);
  u16(0x54, 0xe0);
  u16(0x56, 0x0102);

  const opt = 0x58;
  u16(opt + 0, 0x10b);
  u32(opt + 4, code.byteLength);
  u32(opt + 16, 0x1000);
  u32(opt + 20, 0x1000);
  u32(opt + 28, 0x400000);
  u32(opt + 32, 0x1000);
  u32(opt + 36, 0x200);
  u16(opt + 48, 4);
  u32(opt + 56, 0x2000);
  u32(opt + 60, 0x200);
  u16(opt + 68, 3);
  u32(opt + 72, 0x100000);
  u32(opt + 76, 0x1000);
  u32(opt + 80, 0x100000);
  u32(opt + 84, 0x1000);
  u32(opt + 92, 16);
  u32(opt + 96 + 8, 0x1040);
  u32(opt + 96 + 12, 40);

  const sec = 0x138;
  str(sec, '.text');
  u32(sec + 8, 0x1400);
  u32(sec + 12, 0x1000);
  u32(sec + 16, 0x500);
  u32(sec + 20, 0x200);
  u32(sec + 36, 0x60000020);

  img.set(code, 0x200);
  if (data.byteLength > 0) img.set(data, 0x400);

  const id = 0x240;
  u32(id, 0x1100);
  u32(id + 12, 0x1140);
  u32(id + 16, 0x1160);

  const names: number[] = [];
  for (let i = 0; i < functions.length; i++) {
    const nameRva = 0x1300 + i * 0x20;
    u32(0x300 + i * 4, nameRva);
    names.push(nameRva);
  }
  u32(0x300 + functions.length * 4, 0);

  str(0x340, 'kernel32.dll');

  for (let i = 0; i < functions.length; i++) u32(0x360 + i * 4, names[i]!);
  u32(0x360 + functions.length * 4, 0);

  for (let i = 0; i < functions.length; i++) {
    const off = 0x500 + i * 0x20;
    u16(off, 0);
    str(off + 2, functions[i]!);
  }

  return img;
}

const MESSAGE = 'hello from browser-kernel!\n';
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
  MESSAGE.length, // push len
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
  0x07, // push 7
  0xff,
  0x15,
  0x6c,
  0x11,
  0x40,
  0x00, // call [0x40116c] ExitProcess
]);

async function main(): Promise<void> {
  const image = buildPe(
    ['GetTickCount', 'GetStdHandle', 'WriteFile', 'ExitProcess'],
    code,
    new TextEncoder().encode(MESSAGE),
  );
  await mkdir('sample', { recursive: true });
  await writeFile('sample/hello.exe', image);
  console.log(
    `wrote sample/hello.exe (${image.byteLength} bytes, message ${MESSAGE.length} chars)`,
  );
}

main().catch((error) => {
  console.error('[build-sample-exe] failed', error);
  process.exit(1);
});
