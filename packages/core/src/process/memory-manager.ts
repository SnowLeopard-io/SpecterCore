import type { MemoryManager, MemoryRegion } from '@specter-core/contracts';
import { AllocationType, MemoryProtection, MemoryState } from '@specter-core/contracts';
import { nextId } from '@specter-core/shared';

const PAGE_SIZE = 4 * 1024;
const BASE_ADDRESS = 0x00010000;

/**
 * Virtual memory manager (design doc 4.3.5-4.3.7).
 * Tracks reserved/committed regions and 4KB pages. Physical backing is a
 * sparse page map that a future WASM JIT can install into the linear memory.
 */
export class MemoryManagerImpl implements MemoryManager {
  private readonly regions: MemoryRegion[] = [];
  private readonly pages = new Map<number, Uint8Array>();
  private readonly heaps = new Map<
    number,
    { base: number; size: number; bump: number; freeList: Array<{ addr: number; size: number }>; allocations: Map<number, number> }
  >();
  private nextAddress = BASE_ADDRESS;

  virtualAlloc(size: number, allocationType: number, protection: number): number {
    const alignedSize = Math.ceil(size / PAGE_SIZE) * PAGE_SIZE;
    if (allocationType & AllocationType.MEM_RELEASE) return 0;
    const baseAddress = this.align(this.nextAddress);
    const committed = (allocationType & AllocationType.MEM_COMMIT) !== 0;
    const state = committed ? MemoryState.MEM_COMMITTED : MemoryState.MEM_RESERVED;
    this.regions.push({
      baseAddress,
      size: alignedSize,
      protection: protection as MemoryProtection,
      state,
      committed,
    });
    this.nextAddress = baseAddress + alignedSize;
    if (committed) this.commitPages(baseAddress, alignedSize);
    return baseAddress;
  }

  virtualFree(baseAddress: number, _size: number, freeType: number): boolean {
    const idx = this.regions.findIndex((r) => r.baseAddress === baseAddress);
    if (idx === -1) return false;
    if (freeType & AllocationType.MEM_RELEASE) {
      this.releasePages(baseAddress, this.regions[idx]!.size);
      this.regions.splice(idx, 1);
      return true;
    }
    // MEM_DECOMMIT keeps the region reserved but releases physical pages
    this.releasePages(baseAddress, this.regions[idx]!.size);
    this.regions[idx]!.committed = false;
    this.regions[idx]!.state = MemoryState.MEM_RESERVED;
    return true;
  }

  virtualProtect(baseAddress: number, size: number, protection: number): number {
    const region = this.regions.find((r) => r.baseAddress <= baseAddress && baseAddress < r.baseAddress + r.size);
    if (!region) return 0;
    const old = region.protection;
    region.protection = protection as MemoryProtection;
    void size;
    return old;
  }

  queryRegions(): MemoryRegion[] {
    return this.regions.map((r) => ({ ...r }));
  }

  heapCreate(): number {
    const heapId = nextId();
    const base = this.virtualAlloc(PAGE_SIZE * 256, AllocationType.MEM_RESERVE | AllocationType.MEM_COMMIT, MemoryProtection.PAGE_READWRITE);
    this.heaps.set(heapId, { base, size: PAGE_SIZE * 256, bump: 0, freeList: [], allocations: new Map() });
    return heapId;
  }

  heapAlloc(heapId: number, size: number): number {
    const heap = this.heaps.get(heapId);
    if (!heap) return 0;
    const aligned = Math.ceil(size / 8) * 8;
    // first-fit over the free list
    let best: { addr: number; size: number } | null = null;
    for (const block of heap.freeList) {
      if (block.size >= aligned && (!best || block.size < best.size)) best = block;
    }
    if (best) {
      const addr = best.addr;
      heap.freeList.splice(heap.freeList.indexOf(best), 1);
      heap.allocations.set(addr, aligned);
      return addr;
    }
    const addr = heap.base + heap.bump;
    if (addr + aligned > heap.base + heap.size) return 0;
    heap.bump += aligned;
    heap.allocations.set(addr, aligned);
    return addr;
  }

  heapFree(heapId: number, address: number): boolean {
    const heap = this.heaps.get(heapId);
    if (!heap) return false;
    const size = heap.allocations.get(address) ?? 8;
    heap.allocations.delete(address);
    heap.freeList.push({ addr: address, size });
    return true;
  }

  read(address: number, length: number): Uint8Array {
    const out = new Uint8Array(length);
    let read = 0;
    while (read < length) {
      const pageIndex = Math.floor((address + read) / PAGE_SIZE);
      const offset = (address + read) % PAGE_SIZE;
      const page = this.pages.get(pageIndex);
      if (!page) break;
      const n = Math.min(PAGE_SIZE - offset, length - read);
      out.set(page.subarray(offset, offset + n), read);
      read += n;
    }
    return out.subarray(0, read);
  }

  write(address: number, data: Uint8Array): void {
    let written = 0;
    while (written < data.byteLength) {
      const pageIndex = Math.floor((address + written) / PAGE_SIZE);
      const offset = (address + written) % PAGE_SIZE;
      let page = this.pages.get(pageIndex);
      if (!page) {
        page = new Uint8Array(PAGE_SIZE);
        this.pages.set(pageIndex, page);
      }
      const n = Math.min(PAGE_SIZE - offset, data.byteLength - written);
      page.set(data.subarray(written, written + n), offset);
      written += n;
    }
  }

  private commitPages(base: number, size: number): void {
    const start = Math.floor(base / PAGE_SIZE);
    const count = Math.ceil(size / PAGE_SIZE);
    for (let i = 0; i < count; i++) {
      if (!this.pages.has(start + i)) this.pages.set(start + i, new Uint8Array(PAGE_SIZE));
    }
  }

  private releasePages(base: number, size: number): void {
    const start = Math.floor(base / PAGE_SIZE);
    const count = Math.ceil(size / PAGE_SIZE);
    for (let i = 0; i < count; i++) this.pages.delete(start + i);
  }

  private align(address: number): number {
    return Math.ceil(address / PAGE_SIZE) * PAGE_SIZE;
  }
}