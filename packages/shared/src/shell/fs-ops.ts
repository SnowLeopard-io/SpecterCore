/**
 * Recursive file operations over FileStore: copy / delete / move.
 *
 * The base FileStore.move() only handles single files (both the memory
 * and OPFS implementations), so directory moves go through
 * copyRecursive + deleteRecursive. copyRecursive handles both files and
 * directory trees, so the same helper backs Copy and "Move into a new
 * directory" in the UI.
 */
import type { DirEntry, FileStore } from '@specter-core/contracts';

export async function copyRecursive(fs: FileStore, src: string, dst: string): Promise<void> {
  const st = await fs.stat(src);
  if (!st) throw new Error(`Source not found: ${src}`);
  if (st.kind === 'directory') {
    await fs.createDirectory(dst);
    const list = await fs.listDirectory(src);
    for (const entry of list) {
      await copyRecursive(fs, `${src}/${entry.name}`, `${dst}/${entry.name}`);
    }
    return;
  }
  const f = await fs.openFile(src, 'read');
  let data: Uint8Array;
  try {
    const size = await f.size();
    data = await f.read(0, size);
  } finally {
    await f.close();
  }
  const out = await fs.openFile(dst, 'create');
  try {
    await out.write(0, data);
  } finally {
    await out.close();
  }
}

export async function deleteRecursive(fs: FileStore, path: string): Promise<void> {
  const st = await fs.stat(path);
  if (!st) return;
  if (st.kind === 'directory') {
    const list = await fs.listDirectory(path);
    for (const entry of list) {
      await deleteRecursive(fs, `${path}/${entry.name}`);
    }
    await fs.removeDirectory(path);
  } else {
    await fs.deleteFile(path);
  }
}

export async function moveRecursive(fs: FileStore, from: string, to: string): Promise<void> {
  const st = await fs.stat(from);
  if (!st) throw new Error(`Source not found: ${from}`);
  if (st.kind === 'file') {
    await fs.move(from, to);
    return;
  }
  await copyRecursive(fs, from, to);
  await deleteRecursive(fs, from);
}

/** Pick a non-conflicting name within `entries`: "x.txt" -> "x (2).txt" -> "x (3).txt". */
export function uniqueName(base: string, entries: DirEntry[]): string {
  const existing = new Set(entries.map((e) => e.name));
  if (!existing.has(base)) return base;
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  let n = 2;
  while (existing.has(`${stem} (${n})${ext}`)) n += 1;
  return `${stem} (${n})${ext}`;
}
