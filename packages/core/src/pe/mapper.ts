/**
 * PE image mapper (design doc 4.2.1/4.2.2).
 *
 * Loads a parsed `PeImage` into the WASM linear memory at its image base:
 *   1. writes each section's raw bytes (zero-filling slack),
 *   2. allocates a per-import "trap stub" (`mov eax, idx; int 0x2E; ret`) and
 *      rewrites every IAT slot to point at it,
 *   3. returns the import table so the trap dispatcher can resolve an API by
 *      the stub index read out of EAX (design 4.2.4).
 */

import type { PeImage } from '@bk/contracts';
import type { WasmRuntimeImpl } from '../jit/runtime';

/** Stub region: below the default 0x400000 image base. */
export const STUB_BASE = 0x00200000;

/**
 * Rebasing base for 64-bit images whose preferred ImageBase (typically
 * 0x140000000) exceeds the WASM linear-memory limit (~4GB). Keep it clear of
 * the CPU context (0x1000), the stub region (0x200000) and the stack (0x08000000).
 */
export const X64_BASE = 0x01000000;

/** Maximum address the 4GB WASM memory can hold (images below this keep their base). */
const MAX_IMAGE_BASE = 0xf0000000;

/**
 * stdcall argument counts for common kernel32/user32/gdi32/ntdll APIs. The
 * 32-bit trap stub must be `mov eax,idx; int 0x2E; ret <args*4>` — Windows
 * system APIs are stdcall (callee cleans the stack). A plain `ret` leaks
 * `args*4` bytes per call; after a few calls the guest stack misaligns and the
 * next `ret` pops a garbage address (often 0), which the executor misreads as
 * a clean `exit code 0`. Unknown APIs default to 0 (no cleanup) to preserve the
 * previous behaviour rather than risk over-cleaning.
 */
