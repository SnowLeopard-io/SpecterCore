import type { FileStore } from '@specter-core/contracts';

/**
 * 文件拖入浏览器 → 虚拟磁盘导入。
 * 从 DataTransfer 递归读取（webkitGetAsEntry，支持整目录拖入），
 * 把真实文件字节写入虚拟 C: 盘，保留相对路径。
 */

export interface ImportedFile {
  /** 目标 store 路径（相对 destDir），如 "docs/report.txt"。 */
  path: string;
  file: File;
}

export interface ImportResult {
  total: number;
  imported: number;
  skipped: string[];
}

function join(base: string, name: string): string {
  return base === '' ? name : `${base}/${name}`;
}

/** 清理名称：去掉盘符/绝对路径前缀，替换 Windows 非法字符。 */
export function sanitizeName(name: string): string {
  let n = name.replace(/^[A-Za-z]:[\\/]/, '').replace(/\\/g, '/');
  n = n.replace(/[/:*?"<>|]/g, '_').replace(/^\/+/, '').replace(/\/+$/, '');
  return n;
}

async function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  const out: FileSystemEntry[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (batch.length === 0) return out;
    out.push(...batch);
  }
}

async function walkEntry(entry: FileSystemEntry, base: string, out: ImportedFile[]): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
    out.push({ path: join(base, sanitizeName(entry.name)), file });
  } else if (entry.isDirectory) {
    const children = await readAllEntries((entry as FileSystemDirectoryEntry).createReader());
    for (const child of children) {
      await walkEntry(child, join(base, sanitizeName(entry.name)), out);
    }
  }
}

/** 收集拖入的文件（保留目录结构）。现代浏览器优先，旧浏览器回退到扁平文件。 */
export async function collectDropFiles(dt: DataTransfer): Promise<ImportedFile[]> {
  const items = Array.from(dt.items ?? []);
  const entries = items
    .map((item) => item.webkitGetAsEntry?.() ?? null)
    .filter((entry): entry is FileSystemEntry => entry !== null);
  if (entries.length > 0) {
    const out: ImportedFile[] = [];
    for (const entry of entries) await walkEntry(entry, '', out);
    return out;
  }
  return Array.from(dt.files ?? []).map((file) => ({ path: sanitizeName(file.name), file }));
}

/** 把收集到的文件写入虚拟盘目标目录下。 */
export async function importFiles(fs: FileStore, files: ImportedFile[], destDir = ''): Promise<ImportResult> {
  const skipped: string[] = [];
  for (const item of files) {
    const target = join(destDir, item.path);
    try {
      const parent = target.split('/').filter(Boolean).slice(0, -1).join('/');
      if (parent) await fs.createDirectory(parent).catch(() => {});
      const data = new Uint8Array(await item.file.arrayBuffer());
      let handle;
      try {
        handle = await fs.openFile(target, 'create');
      } catch {
        handle = await fs.openFile(target, 'write');
      }
      try {
        await handle.write(0, data);
        await handle.truncate(data.byteLength);
      } finally {
        await handle.close();
      }
    } catch {
      skipped.push(target);
    }
  }
  return { total: files.length, imported: files.length - skipped.length, skipped };
}
