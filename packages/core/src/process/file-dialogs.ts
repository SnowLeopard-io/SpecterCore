/**
 * comdlg32 common file dialogs (GetOpenFileNameW/A, GetSaveFileNameW/A), delegating to the host fileDialog provider when wired.
 *
 * Split out of guest-process.ts (design doc 4.2.x); pure code movement, no logic changes.
 */

import type { ApiCallContext, ApiInterceptor, ApiResult } from '@specter-core/contracts';
import { WinError as E } from '@specter-core/contracts';
import type { ArchBackend } from '../arch';
import type { WasmRuntimeImpl } from '../jit/runtime';
import type { FileDialogOptions } from './guest-process';

/** Dependencies for the common file dialog install. */
export interface FileDialogDeps {
  runtime: WasmRuntimeImpl;
  interceptor: ApiInterceptor;
  arch: ArchBackend;
  fileDialog?: (kind: 'open' | 'save', opts: FileDialogOptions) => Promise<string | null>;
}

/**
 * comdlg32 common file dialogs (GetOpenFileNameW/A, GetSaveFileNameW/A).
 * notepad delay-loads these through .didat; without handlers the interceptor
 * returns 0 and the dialog "never appears" (Save As fails silently). When a
 * host fileDialog provider is wired in (GuestProcessOptions.fileDialog), the
 * dialog delegates to it — the L6 shell renders a virtual-disk browser and
 * returns the chosen Windows path, which we write back into the guest's
 * OPENFILENAME structure (lpstrFile buffer + nFileOffset/nFileExtension)
 * exactly like a real comdlg32 would. With no provider, dialogs cancel.
 */

