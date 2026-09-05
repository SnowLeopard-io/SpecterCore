/**
 * Startup-critical API surface: module/export resolution, heap/environment, process/thread info, loader lock, and resource/string APIs (design doc 4.2.x).
 *
 * Split out of guest-process.ts (design doc 4.2.x); pure code movement, no logic changes.
 */

import type {
  ApiCallContext,
  ApiHost,
  ApiInterceptor,
  ApiResult,
  PeImage,
} from '@specter-core/contracts';
import { WinError as E } from '@specter-core/contracts';
import type { ApiStub, MappedImage } from '../pe/mapper';
import type { WasmRuntimeImpl } from '../jit/runtime';
import type { ArchBackend } from '../arch';
import type { RunState } from './guest-common';
import { ok1 } from './guest-common';
import { SEH_SENTINEL_VECTOR, X86_CONTEXT_SIZE } from './seh';
import type { SehController } from './seh';
import type { GuiBridge } from './gui-bridge';

/** Dependencies for the startup handler install. */
export interface StartupDeps {
  runtime: WasmRuntimeImpl;
  interceptor: ApiInterceptor;
  arch: ArchBackend;
  state: RunState;
  seh: SehController;
  gui: GuiBridge;
  onWindowMetaChanged: () => ((hwnd: number) => void) | undefined;
}

/**
 * Startup-critical kernel32 functions every real exe needs before it can do
 * anything useful. Installed per-run because they need the loaded image:
 *  - GetModuleHandleW/A(NULL) -> the exe's image base (CRT fetches its own
 *    module handle first thing; returning 0 aborts startup silently);
 *  - GetProcAddress -> resolves the exe's own export table;
 *  - LoadLibraryW/A -> pseudo-loads the exe itself so GetProcAddress works
 *    against the returned handle (no real system DLLs exist yet).
 */

