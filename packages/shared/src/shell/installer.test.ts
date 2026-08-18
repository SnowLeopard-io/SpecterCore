import { describe, expect, it } from 'vitest';
import type { DirEntry, FileOpenMode, FileStat, FileStore, OpenedFile } from '@bk/contracts';
import {
  PROGRAM_FILES,
  REGISTRY_PATH,
  installPackage,
  isInstalled,
  listInstalledApps,
  loadPackageFile,
  uninstallPackage,
} from './installer';

/** 极简内存 FileStore：仅覆盖安装管道所需语义（独立于 @bk/host 的实现）。 */
class FakeStore implements FileStore {
  readonly name = 'fake';
  private readonly files = new Map<string, Uint8Array>();
  private readonly dirs = new Set<string>(['']);

  private parent(p: string): string {
    const idx = p.lastIndexOf('/');
    return idx === -1 ? '' : p.slice(0, idx);
  }

  private assertDir(dir: string): void {
    if (!this.dirs.has(dir)) throw new Error(`Directory not found: ${dir}`);
  }

  async capacity(): Promise<number> {
    return 1024 * 1024 * 1024;
  }
  async usedBytes(): Promise<number> {
    let total = 0;
    for (const d of this.files.values()) total += d.byteLength;
    return total;
  }

  async openFile(path: string, mode: FileOpenMode): Promise<OpenedFile> {
    this.assertDir(this.parent(path));
    if (mode === 'create') {
      if (this.files.has(path)) throw new Error(`File already exists: ${path}`);
      this.files.set(path, new Uint8Array(0));
    } else if (!this.files.has(path)) {
      throw new Error(`File not found: ${path}`);
    }
    return {
      path,
      mode,
      read: async (offset, length) => this.files.get(path)!.slice(offset, offset + length),
      write: async (offset, data) => {
        const existing = this.files.get(path) ?? new Uint8Array(0);
        const next = new Uint8Array(Math.max(existing.byteLength, offset + data.byteLength));
        next.set(existing);
        next.set(data, offset);
        this.files.set(path, next);
        return data.byteLength;
      },
      truncate: async (size) => {
        this.files.set(path, this.files.get(path)!.slice(0, Math.max(0, size)));
      },
      size: async () => this.files.get(path)?.byteLength ?? 0,
      close: async () => {},
    };
  }

  async createDirectory(path: string): Promise<void> {
    const segs = path.split('/').filter(Boolean);
    let cur = '';
    for (const seg of segs) {
      cur = cur === '' ? seg : `${cur}/${seg}`;
      this.dirs.add(cur);
    }
  }

  async removeDirectory(path: string): Promise<void> {
    for (const dir of [...this.dirs]) {
      if (dir === path || dir.startsWith(path + '/')) this.dirs.delete(dir);
    }
    for (const file of [...this.files.keys()]) {
      if (file.startsWith(path + '/')) this.files.delete(file);
    }
    this.dirs.delete(path);
  }

  async deleteFile(path: string): Promise<void> {
    this.files.delete(path);
  }

  async listDirectory(path: string): Promise<DirEntry[]> {
    this.assertDir(path);
    const entries = new Map<string, DirEntry>();
    const prefix = path === '' ? '' : path + '/';
    for (const dir of this.dirs) {
      if (dir === path) continue;
      if (dir.startsWith(prefix)) {
        const name = dir.slice(prefix.length).split('/')[0]!;
        if (name) entries.set(name, { name, kind: 'directory', size: 0, modified: 0 });
      }
    }
    for (const file of this.files.keys()) {
      if (file.startsWith(prefix)) {
        const name = file.slice(prefix.length).split('/')[0]!;
        if (name && !entries.has(name)) {
          entries.set(name, { name, kind: 'file', size: this.files.get(file)!.byteLength, modified: 0 });
        }
      }
    }
    return [...entries.values()];
  }

  async stat(path: string): Promise<FileStat | null> {
    if (this.files.has(path)) {
      return { name: path.split('/').pop()!, kind: 'file', size: this.files.get(path)!.byteLength, modified: 0 };
    }
    if (this.dirs.has(path)) {
      return { name: path.split('/').pop() ?? this.name, kind: 'directory', size: 0, modified: 0 };
    }
    return null;
  }

