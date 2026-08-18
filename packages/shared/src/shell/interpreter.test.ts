import { describe, expect, it } from 'vitest';
import type { DirEntry, FileOpenMode, FileStore, OpenedFile } from '@bk/contracts';
import { CommandInterpreter } from './interpreter';

/** Minimal in-memory FileStore used to drive the interpreter in isolation. */
class MemFile implements OpenedFile {
  constructor(
    readonly path: string,
    readonly mode: FileOpenMode,
    private buf: Uint8Array,
    private readonly onWrite: (buf: Uint8Array) => void,
  ) {}
  async read(offset: number, length: number): Promise<Uint8Array> {
    return this.buf.slice(offset, offset + length);
  }
  async write(offset: number, data: Uint8Array): Promise<number> {
    const next = new Uint8Array(Math.max(this.buf.byteLength, offset + data.byteLength));
    next.set(this.buf);
    next.set(data, offset);
    this.buf = next;
    this.onWrite(next);
    return data.byteLength;
  }
  async truncate(size: number): Promise<void> {
    this.buf = this.buf.slice(0, size);
    this.onWrite(this.buf);
  }
  async size(): Promise<number> {
    return this.buf.byteLength;
  }
  async close(): Promise<void> {}
}

class MemStore implements FileStore {
  readonly name = 'C';
  private files = new Map<string, Uint8Array>();
  private dirs = new Set<string>(['']);
  async capacity(): Promise<number> {
    return 1 << 30;
  }
  async usedBytes(): Promise<number> {
    let n = 0;
    for (const v of this.files.values()) n += v.byteLength;
    return n;
  }
  private ensureParent(p: string): void {
    const segs = p.split('/').filter(Boolean);
    let acc = '';
    for (const s of segs.slice(0, -1)) {
      acc = acc === '' ? s : `${acc}/${s}`;
      this.dirs.add(acc);
    }
  }
  async openFile(path: string, mode: FileOpenMode): Promise<OpenedFile> {
    let buf = this.files.get(path);
    if (mode === 'create') {
      if (buf === undefined) {
        buf = new Uint8Array(0);
        this.files.set(path, buf);
      }
    } else if (buf === undefined) {
      throw new Error(`File not found: ${path}`);
    }
    return new MemFile(path, mode, buf, (b) => this.files.set(path, b));
  }
  async createDirectory(path: string): Promise<void> {
    this.dirs.add(path);
    this.ensureParent(path);
  }
  async removeDirectory(path: string): Promise<void> {
    this.dirs.delete(path);
  }
  async deleteFile(path: string): Promise<void> {
    this.files.delete(path);
  }
  async listDirectory(path: string): Promise<DirEntry[]> {
    const prefix = path === '' ? '' : `${path}/`;
    const out: DirEntry[] = [];
    for (const d of this.dirs) {
      if (d === path) continue;
      if (d.startsWith(prefix)) {
        const rest = d.slice(prefix.length);
        if (!rest.includes('/')) out.push({ name: rest, kind: 'directory', size: 0, modified: 0 });
      }
    }
    for (const f of this.files.keys()) {
      if (f.startsWith(prefix)) {
        const rest = f.slice(prefix.length);
        if (!rest.includes('/')) out.push({ name: rest, kind: 'file', size: this.files.get(f)!.byteLength, modified: 0 });
      }
    }
    return out;
  }
  async stat(path: string): Promise<DirEntry | null> {
    if (this.dirs.has(path)) return { name: path, kind: 'directory', size: 0, modified: 0 };
    if (this.files.has(path)) return { name: path, kind: 'file', size: this.files.get(path)!.byteLength, modified: 0 };
    return null;
  }
  async move(_from: string, _to: string): Promise<void> {}
  async resize(_capacity: number): Promise<void> {}
  async format(): Promise<void> {
    this.files.clear();
    this.dirs = new Set(['']);
  }
}

async function run(cmds: string[]): Promise<string[]> {
  const fs = new MemStore();
  const interp = new CommandInterpreter(fs);
  const all: string[] = [];
  for (const c of cmds) {
    const r = await interp.execute(c);
    all.push(...r.lines);
  }
  return all;
}

describe('CommandInterpreter', () => {
  it('reports its banner', () => {
    const interp = new CommandInterpreter(new MemStore());
    expect(interp.banner[0]).toContain('Microsoft Windows');
  });

  it('creates and lists directories with dir', async () => {
    const out = await run(['md Projects', 'cd Projects', 'md src', 'dir', 'cd ..', 'dir']);
    expect(out.some((l) => l.includes('Projects'))).toBe(true);
    expect(out.some((l) => l.includes('<DIR>'))).toBe(true);
  });

  it('echoes text', async () => {
    const out = await run(['echo hello world']);
    expect(out).toContain('hello world');
  });

  it('types a file (uppercase command alias)', async () => {
    const fs = new MemStore();
    const interp = new CommandInterpreter(fs);
    const f = await fs.openFile('readme.txt', 'create');
    await f.write(0, new TextEncoder().encode('line one\nline two'));
    await f.close();
    const r = await interp.execute('TYPE readme.txt');
    expect(r.lines.join('\n')).toContain('line one');
  });

  it('returns clearScreen for cls', async () => {
    const interp = new CommandInterpreter(new MemStore());
    const r = await interp.execute('cls');
    expect(r.clearScreen).toBe(true);
    expect(r.lines).toEqual([]);
  });

  it('rejects unknown commands', async () => {
    const out = await run(['frobnicate']);
    expect(out.some((l) => l.includes('not recognized'))).toBe(true);
  });
});
