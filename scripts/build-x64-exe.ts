/**
 * Generates `sample/hello-x64.exe` — a hand-assembled PE32+ (64-bit) console
 * program that calls GetStdHandle / WriteFile / ExitProcess through the trap
 * stubs using RIP-relative IAT calls, prints a message and exits with code 0.
 * Used to demo the x86-64 JIT + PE32+ loader pipeline (`pnpm run:exe`).
 *
 * The image is linked at 0x01000000 (the kernel's X64_BASE), so no .reloc
 * section is needed; the IAT slots are rewritten to the trap stub addresses
 * by the mapper at load time.
 */
import { mkdir, writeFile } from 'node:fs/promises';

const IMAGE_BASE = 0x01000000;

interface Section {
  name: string;
  rva: number;
  data: Uint8Array;
  characteristics: number;
}

const u16 = (view: DataView, o: number, v: number) => view.setUint16(o, v, true);
const u32 = (view: DataView, o: number, v: number) => view.setUint32(o, v, true);
const u64 = (view: DataView, o: number, v: number) => view.setBigUint64(o, BigInt(v), true);
const str = (img: Uint8Array, o: number, s: string) => {
  for (let i = 0; i < s.length; i++) img[o + i] = s.charCodeAt(i);
};

function pad8(n: number): number {
  return Math.ceil(n / 8) * 8;
}

function buildX64Pe(sections: Section[], entryRva: number, importDir?: { rva: number; size: number }): Uint8Array {
  const img = new Uint8Array(0x1000);
  const view = new DataView(img.buffer);
  img[0] = 0x4d;
  img[1] = 0x5a;
  u32(view, 0x3c, 0x40);

  img[0x40] = 0x50;
  img[0x41] = 0x45;
  u16(view, 0x44, 0x8664); // machine: AMD64
  u16(view, 0x46, sections.length);
  u16(view, 0x54, 0xf0); // size of optional header (PE32+)
  u16(view, 0x56, 0x0022); // characteristics: executable | large-address-aware

  const opt = 0x58;
  u16(view, opt + 0, 0x20b); // PE32+
  u16(view, opt + 2, 0);
  u32(view, opt + 4, sections[0]!.data.byteLength); // SizeOfCode
  u32(view, opt + 8, sections[1]!.data.byteLength); // SizeOfInitializedData
  u32(view, opt + 12, 0);
  u32(view, opt + 16, entryRva);
  u32(view, opt + 20, sections[0]!.rva); // BaseOfCode
  u64(view, opt + 24, IMAGE_BASE);
  u32(view, opt + 32, 0x1000); // SectionAlignment
  u32(view, opt + 36, 0x200); // FileAlignment
  u16(view, opt + 40, 6); // OS version
  u16(view, opt + 42, 0);
  u16(view, opt + 44, 0); // image version
  u16(view, opt + 46, 0);
  u16(view, opt + 48, 6); // subsystem version
  u16(view, opt + 50, 0);
  u32(view, opt + 52, 0);
  u32(view, opt + 56, 0x4000); // SizeOfImage
  u32(view, opt + 60, 0x400); // SizeOfHeaders
  u32(view, opt + 64, 0);
  u16(view, opt + 68, 3); // subsystem: console
  u16(view, opt + 70, 0);
  u64(view, opt + 72, 0x100000); // SizeOfStackReserve
  u64(view, opt + 80, 0x1000); // SizeOfStackCommit
  u64(view, opt + 88, 0x100000); // SizeOfHeapReserve
  u64(view, opt + 96, 0x1000); // SizeOfHeapCommit
  u32(view, opt + 104, 0);
  u32(view, opt + 108, 16); // NumberOfRvaAndSizes

  // import directory (index 1)
  if (importDir) {
    u32(view, opt + 112 + 8, importDir.rva);
    u32(view, opt + 112 + 12, importDir.size);
  }

  // section headers follow the optional header
  const secTab = opt + 0xf0;
  let rawPtr = 0x400;
  for (let i = 0; i < sections.length; i++) {
    const s = secTab + i * 40;
    const sec = sections[i]!;
    str(img, s, sec.name);
    u32(view, s + 8, sec.data.byteLength); // VirtualSize
    u32(view, s + 12, sec.rva);
    u32(view, s + 16, sec.data.byteLength); // SizeOfRawData
    u32(view, s + 20, rawPtr); // PointerToRawData
    u32(view, s + 36, sec.characteristics);
    img.set(sec.data, rawPtr);
    rawPtr += sec.data.byteLength;
  }

  return img;
}

const MESSAGE = 'hello from browser-kernel (x64)!\r\n';