export const X86_API_ARG_COUNT: Readonly<Record<string, number>> = {
  'getmodulehandlew': 1,
  'getmodulehandlea': 1,
  'getprocaddress': 2,
  'getcommandlinew': 0,
  'getcommandlinea': 0,
  'getstartupinfow': 1,
  'getstartupinfoa': 1,
  'gettickcount': 0,
  // Console/locale functions resolved dynamically (cmd.exe via GetProcAddress):
  // a wrong argCount corrupts the stack (stub pops 0 bytes -> ret from garbage).
  'setthreaduilanguage': 1,
  'setfileuilanguage': 1,
  'getconsolemode': 2,
  'setconsolemode': 2,
  'getfileinformationbyhandleex': 4,
  'setfileinformationbyhandle': 4,
  'gettickcount64': 0,
  'getlasterror': 0,
  'setlasterror': 1,
  'getstdhandle': 1,
  'getconsoleoutputcp': 0,
  'setconsoleoutputcp': 1,
  'exitprocess': 1,
  'createfilea': 7,
  'createfilew': 7,
  'readfile': 5,
  'writefile': 5,
  'closehandle': 1,
  'getfilesize': 2,
  'getfilesizeex': 2,
  'loadlibraryw': 1,
  'loadlibrarya': 1,
  'getmodulefilenamew': 3,
  'getmodulefilenamea': 3,
  'getenvironmentvariablew': 3,
  'getenvironmentvariablea': 3,
  'setenvironmentvariablew': 2,
  'setenvironmentvariablea': 2,
  'getcurrentprocessid': 0,
  'getcurrentthreadid': 0,
  'getsysteminfo': 1,
  'virtualquery': 3,
  'getsystemtime': 1,
  'getlocaltime': 1,
  'messageboxw': 4,
  'messageboxa': 4,
  'getdevicecaps': 2,
  // ---- GDI (gdi32) drawing/bridge: argCounts so real paint paths don't
  // drift the stack. Every one of these is stdcall; the GUI bridge (Layer 2)
  // records paint commands and returns pseudo-handles for the rest.
  'beginpaint': 2,
  'endpaint': 2,
  'getclientrect': 2,
  'getwindowrect': 2,
  'textoutw': 5,
  'textouta': 5,
  'exttextoutw': 8,
  'exttextouta': 8,
  'drawtextw': 5,
  'drawtexta': 5,
  'settextcolor': 2,
  'setbkcolor': 2,
  'setbkmode': 2,
  'getbkcolor': 1,
  'gettextcolor': 1,
  'getstockobject': 1,
  'selectobject': 2,
  'deleteobject': 1,
  'createfontindirectw': 1,
  'createfontindirecta': 1,
  'createsolidbrush': 1,
  'createhatchbrush': 2,
  'createpen': 3,
  'fillrect': 3,
  'framerect': 3,
  'bitblt': 9,
  'stretchblt': 11,
  'patblt': 6,
  'movetoex': 4,
  'lineto': 2,
  'rectangle': 5,
  'ellipse': 5,
  'roundrect': 7,
  'gettextmetrics': 2,
  'gettextfacew': 2,
  'setmapmode': 2,
  'getmapmode': 1,
  'gettextalign': 1,
  'settextalign': 2,
  'setviewportorgex': 3,
  'setwindoworgex': 3,
  'createcompatibledc': 1,
  'createcompatiblebitmap': 3,
  'selectpalette': 3,
  'realizepalette': 1,
  'savedc': 1,
  'restoredc': 2,
  'heapalloc': 3,
  'heapfree': 3,
  'getprocessheap': 0,
  // FreeEnvironmentStringsW/A: 1 param stdcall, ret 4. Missing -> stub ret 0
  // -> 4 bytes leaked -> pop ebx/edi/esi pick up wrong slots -> ret pops a
  // stack address as EIP (cmd.exe fault at eip=0x7ffff9c after its
  // GetEnvironmentStringsW copy helper 0x40e707 returned).
  'freeenvironmentstringsw': 1,
  'freeenvironmentstringsa': 1,
  'virtualalloc': 4,
  'virtualfree': 3,
  'getfileattributesw': 1,
  'getfileattributesa': 1,
  'isdebuggerpresent': 0,
  'rtlmovememory': 3,
  'rtlzeromemory': 2,
  'flushfilebuffers': 1,
  'getfiletype': 1,
  'setfilepointer': 4,
  'sleep': 1,
  'getprocessheapex': 1,
  'getacp': 0,
  'getoemcp': 0,
  'getcpex': 2,
  // GetCPInfo(UINT CodePage, LPCPINFO) — 2 params stdcall, ret 8. Was 1 (ret 4)
  // -> 4 bytes leaked per call -> pop ebx picked up the unpopped arg (0x1b5) ->
  // bl!=0 misrouted to the DBCS lead-byte builder -> its ret popped garbage
  // (CPINFO data address 0x446b10) -> executed as code -> eip=0 exit (cmd.exe
  // "console init passed then internal exit", Step 11 stage 7).
  'getcpinfo': 2,
  'getcpinfoexw': 2,
  'getversion': 0,
  'getversionexa': 1,
  'getversionexw': 1,
  'verifyversioninfow': 4,
  'versetconditionmask': 4, // maskLow, maskHigh, type, cond = 16 bytes (was 3 -> leaked 4B/call)
  'getfullpathnamea': 4,
  'getfullpathnamew': 4,
  // Get/SetCurrentDirectoryW/A: missing argCounts -> stub ret 0 -> 8 bytes
  // leaked per GetCurrentDirectoryW call -> GS cookie copy shifted in the
  // caller frame -> __security_check_cookie fails -> __report_gsfailure
  // (cmd.exe fail-fast after its environment/registry init, Step 11 stage 7).
  'getcurrentdirectoryw': 2,
  'getcurrentdirectorya': 2,
  'setcurrentdirectoryw': 1,
  'setcurrentdirectorya': 1,
  'getwindowsdirectorya': 2,
  'getwindowsdirectoryw': 2,
  'getsystemdirectorya': 2,
  'getsystemdirectoryw': 2,
  'getsystemwindowsdirectorya': 2,
  'getsystemwindowsdirectoryw': 2,
  'getdrivetypea': 1,
  'getdrivetypew': 1,
  'getvolumeinformationa': 8,
  'getvolumeinformationw': 8,
  'getdiskfreespacea': 5,
  'getdiskfreespacew': 5,
  'expandenvironmentstringsa': 3,
  'expandenvironmentstringsw': 3,
  'getcurrentprocess': 0,
  'getcurrentthread': 0,
  'getexitcodeprocess': 2,
  'getexitcodethread': 2,
  'exitthread': 1,
  'createthread': 6,
  'suspendthread': 1,
  'resumethread': 1,
  'getthreadpriority': 1,
  'setthreadpriority': 2,
  'switchtothread': 0,
  'waitforsingleobject': 2,
  'waitforsingleobjectex': 3, // (handle, milliseconds, alertable) — stdcall, notepad's single-instance wait
  'waitformultipleobjects': 5,
  'createeventa': 4,
  'createeventw': 4,
  'setevent': 1,
  'resetevent': 1,
  // Kernel32 synchronization objects: CreateMutexExW is the stdcall
  // single-instance check notepad uses (`CreateMutexExW(0, name, 0, 0x1f0001)`).
  'createmutexexw': 4,
  'createmutexw': 2,
  'createmutexa': 2,
  'openmutexw': 3,
  'openmutexa': 3,
  'releasemutex': 1,
  // notepad's second single-instance step: OpenSemaphoreW + GetLastError check.
  'opensemaphorew': 3,
  'createsemaphoreexw': 6, // (attrs, initial, max, name, flags, desiredAccess)
  'freelibrary': 1,
  'loadlibraryexa': 3,
  'loadlibraryexw': 3,
  'findresourcea': 3,
  'findresourcew': 3,
  'loadresource': 2,
  'sizerofresource': 2,
  'lockresource': 1,
  'raiseexception': 3,
  'rtlunwind': 3,
  'unhandledexceptionfilter': 1,
  'setunhandledexceptionfilter': 1,
  'seterrormode': 1,
  'getthreadlocale': 0,
  'getthreaduilanguage': 0,
  'getthreadpreferreduilanguages': 5,
  'setthreadpreferreduilanguages': 3,
  'getuserpreferreduilanguages': 5,
  'getlogicalprocessorinformation': 2,
  'getnativeprocessorinformation': 2,
  'sizeofresource': 2,
  'entercriticalsection': 1,
  'initializecriticalsection': 1,
  'leavecriticalsection': 1,
  'deletecriticalsection': 1,
  // SRW locks: 1-arg stdcall (PSRWLOCK). Missing these leaks 4 bytes/call —
  // notepad's locked getter (0x40a2ec) pushes the lock pointer, calls
  // AcquireSRWLockExclusive, then `pop edi; pop ebx; pop esi; ret` — with a
  // ret-0 stub the stack drifts and the final ret pops 0 (silent exit).
  'acquiresrwlockexclusive': 1,
  'releasesrwlockexclusive': 1,
  'acquiresrwlockshared': 1,
  'releasesrwlockshared': 1,
  'initcommoncontrols': 0,
  'createwindowexw': 12,
  'translatemessage': 1,
  'charlowerbuffw': 2,
  'callwindowprocw': 5,
  'charupperw': 1,
  'peekmessagew': 5,
  'getsystemmetrics': 1,
  'setwindowlongw': 3,
  'getwindowlongw': 2, // GetWindowLongW(hWnd, nIndex) — 2 args, not 3
  'destroywindow': 1,
  // SetWindowTextW/A are 2-arg stdcall — missing this leaked 8B/call in
  // notepad's title setter (0x40f812) and shifted the GS-cookie copy at
  // [esp+0x2bc], making __security_check_cookie fail-fast.
  'setwindowtextw': 2,
  'setwindowtexta': 2,
  'getwindowtextw': 3,
  'getwindowtexta': 3,
  'charupperbuffw': 2,
  'charnextw': 1,
  'msgwaitformultipleobjects': 5,
  'registerwindowmessagew': 1,
  'registerwindowmessagea': 1,
  // User32 GUI stubs used by notepad's window-init + message loop. These are
  // stdcall; without the arg counts the caller's stack drifts after each call.
  'registerclassexw': 1,
  'registerclassexa': 1,
  'showwindow': 2,
  'updatewindow': 1,
  'getmessagew': 4,
  'getmessagea': 4,
  'translateacceleratorw': 3,
  'isdialogmessagew': 2,
  'defwindowprocw': 4,
  'postquitmessage': 1,
  'sendmessagew': 4,
  'sendmessagea': 4,
  'postmessagew': 4,
  'postmessagea': 4,
  'getdc': 1,
  'getwindowdc': 1,
  'releasedc': 2,
  'getdcorgex': 2,
  // CreateStatusWindowW(style, lpszText, hwndParent, id) — 4-arg stdcall
  // (comctl32). notepad creates its status bar with it; a missing argCount
  // would drift the caller's stack by 4 bytes per call.
  'createstatuswindoww': 4,
  // LoadStringW(hInst, id, buf, cch) is 4 stdcall args — ret 12 leaked 4
  // bytes per call, shifting the stack for esp-relative reads in callers.
  'loadstringw': 4,
  'loadstringa': 4,
  'exitwindowsex': 2,
  'dispatchmessagew': 1,
  // GetFileAttributesExW/A(lpFileName, fInfoLevelId, lpFileInformation) —
  // 3-arg stdcall. Missing this leaks 12 bytes/call; notepad calls it right
  // before the GS-cookie check in WinMain's tail (0x40f304), so the drift
  // shifted the cookie copy at [esp+0x4c] and fail-fasted 0xC0000409.
  'getfileattributesexw': 3,
  'getfileattributesexa': 3,
  // SetWinEventHook is 7-arg stdcall (eventMin,eventMax,hmod,pfn,pid,tid,flags);
  // UnhookWinEvent is 1-arg. Missing the count drifts the stack into the
  // message loop (notepad calls it at 0x40f2d5 / before GetMessageW).
  'setwineventhook': 7,
  'unhookwinevent': 1,
  // CoUninitialize takes no args; declare it explicitly so the stub stays a
  // plain `ret` (the default already does this, but be explicit).
  'coinitialize': 0,
  'terminateprocess': 2,
  'sysallocstringlen': 2,
  'safearrayptrofindex': 3,
  'variantcopy': 2,
  'safearraygetlbound': 3,
  'safearraygetubound': 3,
  'variantinit': 1,
  'variantclear': 1,
  'sysfreestring': 1,
  'sysreallocstringlen': 3,
  'variantchangetype': 4,
  'safearraycreate': 2,
  'convertstringsecuritydescriptortosecuritydescriptorw': 3,
  'openthreadtoken': 4,
  'adjusttokenprivileges': 6,
  'lookupprivilegevaluew': 3,
  'regopenkeyexw': 5,
  'openprocesstoken': 3,
  'freesid': 1,
  'allocateandinitializesid': 8,
  'equalsid': 2,
  'regqueryvalueexw': 6,
  // RegGetValueW/A: 7 params stdcall (hkey, lpSubKey, lpValue, dwFlags,
  // pdwType, pvData, pcbData). Missing -> stub ret 0 -> 28 bytes leaked per
  // call -> GS cookie copy in the caller's frame is shifted ->
  // __security_check_cookie fails -> __report_gsfailure -> TerminateProcess
  // 0xC0000409 (cmd.exe fail-fast right after its registry config loop).
  'reggetvaluew': 7,
  'reggetvaluea': 7,
  'gettokeninformation': 5,
  'convertsidtostringsidw': 2,
  'regclosekey': 1,
  'setthreadlocale': 1,
  'getuserdefaultuilanguage': 0,
  'getsystemdefaultuilanguage': 0,
  'getuserdefaultlangid': 0,
  'getuserdefaultlcid': 0,
  'getsystemdefaultlcid': 0,
  'isvalidlocale': 2,
  'getlocaleinfoa': 4,
  'getlocaleinfow': 4,
  'lcmapstringa': 6,
  'lcmapstringw': 6,
  'comparestringa': 6,
  'comparestringw': 6,
  'getdateformata': 8,
  'getdateformatw': 8,
  'enumcalendarinfow': 6,
  'tlsgetvalue': 1,
  'tlssetvalue': 2,
  'heapcreate': 3,
  'heapdestroy': 1,
  'heapsize': 2,
  'heaprealloc': 4,
  'localalloc': 2,
  'localfree': 1,
  'localrealloc': 3,
  'localsize': 1,
  'virtualprotect': 3,
  'virtualqueryex': 4,
  'queryperformancefrequency': 1,
  'queryperformancecounter': 1,
  'setendoffile': 1,
  'setfilepointerex': 5,
  'setfileattributesa': 2,
  'setfileattributesw': 2,
  'findfirstfilea': 3,
  'findfirstfilew': 3,
  'findnextfilea': 3,
  'findnextfilew': 3,
  'findclose': 1,
  'createdirectorya': 2,
  'createdirectoryw': 2,
  'removedirectorya': 1,
  'removedirectoryw': 1,
  'deletefilea': 1,
  'deletefilew': 1,
  'movefilea': 3,
  'movefilew': 3,
  'createprocessa': 10,
  'createprocessw': 10,
  'widechartomultibyte': 8,
  'multibytetowidechar': 6,
  'formatmessagea': 7,
  'formatmessagew': 7,
  'getconsolecp': 0,
  'lstrlenw': 1,
  'lstrlena': 1,
  'rtldllshutdowninprogress': 0,
  'rtldisownmoduleheapallocation': 2,
  'lstrcpyw': 2,
  'lstrcpya': 2,
  'writeprocessmemory': 5,
  'readprocessmemory': 5,
  'getprocesswindowstation': 0,
  'isprocessorfeaturepresent': 1,
  'getstringtypew': 3,
  'getsystemtimeasfiletime': 1,
  'cocreateguid': 1,
  'cocreateinstance': 5, // (rclsid, pUnkOuter, dwClsContext, riid, ppv) — stdcall
  'coinitializeex': 2,
  'couninitialize': 0,
  'cotaskmemalloc': 1, // ole32 stdcall (1 arg) — not cdecl
  'cotaskmemfree': 1,
  'cotaskmemrealloc': 2,
  // kernel32 stdcall, 6 args. __delayLoadHelper2 wraps it as a plain
  // pass-through: `call [__imp_ResolveDelayLoadedAPI]; pop ebp; ret 8`, so the
  // stub MUST clean the 6 stdcall args (ret 24). With ret 0 the helper's
  // `pop ebp` pops arg0 and its `ret 8` pops arg1 (the delay-load descriptor
  // address) as the return address — the guest then "executes" the descriptor
  // data and faults (notepad: eip = 0x427690 = desc).
  'resolvedelayloadedapi': 6,
  'eventregister': 4,
  'eventsetinformation': 5,
  // WinRT string/activation helpers (api-ms-win-core-winrt-* normalize to
  // kernel32). stdcall; without these the stubs are `ret 0` and the caller's
  // stack drifts 4*N bytes per call. notepad's WIP check uses these (its
  // window-init path calls WindowsCreateStringReference + RoGetActivationFactory
  // after the first CreateWindowExW).
  'windowscreatestringreference': 4,
  'windowscreatestring': 3,
  'windowsdeletestring': 1,
  'windowsgetstringrawbuffer': 2,
  'rogetactivationfactory': 3,
  // Mock IProtectionPolicyManager vtable methods (stdcall; see guest-process
  // RoGetActivationFactory handler). notepad calls vtable[12] with 3 args and
  // vtable[14] with 2 args; IUnknown methods are 3/0/0 args (QI/AddRef/Release);
  // the generic slot stub is 0-arg so an unexpected Release() can't pop the
  // caller's stack.
  'pmp_qi': 3,
  'pmp_checkaccess': 3,
  'pmp_isprotected': 2,
  // vtable[2]: notepad's release helper (0x40a518) does
  // `push esi; push edx; call [vtable+8]` then only `pop esi; ret` — the
  // callee must clean the pushed edx (stdcall, ret 4) or the return address
  // shifts and `ret` pops 0.
  'pmp_release': 1,
  'pmp_vtbl_stub': 0,
  'rogetmatchingrestrictederrorinfo': 2,
  'setrestrictederrorinfo': 1,
  // SHGetKnownFolderPath(REFKNOWNFOLDERID, DWORD, HANDLE, PWSTR*) = 4 stdcall
  // args; notepad delay-loads it (SHELL32) to build its title/banner text.
  'shgetknownfolderpath': 4,
  // REGHANDLE is ULONG64: EventUnregister(REGHANDLE) pushes 8 bytes (2 slots)
  // on x86 stdcall, so the stub must ret 8. With ret 4 the caller's stack
  // drifts by 4 and every later [esp+N] read (e.g. a GS cookie copy) is off
  // by one dword -> __security_check_cookie fails -> __report_gsfailure
  // (notepad: fail at 0x40f32f `mov ecx,[esp+0x4c]` after EventUnregister).
  'eventunregister': 2,
  // EventWriteTransfer(REGHANDLE 8B, PCEVENT_DESCRIPTOR 4B, PVOID 4B, ULONG
  // 4B) = 20 bytes = 5 slots; 8 over-cleaned by 12 bytes per call.
  'eventwritetransfer': 5,
  'heapsetinformation': 4,
  'heapqueryinformation': 4,
  // UCRT functions are cdecl — the CALLER cleans the stack, so the stub must
  // be a plain `ret` (argCount 0). Treating them as stdcall (ret N) double-
  // cleans (caller's add esp,N + stub's ret N) and drifts the stack by 4*N
  // per call, corrupting return addresses (notepad's memset -> GetStartupInfoW).
  'memset': 0,
  'memcpy': 0,
  'memmove': 0,
  'wcslen': 0,
  'strlen': 0,
  'wcscpy': 0,
  'wcscat': 0,
  'wcschr': 0,
  'wcsrchr': 0,
  'wcscmp': 0,
  'wcsncmp': 0,
  'wcsstr': 0,
  'wcsspn': 0,
  'wcstok': 0,
  'wcstoul': 0,
  'wcstol': 0,
  '_strlen': 0,
  'strcpy': 0,
  'strcat': 0,
  'strcmp': 0,
  'strchr': 0,
  'strrchr': 0,
  'strstr': 0,
  'strncmp': 0,
  'strncpy': 0,
  'memcmp': 0,
};
export interface ApiStub {
  index: number;
  module: string;
  proc: string;
  stubAddress: number;
  iatAddress: number;
}