export function installFileDialogs(deps: FileDialogDeps): void {
  const runtime = deps.runtime;
  const rd32 = (a: number): number => {
    const b = runtime.readBytes(a >>> 0, 4);
    return b.byteLength < 4 ? 0 : new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true);
  };
  const wr16 = (a: number, v: number): void => {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, v & 0xffff, true);
    runtime.writeBytes(a >>> 0, b);
  };
  // Read a UTF-16 string until the FIRST NUL; the lpstrFilter string is
  // double-NUL-terminated ("Text Files\0*.txt\0All Files\0*.*\0\0"), so the
  // caller reads the full block separately when it needs the tail.
  const readW = (a: number, maxBytes: number): string => {
    if (!a) return '';
    const bytes = runtime.readBytes(a >>> 0, maxBytes);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let s = '';
    for (let i = 0; i + 1 < bytes.byteLength; i += 2) {
      const c = view.getUint16(i, true);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  };
  const writeW = (a: number, maxBytes: number, s: string): void => {
    const bytes = new Uint8Array(Math.min(maxBytes, (s.length + 1) * 2));
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < s.length && i * 2 + 1 < bytes.byteLength; i++) {
      view.setUint16(i * 2, s.charCodeAt(i), true);
    }
    runtime.writeBytes(a >>> 0, bytes);
  };
  // Read the raw double-NUL-terminated filter block (up to nMaxCustFilter
  // bytes is a lie — comdlg32 caps at 4096 chars; use a sane bound).
  const readFilterBlock = (a: number): string => {
    if (!a) return '';
    const bytes = runtime.readBytes(a >>> 0, 8192);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let s = '';
    let nulCount = 0;
    for (let i = 0; i + 1 < bytes.byteLength; i += 2) {
      const c = view.getUint16(i, true);
      if (c === 0) {
        nulCount += 1;
        if (nulCount >= 2) break;
      }
      s += String.fromCharCode(c);
    }
    return s;
  };

  // OPENFILENAME field offsets differ between x86 and x64 because x64 uses
  // 8-byte pointers (and 8-byte alignment for them):
  //   x86  lpstrFilter=0x0c lpstrFile=0x1c nMaxFile=0x20 lpstrFileTitle=0x24
  //        lpstrInitialDir=0x2c lpstrTitle=0x30 nFileOffset=0x38 nFileExtension=0x3a
  //   x64  lpstrFilter=0x18 lpstrFile=0x30 nMaxFile=0x38 lpstrFileTitle=0x40
  //        lpstrInitialDir=0x50 lpstrTitle=0x58 nFileOffset=0x64 nFileExtension=0x66
  // NOTE: offsets + pointer reader are mode-specific policy; delegate to the
  // arch backend at call time (deps.arch is assigned before run() reaches us).
  const dialogHandler =
    (kind: 'open' | 'save', wide: boolean) =>
    async (ctx: ApiCallContext): Promise<ApiResult> => {
      const ofn = ctx.rawArgs[0] ?? 0;
      if (!ofn) return { returnValue: 0, errorCode: E.NO_ERROR };
      const off = deps.arch.openFileNameOffsets();
      const rdPtr = (a: number): number => (a ? deps.arch.readPointer(deps.runtime, a >>> 0) : 0);
      const lpstrFile = rdPtr(ofn + off.lpstrFile) >>> 0;
      const nMaxFile = rd32(ofn + off.nMaxFile) >>> 0;
      if (!lpstrFile || nMaxFile === 0) return { returnValue: 0, errorCode: E.NO_ERROR };
      // Pre-fill: what comdlg32 shows as the default file name comes from
      // lpstrFile's CURRENT contents (notepad puts "Untitled" there before
      // Save As; an existing file's path for Save).
      const current = wide
        ? readW(lpstrFile, Math.min(nMaxFile * 2, 32768))
        : readCStrRaw(lpstrFile, nMaxFile);
      const initialDir = wide
        ? readW(rdPtr(ofn + off.lpstrInitialDir) >>> 0, 4096)
        : readCStrRaw(rdPtr(ofn + off.lpstrInitialDir) >>> 0, 4096);
      const title = wide
        ? readW(rdPtr(ofn + off.lpstrTitle) >>> 0, 1024)
        : readCStrRaw(rdPtr(ofn + off.lpstrTitle) >>> 0, 1024);
      const filter = wide
        ? readFilterBlock(rdPtr(ofn + off.lpstrFilter) >>> 0)
        : readFilterBlockA(rdPtr(ofn + off.lpstrFilter) >>> 0);
      if (!deps.fileDialog) {
        // No host provider: cancel the dialog (FALSE), like a no-op comdlg32.
        return { returnValue: 0, errorCode: E.NO_ERROR };
      }
      let path: string | null;
      try {
        path = await deps.fileDialog(kind, {
          title,
          initialDir,
          defaultName: current,
          filter,
        });
      } catch (err) {
        console.error('[comdlg32] fileDialog provider threw:', err);
        return { returnValue: 0, errorCode: E.NO_ERROR };
      }
      if (!path) return { returnValue: 0, errorCode: E.NO_ERROR }; // cancelled
      // Windows path -> char count check against the guest buffer.
      const maxChars = Math.max(1, Math.floor((nMaxFile - 1) / (wide ? 2 : 1)));
      if (path.length > maxChars) {
        console.error(`[comdlg32] path too long for lpstrFile (${path.length} > ${maxChars})`);
        return { returnValue: 0, errorCode: E.ERROR_FILENAME_EXCED_RANGE };
      }
      if (wide) {
        writeW(lpstrFile, nMaxFile, path);
      } else {
        const bytes = new TextEncoder().encode(path);
        const out = new Uint8Array(Math.min(nMaxFile, bytes.byteLength + 1));
        out.set(bytes.subarray(0, Math.max(0, out.byteLength - 1)));
        runtime.writeBytes(lpstrFile >>> 0, out);
      }
      // nFileOffset (char offset of the file name in the full path) and
      // nFileExtension (char offset of the dot) — both 16-bit WORDs.
      const lastSep = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
      const nameStart = lastSep >= 0 ? lastSep + 1 : 0;
      const dot = path.lastIndexOf('.');
      const extStart = dot > nameStart ? dot : path.length;
      wr16(ofn + off.nFileOffset, nameStart);
      wr16(ofn + off.nFileExtension, extStart);
      return { returnValue: 1, errorCode: E.NO_ERROR };
    };
  // ANSI (narrow) string readers for the A variants (code page is assumed
  // to be latin1 — ASCII-compatible, which is all these guests use).
  const readCStrRaw = (a: number, maxBytes: number): string => {
    if (!a) return '';
    const bytes = runtime.readBytes(a >>> 0, Math.min(maxBytes, 4096));
    let end = 0;
    while (end < bytes.byteLength && bytes[end] !== 0) end += 1;
    return new TextDecoder('latin1').decode(bytes.subarray(0, end));
  };
  const readFilterBlockA = (a: number): string => {
    if (!a) return '';
    const bytes = runtime.readBytes(a >>> 0, 8192);
    let end = 0;
    let nulCount = 0;
    while (end < bytes.byteLength) {
      if (bytes[end] === 0) {
        nulCount += 1;
        if (nulCount >= 2) break;
      }
      end += 1;
    }
    return new TextDecoder('latin1').decode(bytes.subarray(0, end));
  };

  deps.interceptor.hook('comdlg32.dll', 'GetOpenFileNameW', dialogHandler('open', true));
  deps.interceptor.hook('comdlg32.dll', 'GetOpenFileNameA', dialogHandler('open', false));
  deps.interceptor.hook('comdlg32.dll', 'GetSaveFileNameW', dialogHandler('save', true));
  deps.interceptor.hook('comdlg32.dll', 'GetSaveFileNameA', dialogHandler('save', false));
  // CommDlgExtendedError is only read after a failed/cancelled dialog;
  // ERROR_CANCELLED (1223) is the honest answer for a user cancel.
  deps.interceptor.hook('comdlg32.dll', 'CommDlgExtendedError', () => ({
    returnValue: E.ERROR_CANCELLED,
    errorCode: E.NO_ERROR,
  }));
}
