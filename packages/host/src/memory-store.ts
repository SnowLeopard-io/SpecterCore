import type { DirEntry, FileOpenMode, FileStat, FileStore, OpenedFile } from '@specter-core/contracts';
import { isWithin, toStorePath } from '@specter-core/shared';

/**
 * 内存虚拟硬盘：OPFS 的测试/Node 等价适配器。
 * 验证 Ports & Adapters 模式：FileStore 契约换实现，上层（FS 桥接）零改动。
 */
export class MemoryFileStore implements FileStore {
  readonly name: string;
  private readonly files = new Map<string, Uint8Array>();
  private readonly dirs = new Set<string>();
  private capacityBytes: number;

  constructor(name = 'memory', capacity = 2 * 1024 * 1024 * 1024) {
    this.name = name;
    this.capacityBytes = capacity;
    this.dirs.add('');
  }

  private normalize(storePath: string): string {
    const p = storePath.replace(/\/+$/, '');
    return p === '/' ? '' : p;
  }

  private parent(storePath: string): string {
    const idx = storePath.lastIndexOf('/');
    return idx === -1 ? '' : storePath.slice(0, idx);
  }

  private assertDirExists(dir: string): void {
    if (!this.dirs.has(this.normalize(dir))) {
      throw new Error(`Directory not found: ${dir}`);
    }
  }

  private assertNoAncestorFile(dir: string): void {
    const norm = this.normalize(dir);
    for (const file of this.files.keys()) {
      if (isWithin(file, norm)) throw new Error(`Path conflict: ${dir}`);
    }
  }

  async capacity(): Promise<number> {
    return this.capacityBytes;
  }

  async usedBytes(): Promise<number> {
    let total = 0;
    for (const data of this.files.values()) total += data.byteLength;
    return total;
  }

  async openFile(path: string, mode: FileOpenMode): Promise<OpenedFile> {
    const p = this.normalize(toStorePath(path));
    const dir = this.parent(p);
    this.assertDirExists(dir);

    if (mode === 'create') {
      if (this.files.has(p)) throw new Error(`File already exists: ${path}`);
      this.files.set(p, new Uint8Array(0));
    } else if (!this.files.has(p)) {
      throw new Error(`File not found: ${path}`);
    }
    if (mode === 'append') {
      this.files.set(p, this.files.get(p)!);
    }

    return {
      path,
      mode,
      read: async (offset, length) => {
        const data = this.files.get(p);
        if (!data) throw new Error(`File not found: ${path}`);
        return data.slice(offset, offset + length);
      },
      write: async (offset, data) => {
        const existing = this.files.get(p) ?? new Uint8Array(0);
        const maxLen = Math.max(existing.byteLength, offset + data.byteLength);
        const next = new Uint8Array(maxLen);
        next.set(existing);
        next.set(data, offset);
        this.files.set(p, next);
        return data.byteLength;
      },
      truncate: async (size) => {
        const existing = this.files.get(p) ?? new Uint8Array(0);
        this.files.set(p, existing.slice(0, Math.max(0, size)));
      },
      size: async () => this.files.get(p)?.byteLength ?? 0,
      close: async () => {},
    };
  }

  async createDirectory(path: string): Promise<void> {
    const p = this.normalize(toStorePath(path));
    const segments = p.split('/').filter((seg) => seg.length > 0);
    let current = '';
    for (const segment of segments) {
      current = current === '' ? segment : `${current}/${segment}`;
      this.assertNoAncestorFile(current);
      this.dirs.add(current);
    }
  }

  async removeDirectory(path: string): Promise<void> {
    const p = this.normalize(toStorePath(path));
    if (!this.dirs.has(p)) throw new Error(`Directory not found: ${path}`);
    for (const dir of this.dirs) {
      if (dir !== p && (dir === p || dir.startsWith(p + '/'))) {
        throw new Error(`Directory not empty: ${path}`);
      }
    }
    for (const file of this.files.keys()) {
      if (file.startsWith(p + '/')) throw new Error(`Directory not empty: ${path}`);
    }
    this.dirs.delete(p);
  }

  async deleteFile(path: string): Promise<void> {
    const p = this.normalize(toStorePath(path));
    if (!this.files.has(p)) throw new Error(`File not found: ${path}`);
    this.files.delete(p);
  }

  async listDirectory(path: string): Promise<DirEntry[]> {
    const p = this.normalize(toStorePath(path));
    this.assertDirExists(p);
    const entries = new Map<string, DirEntry>();
    const prefix = p === '' ? '' : p + '/';
    for (const dir of this.dirs) {
      if (dir === p) continue;
      if (dir.startsWith(prefix)) {
        const rest = dir.slice(prefix.length);
        const name = rest.split('/')[0]!;
        if (name && !entries.has(name)) entries.set(name, { name, kind: 'directory', size: 0, modified: 0 });
      }
    }
    for (const file of this.files.keys()) {
      if (file.startsWith(prefix)) {
        const rest = file.slice(prefix.length);
        const name = rest.split('/')[0]!;
        if (name && !entries.has(name)) {
          const data = this.files.get(file)!;
          entries.set(name, { name, kind: 'file', size: data.byteLength, modified: 0 });
        }
      }
    }
    return [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async stat(path: string): Promise<FileStat | null> {
    const p = this.normalize(toStorePath(path));
    if (this.files.has(p)) {
      const data = this.files.get(p)!;
      return { name: p.split('/').pop() ?? p, kind: 'file', size: data.byteLength, modified: 0 };
    }
    if (this.dirs.has(p)) {
      return { name: p.split('/').pop() ?? this.name, kind: 'directory', size: 0, modified: 0 };
    }
    return null;
  }

  async move(from: string, to: string): Promise<void> {
    const f = this.normalize(toStorePath(from));
    const t = this.normalize(toStorePath(to));
    const data = this.files.get(f);
    if (!data) throw new Error(`File not found: ${from}`);
    if (this.dirs.has(t)) {
      this.files.set(this.normalize(t + '/' + f.split('/').pop()!), data);
    } else {
      this.files.set(t, data);
    }
    this.files.delete(f);
  }

  async resize(capacity: number): Promise<void> {
    if (capacity < this.capacityBytes) {
      const used = await this.usedBytes();
      if (used > capacity) throw new Error('Cannot shrink below used bytes');
    }
    this.capacityBytes = capacity;
  }

  async format(): Promise<void> {
    this.files.clear();
    this.dirs.clear();
    this.dirs.add('');
  }
}