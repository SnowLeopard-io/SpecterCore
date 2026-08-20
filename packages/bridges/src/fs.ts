import type {
  CreateFileResult,
  FileStore,
  FileSystemBridge,
  FindData,
  FindFirstResult,
  FindNextResult,
  FsChange,
  GetFileAttributesResult,
  GetFileInformationResult,
  ReadFileResult,
  SetFilePointerResult,
  WinError,
  WriteFileResult,
} from '@specter-core/contracts';
import {
  CreationDisposition,
  DesiredAccess,
  FileAttributeFlags,
  FileMoveMethod,
  WinError as E,
} from '@specter-core/contracts';
import { normalizePath, splitWildcard, toStorePath, wildcardMatch } from '@specter-core/shared';
import { FileHandleTable } from './handle-table';

/**
 * 文件系统桥接：Windows 文件 API → FileStore（OPFS 或内存）。
 * 实现设计文档 3.1：CreateFile/ReadFile/WriteFile/SetFilePointer/FindFirstFile/属性/锁。
 */
export class FileSystemBridgeImpl implements FileSystemBridge {
  private readonly handles = new FileHandleTable();
  private readonly searches = new Map<number, { entries: FindData[]; cursor: number }>();
  private readonly attributes = new Map<string, number>();
  private readonly changeListeners = new Set<(change: FsChange) => void>();
  private nextSearch = 0x20;

  constructor(
    private readonly store: FileStore,
    private readonly onError?: (path: string, error: WinError, operation: string) => void,
  ) {}

  onChange(listener: (change: FsChange) => void): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  /** 通知订阅者虚拟盘发生了变化（store 路径，无盘符）。 */
  private notify(change: FsChange): void {
    if (this.changeListeners.size === 0) return;
    for (const listener of this.changeListeners) listener(change);
  }

  private report(path: string, error: WinError, operation: string): void {
    this.onError?.(path, error, operation);
  }

  private mapError(err: unknown): WinError {
    const message = err instanceof Error ? err.message : String(err);
    if (/not found/i.test(message)) return E.ERROR_FILE_NOT_FOUND;
    if (/not a directory/i.test(message) || /directory not found/i.test(message)) return E.ERROR_PATH_NOT_FOUND;
    if (/already exists/i.test(message)) return E.ERROR_ALREADY_EXISTS;
    if (/not empty/i.test(message)) return E.ERROR_ACCESS_DENIED;
    if (/permission|denied|conflict/i.test(message)) return E.ERROR_ACCESS_DENIED;
    return E.ERROR_INVALID_PARAMETER;
  }

  private async statOrNull(path: string): Promise<FindData | null> {
    const stat = await this.store.stat(path);
    if (!stat) return null;
    const attributes =
      this.attributes.get(normalizePath(path)) ?? this.inferAttributes(stat.kind, stat.name);
    return { ...stat, attributes };
  }

  private inferAttributes(kind: 'file' | 'directory' | 'symlink', name: string): number {
    if (kind === 'directory') return FileAttributeFlags.FILE_ATTRIBUTE_DIRECTORY;
    if (name.startsWith('.')) return FileAttributeFlags.FILE_ATTRIBUTE_HIDDEN;
    return FileAttributeFlags.FILE_ATTRIBUTE_NORMAL;
  }

  // -------------------------------------------------------------------------
  // CreateFile 语义
  // -------------------------------------------------------------------------

