import { describe, expect, it } from 'vitest';
import { MemoryFileStore } from './memory-store';
import { isWithin, toStorePath } from '@bk/shared';

describe('MemoryFileStore', () => {
  it('creates, reads, writes and appends files', async () => {
    const store = new MemoryFileStore('C');
    const file = await store.openFile('C:/hello.txt', 'create');
    await file.write(0, new TextEncoder().encode('hello '));
    await file.write(6, new TextEncoder().encode('world'));
    await file.close();

    const r = await store.openFile('C:/hello.txt', 'read');
    const data = await r.read(0, 100);
    expect(new TextDecoder().decode(data)).toBe('hello world');
  });

  it('writes at arbitrary offsets', async () => {
    const store = new MemoryFileStore('C');
    const file = await store.openFile('C:/a.bin', 'create');
    await file.write(10, new Uint8Array([1, 2, 3]));
    const data = await file.read(0, 20);
    expect(data.length).toBe(13);
    expect([...data.slice(10, 13)]).toEqual([1, 2, 3]);
  });

  it('directories: create, list, remove', async () => {
    const store = new MemoryFileStore('C');
    await store.createDirectory('C:/Users/Test');
    const file = await store.openFile('C:/Users/Test/a.txt', 'create');
    await file.close();

    const entries = await store.listDirectory('C:/Users');
    expect(entries.map((e) => e.name)).toEqual(['Test']);

    const inDir = await store.listDirectory('C:/Users/Test');
    expect(inDir.map((e) => e.name)).toEqual(['a.txt']);
    expect(inDir[0]!.kind).toBe('file');

    await store.deleteFile('C:/Users/Test/a.txt');
    await store.removeDirectory('C:/Users/Test');
    expect(await store.listDirectory('C:/Users')).toEqual([]);
  });

  it('rejects removing non-empty directory', async () => {
    const store = new MemoryFileStore('C');
    await store.createDirectory('C:/d');
    const f = await store.openFile('C:/d/x.txt', 'create');
    await f.close();
    await expect(store.removeDirectory('C:/d')).rejects.toThrow(/not empty/);
  });

  it('deleteFile removes and stat returns null', async () => {
    const store = new MemoryFileStore('C');
    const f = await store.openFile('C:/tmp.txt', 'create');
    await f.close();
    await store.deleteFile('C:/tmp.txt');
    expect(await store.stat('C:/tmp.txt')).toBeNull();
  });

  it('move renames files', async () => {
    const store = new MemoryFileStore('C');
    const f = await store.openFile('C:/old.txt', 'create');
    await f.write(0, new TextEncoder().encode('data'));
    await f.close();
    await store.move('C:/old.txt', 'C:/new.txt');
    expect(await store.stat('C:/old.txt')).toBeNull();
    const r = await store.openFile('C:/new.txt', 'read');
    expect(new TextDecoder().decode(await r.read(0, 100))).toBe('data');
  });

  it('tracks capacity and used bytes', async () => {
    const store = new MemoryFileStore('C', 1024);
    expect(await store.capacity()).toBe(1024);
    const f = await store.openFile('C:/x', 'create');
    await f.write(0, new Uint8Array(10));
    await f.close();
    expect(await store.usedBytes()).toBe(10);
    await expect(store.resize(5)).rejects.toThrow(/shrink/);
    await store.resize(2048);
    expect(await store.capacity()).toBe(2048);
  });

  it('format clears everything', async () => {
    const store = new MemoryFileStore('C');
    const f = await store.openFile('C:/x.txt', 'create');
    await f.close();
    await store.createDirectory('C:/d');
    await store.format();
    expect(await store.listDirectory('C:')).toEqual([]);
  });

  it('openFile missing file throws in read mode', async () => {
    const store = new MemoryFileStore('C');
    await expect(store.openFile('C:/nope.txt', 'read')).rejects.toThrow(/not found/i);
  });

  it('openFile existing file throws in create mode', async () => {
    const store = new MemoryFileStore('C');
    const f = await store.openFile('C:/x', 'create');
    await f.close();
    await expect(store.openFile('C:/x', 'create')).rejects.toThrow(/already exists/i);
  });
});

describe('path helpers used by stores', () => {
  it('toStorePath strips drive', () => {
    expect(toStorePath('C:/a/b')).toBe('a/b');
  });
  it('isWithin detects nesting', () => {
    expect(isWithin('a/b/c', 'a')).toBe(true);
    expect(isWithin('a', 'a/b')).toBe(false);
    expect(isWithin('ab/c', 'a')).toBe(false);
  });
});