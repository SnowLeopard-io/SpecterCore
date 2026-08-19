import type { DirEntry, FileOpenMode, FileStat, OpenedFile } from '@specter-core/contracts';
import { toArrayBufferView, toStorePath } from '@specter-core/shared';

/**
 * OPFS 虚拟硬盘实现（L1）。
 * 每个实例对应 OPFS 根下的一个独立目录 = 一个隔离的虚拟硬盘。
 * 使用异步 FileSystemWritableFileStream 实现随机偏移读写。
 */
export class OpfsFileStoreError extends Error {}

function assertRoot(root: FileSystemDirectoryHandle): void {
  if (!root) throw new OpfsFileStoreError('OPFS is not available in this context');
}

function splitSegments(storePath: string): string[] {
  return storePath.split('/').filter(Boolean);
}

async function resolveHandle(
  root: FileSystemDirectoryHandle,
  storePath: string,
  create: boolean,
): Promise<FileSystemFileHandle | FileSystemDirectoryHandle | null> {
  const segs = splitSegments(storePath);
  if (segs.length === 0) return root;
  let current: FileSystemDirectoryHandle = root;
  for (let i = 0; i < segs.length - 1; i++) {
    current = await current.getDirectoryHandle(segs[i]!, { create });
  }
  const last = segs[segs.length - 1]!;
  const parent = current;
  try {
    return await parent.getFileHandle(last, { create });
  } catch {
    if (create) return null;
    try {
      return await parent.getDirectoryHandle(last, { create: false });
    } catch {
      return null;
    }
  }
}

export class OpfsOpenedFile implements OpenedFile {
  constructor(
    readonly path: string,
    readonly mode: FileOpenMode,
    private readonly handle: FileSystemFileHandle,
    private readonly root: FileSystemDirectoryHandle,
  ) {}

  async read(offset: number, length: number): Promise<Uint8Array> {
    const file = await this.handle.getFile();
    const slice = file.slice(offset, offset + length);
    return new Uint8Array(await slice.arrayBuffer());
  }

  async write(offset: number, data: Uint8Array): Promise<number> {
    const writable = await this.handle.createWritable({ keepExistingData: true });
    try {
      await writable.write({ type: 'write', position: offset, data: toArrayBufferView(data) });
      await writable.close();
      return data.byteLength;
    } catch (err) {
      await writable.abort().catch(() => {});
      throw err;
    }
  }

  async truncate(size: number): Promise<void> {
    const writable = await this.handle.createWritable({ keepExistingData: true });
    try {
      await writable.write({ type: 'truncate', size });
      await writable.close();
    } catch (err) {
      await writable.abort().catch(() => {});
      throw err;
    }
  }

  async size(): Promise<number> {
    const file = await this.handle.getFile();
    return file.size;
  }

  async close(): Promise<void> {
    // 异步句柄无需主动关闭
  }
}

export class OpfsFileStore {
  readonly name: string;
  private readonly root: FileSystemDirectoryHandle;

  private constructor(root: FileSystemDirectoryHandle, name: string) {
    this.root = root;
    this.name = name;
  }

  static async create(name = 'C'): Promise<OpfsFileStore> {
    const base = await navigator.storage.getDirectory();
    const root = await base.getDirectoryHandle(name, { create: true });
    return new OpfsFileStore(root, name);
  }

  async capacity(): Promise<number> {
    const estimate = await navigator.storage.estimate();
    return estimate.quota ?? 2 * 1024 * 1024 * 1024;
  }

  async usedBytes(): Promise<number> {
    const estimate = await navigator.storage.estimate();
    return estimate.usage ?? 0;
  }

  private toStore(path: string): string {
    return toStorePath(path);
  }

  async openFile(path: string, mode: FileOpenMode): Promise<OpenedFile> {
    assertRoot(this.root);
    const store = this.toStore(path);
    // Only write-ish modes create the file; 'read' must fail on a missing
    // file instead of silently creating an empty one (which then reads as
    // "not a PE file" for a guest exe).
    const create = mode === 'write' || mode === 'readwrite' || mode === 'create' || mode === 'append';
    const handle = (await resolveHandle(this.root, store, create)) as FileSystemFileHandle | null;
    if (!handle || handle.kind !== 'file') throw new OpfsFileStoreError(`Not a file: ${path}`);
    return new OpfsOpenedFile(path, mode, handle, this.root);
  }