  async createFile(
    path: string,
    desiredAccess: number,
    shareMode: number,
    creationDisposition: number,
    flagsAndAttributes?: number,
  ): Promise<CreateFileResult> {
    const norm = normalizePath(path);
    const existing = await this.statOrNull(norm);
    const writable = (desiredAccess & DesiredAccess.GENERIC_WRITE) !== 0;

    const sharingViolation = (): CreateFileResult => {
      const err = E.ERROR_SHARING_VIOLATION;
      this.report(norm, err, 'CreateFile');
      return { handle: 0, error: err };
    };

    const truncate = async (): Promise<void> => {
      await this.store.deleteFile(norm).catch(() => {});
      const f = await this.store.openFile(norm, 'create');
      await f.close();
      this.notify({ path: toStorePath(norm), kind: 'created' });
    };

    try {
      switch (creationDisposition) {
        case CreationDisposition.CREATE_NEW:
          if (existing) {
            const err = existing.kind === 'directory' ? E.ERROR_ACCESS_DENIED : E.ERROR_FILE_EXISTS;
            this.report(norm, err, 'CreateFile');
            return { handle: 0, error: err };
          }
          await truncate();
          break;
        case CreationDisposition.CREATE_ALWAYS:
          if (existing && existing.kind === 'directory') {
            this.report(norm, E.ERROR_ACCESS_DENIED, 'CreateFile');
            return { handle: 0, error: E.ERROR_ACCESS_DENIED };
          }
          await truncate();
          break;
        case CreationDisposition.OPEN_EXISTING:
          if (!existing) {
            this.report(norm, E.ERROR_FILE_NOT_FOUND, 'CreateFile');
            return { handle: 0, error: E.ERROR_FILE_NOT_FOUND };
          }
          if (existing.kind === 'directory' && writable) {
            this.report(norm, E.ERROR_ACCESS_DENIED, 'CreateFile');
            return { handle: 0, error: E.ERROR_ACCESS_DENIED };
          }
          if (this.handles.hasSharingConflict(norm, shareMode)) return sharingViolation();
          break;
        case CreationDisposition.OPEN_ALWAYS:
          if (!existing) await truncate();
          break;
        case CreationDisposition.TRUNCATE_EXISTING:
          if (!existing) {
            this.report(norm, E.ERROR_FILE_NOT_FOUND, 'CreateFile');
            return { handle: 0, error: E.ERROR_FILE_NOT_FOUND };
          }
          if (existing.kind === 'directory') {
            this.report(norm, E.ERROR_ACCESS_DENIED, 'CreateFile');
            return { handle: 0, error: E.ERROR_ACCESS_DENIED };
          }
          if (this.handles.hasSharingConflict(norm, shareMode)) return sharingViolation();
          await truncate();
          break;
        default:
          this.report(norm, E.ERROR_INVALID_PARAMETER, 'CreateFile');
          return { handle: 0, error: E.ERROR_INVALID_PARAMETER };
      }

      const handle = this.handles.alloc({
        path: norm,
        access: desiredAccess,
        shareMode,
        pointer: 0,
        writable,
        exclusiveLocked: false,
        sharedLockCount: 0,
        open: true,
      });
      if (flagsAndAttributes && (flagsAndAttributes & FileAttributeFlags.FILE_ATTRIBUTE_HIDDEN) !== 0) {
        this.attributes.set(norm, flagsAndAttributes);
      }
      return { handle, error: E.NO_ERROR };
    } catch (err) {
      const winErr = this.mapError(err);
      this.report(norm, winErr, 'CreateFile');
      return { handle: 0, error: winErr };
    }
  }

  // -------------------------------------------------------------------------
  // ReadFile / WriteFile / 指针
  // -------------------------------------------------------------------------

  async readFile(handle: number, bytesToRead: number, filePointer?: number): Promise<ReadFileResult> {
    const record = this.handles.get(handle);
    if (!record) {
      return { bytesRead: 0, data: new Uint8Array(0), error: E.ERROR_INVALID_HANDLE };
    }
    const offset = filePointer ?? record.pointer;
    try {
      const file = await this.store.openFile(record.path, 'read');
      const data = await file.read(offset, bytesToRead);
      await file.close();
      if (filePointer === undefined) record.pointer = offset + data.byteLength;
      return { bytesRead: data.byteLength, data, error: E.NO_ERROR };
    } catch (err) {
      const winErr = this.mapError(err);
      this.report(record.path, winErr, 'ReadFile');
      return { bytesRead: 0, data: new Uint8Array(0), error: winErr };
    }
  }

  async writeFile(handle: number, data: Uint8Array, filePointer?: number): Promise<WriteFileResult> {
    const record = this.handles.get(handle);
    if (!record) {
      return { bytesWritten: 0, error: E.ERROR_INVALID_HANDLE };
    }
    if (!record.writable) {
      return { bytesWritten: 0, error: E.ERROR_ACCESS_DENIED };
    }
    const offset = filePointer ?? record.pointer;
    try {
      const file = await this.store.openFile(record.path, 'readwrite');
      const written = await file.write(offset, data);
      await file.close();
      if (filePointer === undefined) record.pointer = offset + written;
      if (written > 0) this.notify({ path: toStorePath(record.path), kind: 'modified' });
      return { bytesWritten: written, error: E.NO_ERROR };
    } catch (err) {
      const winErr = this.mapError(err);
      this.report(record.path, winErr, 'WriteFile');
      return { bytesWritten: 0, error: winErr };
    }
  }