  async move(from: string, to: string): Promise<void> {
    const data = this.files.get(from);
    if (!data) throw new Error(`File not found: ${from}`);
    this.files.set(to, data);
    this.files.delete(from);
  }
  async resize(): Promise<void> {}
  async format(): Promise<void> {
    this.files.clear();
    this.dirs.clear();
    this.dirs.add('');
  }
}

function makePkg(overrides: Partial<Parameters<typeof installPackage>[1]> = {}): Parameters<typeof installPackage>[1] {
  return {
    packageId: 'hello-world',
    name: 'Hello World',
    version: '1.0.0',
    icon: 'H',
    description: 'sample',
    entryAppId: 'installed:hello-world',
    entryTitle: 'Hello World',
    entryWidth: 380,
    entryHeight: 260,
    files: [{ path: 'README.txt', data: new TextEncoder().encode('hello from disk') }],
    ...overrides,
  };
}

describe('installer core', () => {
  it('installs files into Program Files and writes the registry', async () => {
    const fs = new FakeStore();
    const rec = await installPackage(fs, makePkg());

    expect(rec.installDir).toBe(`${PROGRAM_FILES}/hello-world`);
    expect(rec.installedAt).toBeGreaterThan(0);

    const installed = await listInstalledApps(fs);
    expect(installed).toHaveLength(1);
    expect(installed[0]!.name).toBe('Hello World');

    // 包文件确实在安装目录里
    const dir = await fs.listDirectory(`${PROGRAM_FILES}/hello-world`);
    expect(dir.map((e) => e.name)).toContain('README.txt');
    const readme = await fs.openFile(`${PROGRAM_FILES}/hello-world/README.txt`, 'read');
    const size = await readme.size();
    const data = await readme.read(0, size);
    await readme.close();
    expect(new TextDecoder().decode(data)).toBe('hello from disk');

    // 注册表文件存在
    expect(await fs.stat(REGISTRY_PATH)).not.toBeNull();
  });

  it('reinstalling the same id upgrades the registry record', async () => {
    const fs = new FakeStore();
    await installPackage(fs, makePkg());
    await installPackage(fs, makePkg({ version: '2.0.0', files: [] }));

    const installed = await listInstalledApps(fs);
    expect(installed).toHaveLength(1);
    expect(installed[0]!.version).toBe('2.0.0');
  });

  it('uninstall removes files and the registry entry', async () => {
    const fs = new FakeStore();
    await installPackage(fs, makePkg());
    expect(await isInstalled(fs, 'hello-world')).toBe(true);

    await uninstallPackage(fs, 'hello-world');
    expect(await isInstalled(fs, 'hello-world')).toBe(false);
    expect(await fs.stat(`${PROGRAM_FILES}/hello-world`)).toBeNull();
    expect(await listInstalledApps(fs)).toHaveLength(0);
  });

  it('loadPackageFile decodes base64 file payloads', async () => {
    const fs = new FakeStore();
    const b64 = btoa('hi');
    await fs.createDirectory('');
    const manifest = {
      packageId: 'x',
      name: 'X',
      version: '1',
      icon: 'x',
      description: 'd',
      entryAppId: 'installed:x',
      entryTitle: 'X',
      entryWidth: 200,
      entryHeight: 100,
      files: [{ path: 'a.txt', data: b64 }],
    };
    await fs.createDirectory('pkg');
    const f = await fs.openFile('pkg/app.bkapp', 'create');
    await f.write(0, new TextEncoder().encode(JSON.stringify(manifest)));
    await f.close();

    const pkg = await loadPackageFile(fs, 'pkg/app.bkapp');
    expect(pkg.files[0]!.path).toBe('a.txt');
    expect(new TextDecoder().decode(pkg.files[0]!.data)).toBe('hi');
  });

  it('returns empty list when the registry is missing', async () => {
    expect(await listInstalledApps(new FakeStore())).toEqual([]);
  });
});
