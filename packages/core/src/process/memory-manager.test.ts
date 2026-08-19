import { describe, expect, it } from 'vitest';
import { AllocationType, MemoryProtection, MemoryState } from '@specter-core/contracts';
import { MemoryManagerImpl } from './memory-manager';

const RW = MemoryProtection.PAGE_READWRITE;

describe('MemoryManagerImpl', () => {
  it('reserves and commits regions', () => {
    const m = new MemoryManagerImpl();
    const addr = m.virtualAlloc(4096, AllocationType.MEM_RESERVE | AllocationType.MEM_COMMIT, RW);
    expect(addr).toBeGreaterThan(0);
    expect(addr % 4096).toBe(0);
    const regions = m.queryRegions();
    expect(regions[0]!.state).toBe(MemoryState.MEM_COMMITTED);
    expect(regions[0]!.committed).toBe(true);
  });

  it('rounds sizes up to page boundaries', () => {
    const m = new MemoryManagerImpl();
    const addr = m.virtualAlloc(100, AllocationType.MEM_RESERVE, RW);
    expect(m.queryRegions()[0]!.size).toBe(4096);
    void addr;
  });

  it('frees committed regions on MEM_RELEASE', () => {
    const m = new MemoryManagerImpl();
    const addr = m.virtualAlloc(4096, AllocationType.MEM_RESERVE | AllocationType.MEM_COMMIT, RW);
    m.write(addr, new Uint8Array([1, 2, 3]));
    expect(m.virtualFree(addr, 0, AllocationType.MEM_RELEASE)).toBe(true);
    expect(m.queryRegions()).toHaveLength(0);
    // pages are gone
    expect(m.read(addr, 3).byteLength).toBe(0);
  });

  it('virtualProtect changes protection and returns old value', () => {
    const m = new MemoryManagerImpl();
    const addr = m.virtualAlloc(4096, AllocationType.MEM_RESERVE | AllocationType.MEM_COMMIT, RW);
    const old = m.virtualProtect(addr, 4096, MemoryProtection.PAGE_READONLY);
    expect(old).toBe(RW);
    expect(m.queryRegions()[0]!.protection).toBe(MemoryProtection.PAGE_READONLY);
  });

  it('heap allocs within the heap region and reuses freed blocks', () => {
    const m = new MemoryManagerImpl();
    const heap = m.heapCreate();
    const a = m.heapAlloc(heap, 16);
    const b = m.heapAlloc(heap, 16);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    expect(m.heapFree(heap, a)).toBe(true);
    const c = m.heapAlloc(heap, 16);
    expect(c).toBe(a);
  });

  it('heapAlloc returns 0 when the heap is exhausted', () => {
    const m = new MemoryManagerImpl();
    const heap = m.heapCreate();
    // exceed the 1MB heap (256 pages)
    const big = 2 * 1024 * 1024;
    const addr = m.heapAlloc(heap, big);
    expect(addr).toBe(0);
  });

  it('read/write across page boundaries', () => {
    const m = new MemoryManagerImpl();
    const addr = m.virtualAlloc(8192, AllocationType.MEM_RESERVE | AllocationType.MEM_COMMIT, RW);
    const data = new Uint8Array(6000).map((_, i) => i % 256);
    m.write(addr, data);
    const out = m.read(addr, 6000);
    expect(out).toEqual(data);
  });
});