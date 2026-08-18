import type { FileHandleRecord } from '@bk/contracts';

/**
 * 文件句柄表：维护 Windows 语义的打开文件记录。
 * 所有句柄操作（CreateFile/ReadFile/WriteFile/CloseHandle）经由此表。
 */
export class FileHandleTable {
  private readonly handles = new Map<number, FileHandleRecord>();
  private readonly byPath = new Map<string, Set<number>>();
  private nextHandle = 0x10;

  alloc(record: Omit<FileHandleRecord, 'handle'>): number {
    const handle = this.nextHandle++;
    this.handles.set(handle, { ...record, handle });
    let set = this.byPath.get(record.path);
    if (!set) {
      set = new Set();
      this.byPath.set(record.path, set);
    }
    set.add(handle);
    return handle;
  }

  get(handle: number): FileHandleRecord | null {
    return this.handles.get(handle) ?? null;
  }

  has(handle: number): boolean {
    return this.handles.has(handle);
  }

  /** 检查共享模式冲突 */
  hasSharingConflict(path: string, shareMode: number): boolean {
    const handles = this.byPath.get(path);
    if (!handles || handles.size === 0) return false;
    for (const h of handles) {
      const record = this.handles.get(h);
      if (!record) continue;
      // 新请求不共享且文件已打开 → 冲突
      if (shareMode === 0) return true;
      // 已有句柄不共享且要打开新句柄 → 冲突
      if (record.shareMode === 0) return true;
      // 写共享不开启时不允许写访问
      if ((record.shareMode & 0x02) === 0 && (shareMode & 0x02) !== 0) return true;
    }
    return false;
  }

  release(handle: number): FileHandleRecord | null {
    const record = this.handles.get(handle);
    if (!record) return null;
    this.handles.delete(handle);
    const set = this.byPath.get(record.path);
    if (set) {
      set.delete(handle);
      if (set.size === 0) this.byPath.delete(record.path);
    }
    return record;
  }

  /** 标记句柄关闭 */
  markClosed(handle: number): void {
    const record = this.handles.get(handle);
    if (record) record.open = false;
  }

  get size(): number {
    return this.handles.size;
  }

  countForPath(path: string): number {
    return this.byPath.get(path)?.size ?? 0;
  }

  allHandles(): number[] {
    return [...this.handles.keys()];
  }
}