  async createDirectory(path: string): Promise<void> {
    assertRoot(this.root);
    const store = this.toStore(path);
    const segs = splitSegments(store);
    if (segs.length === 0) return;
    let current = this.root;
    for (const seg of segs) {
      current = await current.getDirectoryHandle(seg, { create: true });
    }
  }

  async removeDirectory(path: string): Promise<void> {
    assertRoot(this.root);
    const store = this.toStore(path);
    const parent = await this.resolveParentDir(store);
    const name = this.lastSegment(store);
    if (parent && name) await parent.removeEntry(name, { recursive: true });
  }

  async deleteFile(path: string): Promise<void> {
    assertRoot(this.root);
    const store = this.toStore(path);
    const parent = await this.resolveParentDir(store);
    const name = this.lastSegment(store);
    if (parent && name) await parent.removeEntry(name);
  }

  async listDirectory(path: string): Promise<DirEntry[]> {
    assertRoot(this.root);
    const store = this.toStore(path);
    let dir: FileSystemDirectoryHandle;
    if (store === '') {
      dir = this.root;
    } else {
      const handle = await resolveHandle(this.root, store, false);
      if (!handle || handle.kind !== 'directory') throw new OpfsFileStoreError(`Not a directory: ${path}`);
      dir = handle;
    }
    const entries: DirEntry[] = [];
    for await (const [name, child] of dir.entries()) {
      const size = child.kind === 'file' ? (await (child as FileSystemFileHandle).getFile()).size : 0;
      entries.push({ name, kind: child.kind === 'directory' ? 'directory' : 'file', size, modified: 0 });
    }
    return entries.sort((a, b) => a.name.localeCompare(b.name));
  }

  async stat(path: string): Promise<FileStat | null> {
    const store = this.toStore(path);
    if (store === '') {
      return { name: this.name, kind: 'directory', size: 0, modified: 0 };
    }
    let handle: FileSystemFileHandle | FileSystemDirectoryHandle | null;
    try {
      handle = await resolveHandle(this.root, store, false);
    } catch {
      // missing intermediate directory (or any FS error) -> "not found"
      return null;
    }
    if (!handle) return null;
    if (handle.kind === 'directory') return { name: this.lastSegment(store), kind: 'directory', size: 0, modified: 0 };
    const file = await handle.getFile();
    return { name: handle.name, kind: 'file', size: file.size, modified: file.lastModified };
  }

  async move(from: string, to: string): Promise<void> {
    const data = await this.readAll(from);
    await this.writeAll(to, data);
    await this.deleteFile(from);
  }

  async resize(_capacity: number): Promise<void> {
    // OPFS 配额由浏览器管理，容量以 estimate 为准
  }

  async format(): Promise<void> {
    for await (const [name, handle] of this.root.entries()) {
      await this.root.removeEntry(name, { recursive: handle.kind === 'directory' });
    }
  }

  private async resolveParentDir(store: string): Promise<FileSystemDirectoryHandle | null> {
    const segs = splitSegments(store);
    segs.pop();
    let current = this.root;
    for (const seg of segs) {
      try {
        current = await current.getDirectoryHandle(seg, { create: false });
      } catch {
        return null;
      }
    }
    return current;
  }

  private lastSegment(store: string): string {
    return splitSegments(store).pop() ?? '';
  }

  private async readAll(path: string): Promise<Uint8Array> {
    const store = this.toStore(path);
    const handle = (await resolveHandle(this.root, store, false)) as FileSystemFileHandle | null;
    if (!handle) throw new OpfsFileStoreError(`Not found: ${path}`);
    const file = await handle.getFile();
    return new Uint8Array(await file.arrayBuffer());
  }

  private async writeAll(path: string, data: Uint8Array): Promise<void> {
    const store = this.toStore(path);
    const handle = (await resolveHandle(this.root, store, true)) as FileSystemFileHandle | null;
    if (!handle) throw new OpfsFileStoreError(`Cannot create: ${path}`);
    const writable = await handle.createWritable();
    await writable.write(toArrayBufferView(data));
    await writable.close();
  }
}