export interface MappedImage {
  /** image base in the guest address space */
  baseAddress: number;
  entryPoint: number;
  stubs: ApiStub[];
  /**
   * First free address after the static trap stubs. Dynamic resolutions
   * (GetProcAddress for non-imported APIs) append new stubs from here.
   */
  stubEnd: number;
}

function fileOffset(rawImage: Uint8Array, pe: PeImage, sectionName: string): number {
  const sec = pe.sections.find((s) => s.name === sectionName);
  if (!sec) return 0;
  // PeImage does not carry pointerToRawData; recompute from the raw header.
  const eLfanew = readU32(rawImage, 0x3c);
  const coff = eLfanew + 4;
  const numSections = readU16(rawImage, coff + 2);
  const sizeOfOpt = readU16(rawImage, coff + 16);
  const sectionTable = coff + 20 + sizeOfOpt;
  for (let i = 0; i < numSections; i++) {
    const s = sectionTable + i * 40;
    if (readU32(rawImage, s + 12) === sec.virtualAddress) return readU32(rawImage, s + 20);
  }
  return 0;
}

function readU16(data: Uint8Array, offset: number): number {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint16(offset, true);
}

function readU32(data: Uint8Array, offset: number): number {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset, true);
}

/**
 * Applies the base-relocation delta to every relocation entry after the image
 * was copied into memory. `pe.relocations` carries (rva, type) pairs; type 3
 * (HIGHLOW) patches a 32-bit value, type 10 (DIR64) a 64-bit value.
 * `imageBase` is the effective base the sections were written at.
 */
