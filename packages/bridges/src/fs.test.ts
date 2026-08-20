import { describe, expect, it, vi } from 'vitest';
import {
  CreationDisposition,
  DesiredAccess,
  FileAttributeFlags,
  FileMoveMethod,
  ShareMode,
  WinError as E,
} from '@specter-core/contracts';
import { MemoryFileStore } from '@specter-core/host';
import { FileSystemBridgeImpl } from './fs';

const READ = DesiredAccess.GENERIC_READ;
const WRITE = DesiredAccess.GENERIC_WRITE;
const READ_WRITE = READ | WRITE;

function makeBridge() {
  const store = new MemoryFileStore('C');
  const onError = vi.fn();
  const bridge = new FileSystemBridgeImpl(store, onError);
  return { store, bridge, onError };
}

const enc = new TextEncoder();
const dec = new TextDecoder();

describe('FileSystemBridgeImpl - CreateFile', () => {
  it('CREATE_NEW creates a file', async () => {
    const { bridge } = makeBridge();
    const r = await bridge.createFile('C:/new.txt', READ_WRITE, ShareMode.FILE_SHARE_READ, CreationDisposition.CREATE_NEW);
    expect(r.error).toBe(E.NO_ERROR);
    expect(r.handle).toBeGreaterThan(0);
    const st = await bridge.getFileAttributes('C:/new.txt');
    expect(st.error).toBe(E.NO_ERROR);
  });

  it('CREATE_NEW fails when file exists', async () => {
    const { bridge } = makeBridge();
    await bridge.createFile('C:/x.txt', READ_WRITE, 0, CreationDisposition.CREATE_NEW);
    const r = await bridge.createFile('C:/x.txt', READ_WRITE, 0, CreationDisposition.CREATE_NEW);
    expect(r.error).toBe(E.ERROR_FILE_EXISTS);
    expect(r.handle).toBe(0);
  });

  it('OPEN_EXISTING fails when missing', async () => {
    const { bridge } = makeBridge();
    const r = await bridge.createFile('C:/missing.txt', READ, 0, CreationDisposition.OPEN_EXISTING);
    expect(r.error).toBe(E.ERROR_FILE_NOT_FOUND);
  });

  it('OPEN_ALWAYS creates when missing and opens when present', async () => {
    const { bridge } = makeBridge();
    const r1 = await bridge.createFile('C:/a.txt', READ_WRITE, 0, CreationDisposition.OPEN_ALWAYS);
    expect(r1.error).toBe(E.NO_ERROR);
    const r2 = await bridge.createFile('C:/a.txt', READ_WRITE, 0, CreationDisposition.OPEN_ALWAYS);
    expect(r2.error).toBe(E.NO_ERROR);
  });

  it('TRUNCATE_EXISTING empties existing file', async () => {
    const { bridge } = makeBridge();
    const h1 = (await bridge.createFile('C:/t.txt', READ_WRITE, 0, CreationDisposition.CREATE_ALWAYS)).handle;
    await bridge.writeFile(h1, enc.encode('long content'));
    const h2 = (await bridge.createFile('C:/t.txt', READ_WRITE, 0, CreationDisposition.TRUNCATE_EXISTING)).handle;
    const size = await bridge.getFileSize(h2);
    expect(size).toBe(0);
  });

  it('share mode violation returns ERROR_SHARING_VIOLATION', async () => {
    const { bridge } = makeBridge();
    await bridge.createFile('C:/s.txt', READ_WRITE, 0, CreationDisposition.CREATE_ALWAYS);
    const r = await bridge.createFile('C:/s.txt', READ, 0, CreationDisposition.OPEN_EXISTING);
    expect(r.error).toBe(E.ERROR_SHARING_VIOLATION);
  });
});