  async setFilePointer(
    handle: number,
    distance: number,
    moveMethod: number,
  ): Promise<SetFilePointerResult> {
    const record = this.handles.get(handle);
    if (!record) {
      return { newPointer: 0, error: E.ERROR_INVALID_HANDLE };
    }
    let next: number;
    switch (moveMethod) {
      case FileMoveMethod.FILE_BEGIN:
        next = distance;
        break;
      case FileMoveMethod.FILE_CURRENT:
        next = record.pointer + distance;
        break;
      case FileMoveMethod.FILE_END: {
        const size = await this.getFileSize(handle);
        next = size + distance;
        break;
      }
      default:
        return { newPointer: 0, error: E.ERROR_INVALID_PARAMETER };
    }
    if (next < 0) return { newPointer: 0, error: E.ERROR_INVALID_PARAMETER };
    record.pointer = next;
    return { newPointer: next, error: E.NO_ERROR };
  }

  async getFileSize(handle: number): Promise<number> {
    const record = this.handles.get(handle);
    if (!record) return 0;
    const stat = await this.store.stat(record.path);
    return stat?.size ?? 0;
  }

  async getFileInformation(handle: number): Promise<GetFileInformationResult> {
    const record = this.handles.get(handle);
    if (!record) return { path: '', size: 0, attributes: 0, modified: 0, error: E.ERROR_INVALID_HANDLE };
    const stat = await this.store.stat(record.path);
    if (!stat) return { path: record.path, size: 0, attributes: 0, modified: 0, error: E.ERROR_FILE_NOT_FOUND };
    const attributes =
      this.attributes.get(normalizePath(record.path)) ?? this.inferAttributes(stat.kind, stat.name);
    return {
      path: record.path,
      size: stat.size,
      attributes,
      modified: stat.modified,
      error: E.NO_ERROR,
    };
  }

  async setEndOfFile(handle: number): Promise<WinError> {
    const record = this.handles.get(handle);
    if (!record) return E.ERROR_INVALID_HANDLE;
    try {
      const file = await this.store.openFile(record.path, 'readwrite');
      await file.truncate(record.pointer);
      await file.close();
      this.notify({ path: toStorePath(record.path), kind: 'modified' });
      return E.NO_ERROR;
    } catch (err) {
      const winErr = this.mapError(err);
      this.report(record.path, winErr, 'SetEndOfFile');
      return winErr;
    }
  }

  getFilePointer(handle: number): number {
    return this.handles.get(handle)?.pointer ?? -1;
  }

  async closeHandle(handle: number): Promise<WinError> {
    const record = this.handles.get(handle);
    if (!record) return E.ERROR_INVALID_HANDLE;
    this.handles.release(handle);
    return E.NO_ERROR;
  }

  // -------------------------------------------------------------------------
  // FindFirstFile / FindNextFile
  // -------------------------------------------------------------------------