async function main(): Promise<void> {
  // ---- .data layout (RVA 0x2000) ----
  const msgRva = 0x2000;
  const msg = new TextEncoder().encode(MESSAGE);
  const writtenRva = msgRva + pad8(msg.byteLength);
  const iltRva = writtenRva + 8;
  const iatRva = iltRva + 3 * 8;
  const nameRva = iatRva + 3 * 8;
  const hintRva = nameRva + 13;
  const funcs = ['GetStdHandle', 'WriteFile', 'ExitProcess'];
  const hintSizes = funcs.map((f) => 2 + f.length + 1);
  const descRva = hintRva + hintSizes.reduce((a, b) => a + b, 0);

  const data = new Uint8Array(descRva + 40 - msgRva);
  const dview = new DataView(data.buffer);
  const doff = (rva: number) => rva - msgRva;
  data.set(msg, doff(msgRva));
  // ILT (OriginalFirstThunk): RVA of each hint/name entry
  let h = hintRva;
  for (let i = 0; i < funcs.length; i++) {
    u64(dview, doff(iltRva + i * 8), h);
    h += hintSizes[i]!;
  }
  // IAT (FirstThunk): patched by the mapper with trap-stub addresses
  // kernel32.dll name
  str(data, doff(nameRva), 'kernel32.dll');
  h = hintRva;
  for (let i = 0; i < funcs.length; i++) {
    u16(dview, doff(h), 0);
    str(data, doff(h) + 2, funcs[i]!);
    h += hintSizes[i]!;
  }
  // import descriptor
  u32(dview, doff(descRva), iltRva);
  u32(dview, doff(descRva) + 12, nameRva);
  u32(dview, doff(descRva) + 16, iatRva);
  // terminating descriptor is zeroed

  // ---- code (RVA 0x1000) ----
  const code = new Uint8Array(64);
  const cview = new DataView(code.buffer);
  let p = 0;
  const patch = (absTarget: number) => {
    const next = IMAGE_BASE + 0x1000 + p + 4; // disp is relative to the END of the disp32
    const disp = absTarget - next;
    u32(cview, p, disp);
    p += 4;
  };

  code[p++] = 0x48;
  code[p++] = 0x83;
  code[p++] = 0xec;
  code[p++] = 0x28; // sub rsp, 0x28
  code[p++] = 0xb9;
  code[p++] = 0xf5;
  code[p++] = 0xff;
  code[p++] = 0xff;
  code[p++] = 0xff; // mov ecx, -11 (STD_OUTPUT_HANDLE)
  code[p++] = 0xff;
  code[p++] = 0x15; // call [rip+disp] GetStdHandle
  patch(IMAGE_BASE + iatRva + 0);
  code[p++] = 0x48;
  code[p++] = 0x89;
  code[p++] = 0xc1; // mov rcx, rax
  code[p++] = 0x48;
  code[p++] = 0x8d;
  code[p++] = 0x15; // lea rdx, [rip+disp] msg
  patch(IMAGE_BASE + msgRva);
  code[p++] = 0x41;
  code[p++] = 0xb8;
  code[p++] = msg.byteLength & 0xff;
  code[p++] = (msg.byteLength >> 8) & 0xff;
  code[p++] = (msg.byteLength >> 16) & 0xff;
  code[p++] = (msg.byteLength >> 24) & 0xff; // mov r8d, msgLen
  code[p++] = 0x4c;
  code[p++] = 0x8d;
  code[p++] = 0x0d; // lea r9, [rip+disp] written
  patch(IMAGE_BASE + writtenRva);
  code[p++] = 0x48;
  code[p++] = 0xc7;
  code[p++] = 0x44;
  code[p++] = 0x24;
  code[p++] = 0x28;
  code[p++] = 0;
  code[p++] = 0;
  code[p++] = 0;
  code[p++] = 0; // mov qword [rsp+0x28], 0 (lpOverlapped)
  code[p++] = 0xff;
  code[p++] = 0x15; // call [rip+disp] WriteFile
  patch(IMAGE_BASE + iatRva + 8);
  code[p++] = 0x33;
  code[p++] = 0xc9; // xor ecx, ecx
  code[p++] = 0xff;
  code[p++] = 0x15; // call [rip+disp] ExitProcess
  patch(IMAGE_BASE + iatRva + 16);

  const image = buildX64Pe(
    [
      { name: '.text', rva: 0x1000, data: code, characteristics: 0x60000020 },
      { name: '.data', rva: 0x2000, data, characteristics: 0xc0000040 },
    ],
    0x1000,
    { rva: descRva, size: 40 },
  );

  await mkdir('sample', { recursive: true });
  await writeFile('sample/hello-x64.exe', image);
  console.log(`wrote sample/hello-x64.exe (${image.byteLength} bytes, message ${msg.byteLength} chars)`);
}

main().catch((error) => {
  console.error('[build-x64-exe] failed', error);
  process.exit(1);
});
