/**
 * L2 文件系统桥接契约：Windows 文件 API → FileStore。
 */

import type { FileStat } from '../host';

// ---------------------------------------------------------------------------
// Win32 常量（与 Windows SDK 一致）
// ---------------------------------------------------------------------------

export enum WinError {
  NO_ERROR = 0,
  ERROR_INVALID_FUNCTION = 1,
  ERROR_FILE_NOT_FOUND = 2,
  ERROR_PATH_NOT_FOUND = 3,
  ERROR_TOO_MANY_OPEN_FILES = 4,
  ERROR_ACCESS_DENIED = 5,
  ERROR_INVALID_HANDLE = 6,
  ERROR_NOT_ENOUGH_MEMORY = 8,
  ERROR_INVALID_DRIVE = 15,
  ERROR_NOT_SAME_DEVICE = 17,
  ERROR_NO_MORE_FILES = 18,
  ERROR_SHARING_VIOLATION = 32,
  ERROR_LOCK_VIOLATION = 33,
  ERROR_HANDLE_EOF = 38,
  ERROR_FILE_EXISTS = 80,
  ERROR_INVALID_PARAMETER = 87,
  ERROR_DISK_FULL = 112,
  ERROR_ALREADY_EXISTS = 183,
  ERROR_FILENAME_EXCED_RANGE = 206,
  ERROR_CANCELLED = 1223,
  ERROR_NOT_IMPLEMENTED = 120,
  ERROR_OPERATION_ABORTED = 995,
  ERROR_BAD_ARGUMENTS = 160,
}

export enum DesiredAccess {
  GENERIC_READ = 0x80000000,
  GENERIC_WRITE = 0x40000000,
  GENERIC_EXECUTE = 0x20000000,
  GENERIC_ALL = 0x10000000,
}

export enum ShareMode {
  FILE_SHARE_READ = 0x00000001,
  FILE_SHARE_WRITE = 0x00000002,
  FILE_SHARE_DELETE = 0x00000004,
}

export enum CreationDisposition {
  CREATE_NEW = 1,
  CREATE_ALWAYS = 2,
  OPEN_EXISTING = 3,
  OPEN_ALWAYS = 4,
  TRUNCATE_EXISTING = 5,
}

export enum FileAttributeFlags {
  FILE_ATTRIBUTE_READONLY = 0x00000001,
  FILE_ATTRIBUTE_HIDDEN = 0x00000002,
  FILE_ATTRIBUTE_SYSTEM = 0x00000004,
  FILE_ATTRIBUTE_DIRECTORY = 0x00000010,
  FILE_ATTRIBUTE_ARCHIVE = 0x00000020,
  FILE_ATTRIBUTE_NORMAL = 0x00000080,
}

export enum FileMoveMethod {
  FILE_BEGIN = 0,
  FILE_CURRENT = 1,
  FILE_END = 2,
}

export enum SeekMoveMethod {
  SET = 0,
  CUR = 1,
  END = 2,
}

// ---------------------------------------------------------------------------
// 句柄与结果
// ---------------------------------------------------------------------------

export interface FileHandleRecord {
  handle: number;
  path: string;
  access: number;
  shareMode: number;
  pointer: number;
  writable: boolean;
  exclusiveLocked: boolean;
  sharedLockCount: number;
  open: boolean;
}

export interface CreateFileResult {
  handle: number;
  error: WinError;
}

export interface ReadFileResult {
  bytesRead: number;
  data: Uint8Array;
  error: WinError;
}

export interface WriteFileResult {
  bytesWritten: number;
  error: WinError;
}

export interface SetFilePointerResult {
  newPointer: number;
  error: WinError;
}

export interface GetFileAttributesResult {
  attributes: number;
  error: WinError;
}

export interface FindData extends FileStat {
  attributes: number;
}

export interface FindFirstResult {
  searchHandle: number;
  entries: FindData[];
  error: WinError;
}

export interface FindNextResult {
  entries: FindData[];
  error: WinError;
}

export interface FileSystemBridge {
  /** CreateFile：按 creationDisposition 语义打开/创建/截断文件 */
  createFile(
    path: string,
    desiredAccess: number,
    shareMode: number,
    creationDisposition: number,
    flagsAndAttributes?: number,
  ): Promise<CreateFileResult>;
  readFile(handle: number, bytesToRead: number, filePointer?: number): Promise<ReadFileResult>;
  writeFile(handle: number, data: Uint8Array, filePointer?: number): Promise<WriteFileResult>;
  setFilePointer(handle: number, distance: number, moveMethod: number): Promise<SetFilePointerResult>;
  /** SetEndOfFile：把文件截断/扩展到当前文件指针位置 */
  setEndOfFile(handle: number): Promise<WinError>;
  getFileSize(handle: number): Promise<number>;
  getFilePointer(handle: number): number;
  closeHandle(handle: number): Promise<WinError>;
  /** FindFirstFile：支持 * 与 ? 通配符 */
  findFirstFile(path: string, pattern: string): Promise<FindFirstResult>;
  findNextFile(searchHandle: number): Promise<FindNextResult>;
  findClose(searchHandle: number): Promise<void>;
  createDirectory(path: string): Promise<WinError>;
  removeDirectory(path: string): Promise<WinError>;
  deleteFile(path: string): Promise<WinError>;
  getFileAttributes(path: string): Promise<GetFileAttributesResult>;
  setFileAttributes(path: string, attributes: number): Promise<WinError>;
  moveFile(from: string, to: string, replaceExisting: boolean): Promise<WinError>;
  lockFile(handle: number, exclusive: boolean, bytesToLock: number): Promise<WinError>;
  unlockFile(handle: number): Promise<WinError>;
  /** 释放桥接层所有句柄（进程退出时调用） */
  releaseAll(): Promise<void>;
}