export async function installStartupHandlers(
  deps: StartupDeps,
  pe: PeImage,
  mapped: MappedImage,
  stubs: ApiStub[],
  dynCursor: () => number,
  setDynCursor: (next: number) => void,
  image: Uint8Array,
): Promise<void> {
  const base = mapped.baseAddress;
  const exports = new Map<string, number>();
  const byOrdinal = new Map<number, number>();
  for (const e of pe.exports) {
    exports.set(e.name.toLowerCase(), e.address);
    byOrdinal.set(e.ordinal, e.address);
  }
  const readCStr = (address: number): string => {
    if (!address) return '';
    const bytes = deps.runtime.readBytes(address, 4096);
    let end = 0;
    while (end < bytes.byteLength && bytes[end] !== 0) end += 1;
    return new TextDecoder('latin1').decode(bytes.subarray(0, end));
  };
  const readWStr = (address: number): string => {
    if (!address) return '';
    const bytes = deps.runtime.readBytes(address, 8192);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let s = '';
    for (let i = 0; i + 1 < bytes.byteLength; i += 2) {
      const c = view.getUint16(i, true);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  };

  // ------------------------------------------------------------------
  // PE resource table (RT_RCDATA). Inno's SetupLdr locates its payload
  // archive via FindResourceW(0, 0x2B67, RT_RCDATA) + SizeofResource +
  // LoadResource/LockResource: the (tiny) resource is a descriptor holding
  // the archive's file offset, which the installer then reads via its own
  // CreateFileW handle. SizeofResource must therefore return the RESOURCE
  // entry size (44 bytes here), not the overlay length — returning the
  // overlay size made Inno's integrity check fail with "The setup files are
  // corrupted". Parse the real .rsrc directory and serve entries from it.
  // ------------------------------------------------------------------
  const resourceTable = new Map<number, { size: number; address: number }>();
  // Named resources from the merged .mui (key `type:name` lowercase) — e.g.
  // notepad's accelerators live under the string name "GlobalAcc".
  const namedResources = new Map<string, { size: number; address: number }>();
  {
    const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
    const u16 = (o: number): number => (o + 2 <= image.byteLength ? view.getUint16(o, true) : 0);
    const u32 = (o: number): number => (o + 4 <= image.byteLength ? view.getUint32(o, true) : 0);
    const eLfanew = u32(0x3c);
    const coff = eLfanew + 4;
    const numSections = u16(coff + 2);
    const optSize = u16(coff + 16);
    const optMagic = u16(eLfanew + 24);
    const dataDir = eLfanew + 24 + (optMagic === 0x20b ? 112 : 96);
    const resRva = u32(dataDir + 16);
    const secTable = coff + 20 + optSize;
    let resRaw = 0;
    for (let i = 0; i < numSections; i++) {
      const s = secTable + i * 40;
      if (u32(s + 12) === resRva) {
        resRaw = u32(s + 20);
        break;
      }
    }
    if (resRaw) {
      const r2o = (rva: number): number => resRaw + (rva - resRva);
      const inBounds = (o: number, n: number): boolean => o >= 0 && o + n <= image.byteLength;
      const walk = (rva: number, depth: number, typeId: number, nameId: number): void => {
        const off = r2o(rva);
        if (!inBounds(off, 16)) return;
        const named = u16(off + 12);
        const ids = u16(off + 14);
        for (let k = 0; k < named + ids; k++) {
          const e = off + 16 + k * 8;
          if (!inBounds(e, 8)) break;
          const name = u32(e);
          const data = u32(e + 4);
          if (depth === 0) {
            // type level: name = typeId, data -> name-level directory
            walk(resRva + (data & 0x7fffffff), 1, name & 0xffff, 0);
          } else if (depth === 1) {
            // name level: name = nameId, data -> language-level directory
            walk(resRva + (data & 0x7fffffff), 2, typeId, name & 0xffff);
          } else {
            // language level: data -> data entry { DataRVA, Size }
            const de = r2o(resRva + data);
            if (inBounds(de, 8)) {
              const key = ((typeId & 0xffff) << 16) | (nameId & 0xffff);
              if (!resourceTable.has(key)) {
                resourceTable.set(key, { size: u32(de + 4), address: base + u32(de) });
              }
            }
          }
        }
      };
      walk(resRva, 0, 0, 0);
    }
  }
  let lastResourceKey = 0;
  deps.interceptor.hook('kernel32.dll', 'FindResourceW', (ctx) => {
    const name = ctx.rawArgs[1] ?? 0;
    const type = ctx.rawArgs[2] ?? 0;
    // Inno uses numeric IDs; string names would need the guest string.
    if (type > 0xffff || (name & 0x80000000) !== 0)
      return { returnValue: 0, errorCode: E.ERROR_FILE_NOT_FOUND };
    const key = ((type & 0xffff) << 16) | (name & 0xffff);
    if (!resourceTable.has(key)) return { returnValue: 0, errorCode: E.ERROR_FILE_NOT_FOUND };
    lastResourceKey = key;
    return { returnValue: key, errorCode: E.NO_ERROR };
  });
  deps.interceptor.hook('kernel32.dll', 'SizeofResource', (ctx) => {
    const key = (ctx.rawArgs[1] ?? 0) >>> 0;
    const entry = resourceTable.get(key);
    return entry
      ? { returnValue: entry.size, errorCode: E.NO_ERROR }
      : { returnValue: 0, errorCode: E.ERROR_FILE_NOT_FOUND };
  });
  // LoadResource must return a per-resource handle so LockResource can
  // resolve the right entry even when several resources are loaded before
  // any LockResource (winmine: Find×3 → Load×3 → Lock×3). The FindResourceW
  // return value (hResInfo = resource key) doubles as that handle.
  deps.interceptor.hook('kernel32.dll', 'LoadResource', (ctx) => {
    const hResInfo = (ctx.rawArgs[1] ?? 0) >>> 0;
    return { returnValue: hResInfo, errorCode: E.NO_ERROR };
  });
  deps.interceptor.hook('kernel32.dll', 'LockResource', (ctx) => {
    const hResData = (ctx.rawArgs[0] ?? 0) >>> 0;
    const entry = resourceTable.get(hResData) ?? resourceTable.get(lastResourceKey);
    return entry
      ? { returnValue: entry.address, errorCode: E.NO_ERROR }
      : { returnValue: 0, errorCode: E.NO_ERROR };
  });

  // LoadStringW: reads a string from the RT_STRING resource (type 6).
  // String resources are blocks of 16 strings, each prefixed with a WORD
  // (2-byte) length followed by UTF-16 code units; id = block*16 + index.
  // notepad loads its whole UI (menus, dialogs) through this — returning 0
  // makes it fail-fast. (Reading a 1-byte length drifts 1 byte per slot and
  // returns the wrong string — winmine's "Error: %d" came back as the
  // 17-char "Minesweeper Error".)
  const readWChar = (addr: number): number => {
    const b = deps.runtime.readBytes(addr, 2);
    return b.byteLength >= 2 ? new DataView(b.buffer, b.byteOffset, 2).getUint16(0, true) : 0;
  };
  deps.interceptor.hook('user32.dll', 'LoadStringW', (ctx) => {
    const id = (ctx.rawArgs[1] ?? 0) >>> 0;
    const buf = (ctx.rawArgs[2] ?? 0) >>> 0;
    const cch = (ctx.rawArgs[3] ?? 0) >>> 0;
    if (!buf || !cch) return { returnValue: 0, errorCode: E.NO_ERROR };
    // RT_STRING: block id = (stringId >> 4) + 1 (string ids are 1-based,
    // block 1 holds ids 1..15 at slots 1..15, slot 0 of block 1 is the
    // unused id 0), in-block slot = stringId & 0xF.
    const block = resourceTable.get((6 << 16) | ((id >> 4) + 1));
    if (block) {
      let off = block.address;
      const slot = id & 0xf;
      for (let i = 0; i < 16; i++) {
        const b = deps.runtime.readBytes(off, 2);
        const len =
          b.byteLength >= 2 ? new DataView(b.buffer, b.byteOffset, 2).getUint16(0, true) : 0;
        if (i === slot) {
          const n = Math.min(len, cch);
          const w = new Uint8Array(n * 2);
          for (let j = 0; j < n; j++) {
            const c = readWChar(off + 2 + j * 2);
            w[j * 2] = c & 0xff;
            w[j * 2 + 1] = (c >> 8) & 0xff;
          }
          deps.runtime.writeBytes(buf, w);
          deps.runtime.writeInt32(buf + n * 2, 0); // NUL terminator
          return { returnValue: n, errorCode: E.NO_ERROR };
        }
        off += 2 + len * 2;
      }
    }
    // Fallback: the RT_STRING table is missing (no MUI satellite resources,
    // e.g. in the browser). Real Windows aborts notepad here; returning a
    // non-empty placeholder keeps the GUI init going so the window /
    // message-loop / paint pipeline can be exercised. Content is a stub.
    const placeholder = `S${id}`;
    const n = Math.min(placeholder.length, cch - 1);
    const w = new Uint8Array(n * 2 + 2);
    for (let j = 0; j < n; j++) {
      const c = placeholder.charCodeAt(j);
      w[j * 2] = c & 0xff;
      w[j * 2 + 1] = (c >> 8) & 0xff;
    }
    deps.runtime.writeBytes(buf, w);
    return { returnValue: n, errorCode: E.NO_ERROR };
  });

  // FormatMessageW: cmd.exe pulls its dir header / file-row / error format
  // strings from the RT_MESSAGETABLE (type 11) merged from cmd.exe.mui, and
  // formats system errors via FORMAT_MESSAGE_FROM_SYSTEM. Without a handler
  // both return 0 -> dir prints nothing and error paths print "unknown".
  //
  // RT_MESSAGETABLE layout (winnt.h):
  //   MESSAGE_RESOURCE_DATA { DWORD NumberOfBlocks; MESSAGE_RESOURCE_BLOCK[] }
  //   MESSAGE_RESOURCE_BLOCK { DWORD LowId; DWORD HighId;
  //                            DWORD OffsetToEntries; }  // from DATA start
  //   entries are sequential per block (entry k = id LowId+k):
  //   MESSAGE_RESOURCE_ENTRY { WORD Length; WORD Flags; WCHAR Text[]; }
  //   Length includes the 4-byte header; entries are DWORD-aligned.
  const rd16 = (a: number): number => {
    const b = deps.runtime.readBytes(a >>> 0, 2);
    return b.byteLength >= 2 ? new DataView(b.buffer, b.byteOffset, 2).getUint16(0, true) : 0;
  };
  const readMsgTable = (addr: number, size: number, msgId: number): string | null => {
    const nb = deps.runtime.readInt32(addr);
    for (let b = 0; b < nb; b++) {
      const bo = addr + 4 + b * 12;
      const low = deps.runtime.readInt32(bo) >>> 0;
      const high = deps.runtime.readInt32(bo + 4) >>> 0;
      const off = deps.runtime.readInt32(bo + 8) >>> 0;
      if (msgId < low || msgId > high) continue;
      let eo = addr + off;
      const idx = msgId - low;
      for (let i = 0; i < idx; i++) {
        const len = rd16(eo);
        if (len < 4) return null;
        eo = (eo + len + 3) & ~3;
      }
      const len = rd16(eo);
      if (len < 4) return null;
      const flags = rd16(eo + 2);
      const tlen = len - 4;
      if (flags & 1) {
        // Unicode entry: UTF-16LE text, strip trailing NUL/padding.
        let s = '';
        for (let i = 0; i + 1 < tlen; i += 2) {
          const c = rd16(eo + 4 + i);
          if (c === 0) break;
          s += String.fromCharCode(c);
        }
        return s;
      }
      // ANSI entry (rare in modern MUI): latin1 bytes.
      let s = '';
      for (let i = 0; i < tlen; i++) {
        const c = rd16(eo + 4 + i) & 0xff;
        if (c === 0) break;
        s += String.fromCharCode(c);
      }
      return s;
    }
    return null;
  };
  const lookupMsgTable = (msgId: number): string | null => {
    for (const [key, entry] of resourceTable) {
      if (key >>> 16 !== 11) continue;
      const t = readMsgTable(entry.address, entry.size, msgId);
      if (t !== null) return t;
    }
    return null;
  };
  // FORMAT_MESSAGE_FROM_SYSTEM fallback: a small map of the system error
  // strings cmd prints on failure paths. Unknown ids -> ERROR_MR_MID_NOT_FOUND.
  const SYSTEM_MESSAGE_TEXT: Record<number, string> = {
    2: 'The system cannot find the file specified.',
    3: 'The system cannot find the path specified.',
    5: 'Access is denied.',
    6: 'The handle is invalid.',
    8: 'Not enough storage is available to process this command.',
    87: 'The parameter is incorrect.',
    120: 'This function is not supported on this system.',
    123: 'The filename, directory name, or volume label syntax is incorrect.',
    267: 'The directory name is invalid.',
    317: 'The system cannot find message text for message number 0x%1 in the message file for %2.',
  };
  deps.interceptor.hook('kernel32.dll', 'FormatMessageW', (ctx) => {
    const flags = (ctx.rawArgs[0] ?? 0) >>> 0;
    const hModule = (ctx.rawArgs[1] ?? 0) >>> 0;
    const msgId = (ctx.rawArgs[2] ?? 0) >>> 0;
    const bufPtr = (ctx.rawArgs[4] ?? 0) >>> 0;
    const nSize = (ctx.rawArgs[5] ?? 0) >>> 0;
    const allocBuf = (flags & 0x100) !== 0;
    const fromModule = (flags & 0x800) !== 0;
    const fromSystem = (flags & 0x1000) !== 0;
    let text: string | null = null;
    if (fromModule && hModule === 0) text = lookupMsgTable(msgId);
    if (text === null && fromSystem) text = SYSTEM_MESSAGE_TEXT[msgId] ?? null;
    if (text === null) return { returnValue: 0, errorCode: 0x13d as E }; // ERROR_MR_MID_NOT_FOUND
    // Minimal %N substitution from the Arguments parameter.
    //
    // The Arguments parameter is `va_list *`:
    //  - WITHOUT FORMAT_MESSAGE_ARGUMENT_ARRAY (0x2000): it points to a
    //    va_list variable; the va_list (x86: char*) points at the first
    //    argument on the caller's stack. So the real arg array is
    //    [ *Arguments + i*4 ] — one level of indirection.
    //  - WITH FORMAT_MESSAGE_ARGUMENT_ARRAY: it IS the LPCWSTR* array.
    // Without the extra dereference, cmd's dir headers come out with
    // garbage where the drive letter / volume serial / path insert should
    // be (the va_list value was read as the string pointer itself).
    let argsPtr = (ctx.rawArgs[6] ?? 0) >>> 0;
    const argArray = (flags & 0x2000) !== 0;
    if (argsPtr && !(flags & 0x200) && !argArray) {
      argsPtr = deps.runtime.readInt32(argsPtr) >>> 0;
    }
    const readArgW = (i: number): string => {
      if (!argsPtr) return '';
      const p = deps.runtime.readInt32(argsPtr + i * 4) >>> 0;
      if (!p) return '';
      let s = '';
      for (let j = 0; j < 512; j++) {
        const c = rd16(p + j * 2);
        if (c === 0) break;
        s += String.fromCharCode(c);
      }
      return s;
    };
    if (argsPtr && !(flags & 0x200)) {
      text = text.replace(/%([1-9])/g, (_m, d: string) => readArgW(Number(d) - 1));
    }
    const chars = text.length;
    const outAddr = allocBuf ? bumpAlloc(chars * 2 + 8) : bufPtr;
    if (allocBuf && bufPtr) deps.runtime.writeInt32(bufPtr, outAddr);
    const cap = allocBuf ? chars + 1 : Math.max(0, nSize);
    const n = Math.min(chars, cap);
    const w = new Uint8Array(n * 2 + 2);
    for (let i = 0; i < n; i++) {
      const c = text.charCodeAt(i);
      w[i * 2] = c & 0xff;
      w[i * 2 + 1] = (c >> 8) & 0xff;
    }
    deps.runtime.writeBytes(outAddr, w);
    return { returnValue: n, errorCode: E.NO_ERROR };
  });
  // guest parses the RT_MENU / RT_ACCELERATOR structures itself). The
  // returned "handle" doubles as the resource address in guest memory, which
  // is what CreateWindowExW receives as hMenu — good enough to keep the UI
  // init path alive. Numeric ids (MAKEINTRESOURCE) resolve from the resource
  // table; string names (e.g. notepad's LoadAcceleratorsW(hInst, L"GlobalAcc"))
  // resolve from the named-resource map merged from the .mui file.
  const loadResBytes = (ctx: ApiCallContext, type: number): ApiResult => {
    const name = ctx.rawArgs[1] ?? 0;
    let entry: { size: number; address: number } | undefined;
    if (name >>> 16 === 0) {
      const key = ((type & 0xffff) << 16) | (name & 0xffff);
      entry = resourceTable.get(key);
      if (entry) lastResourceKey = key;
    } else {
      const s = readWStr(name).toLowerCase();
      if (s) entry = namedResources.get(`${type}:${s}`);
    }
    if (entry) return { returnValue: entry.address, errorCode: E.NO_ERROR };
    // Fallback: resource missing (no MUI) — mint a unique pseudo-handle so
    // guests that null-check LoadMenuW/LoadAcceleratorsW keep going. The
    // handle is never dereferenced as a real resource by our bridge.
    return { returnValue: ++resHandleSeq, errorCode: E.NO_ERROR };
  };
  let resHandleSeq = 0x2000;
  deps.interceptor.hook('user32.dll', 'LoadMenuW', (ctx) => {
    const res = loadResBytes(ctx, 4);
    if (res.returnValue)
      deps.gui.menuByHandle.set(res.returnValue, deps.gui.parseMenuResource(res.returnValue));
    return res;
  });
  // SetMenu attaches a previously LoadMenuW'd RT_MENU to a window. winmine
  // calls this AFTER CreateWindowExW returned (hMenu was NULL at create), so
  // without this hook the host never sees the Game/Help bar. We copy the
  // parsed sections into the window record and notify the host to re-render.
  deps.interceptor.hook('user32.dll', 'SetMenu', (ctx) => {
    const hwnd = ctx.rawArgs[0] ?? 0;
    const hMenu = ctx.rawArgs[1] ?? 0;
    const rec = deps.gui.windowRecords.get(hwnd);
    if (!rec) return { returnValue: 0, errorCode: E.NO_ERROR };
    rec.menu = hMenu ? (deps.gui.menuByHandle.get(hMenu) ?? []) : [];
    deps.onWindowMetaChanged()?.(hwnd);
    return { returnValue: 1, errorCode: E.NO_ERROR };
  });
  deps.interceptor.hook('user32.dll', 'LoadMenuA', (ctx) => loadResBytes(ctx, 4));
  deps.interceptor.hook('user32.dll', 'LoadAcceleratorsW', (ctx) => loadResBytes(ctx, 9));
  deps.interceptor.hook('user32.dll', 'LoadAcceleratorsA', (ctx) => loadResBytes(ctx, 9));

  // LoadCursorW/LoadIconW: notepad stores these handles in globals and tests
  // them for NULL during window init (`cmp [g_cursor], 0; je fail`). The
  // guest never dereferences the handle contents, so a unique non-zero
  // pseudo-handle is enough to keep the init path alive.
  let uiHandleSeq = 0x1000;
  const pseudoUiHandle = (): ApiResult => ({ returnValue: ++uiHandleSeq, errorCode: E.NO_ERROR });
  deps.interceptor.hook('user32.dll', 'LoadCursorW', pseudoUiHandle);
  deps.interceptor.hook('user32.dll', 'LoadCursorA', pseudoUiHandle);
  deps.interceptor.hook('user32.dll', 'LoadIconW', pseudoUiHandle);
  deps.interceptor.hook('user32.dll', 'LoadIconA', pseudoUiHandle);

  // ------------------------------------------------------------------
  // ucrtbase wide/narrow string functions. notepad's save path converts the
  // EDIT text with WideCharToMultiByte and walks the result with wcsnlen /
  // wcscpy; returning 0 for a length made it abort the save. (The stubs are
  // cdecl: caller cleans up, argCount 0 in X86_API_ARG_COUNT.)
  // ------------------------------------------------------------------
  const strReadW = (a: number): string => {
    if (!a) return '';
    const bytes = deps.runtime.readBytes(a >>> 0, 4096);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let s = '';
    for (let i = 0; i + 1 < bytes.byteLength; i += 2) {
      const c = view.getUint16(i, true);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  };
  const strReadA = (a: number): string => {
    if (!a) return '';
    const bytes = deps.runtime.readBytes(a >>> 0, 4096);
    let end = 0;
    while (end < bytes.byteLength && bytes[end] !== 0) end += 1;
    return new TextDecoder('latin1').decode(bytes.subarray(0, end));
  };
  const writeStrW = (a: number, s: string): void => {
    const w = new Uint8Array((s.length + 1) * 2);
    for (let i = 0; i < s.length; i++) {
      w[i * 2] = s.charCodeAt(i) & 0xff;
      w[i * 2 + 1] = (s.charCodeAt(i) >> 8) & 0xff;
    }
    deps.runtime.writeBytes(a >>> 0, w);
  };
  const writeStrA = (a: number, s: string): void => {
    const bytes = new TextEncoder().encode(s);
    const out = new Uint8Array(bytes.byteLength + 1);
    out.set(bytes);
    deps.runtime.writeBytes(a >>> 0, out);
  };
  deps.interceptor.hook('ucrtbase.dll', 'wcsnlen', (ctx) => {
    const s = strReadW(ctx.rawArgs[0] ?? 0);
    const max = ctx.rawArgs[1] ?? 0;
    return { returnValue: Math.min(s.length, max >>> 0), errorCode: E.NO_ERROR };
  });
  deps.interceptor.hook('ucrtbase.dll', 'wcslen', (ctx) => ({
    returnValue: strReadW(ctx.rawArgs[0] ?? 0).length,
    errorCode: E.NO_ERROR,
  }));
  deps.interceptor.hook('ucrtbase.dll', 'strlen', (ctx) => ({
    returnValue: strReadA(ctx.rawArgs[0] ?? 0).length,
    errorCode: E.NO_ERROR,
  }));
  deps.interceptor.hook('ucrtbase.dll', 'wcscpy', (ctx) => {
    const dst = ctx.rawArgs[0] ?? 0;
    const src = strReadW(ctx.rawArgs[1] ?? 0);
    if (dst) writeStrW(dst, src);
    return { returnValue: dst, errorCode: E.NO_ERROR };
  });
  deps.interceptor.hook('ucrtbase.dll', 'wcsncpy', (ctx) => {
    const dst = ctx.rawArgs[0] ?? 0;
    const src = strReadW(ctx.rawArgs[1] ?? 0);
    const n = ctx.rawArgs[2] ?? 0;
    if (dst) writeStrW(dst, src.slice(0, Math.max(0, n)));
    return { returnValue: dst, errorCode: E.NO_ERROR };
  });
  deps.interceptor.hook('ucrtbase.dll', 'strcpy', (ctx) => {
    const dst = ctx.rawArgs[0] ?? 0;
    const src = strReadA(ctx.rawArgs[1] ?? 0);
    if (dst) writeStrA(dst, src);
    return { returnValue: dst, errorCode: E.NO_ERROR };
  });
  deps.interceptor.hook('ucrtbase.dll', 'strncpy', (ctx) => {
    const dst = ctx.rawArgs[0] ?? 0;
    const src = strReadA(ctx.rawArgs[1] ?? 0);
    const n = ctx.rawArgs[2] ?? 0;
    if (dst) writeStrA(dst, src.slice(0, Math.max(0, n)));
    return { returnValue: dst, errorCode: E.NO_ERROR };
  });
  deps.interceptor.hook('ucrtbase.dll', 'wcschr', (ctx) => {
    const s = strReadW(ctx.rawArgs[0] ?? 0);
    const ch = ctx.rawArgs[1] ?? 0;
    const idx = s.indexOf(String.fromCharCode(ch & 0xffff));
    if (idx < 0) return { returnValue: 0, errorCode: E.NO_ERROR };
    return { returnValue: (ctx.rawArgs[0] ?? 0) + idx * 2, errorCode: E.NO_ERROR };
  });
  deps.interceptor.hook('ucrtbase.dll', 'wcsrchr', (ctx) => {
    const s = strReadW(ctx.rawArgs[0] ?? 0);
    const ch = ctx.rawArgs[1] ?? 0;
    const idx = s.lastIndexOf(String.fromCharCode(ch & 0xffff));
    if (idx < 0) return { returnValue: 0, errorCode: E.NO_ERROR };
    return { returnValue: (ctx.rawArgs[0] ?? 0) + idx * 2, errorCode: E.NO_ERROR };
  });
  deps.interceptor.hook('ucrtbase.dll', 'strchr', (ctx) => {
    const s = strReadA(ctx.rawArgs[0] ?? 0);
    const ch = ctx.rawArgs[1] ?? 0;
    const idx = s.indexOf(String.fromCharCode(ch & 0xff));
    if (idx < 0) return { returnValue: 0, errorCode: E.NO_ERROR };
    return { returnValue: (ctx.rawArgs[0] ?? 0) + idx, errorCode: E.NO_ERROR };
  });
  deps.interceptor.hook('ucrtbase.dll', 'strrchr', (ctx) => {
    const s = strReadA(ctx.rawArgs[0] ?? 0);
    const ch = ctx.rawArgs[1] ?? 0;
    const idx = s.lastIndexOf(String.fromCharCode(ch & 0xff));
    if (idx < 0) return { returnValue: 0, errorCode: E.NO_ERROR };
    return { returnValue: (ctx.rawArgs[0] ?? 0) + idx, errorCode: E.NO_ERROR };
  });
  deps.interceptor.hook('ucrtbase.dll', 'wcsncmp', (ctx) => {
    const a = strReadW(ctx.rawArgs[0] ?? 0);
    const b = strReadW(ctx.rawArgs[1] ?? 0);
    const n = (ctx.rawArgs[2] ?? 0) >>> 0;
    const aa = a.slice(0, n);
    const bb = b.slice(0, n);
    return { returnValue: aa < bb ? -1 : aa > bb ? 1 : 0, errorCode: E.NO_ERROR };
  });
  deps.interceptor.hook('ucrtbase.dll', 'wcscmp', (ctx) => {
    const a = strReadW(ctx.rawArgs[0] ?? 0);
    const b = strReadW(ctx.rawArgs[1] ?? 0);
    return { returnValue: a < b ? -1 : a > b ? 1 : 0, errorCode: E.NO_ERROR };
  });
  deps.interceptor.hook('ucrtbase.dll', 'strncmp', (ctx) => {
    const a = strReadA(ctx.rawArgs[0] ?? 0);
    const b = strReadA(ctx.rawArgs[1] ?? 0);
    const n = (ctx.rawArgs[2] ?? 0) >>> 0;
    const aa = a.slice(0, n);
    const bb = b.slice(0, n);
    return { returnValue: aa < bb ? -1 : aa > bb ? 1 : 0, errorCode: E.NO_ERROR };
  });
  deps.interceptor.hook('ucrtbase.dll', 'strcmp', (ctx) => {
    const a = strReadA(ctx.rawArgs[0] ?? 0);
    const b = strReadA(ctx.rawArgs[1] ?? 0);
    return { returnValue: a < b ? -1 : a > b ? 1 : 0, errorCode: E.NO_ERROR };
  });

  // ------------------------------------------------------------------
  // GUI layer: class registration / window creation / message loop are
  // installed by installGuiBridge() (called from run() after the SEH
  // machinery, which owns the nested-executor helpers it needs).
  // ------------------------------------------------------------------

  // ------------------------------------------------------------------
  // Kernel32 mutex fake-handle layer: notepad's single-instance check is
  // `CreateMutexExW(0, name, 0, 0x1f0001)`; with the default 0 return the
  // NULL handle reads as "another instance owns the mutex" and notepad
  // exits before its message loop (the Step 7 blocker). Minting a unique
  // non-zero handle + GetLastError=0 (the existing default) makes the
  // mutex "created by this instance", so the check passes and notepad
  // proceeds to GetMessageW.
  // ------------------------------------------------------------------
  let mutexSeq = 0x20000;
  const createMutex = (): ApiResult => ({ returnValue: ++mutexSeq, errorCode: E.NO_ERROR });
  deps.interceptor.hook('kernel32.dll', 'CreateMutexExW', createMutex);
  deps.interceptor.hook('kernel32.dll', 'CreateMutexW', createMutex);
  deps.interceptor.hook('kernel32.dll', 'CreateMutexA', createMutex);
  deps.interceptor.hook('kernel32.dll', 'OpenMutexW', createMutex);
  deps.interceptor.hook('kernel32.dll', 'OpenMutexA', createMutex);
  deps.interceptor.hook('kernel32.dll', 'ReleaseMutex', () => ok1());
  // notepad's second single-instance step: after the mutex it opens a named
  // semaphore; NULL + GetLastError()==ERROR_FILE_NOT_FOUND means "first
  // run" and startup continues, anything else aborts. Report exactly that.
  deps.interceptor.hook('kernel32.dll', 'OpenSemaphoreW', () => ({
    returnValue: 0,
    errorCode: E.ERROR_FILE_NOT_FOUND,
  }));
  deps.interceptor.hook('kernel32.dll', 'OpenSemaphoreA', () => ({
    returnValue: 0,
    errorCode: E.ERROR_FILE_NOT_FOUND,
  }));
  deps.interceptor.hook('kernel32.dll', 'CreateSemaphoreExW', createMutex);
  // GetLastError must reflect the last failed API call (the interceptor
  // stores non-zero errorCode from dispatched handlers), otherwise guests
  // branching on it — like notepad's single-instance semaphore check —
  // see ERROR_SUCCESS and take the wrong path. The default handler in
  // handlers.ts returns a hard-coded 0.
  deps.interceptor.hook('kernel32.dll', 'GetLastError', (ctx) => ({
    returnValue: deps.interceptor.getLastError(ctx.pid),
    errorCode: E.NO_ERROR,
  }));
  deps.interceptor.hook('kernel32.dll', 'SetLastError', (ctx) => {
    deps.interceptor.setLastError(ctx.pid, ctx.rawArgs[0] ?? 0);
    return { returnValue: 0, errorCode: E.NO_ERROR };
  });

  const moduleHandle = (ctx: ApiCallContext): ApiResult => {
    const name = ctx.rawArgs[0] ?? 0;
    if (name === 0) return { returnValue: base, errorCode: E.NO_ERROR };
    // cmd.exe checks GetModuleHandleW(L"KERNEL32.DLL") during init and
    // aborts when it fails; treat the core system DLLs as loaded. Return a
    // PSEUDO base (non-zero, but NOT the exe's image base): notepad queries
    // ntdll exports during CRT shutdown via
    //   GetProcAddress(GetModuleHandleW("ntdll.dll"), "RtlDisownModuleHeapAllocation")
    // If this returned the exe base, GetProcAddress would treat it as the
    // image and mint a dynamic stub; with a pseudo base the mod!==base
    // branch in GetProcAddress resolves to NULL and the guest skips the
    // call — matching the pre-Step-11 behavior that clean-exited.
    const s = readWStr(name).toLowerCase();
    if (
      s &&
      /^(kernel32|kernelbase|ntdll|ucrtbase|user32|gdi32|advapi32|shell32|comdlg32|ole32|comctl32|shlwapi|msvcrt|version|winmm|oleaut32|setupapi|api-ms-win-)/.test(
        s,
      )
    ) {
      return { returnValue: 0x70000000, errorCode: E.NO_ERROR };
    }
    return { returnValue: 0, errorCode: E.NO_ERROR };
  };
  deps.interceptor.hook('kernel32.dll', 'GetModuleHandleW', moduleHandle);
  deps.interceptor.hook('kernel32.dll', 'GetModuleHandleA', moduleHandle);

  // Resolves APIs resolved DYNAMICALLY via GetProcAddress (installers do
  // this for functions they don't statically import). Known Windows APIs
  // get a fresh trap stub appended after the static ones, so `call` lands
  // in the dispatcher and the handler registry answers; unknown names
  // return NULL like a real lookup miss.
  const allocDynamicStub = (procName: string, moduleName?: string): number => {
    let module = 'kernel32.dll';
    for (const key of deps.interceptor.listHooks()) {
      const bang = key.indexOf('!');
      if (bang > 0 && key.slice(bang + 1).toLowerCase() === procName.toLowerCase()) {
        module = key.slice(0, bang);
        break;
      }
    }
    // Module-qualified lookup first: delay-imports resolved by ordinal get
    // procName "#N" which is meaningless alone (Wldp.dll#10 = 3 stdcall args,
    // Wldp.dll#2 = 5). Without this the stub `ret 0` leaks 4*N bytes per call
    // and drifts the guest stack (cmd parser 0x40b743 +12 -> ebx clobbered).
    // x64 uses the Microsoft x64 calling convention: the CALLER cleans the
    // stack, so the backend emits a plain `ret` (c3). Only 32-bit stdcall
    // imports need `ret <args*4>` — an x64 `ret N` pops N extra bytes and
    // drifts the guest stack (SHGetKnownFolderPath: ret 16 vs ret -> +0x10).
    const argCount = deps.arch.importArgCount(procName, moduleName);
    const index = stubs.length;
    const stubAddress = dynCursor();
    const stub = deps.arch.emitImportStub(index, argCount);
    deps.runtime.writeBytes(stubAddress, stub);
    stubs.push({ index, module, proc: procName, stubAddress, iatAddress: 0 });
    setDynCursor(stubAddress + stub.length);
    return stubAddress;
  };

  deps.interceptor.hook('kernel32.dll', 'GetProcAddress', (ctx) => {
    const mod = ctx.rawArgs[0] ?? 0;
    const name = ctx.rawArgs[1] ?? 0;
    if (name === 0) return { returnValue: 0, errorCode: E.NO_ERROR };
    if ((name & 0x80000000) !== 0) {
      // ordinal: only resolvable against the exe's own export table
      const address = byOrdinal.get(name & 0xffff);
      return address === undefined
        ? { returnValue: 0, errorCode: E.NO_ERROR }
        : { returnValue: base + address, errorCode: E.NO_ERROR };
    }
    const procName = readCStr(name).toLowerCase();
    if (!procName) return { returnValue: 0, errorCode: E.NO_ERROR };
    // 1) the exe's own exports (GetProcAddress on the image base)
    const own = exports.get(procName);
    if (own !== undefined) return { returnValue: base + own, errorCode: E.NO_ERROR };
    // 2) known Windows APIs -> dynamic trap stub (module ignored: we have no
    //    real DLLs, only the handler registry)
    if (mod !== 0 && mod !== base) return { returnValue: 0, errorCode: E.NO_ERROR };
    const stub = allocDynamicStub(procName);
    return { returnValue: stub, errorCode: E.NO_ERROR };
  });

  // ResolveDelayLoadedAPI: notepad delay-loads COMCTL32/SHELL32 functions
  // through .didat thunks. The CRT helper calls this with the delay-load
  // descriptor; we read the DLL/function name, mint a dynamic trap stub and
  // fill the IAT slot so the thunk's `jmp [slot]` lands in our dispatcher.
  // Signature (delayhlp.cpp): (ParentModuleBase, DelayloadDescriptor,
  //   FailureDllHook, RvaToVa, ThunkAddress, Flags).
  deps.interceptor.hook('kernel32.dll', 'ResolveDelayLoadedAPI', (ctx) => {
    const parentBase = (ctx.rawArgs[0] ?? 0) >>> 0;
    const desc = (ctx.rawArgs[1] ?? 0) >>> 0;
    const thunk = (ctx.rawArgs[4] ?? 0) >>> 0;
    const rd32 = (a: number): number => (a ? deps.runtime.readInt32(a) >>> 0 : 0);
    // x64 IAT/INT entries are 8 bytes; x86 entries are 4. The name RVA lives
    // in the low 4 bytes of each entry (RVAs are < 4GB). For x64 the ordinal
    // marker is bit 63 (IMAGE_ORDINAL_FLAG64), which sits in the HIGH dword —
    // reading only the low dword would mistake an ordinal import for a tiny
    // name RVA, resolve nothing, and make ResolveDelayLoadedAPI return 0,
    // which aborts cmd.exe's Wldp.dll delay-load init. So read the full
    // 8-byte thunk-data to detect ordinals on x64.
    const stride = deps.arch.thunkStride;
    const dllRva = rd32(desc + 4);
    const iatRva = rd32(desc + 12);
    const intRva = rd32(desc + 16);
    if (!parentBase || !dllRva || !intRva || !thunk || !iatRva)
      return { returnValue: 0, errorCode: E.NO_ERROR };
    const dllName = readCStr(parentBase + dllRva).toLowerCase();
    const idx = (thunk - (parentBase + iatRva)) / stride;
    const intThunk = parentBase + intRva + idx * stride;
    const entry = deps.arch.readThunkEntry(deps.runtime, intThunk);
    const ORDINAL_FLAG = deps.arch.ordinalFlag;
    let procName: string;
    if ((entry & ORDINAL_FLAG) !== 0n) {
      procName = `#${Number(entry & 0xffffn)}`;
    } else {
      const nameRva = Number(entry & 0xffffffffn);
      procName = readCStr(parentBase + nameRva + 2);
    }
    if (!procName) return { returnValue: 0, errorCode: E.NO_ERROR };
    const stub = allocDynamicStub(procName, dllName);
    if (!stub) return { returnValue: 0, errorCode: E.NO_ERROR };
    // For x64 the IAT slot is 8 bytes; resolve it with a full 64-bit pointer
    // (guest addresses stay in the low 4GB, so the high dword is 0). The
    // backend's writeIatSlot mirrors the delay-load x86/x64 behavior.
    deps.arch.writeIatSlot(deps.runtime, thunk, stub >>> 0, dllName);
    return { returnValue: stub, errorCode: E.NO_ERROR };
  });

  const pseudoLoad = (): ApiResult => ({ returnValue: base, errorCode: E.NO_ERROR });
  deps.interceptor.hook('kernel32.dll', 'LoadLibraryW', pseudoLoad);
  deps.interceptor.hook('kernel32.dll', 'LoadLibraryA', pseudoLoad);
  deps.interceptor.hook('kernel32.dll', 'LoadLibraryExW', pseudoLoad);
  deps.interceptor.hook('kernel32.dll', 'LoadLibraryExA', pseudoLoad);

  // CRT exit paths terminate the process like ExitProcess. Without this,
  // notepad's WinMain failure path calls _o_exit (ucrtbase), our handler
  // registry answers 0, the guest falls through the trailing int3 padding
  // into __scrt_common_main_seh and re-enters WinMain — an infinite
  // re-init loop (each pass reallocates the string table and stacks grow).
  const crtExit = (ctx: ApiCallContext): ApiResult => {
    deps.state.exitCode = (ctx.rawArgs[0] ?? 0) & 0xffffffff;
    deps.state.exitRequested = true;
    deps.runtime.setEip(0);
    return { returnValue: 0, errorCode: E.NO_ERROR };
  };
  for (const name of ['_exit', '_Exit', 'exit', '_o_exit', '_o__exit']) {
    deps.interceptor.hook('ucrtbase.dll', name, crtExit);
  }

  // GetModuleFileNameW/A: report the module path so the guest can reopen its
  // own file (installers read their archive overlay from disk).
  if (deps.state.modulePath) {
    // Real Windows reports module paths with backslashes; guest binaries
    // (esp. cmd.exe) split on the last '\' to find their own directory.
    // Normalize forward slashes so that path parsing works correctly.
    const pathW = deps.state.modulePath.replace(/\//g, '\\') + '\0';
    const pathA = pathW;
    deps.interceptor.hook('kernel32.dll', 'GetModuleFileNameW', (ctx) => {
      const buf = ctx.rawArgs[1] ?? 0;
      const cap = ctx.rawArgs[2] ?? 0;
      if (!buf || !cap) return { returnValue: 0, errorCode: E.NO_ERROR };
      const bytes = new TextEncoder().encode(pathW);
      const n = Math.min(cap, pathW.length - 1); // exclude the NUL
      const w = new Uint8Array(n * 2);
      for (let i = 0; i < n; i++) w[i * 2] = bytes[i] ?? 0;
      deps.runtime.writeBytes(buf, w);
      return { returnValue: n, errorCode: E.NO_ERROR };
    });
    deps.interceptor.hook('kernel32.dll', 'GetModuleFileNameA', (ctx) => {
      const buf = ctx.rawArgs[1] ?? 0;
      const cap = ctx.rawArgs[2] ?? 0;
      if (!buf || !cap) return { returnValue: 0, errorCode: E.NO_ERROR };
      const bytes = new TextEncoder().encode(pathA);
      const n = Math.min(cap, pathA.length);
      deps.runtime.writeBytes(buf, bytes.subarray(0, n));
      return { returnValue: n, errorCode: E.NO_ERROR };
    });
  }

  // SetFilePointer -> fs bridge (the default handler returns 0 and installers
  // that read their own payload in chunks get stuck at offset 0).
  deps.interceptor.hook('kernel32.dll', 'SetFilePointer', (ctx, host) => {
    const handle = ctx.rawArgs[0] ?? 0;
    const dist = (ctx.rawArgs[1] ?? 0) | 0;
    const method = ctx.rawArgs[3] ?? 0;
    return host.fs
      .setFilePointer(handle, dist, method)
      .then((r) =>
        r.error === E.NO_ERROR
          ? { returnValue: r.newPointer, errorCode: E.NO_ERROR }
          : { returnValue: 0xffffffff, errorCode: r.error },
      );
  });

  // CreateFileW with proper UTF-16 path decoding (the default handler reads
  // the wide string as ANSI and stops at the first NUL byte).
  deps.interceptor.hook('kernel32.dll', 'CreateFileW', (ctx, host) => {
    const path = readWStr(ctx.rawArgs[0] ?? 0);
    if (!path) return { returnValue: 0xffffffff, errorCode: E.ERROR_FILE_NOT_FOUND };
    return host.fs
      .createFile(
        path,
        ctx.rawArgs[1] ?? 0,
        ctx.rawArgs[2] ?? 0,
        ctx.rawArgs[4] ?? 0,
        ctx.rawArgs[5] ?? 0,
      )
      .then((r) => {
        if (r.error === E.NO_ERROR) {
          // A successful CreateFileW leaves GetLastError() = 0 (real Windows:
          // OPEN_ALWAYS on an existing file would set ERROR_ALREADY_EXISTS,
          // but notepad's save flow only tests "== 0 → ok"). The interceptor
          // only records NON-zero errorCodes, so a stale error from an earlier
          // failed call (e.g. GetFileAttributesW) survives here and notepad
          // would abort the save. Clear it explicitly.
          deps.interceptor.setLastError(ctx.pid, 0);
          return { returnValue: r.handle, errorCode: E.NO_ERROR };
        }
        return { returnValue: 0xffffffff, errorCode: r.error };
      });
  });

  // DeleteFileW/A — notepad's Save As DELETES the target file before
  // writing the new contents. Without a handler the interceptor returns 0
  // with ERROR_CALL_NOT_IMPLEMENTED, which notepad formats as "This function
  // is not supported on this system." and aborts the save. (design doc 3.1.7)
  deps.interceptor.hook('kernel32.dll', 'DeleteFileW', (ctx, host) => {
    const path = readWStr(ctx.rawArgs[0] ?? 0);
    if (!path) return { returnValue: 0, errorCode: E.ERROR_FILE_NOT_FOUND };
    return host.fs.deleteFile(path).then((err) => {
      if (err === E.NO_ERROR) {
        deps.interceptor.setLastError(ctx.pid, 0);
        return { returnValue: 1, errorCode: E.NO_ERROR };
      }
      return { returnValue: 0, errorCode: err };
    });
  });
  deps.interceptor.hook('kernel32.dll', 'DeleteFileA', (ctx, host) => {
    const path = readCStr(ctx.rawArgs[0] ?? 0);
    if (!path) return { returnValue: 0, errorCode: E.ERROR_FILE_NOT_FOUND };
    return host.fs.deleteFile(path).then((err) => {
      if (err === E.NO_ERROR) {
        deps.interceptor.setLastError(ctx.pid, 0);
        return { returnValue: 1, errorCode: E.NO_ERROR };
      }
      return { returnValue: 0, errorCode: err };
    });
  });

  // PathFileExistsW/A (shlwapi) — BOOL existence probe. notepad checks the
  // target before Save As (to show the "replace?" prompt / delete old file).
  // The default handler returns 0 = "does not exist" with an error, which
  // makes overwrite flows behave as if the file were never there.
  const pathExists =
    (readPath: (ctx: ApiCallContext) => string) =>
    async (ctx: ApiCallContext, host: ApiHost): Promise<ApiResult> => {
      const path = readPath(ctx);
      if (!path) return { returnValue: 0, errorCode: E.NO_ERROR };
      const res = await host.fs.getFileAttributes(path);
      return { returnValue: res.error === E.NO_ERROR ? 1 : 0, errorCode: E.NO_ERROR };
    };
  deps.interceptor.hook(
    'shlwapi.dll',
    'PathFileExistsW',
    pathExists((ctx) => readWStr(ctx.rawArgs[0] ?? 0)),
  );
  deps.interceptor.hook(
    'shlwapi.dll',
    'PathFileExistsA',
    pathExists((ctx) => readCStr(ctx.rawArgs[0] ?? 0)),
  );
  // api-ms-win-core-shlwapi-legacy-l1-1-0.dll normalizes to shlwapi.dll via
  // normalizeApiSetModule, so the hooks above are sufficient; keep aliases
  // on kernel32 for guests that import it through the core api-set path.
  deps.interceptor.hook(
    'kernel32.dll',
    'PathFileExistsW',
    pathExists((ctx) => readWStr(ctx.rawArgs[0] ?? 0)),
  );
  deps.interceptor.hook(
    'kernel32.dll',
    'PathFileExistsA',
    pathExists((ctx) => readCStr(ctx.rawArgs[0] ?? 0)),
  );

  // SetEndOfFile(hFile) — truncate/extend the file to the current pointer.
  // notepad's save routine calls it right after WriteFile; without a
  // handler it returns ERROR_CALL_NOT_IMPLEMENTED and rewrites of an
  // existing (longer) file keep the stale tail beyond the new content.
  deps.interceptor.hook('kernel32.dll', 'SetEndOfFile', (ctx, host) =>
    host.fs.setEndOfFile(ctx.rawArgs[0] ?? 0).then((err) => {
      if (err === E.NO_ERROR) return { returnValue: 1, errorCode: E.NO_ERROR };
      return { returnValue: 0, errorCode: err };
    }),
  );

  // Truthful VirtualQuery. The default handler claims the whole 4GB is one
  // committed region (RegionSize=0xFFFFFFFF), which makes region-walking
  // loops (packers/installers probe every 64KB page of their image) walk
  // past the actual linear-memory end and trap with "memory access out of
  // bounds" exactly at the memory boundary. Answer with the real region:
  // one committed page-aligned region from the queried page to the end of
  // the current linear memory, and fail (return 0) beyond it so walkers
  // stop instead of probing into the void.
  const memSize = deps.runtime.memory.buffer.byteLength;
  deps.interceptor.hook('kernel32.dll', 'VirtualQuery', (ctx) => {
    const address = ctx.rawArgs[0] ?? 0;
    const out = ctx.rawArgs[1] ?? 0;
    const len = ctx.rawArgs[2] ?? 0;
    if (!address || !out || address >= memSize)
      return { returnValue: 0, errorCode: E.ERROR_INVALID_PARAMETER };
    const baseAddress = address & ~0xfff; // page-align down
    const regionSize = memSize - baseAddress;
    const w = new Uint8Array(28);
    const view = new DataView(w.buffer);
    view.setUint32(0, baseAddress, true); // BaseAddress
    view.setUint32(4, baseAddress, true); // AllocationBase
    view.setUint32(8, 0x04, true); // AllocationProtect = PAGE_READWRITE
    view.setUint32(12, regionSize, true); // RegionSize (real, not 4GB)
    view.setUint32(16, 0x1000, true); // State = MEM_COMMIT
    view.setUint32(20, 0x04, true); // Protect = PAGE_READWRITE
    view.setUint32(24, 0x20000, true); // Type = MEM_PRIVATE
    const n = Math.min(28, len);
    deps.runtime.writeBytes(out, w.subarray(0, n));
    return { returnValue: n, errorCode: E.NO_ERROR };
  });

  // ------------------------------------------------------------------
  // Minimal heap / virtual memory (real installers unpack megabytes).
  // A bump allocator over the free space ABOVE the stack headroom: the
  // stack grows down from 0x08000000 while the heap grows up from just
  // past it, so they never collide. Blocks get an 8-byte size header at
  // [user-4] (what msvcrt/NSIS heap code reads); frees are no-ops.
  // ------------------------------------------------------------------
  const heapBase = (deps.runtime.memory.buffer.byteLength + 0xffff) & ~0xffff;
  let heapCursor = heapBase;
  const heapHandle = heapBase;
  const bumpAlloc = (size: number): number => {
    const blockSize = Math.max(8, (size + 8 + 7) & ~7);
    heapCursor = (heapCursor + 7) & ~7;
    const user = heapCursor;
    heapCursor += blockSize;
    deps.runtime.ensure(heapCursor + 0x1000);
    deps.runtime.writeInt32(user - 4, blockSize);
    return user;
  };
  deps.state.guestHeapAlloc = bumpAlloc;

  // SEH dispatch scratch (see installSehDispatch): an executable sentinel
  // stub (`int 0x2d` stops the nested handler run with EAX = disposition),
  // plus room for the EXCEPTION_RECORD (80 bytes) and x86 CONTEXT (0x2CC).
  // Allocated from the bump heap — never freed, stable for the whole run.
  deps.seh.sentinelAddr = bumpAlloc(8);
  deps.seh.excAddr = bumpAlloc(0x80);
  deps.seh.ctxAddr = bumpAlloc(X86_CONTEXT_SIZE);
  deps.runtime.writeBytes(deps.seh.sentinelAddr, new Uint8Array([0xcd, SEH_SENTINEL_VECTOR]));

  // GetCommandLineW/A: return pointers to the (possibly empty) command line
  // in guest memory. Returning 0 makes CRT arg parsing walk address 0 and
  // spin forever (e.g. notepad's tokenizer + CharNextW).
  // Windows convention: the FULL command line starts with the executable
  // (quoted, full path), followed by the arguments. notepad tokenizes it
  // and treats the first token as argv[0] (the exe) — if only the file
  // argument is present it lands in argv[0] and notepad never opens it.
  const exeName = deps.state.modulePath.split(/[\\/]/).pop() ?? 'app.exe';
  // Empty commandLine => custom cmd (session 10) requires GetCommandLineW to
  // be empty so it enters interactive mode; non-empty => full command line so
  // notepad's tokenizer can skip the exe name and open the file argument.
  const fullCmdLine = deps.state.commandLine
    ? `${deps.state.modulePath} ${deps.state.commandLine}`
    : '';
  const cmdLine = fullCmdLine;
  // WinMain's lpCmdLine is the ARGUMENTS ONLY (no exe name) — Windows
  // convention. notepad's wWinMain treats lpCmdLine as the file to open, so
  // it must NOT start with the exe name.
  const cmdLineArgs = deps.state.commandLine;
  // Environment entries shared by the wide/narrow blocks and _environ.
  // cmd.exe walks the GetEnvironmentStringsW block with wcslen-style loops
  // (0x40b836) and reads COMSPEC/PATH/PROMPT; returning 0 makes it spin on
  // the SEH chain bytes at guest address 0.
  const envEntries: Array<[string, string]> = [
    ['=C:', 'C:\\'],
    ['SystemRoot', 'C:\\Windows'],
    ['COMSPEC', 'C:\\Windows\\System32\\cmd.exe'],
    ['PATH', 'C:\\Windows\\SysWOW64;C:\\Windows\\System32;C:\\Windows'],
    ['TEMP', 'C:\\Users\\Guest\\AppData\\Local\\Temp'],
    ['TMP', 'C:\\Users\\Guest\\AppData\\Local\\Temp'],
    ['USERPROFILE', 'C:\\Users\\Guest'],
    ['HOMEDRIVE', 'C:'],
    ['HOMEPATH', '\\Users\\Guest'],
    ['PROMPT', '$P$G'],
    ['PATHEXT', '.COM;.EXE;.BAT;.CMD'],
    ['OS', 'Windows_NT'],
    ['NUMBER_OF_PROCESSORS', '1'],
    ['PROCESSOR_ARCHITECTURE', 'x86'],
  ];
  const cmdLineW = bumpAlloc((cmdLine.length + 1) * 2);
  {
    const w = new Uint8Array((cmdLine.length + 1) * 2);
    for (let i = 0; i < cmdLine.length; i++) {
      w[i * 2] = cmdLine.charCodeAt(i) & 0xff;
      w[i * 2 + 1] = (cmdLine.charCodeAt(i) >> 8) & 0xff;
    }
    deps.runtime.writeBytes(cmdLineW, w);
  }
  const cmdLineA = bumpAlloc(cmdLine.length + 1);
  {
    const w = new Uint8Array(cmdLine.length + 1);
    for (let i = 0; i < cmdLine.length; i++) w[i] = cmdLine.charCodeAt(i) & 0xff;
    deps.runtime.writeBytes(cmdLineA, w);
  }
  // WinMain lpCmdLine (arguments only, wide).
  const cmdLineArgsW = bumpAlloc((cmdLineArgs.length + 1) * 2);
  {
    const w = new Uint8Array((cmdLineArgs.length + 1) * 2);
    for (let i = 0; i < cmdLineArgs.length; i++) {
      w[i * 2] = cmdLineArgs.charCodeAt(i) & 0xff;
      w[i * 2 + 1] = (cmdLineArgs.charCodeAt(i) >> 8) & 0xff;
    }
    deps.runtime.writeBytes(cmdLineArgsW, w);
  }
  deps.interceptor.hook('kernel32.dll', 'GetCommandLineW', () => ({
    returnValue: cmdLineW,
    errorCode: E.NO_ERROR,
  }));
  deps.interceptor.hook('kernel32.dll', 'GetCommandLineA', () => ({
    returnValue: cmdLineA,
    errorCode: E.NO_ERROR,
  }));
  // UCRT's wide command-line accessor (imported via api-ms-win-crt-private,
  // normalized to ucrtbase.dll). Returning 0 makes the CRT arg tokenizer
  // call CharNextW(0) forever.
  deps.interceptor.hook('ucrtbase.dll', '_o__get_wide_winmain_command_line', () => ({
    returnValue: cmdLineArgsW,
    errorCode: E.NO_ERROR,
  }));
  deps.interceptor.hook('ucrtbase.dll', '_get_wide_winmain_command_line', () => ({
    returnValue: cmdLineArgsW,
    errorCode: E.NO_ERROR,
  }));
  // __argc/__argv (and the private _o__ variants): console programs like
  // cmd.exe read argc/argv through these; returning 0 makes main() see a
  // NULL argv and exit immediately. Windows convention: argv[0] is the
  // executable path, argv[1..] are the command-line arguments. The
  // commandLine option carries ONLY the arguments (CreateProcess-style),
  // so the exe name is prepended here — without it, notepad treats the
  // first file argument as argv[0] and never opens it.
  // Windows convention: argv[0] is the executable path, argv[1..] the args.
  // BUT the custom cmd build (session 10) treats `__argc == 0` as "plain
  // interactive shell" and `__argc > 0` as "invoked with args" (silently
  // skips dir/echo output). So the exe-name prefix is added ONLY when real
  // arguments exist — an empty commandLine must yield __argc == 0.
  const argTokens = deps.state.commandLine.trim().split(/\s+/).filter(Boolean);
  const argvParts = argTokens.length > 0 ? [exeName, ...argTokens] : [];
  const argvSlot = bumpAlloc((argvParts.length + 1) * 4);
  const argvStrings: number[] = [];
  for (const part of argvParts) {
    const p = bumpAlloc(part.length + 1);
    const w = new Uint8Array(part.length + 1);
    for (let i = 0; i < part.length; i++) w[i] = part.charCodeAt(i) & 0xff;
    deps.runtime.writeBytes(p, w);
    argvStrings.push(p);
  }
  for (let i = 0; i < argvStrings.length; i++) {
    deps.runtime.writeInt32(argvSlot + i * 4, argvStrings[i]!);
  }
  deps.runtime.writeInt32(argvSlot + argvStrings.length * 4, 0); // NULL terminator
  // Wide __wargv for wmain-based console programs.
  const argvWSlot = bumpAlloc((argvParts.length + 1) * 4);
  const argvWStrings: number[] = [];
  for (const part of argvParts) {
    const p = bumpAlloc((part.length + 1) * 2);
    const w = new Uint8Array((part.length + 1) * 2);
    for (let i = 0; i < part.length; i++) {
      w[i * 2] = part.charCodeAt(i) & 0xff;
      w[i * 2 + 1] = (part.charCodeAt(i) >> 8) & 0xff;
    }
    deps.runtime.writeBytes(p, w);
    argvWStrings.push(p);
  }
  for (let i = 0; i < argvWStrings.length; i++) {
    deps.runtime.writeInt32(argvWSlot + i * 4, argvWStrings[i]!);
  }
  deps.runtime.writeInt32(argvWSlot + argvWStrings.length * 4, 0);
  // Environment block for _environ / getenv (narrow char* env[] array).
  const envSlot = bumpAlloc((envEntries.length + 1) * 4);
  {
    let i = 0;
    for (const [k, v] of envEntries) {
      const s = `${k}=${v}`;
      const p = bumpAlloc(s.length + 1);
      const w = new Uint8Array(s.length + 1);
      for (let j = 0; j < s.length; j++) w[j] = s.charCodeAt(j) & 0xff;
      deps.runtime.writeBytes(p, w);
      deps.runtime.writeInt32(envSlot + i * 4, p);
      i++;
    }
    deps.runtime.writeInt32(envSlot + i * 4, 0); // NULL terminator
  }
  // Wide environment block (GetEnvironmentStringsW): double-NUL UTF-16LE.
  {
    let total = 0;
    for (const [k, v] of envEntries) total += k.length + 1 + v.length + 1;
    const buf = bumpAlloc((total + 1) * 2);
    const w = new Uint8Array((total + 1) * 2);
    let off = 0;
    for (const [k, v] of envEntries) {
      const s = `${k}=${v}`;
      for (let i = 0; i < s.length; i++) {
        w[off * 2] = s.charCodeAt(i) & 0xff;
        w[off * 2 + 1] = (s.charCodeAt(i) >> 8) & 0xff;
        off++;
      }
      off++; // NUL between entries
    }
    off++; // final NUL -> double NUL terminator
    deps.runtime.writeBytes(buf, w);
    deps.state.wideEnvBlock = buf;
  }
  // Narrow environment block (GetEnvironmentStringsA): double-NUL ANSI.
  {
    let total = 0;
    for (const [k, v] of envEntries) total += k.length + 1 + v.length + 1;
    const buf = bumpAlloc(total + 1);
    const w = new Uint8Array(total + 1);
    let off = 0;
    for (const [k, v] of envEntries) {
      const s = `${k}=${v}`;
      for (let i = 0; i < s.length; i++) w[off++] = s.charCodeAt(i) & 0xff;
      off++; // NUL between entries
    }
    w[off] = 0; // final NUL -> double NUL terminator
    deps.runtime.writeBytes(buf, w);
    deps.state.narrowEnvBlock = buf;
  }
  deps.interceptor.hook('kernel32.dll', 'GetEnvironmentStringsW', () => ({
    returnValue: deps.state.wideEnvBlock,
    errorCode: E.NO_ERROR,
  }));
  deps.interceptor.hook('kernel32.dll', 'GetEnvironmentStringsA', () => ({
    returnValue: deps.state.narrowEnvBlock,
    errorCode: E.NO_ERROR,
  }));
  for (const name of [
    '_o___p___argv',
    '___p___argv',
    '__p___argv',
    '_o___p___argc',
    '___p___argc',
    '__p___argc',
    '_o___p___wargv',
    '___p___wargv',
    '__p___wargv',
    '_o___p___wargc',
    '___p___wargc',
    '__p___wargc',
  ]) {
    deps.interceptor.hook('ucrtbase.dll', name, () => ({
      returnValue: name.toLowerCase().endsWith('argc')
        ? argvParts.length
        : name.includes('wargv')
          ? argvWSlot
          : argvSlot,
      errorCode: E.NO_ERROR,
    }));
  }
  for (const name of [
    '_o__get_initial_narrow_environment',
    '_get_initial_narrow_environment',
    '_o__get_initial_wide_environment',
    '_get_initial_wide_environment',
    '_o__environ',
    '___environ',
  ]) {
    deps.interceptor.hook('ucrtbase.dll', name, () => ({
      returnValue: envSlot,
      errorCode: E.NO_ERROR,
    }));
  }
  // Current working directory (per-run): cmd.exe's prompt and relative
  // paths depend on it. The virtual disk is mounted at C:\, so the CWD
  // lives under C:\.
  const readW = (a: number): string => {
    if (!a) return '';
    const bytes = deps.runtime.readBytes(a, 2048);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let s = '';
    for (let i = 0; i + 1 < bytes.byteLength; i += 2) {
      const c = view.getUint16(i, true);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  };
  const writeW = (a: number, s: string, maxChars: number): number => {
    const n = Math.min(s.length, Math.max(0, maxChars - 1));
    const w = new Uint8Array(n * 2 + 2);
    for (let i = 0; i < n; i++) {
      w[i * 2] = s.charCodeAt(i) & 0xff;
      w[i * 2 + 1] = (s.charCodeAt(i) >> 8) & 0xff;
    }
    deps.runtime.writeBytes(a, w);
    return n;
  };
  const readA = (a: number): string => {
    if (!a) return '';
    const bytes = deps.runtime.readBytes(a, 4096);
    let s = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      if (bytes[i] === 0) break;
      s += String.fromCharCode(bytes[i]!);
    }
    return s;
  };
  const writeA = (a: number, s: string, maxChars: number): number => {
    const n = Math.min(s.length, Math.max(0, maxChars - 1));
    const w = new Uint8Array(n + 1);
    for (let i = 0; i < n; i++) w[i] = s.charCodeAt(i) & 0xff;
    deps.runtime.writeBytes(a, w);
    return n;
  };
  // GetEnvironmentVariableW/A: look up the env block. cmd.exe reads
  // COMSPEC / PATH / PROMPT through these.
  const envVar = (name: string): string | undefined => {
    for (const [k, v] of envEntries) if (k === name) return v;
    return undefined;
  };
  deps.interceptor.hook('kernel32.dll', 'GetEnvironmentVariableW', (ctx) => {
    const name = readW(ctx.rawArgs[0] ?? 0);
    const val = envVar(name);
    if (val === undefined) return { returnValue: 0, errorCode: E.NO_ERROR }; // not found
    const buf = ctx.rawArgs[1] ?? 0;
    if (buf) return { returnValue: writeW(buf, val, ctx.rawArgs[2] ?? 0), errorCode: E.NO_ERROR };
    return { returnValue: val.length, errorCode: E.NO_ERROR };
  });
  deps.interceptor.hook('kernel32.dll', 'GetEnvironmentVariableA', (ctx) => {
    const name = readA(ctx.rawArgs[0] ?? 0);
    const val = envVar(name);
    if (val === undefined) return { returnValue: 0, errorCode: E.NO_ERROR }; // not found
    const buf = ctx.rawArgs[1] ?? 0;
    if (buf) return { returnValue: writeA(buf, val, ctx.rawArgs[2] ?? 0), errorCode: E.NO_ERROR };
    return { returnValue: val.length, errorCode: E.NO_ERROR };
  });
  deps.interceptor.hook('kernel32.dll', 'GetCurrentDirectoryW', (ctx) => {
    const buf = ctx.rawArgs[1] ?? 0;
    if (buf)
      return {
        returnValue: writeW(buf, deps.state.cwd, ctx.rawArgs[0] ?? 0),
        errorCode: E.NO_ERROR,
      };
    return { returnValue: deps.state.cwd.length, errorCode: E.NO_ERROR };
  });
  deps.interceptor.hook('kernel32.dll', 'GetCurrentDirectoryA', (ctx) => {
    const buf = ctx.rawArgs[1] ?? 0;
    if (buf) {
      const w = new Uint8Array(deps.state.cwd.length + 1);
      for (let i = 0; i < deps.state.cwd.length; i++) w[i] = deps.state.cwd.charCodeAt(i) & 0xff;
      deps.runtime.writeBytes(buf, w);
    }
    return { returnValue: deps.state.cwd.length, errorCode: E.NO_ERROR };
  });
  deps.interceptor.hook('kernel32.dll', 'GetFullPathNameW', (ctx) => {
    const input = readW(ctx.rawArgs[0] ?? 0);
    const cap = ctx.rawArgs[1] ?? 0;
    const buf = ctx.rawArgs[2] ?? 0;
    const filePart = ctx.rawArgs[3] ?? 0;
    // Path resolution per Win32 rules:
    //   drive-absolute ("C:\...")  -> as-is.
    //   root-relative ("\foo")       -> prepend current drive (NOT cwd).
    //   relative ("foo")              -> prepend cwd.
    let absolute: string;
    if (/^[A-Za-z]:[\\/]/.test(input)) {
      absolute = input;
    } else if (input.startsWith('\\') || input.startsWith('/')) {
      // Strip leading separators, take the current drive ("C:").
      const rest = input.replace(/^[\\/]+/, '');
      const drive = deps.state.cwd.match(/^[A-Za-z]:/) ? deps.state.cwd.slice(0, 2) : 'C:';
      absolute = rest ? `${drive}\\${rest}` : `${drive}\\`;
    } else {
      absolute = `${deps.state.cwd.replace(/[\\/]$/, '')}\\${input}`;
    }
    if (!buf || !cap) return { returnValue: absolute.length, errorCode: E.NO_ERROR };
    if (absolute.length >= cap) {
      writeW(buf, absolute, cap);
      return { returnValue: absolute.length + 1, errorCode: E.NO_ERROR };
    }
    writeW(buf, absolute, cap);
    if (filePart) {
      const slash = Math.max(absolute.lastIndexOf('\\'), absolute.lastIndexOf('/'));
      deps.runtime.writeInt32(filePart, (buf + Math.max(0, slash + 1) * 2) >>> 0);
    }
    return { returnValue: absolute.length, errorCode: E.NO_ERROR };
  });
  deps.interceptor.hook('kernel32.dll', 'SetCurrentDirectoryW', (ctx) => {
    const p = readW(ctx.rawArgs[0] ?? 0);
    deps.state.cwd = p || deps.state.cwd;
    return { returnValue: 1, errorCode: E.NO_ERROR };
  });
  deps.interceptor.hook('kernel32.dll', 'SetCurrentDirectoryA', (ctx) => {
    const p = ctx.rawArgs[0] ?? 0;
    if (p) {
      const bytes = deps.runtime.readBytes(p, 2048);
      let s = '';
      for (const b of bytes) {
        if (b === 0) break;
        s += String.fromCharCode(b);
      }
      deps.state.cwd = s || deps.state.cwd;
    }
    return { returnValue: 1, errorCode: E.NO_ERROR };
  });

  // ------------------------------------------------------------------
  // TEB + TLS. The decoder ignores segment prefixes, so fs: behaves like
  // a flat base of 0 — i.e. the guest TEB sits at guest address 0. That is
  // already how SEH works here (fs:[0] -> [0]). TEB+0x2C is the
  // ThreadLocalStoragePointer; Inno's embedded RTL reads TLS INLINE via
  // fs:[0x2c] (see 0x40f7d0) instead of calling TlsGetValue, so both the
  // inlined path and the kernel32 TlsSetValue/TlsGetValue handlers must
  // agree on the SAME array. Slot 0 is where Inno stores its exception
  // frame list head (TlsSetValue(0, ...) in the log).
  // ------------------------------------------------------------------
  const tlsSlotCount = 128;
  const tlsArray = bumpAlloc(tlsSlotCount * 4);
  deps.runtime.writeInt32(0x2c, tlsArray);
  // Seed slot 0 from the PE TLS directory: allocate a per-thread TLS block,
  // copy the template, and point TLS array[0] at it. Inno's embedded RTL
  // reads TLS inline via fs:[0x2c] (see 0x40cc60) and stores its exception-
  // frame list head in slot 0. Without the template the slot stays 0, so the
  // frame push/pop code reads/writes [0] (the SEH chain head at TEB+0)
  // instead of the frame head variable — corrupting the SEH chain and then
  // treating an SEH record as a finally-frame (magic check fails -> fault).
  const tls = pe.tls;
  if (tls && tls.templateRva) {
    const tlsBlock = bumpAlloc(tls.templateSize + tls.zeroFillSize);
    if (tls.templateSize > 0) deps.runtime.writeBytes(tlsBlock, tls.template);
    deps.runtime.writeInt32(tlsArray, tlsBlock);
    if (tls.indexRva) deps.runtime.writeInt32(tls.indexRva + pe.baseAddress, 0);
  }
  deps.interceptor.hook('kernel32.dll', 'TlsGetValue', (ctx) => {
    const slot = (ctx.rawArgs[0] ?? 0) >>> 0;
    return {
      returnValue: slot < tlsSlotCount ? deps.runtime.readInt32(tlsArray + slot * 4) : 0,
      errorCode: E.NO_ERROR,
    };
  });
  deps.interceptor.hook('kernel32.dll', 'TlsSetValue', (ctx) => {
    const slot = (ctx.rawArgs[0] ?? 0) >>> 0;
    const value = (ctx.rawArgs[1] ?? 0) >>> 0;
    if (slot < tlsSlotCount) deps.runtime.writeInt32(tlsArray + slot * 4, value);
    return { returnValue: 1, errorCode: E.NO_ERROR };
  });

  deps.interceptor.hook('kernel32.dll', 'GetProcessHeap', () => ({
    returnValue: heapHandle,
    errorCode: E.NO_ERROR,
  }));
  deps.interceptor.hook('kernel32.dll', 'GetProcessHeapEx', () => ({
    returnValue: heapHandle,
    errorCode: E.NO_ERROR,
  }));
  deps.interceptor.hook('kernel32.dll', 'HeapCreate', () => ({
    returnValue: heapHandle,
    errorCode: E.NO_ERROR,
  }));
  deps.interceptor.hook('kernel32.dll', 'HeapDestroy', () => ok1());
  deps.interceptor.hook('kernel32.dll', 'HeapAlloc', (ctx) => {
    const size = ctx.rawArgs[2] ?? 0;
    return { returnValue: bumpAlloc(size), errorCode: E.NO_ERROR };
  });
  deps.interceptor.hook('kernel32.dll', 'HeapReAlloc', (ctx) => {
    // HeapReAlloc(hHeap, dwFlags, lpMem, dwBytes): lpMem is rawArgs[2],
    // NOT rawArgs[1] (dwFlags). Using rawArgs[1] made old=0 -> bumpAlloc
    // without copying, so cmd's 0x411cd0 realloc helper (used by the
    // 0x40fed0 tokenizer tail) returned an EMPTY string. Same class of
    // arg-index bug as HeapSize below.
    const old = ctx.rawArgs[2] ?? 0;
    const size = ctx.rawArgs[3] ?? 0;
    if (!old) return { returnValue: bumpAlloc(size), errorCode: E.NO_ERROR };
    const oldSize = Math.max(0, deps.runtime.readInt32(old - 4) & ~7);
    const next = bumpAlloc(size);
    const n = Math.min(oldSize, size);
    if (n > 0) deps.runtime.writeBytes(next, deps.runtime.readBytes(old, n));
    return { returnValue: next, errorCode: E.NO_ERROR };
  });
  deps.interceptor.hook('kernel32.dll', 'HeapFree', () => ok1());
  // HeapSize(hHeap, dwFlags, lpMem) = 3 args; lpMem is rawArgs[2]. The old
  // code read rawArgs[1] (dwFlags=0) and always returned 0 — harmless only
  // while callers ignored the result (cmd's 0x411cd0 helper).
  deps.interceptor.hook('kernel32.dll', 'HeapSize', (ctx) => {
    const p = ctx.rawArgs[2] ?? 0;
    return {
      returnValue: p ? Math.max(0, deps.runtime.readInt32(p - 4) & ~7) : 0,
      errorCode: E.NO_ERROR,
    };
  });
  deps.interceptor.hook('kernel32.dll', 'LocalAlloc', (ctx) => {
    const size = ctx.rawArgs[1] ?? 0;
    return { returnValue: bumpAlloc(size), errorCode: E.NO_ERROR };
  });
  deps.interceptor.hook('kernel32.dll', 'LocalFree', () => ({
    returnValue: 0,
    errorCode: E.NO_ERROR,
  }));
  // LocalLock/LocalUnlock: notepad's save flow locks the EM_GETHANDLE text
  // handle and reads the buffer directly. Fixed (LMEM_FIXED) memory locks to
  // itself, so LocalLock returns the handle unchanged; unlock reports 0
  // (lock count reached 0) with NO_ERROR like a fixed block.
  deps.interceptor.hook('kernel32.dll', 'LocalLock', (ctx) => ({
    returnValue: ctx.rawArgs[0] ?? 0,
    errorCode: E.NO_ERROR,
  }));
  deps.interceptor.hook('kernel32.dll', 'LocalUnlock', () => ({
    returnValue: 0,
    errorCode: E.NO_ERROR,
  }));
  // LocalSize: notepad reads the allocated size back right after LocalAlloc
  // (`mov esi,eax; shr esi,1; je fail`) — an unimplemented 0 aborts startup
  // with STATUS_STACK_BUFFER_OVERRUN. Same [user-4] size header as HeapSize.
  deps.interceptor.hook('kernel32.dll', 'LocalSize', (ctx) => {
    const p = ctx.rawArgs[0] ?? 0;
    return {
      returnValue: p ? Math.max(0, deps.runtime.readInt32(p - 4) & ~7) : 0,
      errorCode: E.NO_ERROR,
    };
  });

  // ucrtbase heap allocators. notepad's C++ `operator new` routes through
  // malloc; returning 0 makes `new` throw std::bad_alloc via
  // _CxxThrowException (which needs full MSVC C++ exception dispatch to
  // unwind — out of scope), so allocate from the same bump heap instead.
  // These are cdecl (caller cleans up); the stub argCount for them is 0.
  const ucrtAlloc = (ctx: ApiCallContext): ApiResult => ({
    returnValue: bumpAlloc(ctx.rawArgs[0] ?? 0),
    errorCode: E.NO_ERROR,
  });
  const ucrtRealloc = (ctx: ApiCallContext): ApiResult => {
    const old = ctx.rawArgs[0] ?? 0;
    const size = ctx.rawArgs[1] ?? 0;
    if (!old) return { returnValue: bumpAlloc(size), errorCode: E.NO_ERROR };
    const oldSize = Math.max(0, deps.runtime.readInt32(old - 4) & ~7);
    const next = bumpAlloc(size);
    const n = Math.min(oldSize, size);
    if (n > 0) deps.runtime.writeBytes(next, deps.runtime.readBytes(old, n));
    return { returnValue: next, errorCode: E.NO_ERROR };
  };
  const ucrtCalloc = (ctx: ApiCallContext): ApiResult => {
    const n = (ctx.rawArgs[0] ?? 0) >>> 0;
    const size = (ctx.rawArgs[1] ?? 0) >>> 0;
    const total = n * size;
    const p = bumpAlloc(total);
    if (total > 0) deps.runtime.writeBytes(p, new Uint8Array(total));
    return { returnValue: p, errorCode: E.NO_ERROR };
  };
  for (const name of ['malloc', '_o_malloc', '_malloc_base']) {
    deps.interceptor.hook('ucrtbase.dll', name, ucrtAlloc);
  }
  for (const name of ['calloc', '_o_calloc', '_calloc_base']) {
    deps.interceptor.hook('ucrtbase.dll', name, ucrtCalloc);
  }
  for (const name of ['realloc', '_o_realloc', '_realloc_base']) {
    deps.interceptor.hook('ucrtbase.dll', name, ucrtRealloc);
  }
  for (const name of ['free', '_o_free', '_free_base', '_o__free_base']) {
    deps.interceptor.hook('ucrtbase.dll', name, () => ({ returnValue: 0, errorCode: E.NO_ERROR }));
  }

  // COM task allocators (normalized from api-ms-win-core-com-* to ole32).
  deps.interceptor.hook('ole32.dll', 'CoTaskMemAlloc', ucrtAlloc);
  deps.interceptor.hook('ole32.dll', 'CoTaskMemRealloc', ucrtRealloc);
  deps.interceptor.hook('ole32.dll', 'CoTaskMemFree', () => ({
    returnValue: 0,
    errorCode: E.NO_ERROR,
  }));
  // CoCreateGuid: fill a (unique-enough) GUID so callers can key on it.
  let guidCounter = 0x10203040;
  deps.interceptor.hook('ole32.dll', 'CoCreateGuid', (ctx) => {
    const p = ctx.rawArgs[0] ?? 0;
    if (!p) return { returnValue: 0x80070057, errorCode: E.NO_ERROR }; // E_INVALIDARG
    guidCounter = (guidCounter + 0x9e3779b9) | 0;
    const t = Date.now() & 0xffffffff;
    // GUID layout: Data1 u32 @0, Data2 u16 @4, Data3 u16 @6, Data4 u8[8] @8.
    // Data4 MUST start at p+8 — writing at p+10 spilled 2 bytes past the
    // GUID and clobbered the caller's stack cookie ([ebp-4] low 16 bits),
    // which made every cookie-checked function fail-fast afterwards.
    deps.runtime.writeInt32(p, guidCounter);
    deps.runtime.writeInt32(p + 4, t);
    const b = new Uint8Array(8);
    for (let i = 0; i < 8; i++) b[i] = ((guidCounter >>> (i * 4)) ^ (t >> (i * 3))) & 0xff;
    deps.runtime.writeBytes(p + 8, b);
    return { returnValue: 0, errorCode: E.NO_ERROR }; // S_OK
  });
  // CoCreateInstance: no COM servers exist in this environment. notepad's
  // lazy COM-object getter (0x423246) does `test eax,eax; js` and skips
  // gracefully on a FAILED HRESULT — but the generic unimplemented handler
  // returns 0 = S_OK WITHOUT writing ppv, so the guest then dereferences the
  // stale global (0x429e18) and derails. Report the class as not registered.
  deps.interceptor.hook('ole32.dll', 'CoCreateInstance', () => ({
    returnValue: 0x80040154, // REGDB_E_CLASSNOTREG
    errorCode: E.NO_ERROR,
  }));

  // ---------------------------------------------------------------------
  // File mappings (CreateFileMappingW / MapViewOfFile / UnmapViewOfFile).
  // notepad opens files through a memory-mapped view instead of ReadFile:
  // right after GetFileInformationByHandle it calls CreateFileMappingW +
  // MapViewOfFile and reads the content straight out of the mapped pointer.
  // With no handler, CreateFileMappingW returned 0 and notepad fell back to
  // an EMPTY local buffer — every command-line file open showed a blank
  // document even though the handle chain (open -> info) succeeded.
  // We back the mapping with bump-heap memory and copy the file content in
  // at CreateFileMappingW time; MapViewOfFile just returns the pointer.
  // ---------------------------------------------------------------------
  const fileMappings = new Map<
    number,
    { ptr: number; size: number; path: string; fileHandle: number }
  >();
  let nextMapping = 0x60;
  deps.interceptor.hook('kernel32.dll', 'CreateFileMappingW', async (ctx, host) => {
    const hFile = (ctx.rawArgs[0] ?? 0) >>> 0;
    const sizeHigh = (ctx.rawArgs[3] ?? 0) >>> 0;
    const sizeLow = (ctx.rawArgs[4] ?? 0) >>> 0;
    const requested = sizeHigh * 0x100000000 + sizeLow;
    let path = '';
    let size = Math.max(0x1000, requested || 0);
    if (hFile !== 0xffffffff) {
      const info = await host.fs.getFileInformation(hFile);
      if (info.error !== E.NO_ERROR) {
        return { returnValue: 0, errorCode: info.error };
      }
      path = info.path;
      size = Math.max(info.size, requested || 0);
    }
    const ptr = bumpAlloc(Math.max(8, size));
    if (path && size > 0) {
      // Read the file content into the mapping (handle pointer is still 0
      // here — notepad maps right after CreateFileW/GetFileInformationByHandle).
      const r = await host.fs.readFile(hFile, size);
      if (r.error === E.NO_ERROR && r.data.length > 0) {
        deps.runtime.writeBytes(ptr, r.data);
      }
    }
    const handle = nextMapping++;
    fileMappings.set(handle, { ptr, size, path, fileHandle: hFile });
    return { returnValue: handle, errorCode: E.NO_ERROR };
  });
  deps.interceptor.hook('kernel32.dll', 'MapViewOfFile', (ctx) => {
    const handle = (ctx.rawArgs[0] ?? 0) >>> 0;
    const mapping = fileMappings.get(handle);
    if (!mapping) return { returnValue: 0, errorCode: E.ERROR_INVALID_HANDLE };
    const offsetLow = (ctx.rawArgs[3] ?? 0) >>> 0;
    return { returnValue: (mapping.ptr + offsetLow) >>> 0, errorCode: E.NO_ERROR };
  });
  deps.interceptor.hook('kernel32.dll', 'UnmapViewOfFile', () => ({
    returnValue: 1,
    errorCode: E.NO_ERROR,
  }));
  deps.interceptor.hook('kernel32.dll', 'FlushViewOfFile', () => ({
    returnValue: 1,
    errorCode: E.NO_ERROR,
  }));
  // CloseHandle must also release mapping handles (notepad closes the
  // mapping after the document is loaded).
  deps.interceptor.hook('kernel32.dll', 'CloseHandle', async (ctx, host) => {
    const handle = (ctx.rawArgs[0] ?? 0) >>> 0;
    if (fileMappings.delete(handle)) {
      return { returnValue: 1, errorCode: E.NO_ERROR };
    }
    const err = await host.fs.closeHandle(handle);
    return { returnValue: err === E.NO_ERROR ? 1 : 0, errorCode: err };
  });
  deps.interceptor.hook('kernel32.dll', 'LocalReAlloc', (ctx) => {
    const old = ctx.rawArgs[0] ?? 0;
    const size = ctx.rawArgs[1] ?? 0;
    if (!old) return { returnValue: bumpAlloc(size), errorCode: E.NO_ERROR };
    const oldSize = Math.max(0, deps.runtime.readInt32(old - 4) & ~7);
    const next = bumpAlloc(size);
    const n = Math.min(oldSize, size);
    if (n > 0) deps.runtime.writeBytes(next, deps.runtime.readBytes(old, n));
    return { returnValue: next, errorCode: E.NO_ERROR };
  });
  deps.interceptor.hook('kernel32.dll', 'VirtualAlloc', (ctx) => {
    const size = ctx.rawArgs[1] ?? 0;
    const type = ctx.rawArgs[2] ?? 0;
    // MEM_COMMIT (0x1000) alone is a valid request (commits in an existing
    // reservation) — the MM uses VirtualAlloc(0, pool, COMMIT, RW) to grow
    // its arena. Only pure MEM_RESERVE (0x2000 without COMMIT) or size 0
    // returns NULL. Real Windows returns 64KB-aligned addresses.
    if (!size || (type & 0x1000) === 0) return { returnValue: 0, errorCode: E.NO_ERROR };
    if ((heapCursor & 0xffff) !== 0) heapCursor = (heapCursor + 0xffff) & ~0xffff;
    const user = bumpAlloc(size);
    return { returnValue: user, errorCode: E.NO_ERROR };
  });
  deps.interceptor.hook('kernel32.dll', 'VirtualFree', () => ok1());
  deps.interceptor.hook('kernel32.dll', 'VirtualProtect', () => ok1());
  deps.interceptor.hook('kernel32.dll', 'Sleep', () => ({ returnValue: 0, errorCode: E.NO_ERROR }));

  // ------------------------------------------------------------------
  // WinRT string/activation helpers (api-ms-win-core-winrt-* normalize to
  // kernel32) + SHELL32 delay-loads. These return HRESULTs, and the generic
  // unimplemented handler returns 0 = S_OK WITHOUT writing the output
  // pointers — the guest then believes the call succeeded and dereferences
  // uninitialized outputs (notepad's WIP check: RoGetActivationFactory
  // "succeeds" with a garbage factory -> vtable call through garbage ->
  // runaway). Two rules:
  //   - WindowsCreateStringReference/CreateString MUST succeed AND write a
  //     valid HSTRING; notepad's `js` on their failure throws via 0x40cc99
  //     (not a graceful path).
  //   - RoGetActivationFactory (and the error-info helpers) MUST return a
  //     FAILED HRESULT so notepad's `jns` check takes its trace-and-skip
  //     path and continues to the message loop.
  // HSTRING layout (winstring): [h-8] = u32 length, [h-4] = flags,
  // h = UTF-16 data. For a reference string the header is caller-provided
  // and HSTRING = header + 8.
  // ------------------------------------------------------------------
  const createStringReference = (ctx: ApiCallContext): ApiResult => {
    const source = (ctx.rawArgs[0] ?? 0) >>> 0;
    const len = (ctx.rawArgs[1] ?? 0) >>> 0;
    const headerPtr = (ctx.rawArgs[2] ?? 0) >>> 0; // HSTRING_HEADER* (caller-provided)
    const out = (ctx.rawArgs[3] ?? 0) >>> 0; // HSTRING* out
    if (!out) return { returnValue: 0x80070057, errorCode: E.NO_ERROR }; // E_INVALIDARG
    // Heap-copy the source so the HSTRING has the same layout as
    // WindowsCreateString ([h-8]=len, [h-4]=flags, h=data). Real reference
    // strings alias the caller's source via the HSTRING_HEADER, but then
    // RoGetActivationFactory can't read the class name back; the bump-heap
    // copy is single-use and never freed (acceptable).
    const p = bumpAlloc(len * 2 + 8);
    deps.runtime.writeInt32(p, len);
    deps.runtime.writeInt32(p + 4, 0);
    if (source && len) {
      deps.runtime.writeBytes(p + 8, deps.runtime.readBytes(source, len * 2));
    }
    deps.runtime.writeInt32(out, p + 8);
    void headerPtr;
    return { returnValue: 0, errorCode: E.NO_ERROR }; // S_OK
  };
  const createString = (ctx: ApiCallContext): ApiResult => {
    const source = (ctx.rawArgs[0] ?? 0) >>> 0;
    const len = (ctx.rawArgs[1] ?? 0) >>> 0;
    const out = (ctx.rawArgs[2] ?? 0) >>> 0;
    if (!out) return { returnValue: 0x80070057, errorCode: E.NO_ERROR };
    const p = bumpAlloc(len * 2 + 8);
    deps.runtime.writeInt32(p, len);
    deps.runtime.writeInt32(p + 4, 0);
    if (source && len) {
      deps.runtime.writeBytes(p + 8, deps.runtime.readBytes(source, len * 2));
    }
    deps.runtime.writeInt32(out, p + 8);
    return { returnValue: 0, errorCode: E.NO_ERROR };
  };
  const getStringRawBuffer = (ctx: ApiCallContext): ApiResult => {
    const h = (ctx.rawArgs[0] ?? 0) >>> 0;
    const lenOut = (ctx.rawArgs[1] ?? 0) >>> 0;
    if (lenOut) deps.runtime.writeInt32(lenOut, h ? deps.runtime.readInt32(h - 8) : 0);
    return { returnValue: h, errorCode: E.NO_ERROR };
  };
  // E_NOTIMPL (0x80004001, sign bit set) — guests check HRESULTs with
  // `jns`/`js` and take their documented failure path.
  const failHr = (): ApiResult => ({ returnValue: 0x80004001, errorCode: E.NO_ERROR });
  deps.interceptor.hook('kernel32.dll', 'WindowsCreateStringReference', createStringReference);
  deps.interceptor.hook('kernel32.dll', 'WindowsCreateString', createString);
  deps.interceptor.hook('kernel32.dll', 'WindowsDeleteString', () => ({
    returnValue: 0,
    errorCode: E.NO_ERROR,
  }));
  deps.interceptor.hook('kernel32.dll', 'WindowsGetStringRawBuffer', getStringRawBuffer);
  // RoGetActivationFactory is a split personality:
  //  - The early WIP check (0x40bcaa) tolerates a FAILED HRESULT and skips
  //    gracefully (Step 7 behavior — E_NOTIMPL).
  //  - The EDP helper (edpapphelper.cpp:246, 0x424f8b) does
  //    `test edi,edi; jns` — ANY negative HRESULT triggers WIL report +
  //    __fastfail (0x424f96 -> 0x4076c9 -> ... -> int 0x29), which ends the
  //    process. On real systems RoGetActivationFactory succeeds for this
  //    class, so notepad never sees the failure path.
  // For "Windows.Security.EnterpriseData.ProtectionPolicyManager" we
  // therefore mint a fake IInspectable factory whose vtable slots are trap
  // stubs: vtable[12] (CheckAccess-ish) answers S_OK, vtable[14]
  // (IsProtectionEnabled-ish) writes "not protected" (bool 0) and returns
  // S_OK. Other classes keep the E_NOTIMPL behavior.
  const pmpFactoryAddr = ((): number => {
    // x64 vtable slots are 8-byte pointers at 8-byte stride (notepad reads
    // vtable[12] at offset 0x60); the 32-bit build uses 4-byte slots.
    const writePtr = (address: number, value: number): void =>
      deps.arch.writePointer(deps.runtime, address, value | 0);
    const slotCount = deps.arch.vtableSlotCount();
    const vt = bumpAlloc(slotCount * deps.arch.pointerSize);
    const factory = bumpAlloc(0x10);
    // IUnknown: [0]=QueryInterface(3 args), [1]=AddRef(0), [2]=Release(0).
    // notepad's EDP helper then calls [12] (CheckAccess-ish, 3 args) and
    // [14] (IsProtectionEnabled-ish, 2 args). Everything else answers with
    // a 0-arg stub so an unexpected Release() cannot pop the caller's stack.
    const slotName = (i: number): string =>
      i === 0
        ? 'pmp_qi'
        : i === 2
          ? 'pmp_release'
          : i === 12
            ? 'pmp_checkaccess'
            : i === 14
              ? 'pmp_isprotected'
              : 'pmp_vtbl_stub';
    for (let i = 0; i < slotCount; i++) {
      const stub = allocDynamicStub(slotName(i));
      writePtr(vt + i * deps.arch.pointerSize, stub);
    }
    writePtr(factory, vt);
    return factory;
  })();
  deps.interceptor.hook('kernel32.dll', 'RoGetActivationFactory', (ctx) => {
    const classId = (ctx.rawArgs[0] ?? 0) >>> 0;
    const out = (ctx.rawArgs[2] ?? 0) >>> 0;
    // HSTRING: [h-8] = char length, h = UTF-16 data.
    let name = '';
    if (classId) {
      const len = deps.runtime.readInt32(classId - 8);
      if (len >= 0 && len <= 0x100) {
        const b = deps.runtime.readBytes(classId, len * 2);
        for (let i = 0; i + 1 < b.byteLength; i += 2) {
          const c = b[i]! | (b[i + 1]! << 8);
          if (c === 0) break;
          name += String.fromCharCode(c);
        }
      }
    }
    if (name === 'Windows.Security.EnterpriseData.ProtectionPolicyManager') {
      if (out) {
        deps.arch.writePointer(deps.runtime, out, pmpFactoryAddr | 0);
      }
      return { returnValue: 0, errorCode: E.NO_ERROR }; // S_OK
    }
    return { returnValue: 0x80004001, errorCode: E.NO_ERROR }; // E_NOTIMPL
  });
  // Mock IProtectionPolicyManager vtable method handlers (dispatched via
  // the trap stubs minted above; stdcall arg counts live in mapper.ts).
  const pmpOk = (): ApiResult => ({ returnValue: 0, errorCode: E.NO_ERROR });
  deps.interceptor.hook('kernel32.dll', 'pmp_vtbl_stub', pmpOk);
  deps.interceptor.hook('kernel32.dll', 'pmp_qi', (ctx) => {
    // (this, riid, void** out) — return a copy of the interface pointer.
    const out = ctx.rawArgs[2] ?? 0;
    const self = ctx.rawArgs[0] ?? 0;
    if (out) {
      deps.arch.writePointer(deps.runtime, out, self | 0);
    }
    return { returnValue: 0, errorCode: E.NO_ERROR };
  });
  deps.interceptor.hook('kernel32.dll', 'pmp_checkaccess', pmpOk);
  deps.interceptor.hook('kernel32.dll', 'pmp_release', pmpOk);
  deps.interceptor.hook('kernel32.dll', 'pmp_isprotected', (ctx) => {
    // (this, bool* out) — report "not protected".
    const out = ctx.rawArgs[1] ?? 0;
    if (out) deps.runtime.writeInt32(out, 0);
    return { returnValue: 0, errorCode: E.NO_ERROR };
  });
  // ------------------------------------------------------------------
  // WinUI/THF host object: notepad-x64 bootstraps its message pump through
  //   CoCreateInstance({0B35F8B5-4805-48B1-A6EE-88BD00B4A5E7}, ...)
  // which is the Windows App SDK / WinUI host class. With no COM servers we
  // returned REGDB_E_CLASSNOTREG, and the 64-bit WinMain treats that as fatal
  // (it never calls GetMessageW — its loop lives inside the framework).
  // Mint a minimal COM object (IUnknown + generic method stubs) so WinMain
  // proceeds. This is the first step of "emulate WinUI/XAML": enough object
  // surface for notepad to drive its own host window; richer XAML content
  // rendering is out of scope here.
  if (deps.arch.mode === 'x64') {
    const notepadHostClsid = [
      0x0b, 0x35, 0xf8, 0xb5, 0x48, 0x05, 0xb1, 0x48, 0xa6, 0xee, 0x88, 0xbd, 0x00, 0xb4, 0xa5,
      0xe7,
    ];
    const comSlotCount = deps.arch.comVtableSlotCount();
    const comVt = bumpAlloc(comSlotCount * deps.arch.pointerSize);
    const comObj = bumpAlloc(0x10);
    {
      const slotName = (i: number): string =>
        i === 0 ? 'com_qi' : i === 1 ? 'com_addref' : i === 2 ? 'com_release' : 'com_method';
      for (let i = 0; i < comSlotCount; i++) {
        const stub = allocDynamicStub(slotName(i));
        const addr = comVt + i * deps.arch.pointerSize;
        deps.arch.writePointer(deps.runtime, addr, stub | 0);
      }
      deps.arch.writePointer(deps.runtime, comObj, comVt | 0);
    }
    const clsidMatches = (p: number): boolean => {
      if (!p) return false;
      const b = deps.runtime.readBytes(p, 16);
      for (let i = 0; i < 16; i++) if (b[i] !== notepadHostClsid[i]) return false;
      return true;
    };
    deps.interceptor.hook('kernel32.dll', 'com_qi', (ctx) => {
      const out = (ctx.rawArgs?.[2] ?? 0) >>> 0;
      const self = (ctx.rawArgs?.[0] ?? 0) >>> 0;
      if (out) {
        deps.arch.writePointer(deps.runtime, out, self | 0);
      }
      return { returnValue: 0, errorCode: E.NO_ERROR }; // S_OK
    });
    deps.interceptor.hook('kernel32.dll', 'com_addref', () => ({
      returnValue: 1,
      errorCode: E.NO_ERROR,
    }));
    deps.interceptor.hook('kernel32.dll', 'com_release', () => ({
      returnValue: 0,
      errorCode: E.NO_ERROR,
    }));
    deps.interceptor.hook('kernel32.dll', 'com_method', async (ctx) => {
      const self = (ctx.rawArgs?.[0] ?? 0) >>> 0;
      // The host object's method is notepad-x64's message-pump entry. Run it so
      // the window actually pumps and renders (see runGuiPump).
      if (self === comObj) {
        return { returnValue: await deps.gui.runPump(), errorCode: E.NO_ERROR };
      }
      return { returnValue: 0, errorCode: E.NO_ERROR };
    });
    deps.interceptor.hook('ole32.dll', 'CoCreateInstance', (ctx) => {
      const rclsid = (ctx.rawArgs?.[0] ?? 0) >>> 0;
      const ppv = (ctx.rawArgs?.[4] ?? 0) >>> 0;
      if (clsidMatches(rclsid)) {
        if (ppv) {
          deps.arch.writePointer(deps.runtime, ppv, comObj | 0);
        }
        return { returnValue: 0, errorCode: E.NO_ERROR }; // S_OK
      }
      return { returnValue: 0x80040154, errorCode: E.NO_ERROR }; // REGDB_E_CLASSNOTREG
    });
    // CoCreateInstance may also resolve under the api-ms forwarding module.
    deps.interceptor.hook('api-ms-win-core-com-l1-1-0.dll', 'CoCreateInstance', (ctx) => {
      const rclsid = (ctx.rawArgs?.[0] ?? 0) >>> 0;
      const ppv = (ctx.rawArgs?.[4] ?? 0) >>> 0;
      if (clsidMatches(rclsid)) {
        if (ppv) {
          deps.arch.writePointer(deps.runtime, ppv, comObj | 0);
        }
        return { returnValue: 0, errorCode: E.NO_ERROR }; // S_OK
      }
      return { returnValue: 0x80040154, errorCode: E.NO_ERROR }; // REGDB_E_CLASSNOTREG
    });
  }

  deps.interceptor.hook('kernel32.dll', 'RoGetMatchingRestrictedErrorInfo', failHr);
  deps.interceptor.hook('kernel32.dll', 'SetRestrictedErrorInfo', failHr);
  // notepad delay-loads SHGetKnownFolderPath (resolved as kernel32 by
  // allocDynamicStub). The 32-bit notepad skips the title/banner path when it
  // fails, but the 64-bit build aborts window creation entirely on a FAILED
  // HRESULT, so return a real Documents path (S_OK) here. Signature:
  //   SHGetKnownFolderPath(rfid, dwFlags, hToken, PWSTR *ppszPath)
  // The string is allocated via CoTaskMemAlloc and freed by CoTaskMemFree
  // (a no-op in this environment), so a bump-allocated buffer is safe.
  {
    const documentsPath = `${deps.state.cwd.replace(/\\$/, '')}\\Documents`;
    const buffer = bumpAlloc((documentsPath.length + 1) * 2);
    for (let i = 0; i < documentsPath.length; i++) {
      const code = documentsPath.charCodeAt(i);
      deps.runtime.writeBytes(buffer + i * 2, new Uint8Array([code & 0xff, (code >> 8) & 0xff]));
    }
    deps.runtime.writeBytes(buffer + documentsPath.length * 2, new Uint8Array(2));
    deps.interceptor.hook('kernel32.dll', 'SHGetKnownFolderPath', (ctx) => {
      const out = ctx.rawArgs[3] ?? 0;
      if (out) deps.runtime.writeInt32(out, buffer);
      return { returnValue: 0, errorCode: E.NO_ERROR }; // S_OK
    });
    deps.interceptor.hook('shell32.dll', 'SHGetKnownFolderPath', (ctx) => {
      const out = ctx.rawArgs[3] ?? 0;
      if (out) deps.runtime.writeInt32(out, buffer);
      return { returnValue: 0, errorCode: E.NO_ERROR }; // S_OK
    });
  }

  // OS version reporting (NSIS / CRT gate on it).
  deps.interceptor.hook('kernel32.dll', 'GetVersion', () => ({
    returnValue: 0x8000000a, // NT, major 10, minor 0 (0x80000000 = NT)
    errorCode: E.NO_ERROR,
  }));
  // GetVersionEx writes into a caller-allocated struct whose size the caller
  // declares in dwOSVersionInfoSize. The struct comes in two flavours and the
  // ANSI/Unicode split doubles the char array:
  //   OSVERSIONINFOW   = 5*4 + 128*2       = 276
  //   OSVERSIONINFOEXW = 276 + 2+2+2+1+1   = 284
  //   OSVERSIONINFOA   = 5*4 + 128         = 148
  //   OSVERSIONINFOEXA = 148 + 2+2+2+1+1   = 156
  // Writing a fixed 284 bytes into a 276-byte OSVERSIONINFOW overruns it by 8
  // bytes. Delphi / Inno Setup installers allocate that struct ON THE STACK
  // (`add esp,-0x114; mov [esp],0x114; push esp; call GetVersionExW`), so the
  // overrun lands exactly on the caller's saved return address and zeroes it —
  // the following `ret` jumps to 0 and the whole process looks like a silent
  // "clean exit" 17 API calls into startup, with no fault to point at.
  // Honour the declared size instead, and never write past it.
  const fillVersionInfo = (
    out: number,
    unicode: boolean,
  ): { returnValue: number; errorCode: E } => {
    if (!out) return { returnValue: 0, errorCode: E.NO_ERROR };
    const base = unicode ? 276 : 148; // OSVERSIONINFO(W|A)
    const ex = unicode ? 284 : 156; // OSVERSIONINFOEX(W|A)
    const declared = deps.runtime.readInt32(out) >>> 0;
    // Clamp to something sane: at least the 5 fixed DWORDs, never past the EX
    // layout. A garbage size (0, huge) is a real caller bug -> fail like Windows.
    if (declared < 20 || declared > ex) {
      return { returnValue: 0, errorCode: E.ERROR_INVALID_PARAMETER };
    }
    const w = new Uint8Array(declared);
    const view = new DataView(w.buffer);
    view.setUint32(0, declared, true); // dwOSVersionInfoSize (echo back)
    view.setUint32(4, 10, true); // dwMajorVersion
    view.setUint32(8, 0, true); // dwMinorVersion
    view.setUint32(12, 19045, true); // dwBuildNumber
    view.setUint32(16, 2, true); // dwPlatformId = VER_PLATFORM_WIN32_NT
    // szCSDVersion stays zeroed = no service pack.
    if (declared >= ex) {
      view.setUint16(base, 0, true); // wServicePackMajor
      view.setUint16(base + 2, 0, true); // wServicePackMinor
      view.setUint16(base + 4, 0x100, true); // wSuiteMask = VER_SUITE_SINGLEUSERTS
      w[base + 6] = 1; // wProductType = VER_NT_WORKSTATION
      w[base + 7] = 0; // wReserved
    }
    deps.runtime.writeBytes(out, w);
    return { returnValue: 1, errorCode: E.NO_ERROR };
  };
  deps.interceptor.hook('kernel32.dll', 'GetVersionExW', (ctx) =>
    fillVersionInfo(ctx.rawArgs[0] ?? 0, true),
  );
  deps.interceptor.hook('kernel32.dll', 'GetVersionExA', (ctx) =>
    fillVersionInfo(ctx.rawArgs[0] ?? 0, false),
  );

  // ------------------------------------------------------------------
  // OS version gating (installers refuse to run on "old" Windows).
  // VerSetConditionMask builds a 64-bit condition mask (8-bit condition
  // fields at bit-offset == TypeMask value); VerifyVersionInfoW compares the
  // emulated OS (10.0.19045, NT) against it. Returning 0 from the verify
  // makes Inno/NSIS abort startup with no UI.
  // ------------------------------------------------------------------
  deps.interceptor.hook('kernel32.dll', 'VerSetConditionMask', (ctx) => {
    const maskLow = (ctx.rawArgs[0] ?? 0) >>> 0;
    const maskHigh = (ctx.rawArgs[1] ?? 0) >>> 0;
    const typeBit = ctx.rawArgs[2] ?? 0;
    const condition = (ctx.rawArgs[3] ?? 0) & 0xff;
    if (typeBit >= 32) {
      const p = typeBit - 32;
      return {
        returnValue: maskLow,
        returnValueHigh: (maskHigh & ~(0xff << p)) | (condition << p),
        errorCode: E.NO_ERROR,
      };
    }
    return {
      returnValue: (maskLow & ~(0xff << typeBit)) | (condition << typeBit),
      returnValueHigh: maskHigh,
      errorCode: E.NO_ERROR,
    };
  });
  deps.interceptor.hook('kernel32.dll', 'VerifyVersionInfoW', (ctx) => {
    const lpvi = ctx.rawArgs[0] ?? 0;
    const typeMask = ctx.rawArgs[1] ?? 0;
    if (!lpvi || !typeMask) return { returnValue: 0, errorCode: E.ERROR_INVALID_PARAMETER };
    // The guest fills OSVERSIONINFOEXW with the minimum version it accepts
    // and compares field-by-field — but a naive per-field check fails for
    // (major,minor) pairs like "6.1" vs our "10.0" (0 >= 1 is false). Real
    // Windows solves this by reporting unmanifested apps a compatibility
    // version and by treating the check as a version ordering. We emulate
    // the outcome installers actually rely on: lexicographic comparison of
    // the emulated OS (10.0.19045, NT) against the requested version, over
    // the fields present in the type mask.
    // wServicePackMajor/Minor are WORDs packed at +276/+278, so a 32-bit read
    // at either offset drags the neighbouring field in. Read the pair once and
    // split it.
    const spPair = deps.runtime.readInt32(lpvi + 276) >>> 0;
    const req = {
      major: deps.runtime.readInt32(lpvi + 4),
      minor: deps.runtime.readInt32(lpvi + 8),
      build: deps.runtime.readInt32(lpvi + 12),
      platform: deps.runtime.readInt32(lpvi + 16),
      spMajor: spPair & 0xffff,
      spMinor: (spPair >>> 16) & 0xffff,
    };
    const ours = {
      major: 10,
      minor: 0,
      build: 19045,
      platform: 2,
      spMajor: 0,
      spMinor: 0,
    } as const;
    const order: Array<[keyof typeof req, number]> = [
      ['major', 0x2],
      ['minor', 0x1],
      ['build', 0x4],
      ['platform', 0x8],
      ['spMajor', 0x20],
      ['spMinor', 0x10],
    ];
    for (const [key, bit] of order) {
      if ((typeMask & bit) === 0) continue;
      if (ours[key] > req[key]) return { returnValue: 1, errorCode: E.NO_ERROR };
      if (ours[key] < req[key]) return { returnValue: 0, errorCode: E.NO_ERROR };
    }
    return { returnValue: 1, errorCode: E.NO_ERROR };
  });

  // MUI satellite resources: Windows 10+ apps keep strings/menus/dialogs in
  // a sibling "<lang>/<module>.mui"; the exe itself has no RT_STRING and
  // LoadStringW would always fail. Merge the .mui entries into the table so
  // the hooks above (LoadStringW/LoadMenuW/...) resolve them. Needs bumpAlloc
  // (defined above) to copy the bytes into guest memory.
  await mergeMuiResources(deps, resourceTable, namedResources, bumpAlloc);
  // Keep the RT_MENU (type 4) entries for class-menu parsing (Layer 3):
  // notepad attaches its menu via WNDCLASSEXW.lpszMenuName, not LoadMenuW.
  deps.gui.menuResourceTable.clear();
  for (const [key, entry] of resourceTable) {
    if (key >>> 16 === 4) deps.gui.menuResourceTable.set(key & 0xffff, entry);
  }
}

/**
 * Loads MUI satellite resources for modulePath and merges their resource
 * entries into `resourceTable` (guest-address space). Windows 10+ keeps an
 * app's localizable resources (RT_STRING type 6, RT_MENU type 4,
 * RT_ACCELERATOR type 9) in `<exeDir>\<lang>\<module>.mui` — notepad.exe has
 * no strings of its own and LoadStringW fails (startup abort) without them.
 *
 * Each MUI resource block is copied into the guest bump heap so the address
 * handed to LoadStringW/LoadMenuW points at real bytes the guest can read.
 * Numeric resource ids only (MUI files use numeric ids; string names would
 * need guest string parsing).
 */
async function mergeMuiResources(
  deps: StartupDeps,
  resourceTable: Map<number, { size: number; address: number }>,
  namedResources: Map<string, { size: number; address: number }>,
  bumpAlloc: (size: number) => number,
): Promise<void> {
  if (!deps.state.modulePath || !deps.state.readFile) return;
  const dir = deps.state.modulePath.replace(/[\\/][^\\/]*$/, '');
  const base = deps.state.modulePath.replace(/^.*[\\/]/, '').replace(/\.mui$/i, '');
  // The 32-bit notepad's satellite lives under System32\<lang> on x64 hosts
  // (the SysWOW64\<lang> directory does not exist), so probe both.
  const candidates = [
    `${dir}/en-US/${base}.mui`,
    `${dir}/zh-CN/${base}.mui`,
    `${dir}/zh-Hans/${base}.mui`,
    `C:/Windows/System32/en-US/${base}.mui`,
    `C:/Windows/System32/zh-CN/${base}.mui`,
    `C:/Windows/System32/zh-Hans/${base}.mui`,
  ];
  let mui: Uint8Array | null = null;
  let muiPath = '';
  for (const p of candidates) {
    try {
      mui = await deps.state.readFile(p);
    } catch {
      mui = null;
    }
    if (mui && mui.byteLength > 0) {
      muiPath = p;
      break;
    }
  }
  if (!mui || mui.byteLength === 0) {
    console.warn(
      `[specter-core] MUI: no satellite found for ${deps.state.modulePath} (candidates: ${candidates.join(', ')})`,
    );
    return;
  }

  const view = new DataView(mui.buffer, mui.byteOffset, mui.byteLength);
  const u16 = (o: number): number => (o + 2 <= mui.byteLength ? view.getUint16(o, true) : 0);
  const u32 = (o: number): number => (o + 4 <= mui.byteLength ? view.getUint32(o, true) : 0);
  if (u16(0) !== 0x5a4d) return; // not a PE
  const eLfanew = u32(0x3c);
  const coff = eLfanew + 4;
  const numSections = u16(coff + 2);
  const optSize = u16(coff + 16);
  const optMagic = u16(eLfanew + 24);
  const dataDir = eLfanew + 24 + (optMagic === 0x20b ? 112 : 96);
  const resRva = u32(dataDir + 16);
  if (!resRva) return;
  const secTable = coff + 20 + optSize;
  let resRaw = 0;
  for (let i = 0; i < numSections; i++) {
    const s = secTable + i * 40;
    if (u32(s + 12) === resRva) {
      resRaw = u32(s + 20);
      break;
    }
  }
  if (!resRaw) return;
  const r2o = (rva: number): number => resRaw + (rva - resRva);
  const inBounds = (o: number, n: number): boolean => o >= 0 && o + n <= mui.byteLength;

  // Collect {type, nameId} -> raw data bytes (numeric) and
  // {type, nameStr} -> raw data bytes (named resources).
  const entries = new Map<number, Uint8Array>();
  const namedEntries = new Map<string, Uint8Array>();
  // Reads a resource-directory string name (u16 length + UTF-16LE) at the
  // given offset into the .mui file; returns '' when absent.
  const readNameStr = (off: number): string => {
    if (!inBounds(off, 2)) return '';
    const len = u16(off);
    if (!inBounds(off + 2, len * 2)) return '';
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(u16(off + 2 + i * 2));
    return s;
  };
  const walk = (
    rva: number,
    depth: number,
    typeId: number,
    nameId: number,
    nameStr: string,
  ): void => {
    const off = r2o(rva);
    if (!inBounds(off, 16)) return;
    const named = u16(off + 12);
    const ids = u16(off + 14);
    for (let k = 0; k < named + ids; k++) {
      const e = off + 16 + k * 8;
      if (!inBounds(e, 8)) break;
      const name = u32(e);
      const data = u32(e + 4);
      if (depth === 0) {
        walk(resRva + (data & 0x7fffffff), 1, name & 0xffff, 0, '');
      } else if (depth === 1) {
        if ((name & 0x80000000) !== 0) {
          const s = readNameStr(r2o(resRva + (name & 0x7fffffff)));
          walk(resRva + (data & 0x7fffffff), 2, typeId, 0, s);
        } else {
          walk(resRva + (data & 0x7fffffff), 2, typeId, name & 0xffff, '');
        }
      } else {
        const de = r2o(resRva + data);
        if (!inBounds(de, 8)) continue;
        const dataRva = u32(de);
        const size = u32(de + 4);
        const doff = r2o(dataRva);
        if (!inBounds(doff, size) || size === 0) continue;
        if (nameStr) {
          const key = `${typeId}:${nameStr.toLowerCase()}`;
          if (!namedEntries.has(key)) namedEntries.set(key, mui.subarray(doff, doff + size));
        } else {
          const key = ((typeId & 0xffff) << 16) | (nameId & 0xffff);
          if (!entries.has(key)) entries.set(key, mui.subarray(doff, doff + size));
        }
      }
    }
  };
  walk(resRva, 0, 0, 0, '');

  let merged = 0;
  for (const [key, data] of entries) {
    const type = key >>> 16;
    // Merge resources the hooks can serve: strings (6), menus (4),
    // accelerators (9), and RT_MESSAGETABLE (11). cmd.exe keeps its dir /
    // error formatting strings in the message table and reads them via
    // FormatMessage(FORMAT_MESSAGE_FROM_HMODULE), so without type 11 the
    // merged table stays empty and dir emits nothing useful. The MUI
    // internal type (232) and RT_VERSION (16) are intentionally skipped.
    if (type !== 6 && type !== 4 && type !== 9 && type !== 11) continue;
    const addr = bumpAlloc(data.byteLength);
    deps.runtime.writeBytes(addr, data);
    resourceTable.set(key, { size: data.byteLength, address: addr });
    merged += 1;
  }
  for (const [key, data] of namedEntries) {
    const type = Number.parseInt(key, 10);
    if (type !== 4 && type !== 9) continue;
    const addr = bumpAlloc(data.byteLength);
    deps.runtime.writeBytes(addr, data);
    namedResources.set(key, { size: data.byteLength, address: addr });
    merged += 1;
  }
  if (merged > 0) {
    deps.state.muiLoaded = true;
    deps.state.muiSource = muiPath;
    console.error(`[specter-core] merged ${merged} MUI resources (${muiPath})`);
  } else {
    console.warn(`[specter-core] MUI: found ${muiPath} but merged 0 resources`);
  }
}