  async findFirstFile(path: string, pattern: string): Promise<FindFirstResult> {
    const norm = normalizePath(path);
    const { dir } = splitWildcard(pattern);
    const searchDir = dir === '' ? norm : normalizePath(`${norm}/${dir}`);
    const filePattern = splitWildcard(pattern).pattern;
    try {
      const entries = await this.store.listDirectory(searchDir);
      const matches = entries
        .filter((entry) => wildcardMatch(entry.name, filePattern))
        .map<FindData>((entry) => ({
          ...entry,
          attributes: this.inferAttributes(entry.kind, entry.name),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

      const searchHandle = this.nextSearch++;
      this.searches.set(searchHandle, { entries: matches, cursor: 0 });
      const first = matches[0];
      const resultEntries = first ? [first] : [];
      return {
        searchHandle,
        entries: resultEntries,
        error: first ? E.NO_ERROR : E.ERROR_NO_MORE_FILES,
      };
    } catch (err) {
      return { searchHandle: 0, entries: [], error: this.mapError(err) };
    }
  }

  async findNextFile(searchHandle: number): Promise<FindNextResult> {
    const search = this.searches.get(searchHandle);
    if (!search) return { entries: [], error: E.ERROR_INVALID_HANDLE };
    search.cursor += 1;
    const next = search.entries[search.cursor];
    return {
      entries: next ? [next] : [],
      error: next ? E.NO_ERROR : E.ERROR_NO_MORE_FILES,
    };
  }

  async findClose(searchHandle: number): Promise<void> {
    this.searches.delete(searchHandle);
  }

  // -------------------------------------------------------------------------
  // 目录 / 删除 / 属性 / 移动
  // -------------------------------------------------------------------------

  async createDirectory(path: string): Promise<WinError> {
    const norm = normalizePath(path);
    try {
      await this.store.createDirectory(norm);
      this.attributes.set(norm, FileAttributeFlags.FILE_ATTRIBUTE_DIRECTORY);
      this.notify({ path: toStorePath(norm), kind: 'created' });
      return E.NO_ERROR;
    } catch (err) {
      const winErr = this.mapError(err);
      this.report(norm, winErr, 'CreateDirectory');
      return winErr;
    }
  }

  async removeDirectory(path: string): Promise<WinError> {
    const norm = normalizePath(path);
    try {
      await this.store.removeDirectory(norm);
      this.attributes.delete(norm);
      this.notify({ path: toStorePath(norm), kind: 'deleted' });
      return E.NO_ERROR;
    } catch (err) {
      const winErr = this.mapError(err);
      this.report(norm, winErr, 'RemoveDirectory');
      return winErr;
    }
  }

  async deleteFile(path: string): Promise<WinError> {
    const norm = normalizePath(path);
    try {
      await this.store.deleteFile(norm);
      this.attributes.delete(norm);
      this.notify({ path: toStorePath(norm), kind: 'deleted' });
      return E.NO_ERROR;
    } catch (err) {
      const winErr = this.mapError(err);
      this.report(norm, winErr, 'DeleteFile');
      return winErr;
    }
  }

  async getFileAttributes(path: string): Promise<GetFileAttributesResult> {
    const norm = normalizePath(path);
    const stat = await this.statOrNull(norm);
    if (!stat) {
      return { attributes: 0xffffffff, error: E.ERROR_FILE_NOT_FOUND };
    }
    return { attributes: stat.attributes, error: E.NO_ERROR };
  }

  async setFileAttributes(path: string, attributes: number): Promise<WinError> {
    const norm = normalizePath(path);
    const stat = await this.store.stat(norm);
    if (!stat) return E.ERROR_FILE_NOT_FOUND;
    this.attributes.set(norm, attributes);
    return E.NO_ERROR;
  }

  async moveFile(from: string, to: string, replaceExisting: boolean): Promise<WinError> {
    const src = normalizePath(from);
    const dst = normalizePath(to);
    try {
      const targetExists = (await this.store.stat(dst)) !== null;
      if (targetExists && !replaceExisting) {
        return E.ERROR_FILE_EXISTS;
      }
      if (targetExists && replaceExisting) {
        await this.store.deleteFile(dst).catch(() => {});
      }
      await this.store.move(src, dst);
      const attrs = this.attributes.get(src);
      if (attrs !== undefined) {
        this.attributes.delete(src);
        this.attributes.set(dst, attrs);
      }
      this.notify({ path: toStorePath(src), kind: 'moved', to: toStorePath(dst) });
      return E.NO_ERROR;
    } catch (err) {
      const winErr = this.mapError(err);
      this.report(src, winErr, 'MoveFile');
      return winErr;
    }
  }

  // -------------------------------------------------------------------------
  // 文件锁
  // -------------------------------------------------------------------------

  async lockFile(handle: number, exclusive: boolean, _bytesToLock: number): Promise<WinError> {
    const record = this.handles.get(handle);
    if (!record) return E.ERROR_INVALID_HANDLE;
    if (record.exclusiveLocked || (record.sharedLockCount > 0 && exclusive)) {
      return E.ERROR_LOCK_VIOLATION;
    }
    if (exclusive) {
      record.exclusiveLocked = true;
    } else {
      record.sharedLockCount += 1;
    }
    return E.NO_ERROR;
  }

  async unlockFile(handle: number): Promise<WinError> {
    const record = this.handles.get(handle);
    if (!record) return E.ERROR_INVALID_HANDLE;
    if (record.exclusiveLocked) {
      record.exclusiveLocked = false;
    } else if (record.sharedLockCount > 0) {
      record.sharedLockCount -= 1;
    }
    return E.NO_ERROR;
  }

  async releaseAll(): Promise<void> {
    for (const handle of this.handles.allHandles()) {
      this.handles.release(handle);
    }
    this.searches.clear();
    this.attributes.clear();
  }
}