function applyRelocations(runtime: WasmRuntimeImpl, pe: PeImage, imageBase: number, delta: number): void {
  if (delta === 0) return;
  for (const rel of pe.relocations) {
    const address = imageBase + rel.rva;
    if (rel.type === 3) {
      const value = runtime.readInt32(address);
      runtime.writeInt32(address, value + delta);
    } else {
      // type 10 (DIR64): patch 64-bit; values stay < 2^53 so Number is safe
      const low = runtime.readInt32(address);
      const high = runtime.readInt32(address + 4);
      const value = low + high * 4294967296;
      const next = value + delta;
      runtime.writeInt32(address, next | 0);
      runtime.writeInt32(address + 4, Math.floor(next / 4294967296));
    }
  }
}

/** Maps the image and rewrites the IAT; returns the stub/import table. */
export function mapPeImage(runtime: WasmRuntimeImpl, rawImage: Uint8Array, pe: PeImage): MappedImage {
  // Choose the effective image base (rebase oversized PE32+ images).
  const rebase = pe.baseAddress > MAX_IMAGE_BASE;
  const baseAddress = rebase ? X64_BASE : pe.baseAddress;
  const delta = baseAddress - pe.baseAddress;
  const entryRva = pe.entryPoint - pe.baseAddress;

  // 1. sections
  for (const sec of pe.sections) {
    const dst = baseAddress + sec.virtualAddress;
    const off = fileOffset(rawImage, pe, sec.name);
    const span = Math.max(sec.virtualSize, sec.rawSize);
    const n = Math.min(sec.rawSize, Math.max(0, rawImage.byteLength - off));
    if (n > 0) runtime.writeBytes(dst, rawImage.subarray(off, off + n));
    if (span > n) runtime.writeBytes(dst + n, new Uint8Array(span - n));
  }

  // 2. base relocations (rebasing a PE32+ image below 4GB)
  applyRelocations(runtime, pe, baseAddress, delta);

  // 3. IAT rewriting with trap stubs
  let nextStub = STUB_BASE;
  const stubs: ApiStub[] = [];
  let index = 0;
  for (const imp of pe.imports) {
    for (const fn of imp.functions) {
      const proc = fn.name ?? `#${fn.ordinal ?? 0}`;
      const stubAddress = nextStub;
      // mov eax, <index>; int 0x2E; ret [<args*4>]
      // 32-bit APIs are stdcall: the stub must pop the caller's arguments or
      // the guest stack drifts and the next `ret` pops a garbage address.
      const argCount = pe.is64 ? 0 : X86_API_ARG_COUNT[proc.toLowerCase()] ?? 0;
      const stubLen = pe.is64 || argCount === 0 ? 8 : 10;
      const stub = new Uint8Array(stubLen);
      stub[0] = 0xb8;
      stub[1] = index & 0xff;
      stub[2] = (index >> 8) & 0xff;
      stub[3] = (index >> 16) & 0xff;
      stub[4] = (index >> 24) & 0xff;
      stub[5] = 0xcd;
      stub[6] = 0x2e;
      if (argCount > 0) {
        // ret <args*4> — clears the pushed arguments (stdcall).
        const popBytes = argCount * 4;
        stub[7] = 0xc2;
        stub[8] = popBytes & 0xff;
        stub[9] = (popBytes >> 8) & 0xff;
      } else {
        stub[7] = 0xc3;
      }
      runtime.writeBytes(stubAddress, stub);

      // IAT slot: image base + iatRva + slot*4 (thunks are 8 bytes on PE32+)
      const slot = imp.functions.indexOf(fn);
      const iatAddress = baseAddress + imp.iatRva + slot * (pe.is64 ? 8 : 4);
      if (pe.is64) {
        runtime.writeInt32(iatAddress, stubAddress);
        runtime.writeInt32(iatAddress + 4, 0);
      } else {
        runtime.writeInt32(iatAddress, stubAddress);
      }

      stubs.push({ index, module: imp.moduleName, proc, stubAddress, iatAddress });
      nextStub += stubLen;
      index += 1;
    }
  }

  return { baseAddress, entryPoint: entryRva + baseAddress, stubs, stubEnd: nextStub };
}
