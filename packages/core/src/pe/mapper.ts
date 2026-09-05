/**
 * PE image mapper (design doc 4.2.1/4.2.2).
 *
 * Loads a parsed `PeImage` into the WASM linear memory at its image base:
 *   1. writes each section's raw bytes (zero-filling slack),
 *   2. allocates a per-import "trap stub" (`mov eax, idx; int 0x2E; ret`) and
 *      rewrites every IAT slot to point at it,
 *   3. returns the import table so the trap dispatcher can resolve an API by
 *      the stub index read out of EAX (design 4.2.4).
 */

import type { PeImage } from '@specter-core/contracts';
import type { WasmRuntimeImpl } from '../jit/runtime';
import { archForPe, type ArchBackend } from '../arch';

/** Stub region: below the default 0x400000 image base. */
export const STUB_BASE = 0x00200000;

/**
 * Rebasing base for 64-bit images whose preferred ImageBase (typically
 * 0x140000000) exceeds the WASM linear-memory limit (~4GB). Keep it clear of
 * the CPU context (0x1000), the stub region (0x200000) and the stack (0x08000000).
 */
export const X64_BASE = 0x01000000;

/** Maximum address the 4GB WASM memory can hold (images below this keep their base). */
const MAX_IMAGE_BASE = 0xf0000000;
import { X86_API_ARG_COUNT } from './api-arg-counts';

export { X86_API_ARG_COUNT };

export interface ApiStub {
  index: number;
  module: string;
  proc: string;
  stubAddress: number;
  iatAddress: number;
}

export interface MappedImage {
  /** image base in the guest address space */
  baseAddress: number;
  entryPoint: number;
  stubs: ApiStub[];
  /**
   * First free address after the static trap stubs. Dynamic resolutions
   * (GetProcAddress for non-imported APIs) append new stubs from here.
   */
  stubEnd: number;
}

function fileOffset(rawImage: Uint8Array, pe: PeImage, sectionName: string): number {
  const sec = pe.sections.find((s) => s.name === sectionName);
  if (!sec) return 0;
  // PeImage does not carry pointerToRawData; recompute from the raw header.
  const eLfanew = readU32(rawImage, 0x3c);
  const coff = eLfanew + 4;
  const numSections = readU16(rawImage, coff + 2);
  const sizeOfOpt = readU16(rawImage, coff + 16);
  const sectionTable = coff + 20 + sizeOfOpt;
  for (let i = 0; i < numSections; i++) {
    const s = sectionTable + i * 40;
    if (readU32(rawImage, s + 12) === sec.virtualAddress) return readU32(rawImage, s + 20);
  }
  return 0;
}

function readU16(data: Uint8Array, offset: number): number {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint16(offset, true);
}

function readU32(data: Uint8Array, offset: number): number {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset, true);
}

/**
 * Applies the base-relocation delta to every relocation entry after the image
 * was copied into memory. `pe.relocations` carries (rva, type) pairs; type 3
 * (HIGHLOW) patches a 32-bit value, type 10 (DIR64) a 64-bit value.
 * `imageBase` is the effective base the sections were written at.
 */
function applyRelocations(
  runtime: WasmRuntimeImpl,
  pe: PeImage,
  imageBase: number,
  delta: number,
): void {
  if (delta === 0) return;
  for (const rel of pe.relocations) {
    const address = imageBase + rel.rva;
    if (rel.type === 3) {
      const value = runtime.readInt32(address);
      runtime.writeInt32(address, value + delta);
    } else {
      // type 10 (DIR64): patch 64-bit; values stay < 2^53 so Number is safe
      const low = runtime.readInt32(address);
      const high = runtime.readInt32(address + 4);
      const value = low + high * 4294967296;
      const next = value + delta;
      runtime.writeInt32(address, next | 0);
      runtime.writeInt32(address + 4, Math.floor(next / 4294967296));
    }
  }
}

/** Maps the image and rewrites the IAT; returns the stub/import table. */
export function mapPeImage(
  runtime: WasmRuntimeImpl,
  rawImage: Uint8Array,
  pe: PeImage,
  arch: ArchBackend = archForPe(pe),
): MappedImage {
  // Choose the effective image base (rebase oversized PE32+ images).
  const rebase = pe.baseAddress > MAX_IMAGE_BASE;
  const baseAddress = rebase ? X64_BASE : pe.baseAddress;
  const delta = baseAddress - pe.baseAddress;
  const entryRva = pe.entryPoint - pe.baseAddress;

  // 1. sections
  for (const sec of pe.sections) {
    const dst = baseAddress + sec.virtualAddress;
    const off = fileOffset(rawImage, pe, sec.name);
    const span = Math.max(sec.virtualSize, sec.rawSize);
    const n = Math.min(sec.rawSize, Math.max(0, rawImage.byteLength - off));
    if (n > 0) runtime.writeBytes(dst, rawImage.subarray(off, off + n));
    if (span > n) runtime.writeBytes(dst + n, new Uint8Array(span - n));
  }

  // 2. base relocations (rebasing a PE32+ image below 4GB)
  applyRelocations(runtime, pe, baseAddress, delta);

  // 3. IAT rewriting with trap stubs
  let nextStub = STUB_BASE;
  const stubs: ApiStub[] = [];
  let index = 0;
  for (const imp of pe.imports) {
    for (const fn of imp.functions) {
      const proc = fn.name ?? `#${fn.ordinal ?? 0}`;
      const stubAddress = nextStub;
      const argCount = arch.importArgCount(proc);
      const stub = arch.emitImportStub(index, argCount);
      runtime.writeBytes(stubAddress, stub);

      // IAT slot: image base + iatRva + slot*pointerSize (8 bytes on PE32+).
      // The slot must use the entry's ILT index: dropping entries (e.g. ordinal
      // imports) earlier would shift later slots and mispatch `call [IAT]` sites.
      const slot = fn.index ?? imp.functions.indexOf(fn);
      const iatAddress = baseAddress + imp.iatRva + slot * arch.pointerSize;
      arch.writeIatSlot(runtime, iatAddress, stubAddress);

      stubs.push({ index, module: imp.moduleName, proc, stubAddress, iatAddress });
      nextStub += stub.length;
      index += 1;
    }
  }

  return { baseAddress, entryPoint: entryRva + baseAddress, stubs, stubEnd: nextStub };
}