describe('FileSystemBridgeImpl - read/write/seek', () => {
  it('writes and reads back with pointer advancement', async () => {
    const { bridge } = makeBridge();
    const h = (await bridge.createFile('C:/data.bin', READ_WRITE, 0, CreationDisposition.CREATE_ALWAYS)).handle;
    const w = await bridge.writeFile(h, enc.encode('hello world'));
    expect(w.bytesWritten).toBe(11);
    expect(bridge.getFilePointer(h)).toBe(11);

    await bridge.setFilePointer(h, 0, FileMoveMethod.FILE_BEGIN);
    const r = await bridge.readFile(h, 11);
    expect(r.bytesRead).toBe(11);
    expect(dec.decode(r.data)).toBe('hello world');
  });

  it('setFilePointer supports BEGIN/CURRENT/END', async () => {
    const { bridge } = makeBridge();
    const h = (await bridge.createFile('C:/p.txt', READ_WRITE, 0, CreationDisposition.CREATE_ALWAYS)).handle;
    await bridge.writeFile(h, enc.encode('0123456789'));
    await bridge.setFilePointer(h, 4, FileMoveMethod.FILE_BEGIN);
    expect(bridge.getFilePointer(h)).toBe(4);
    await bridge.setFilePointer(h, 2, FileMoveMethod.FILE_CURRENT);
    expect(bridge.getFilePointer(h)).toBe(6);
    await bridge.setFilePointer(h, -3, FileMoveMethod.FILE_END);
    expect(bridge.getFilePointer(h)).toBe(7);
  });

  it('negative seek is rejected', async () => {
    const { bridge } = makeBridge();
    const h = (await bridge.createFile('C:/p.txt', READ_WRITE, 0, CreationDisposition.CREATE_ALWAYS)).handle;
    const r = await bridge.setFilePointer(h, -1, FileMoveMethod.FILE_BEGIN);
    expect(r.error).toBe(E.ERROR_INVALID_PARAMETER);
  });

  it('returns invalid handle for unknown handle', async () => {
    const { bridge } = makeBridge();
    const r = await bridge.readFile(9999, 10);
    expect(r.error).toBe(E.ERROR_INVALID_HANDLE);
    const w = await bridge.writeFile(9999, new Uint8Array(1));
    expect(w.error).toBe(E.ERROR_INVALID_HANDLE);
  });

  it('overlapped filePointer does not move the handle pointer', async () => {
    const { bridge } = makeBridge();
    const h = (await bridge.createFile('C:/o.txt', READ_WRITE, 0, CreationDisposition.CREATE_ALWAYS)).handle;
    await bridge.writeFile(h, enc.encode('abcdef'));
    await bridge.writeFile(h, enc.encode('XY'), 1);
    expect(bridge.getFilePointer(h)).toBe(6);
    await bridge.setFilePointer(h, 0, FileMoveMethod.FILE_BEGIN);
    const r = await bridge.readFile(h, 6, 0);
    expect(dec.decode(r.data)).toBe('aXYdef');
    expect(bridge.getFilePointer(h)).toBe(0);
  });

  it('closeHandle releases the handle', async () => {
    const { bridge } = makeBridge();
    const h = (await bridge.createFile('C:/c.txt', READ, 0, CreationDisposition.CREATE_ALWAYS)).handle;
    expect(await bridge.closeHandle(h)).toBe(E.NO_ERROR);
    const r = await bridge.readFile(h, 1);
    expect(r.error).toBe(E.ERROR_INVALID_HANDLE);
  });
});

describe('FileSystemBridgeImpl - find', () => {
  it('findFirstFile/findNextFile with wildcards', async () => {
    const { bridge } = makeBridge();
    await bridge.createDirectory('C:/dir');
    for (const name of ['a.txt', 'b.txt', 'c.md']) {
      const h = (await bridge.createFile(`C:/dir/${name}`, READ_WRITE, 0, CreationDisposition.CREATE_ALWAYS)).handle;
      await bridge.closeHandle(h);
    }
    const first = await bridge.findFirstFile('C:/dir', '*');
    expect(first.error).toBe(E.NO_ERROR);
    expect(first.entries[0]?.name).toBe('a.txt');

    const all = [first.entries[0]!.name];
    for (let i = 0; i < 5; i++) {
      const next = await bridge.findNextFile(first.searchHandle);
      if (next.error === E.ERROR_NO_MORE_FILES) break;
      all.push(next.entries[0]!.name);
    }
    expect(all).toEqual(['a.txt', 'b.txt', 'c.md']);

    const txt = await bridge.findFirstFile('C:/dir', '*.txt');
    expect(txt.entries.map((e) => e.name)).toEqual(['a.txt']);
    await bridge.findClose(txt.searchHandle);
    await bridge.findClose(first.searchHandle);
  });
});

describe('FileSystemBridgeImpl - onChange notifications', () => {
  it('notifies created/modified/deleted/moved with store paths', async () => {
    const { bridge } = makeBridge();
    const changes: Array<{ path: string; kind: string; to?: string }> = [];
    bridge.onChange((c) => changes.push(c));
    // Directories first: the store refuses to create a subdir under a dir that
    // already contains files (assertNoAncestorFile). Clear dir notifications.
    await bridge.createDirectory('C:/Desktop');
    await bridge.createDirectory('C:/Desktop/sub');
    changes.length = 0;

    const h = (await bridge.createFile('C:/Desktop/a.txt', READ_WRITE, 0, CreationDisposition.CREATE_NEW)).handle;
    expect(changes).toEqual([{ path: 'Desktop/a.txt', kind: 'created' }]);

    await bridge.writeFile(h, enc.encode('hello'));
    expect(changes[1]).toEqual({ path: 'Desktop/a.txt', kind: 'modified' });

    await bridge.setEndOfFile(h);
    expect(changes[2]).toEqual({ path: 'Desktop/a.txt', kind: 'modified' });
    await bridge.closeHandle(h);

    expect(await bridge.moveFile('C:/Desktop/a.txt', 'C:/Desktop/sub/a.txt', false)).toBe(E.NO_ERROR);
    expect(changes[3]).toEqual({ path: 'Desktop/a.txt', kind: 'moved', to: 'Desktop/sub/a.txt' });

    expect(await bridge.deleteFile('C:/Desktop/sub/a.txt')).toBe(E.NO_ERROR);
    expect(changes[4]).toEqual({ path: 'Desktop/sub/a.txt', kind: 'deleted' });
  });

  it('unsubscribes via the returned dispose fn', async () => {
    const { bridge } = makeBridge();
    const seen: string[] = [];
    const dispose = bridge.onChange((c) => seen.push(c.kind));
    dispose();
    await bridge.createFile('C:/x.txt', READ_WRITE, 0, CreationDisposition.CREATE_NEW);
    expect(seen).toEqual([]);
  });
});

describe('FileSystemBridgeImpl - directories, attributes, move, lock', () => {
  it('create/remove directory', async () => {
    const { bridge } = makeBridge();
    expect(await bridge.createDirectory('C:/my/dir')).toBe(E.NO_ERROR);
    expect(await bridge.removeDirectory('C:/my/dir')).toBe(E.NO_ERROR);
    expect(await bridge.removeDirectory('C:/my/dir')).toBe(E.ERROR_FILE_NOT_FOUND);
  });

  it('get/set file attributes', async () => {
    const { bridge } = makeBridge();
    const h = (await bridge.createFile('C:/attr.txt', READ_WRITE, 0, CreationDisposition.CREATE_ALWAYS)).handle;
    await bridge.closeHandle(h);
    const before = await bridge.getFileAttributes('C:/attr.txt');
    expect(before.attributes & FileAttributeFlags.FILE_ATTRIBUTE_NORMAL).toBeTruthy();
    await bridge.setFileAttributes('C:/attr.txt', FileAttributeFlags.FILE_ATTRIBUTE_READONLY | FileAttributeFlags.FILE_ATTRIBUTE_HIDDEN);
    const after = await bridge.getFileAttributes('C:/attr.txt');
    expect(after.attributes & FileAttributeFlags.FILE_ATTRIBUTE_READONLY).toBeTruthy();
    expect(after.attributes & FileAttributeFlags.FILE_ATTRIBUTE_HIDDEN).toBeTruthy();
  });

  it('moveFile respects replaceExisting', async () => {
    const { bridge } = makeBridge();
    const h = (await bridge.createFile('C:/src.txt', READ_WRITE, 0, CreationDisposition.CREATE_ALWAYS)).handle;
    await bridge.writeFile(h, enc.encode('src'));
    await bridge.closeHandle(h);
    const h2 = (await bridge.createFile('C:/dst.txt', READ_WRITE, 0, CreationDisposition.CREATE_ALWAYS)).handle;
    await bridge.closeHandle(h2);

    expect(await bridge.moveFile('C:/src.txt', 'C:/dst.txt', false)).toBe(E.ERROR_FILE_EXISTS);
    expect(await bridge.moveFile('C:/src.txt', 'C:/dst.txt', true)).toBe(E.NO_ERROR);
    const r = await bridge.getFileAttributes('C:/src.txt');
    expect(r.error).toBe(E.ERROR_FILE_NOT_FOUND);
  });

  it('lock/unlock file', async () => {
    const { bridge } = makeBridge();
    const h = (await bridge.createFile('C:/lock.txt', READ_WRITE, 0, CreationDisposition.CREATE_ALWAYS)).handle;
    expect(await bridge.lockFile(h, true, 0)).toBe(E.NO_ERROR);
    expect(await bridge.lockFile(h, true, 0)).toBe(E.ERROR_LOCK_VIOLATION);
    expect(await bridge.unlockFile(h)).toBe(E.NO_ERROR);
    expect(await bridge.lockFile(h, false, 0)).toBe(E.NO_ERROR);
    expect(await bridge.unlockFile(h)).toBe(E.NO_ERROR);
  });

  it('releaseAll closes every handle and reports errors via callback', async () => {
    const { bridge, onError } = makeBridge();
    await bridge.createFile('C:/a.txt', READ, 0, CreationDisposition.CREATE_ALWAYS);
    await bridge.createFile('C:/b.txt', READ, 0, CreationDisposition.CREATE_ALWAYS);
    await bridge.releaseAll();
    // trigger a missing file to exercise the error callback
    const r = await bridge.createFile('C:/nope.txt', READ, 0, CreationDisposition.OPEN_EXISTING);
    expect(r.error).toBe(E.ERROR_FILE_NOT_FOUND);
    expect(onError).toHaveBeenCalled();
  });
});