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

import type { PeImage } from '@specter-core/contracts';
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
  // BrandingFormatString (winbrand.dll, delay-loaded): stdcall, 1 arg.
  // A missing/0 argCount makes the dynamic stub `ret 0`, leaving the pushed
  // arg on the stack — the caller's `pop edi/esi/ebx` then read shifted slots
  // and edi ends up a pseudo-handle (0xfffffff4) -> OOB in cmd.exe.
  'brandingformatstring': 1,
  // Wldp.dll delay-loads by ORDINAL (unnamed exports) — cmd.exe calls them
  // via .didat thunks: [0x453004] = Wldp#10 (3 stdcall args: "WindowsCommand-
  // Prompt", "LockBatchFilesWhenInUse", &out), [0x453000] = Wldp#2 (5 stdcall
  // args). allocDynamicStub mints procName "#10"/"#2"; a name-only lookup
  // misses and the stub `ret 0`, leaking 12/20 bytes per call — that +12 drift
  // clobbered ebx in cmd's parser 0x40b743 epilogue (main's slot loop then
  // skipped the `dir` command and cmd exited 0 silently). Keyed by module
  // because ordinals are per-DLL (module-qualified lookup in allocDynamicStub).
  'wldp.dll!#10': 3,
  'wldp.dll!#2': 5,
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
  // GetNativeSystemInfo(LPSYSTEM_INFO) — 1 stdcall arg (ret 4). Resolved via
  // GetProcAddress/delay-load by 32-bit installers; a missing argCount makes
  // the dynamic stub `ret 0`, leaking 4 bytes per call and drifting the
  // caller's frame so its `ret` pops a stale slot (VSCode Setup ia32: the
  // .itext dispatch fn's ret popped 0x10100 instead of its real return addr).
  'getnativesysteminfo': 1,
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
  // DeleteDC(hdc) — 1-arg stdcall. MISSING -> stub ret 0 -> 4 bytes leaked
  // per call; winmine's bitmap cleanup loop (0x1002607) calls it 16x, so the
  // drift shifts the epilogue `ret` to pop a garbage return address.
  'deletedc': 1,
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
  // GetTextFaceW(hdc, cch, lpFaceName) — 3 args. With 2 the stub ret 8 leaks
  // 4 bytes/call; notepad calls it right before 0x40f70f (status-bar/font
  // init) whose epilogue pops ebx — a leak here corrupts the restored ebx.
  'gettextfacew': 3,
  'setmapmode': 2,
  'getmapmode': 1,
  'gettextalign': 1,
  'settextalign': 2,
  'setviewportorgex': 3,
  'setwindoworgex': 3,
  'createcompatibledc': 1,
  'createcompatiblebitmap': 3,
  // SetDIBitsToDevice(hdc, xDest, yDest, dwWidth, dwHeight, xSrc, ySrc,
  // uStartScan, cScanLines, lpvBits, lpbmi, fColorUse) — 12-arg stdcall.
  // MISSING -> stub ret 0 -> 48 bytes leaked per call; winmine's board-draw
  // loop calls it 16x and the epilogue `ret` then popped garbage (eip=0x10).
  'setdibitstodevice': 12,
  // SetROP2(hdc, fnDrawMode) / SetPixel(hdc, x, y, crColor) — used by winmine's
  // board drawing (SetROP2 R2_XORPEN for flag reveal). Missing argCounts leak
  // 8/12 bytes per call and corrupt the draw-loop stack.
  'setrop2': 2,
  'setpixel': 3,
  // GetLayout(hdc) / SetLayout(hdc, dwLayout) — 1/2-arg stdcall (GDI).
  'getlayout': 1,
  'setlayout': 2,
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
  // ANSI/UTF-16 conversion (notepad's save path converts EDIT text before
  // writing). stdcall; argCounts matter for the dynamic stub `ret N`.
  'widechartomultibyte': 8,
  'multibytetowidechar': 6,
  'wcsnlen': 2,
  // GetFileAttributesExW/A(lpFileName, fInfoLevelId, lpFileInformation) —
  // 3-arg stdcall. Missing this leaks 12 bytes/call; notepad calls it right
  // before the GS-cookie check in WinMain's tail (0x40f304), so the drift
  // shifted the cookie copy at [esp+0x4c] and fail-fasted 0xC0000409.
  'setendoffile': 1,
  'getfileattributesexw': 3,
  'getfileattributesexa': 3,
  'pathfindextensionw': 1,
  'pathfindfilenamew': 1,
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
  // comdlg32 common file dialogs (notepad delay-loads these via .didat):
  // stdcall, 1 arg (LPOPENFILENAME). A wrong/missing argCount leaks 4 bytes
  // per call and drifts the guest stack (same family as the cmd.exe leaks).
  'getopenfilenamew': 1,
  'getopenfilenamea': 1,
  'getsavefilenamew': 1,
  'getsavefilenamea': 1,
  // shlwapi / file helpers notepad uses in the save path (delay-loaded):
  'deletefilew': 1,
  'deletefilea': 1,
  'pathfileexistsw': 1,
  'pathfileexistsa': 1,
  'commdlgextendederror': 0,
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
  // GetDiskFreeSpaceExW/A take 4 params (stdcall, ret 16). Missing entries
  // made the stub `ret 0`, leaking 16 bytes per call; cmd.exe's dir summary
  // then read garbage stack -> 0/0 div fault at 0x406515 (fix session 6).
  'getdiskfreespaceexw': 4,
  'getdiskfreespaceexa': 4,
  'expandenvironmentstringsa': 3,
  'expandenvironmentstringsw': 3,
  'getcurrentprocess': 0,
  'getcurrentthread': 0,
  'getexitcodeprocess': 2,
  'getexitcodethread': 2,
  'exitthread': 1,
  'createthread': 6,
  'openthread': 3,
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
  // InitializeCriticalSectionEx(lpCriticalSection, dwSpinCount, dwFlags) is
  // 3-arg stdcall; a 1-arg stub ret 4 over-cleans 8 bytes and the caller's
  // epilogue `ret` pops a garbage slot (PuTTY delay-load path 0x4c35a7).
  'initializecriticalsectionex': 3,
  'initializecriticalsectionandspincount': 2,
  'leavecriticalsection': 1,
  'deletecriticalsection': 1,
  'tryentercriticalsection': 1,
  // SRW locks: 1-arg stdcall (PSRWLOCK). Missing these leaks 4 bytes/call —
  // notepad's locked getter (0x40a2ec) pushes the lock pointer, calls
  // AcquireSRWLockExclusive, then `pop edi; pop ebx; pop esi; ret` — with a
  // ret-0 stub the stack drifts and the final ret pops 0 (silent exit).
  'acquiresrwlockexclusive': 1,
  'releasesrwlockexclusive': 1,
  'acquiresrwlockshared': 1,
  'releasesrwlockshared': 1,
  'initcommoncontrols': 0,
  // InitCommonControlsEx(const INITCOMMONCONTROLSEX*) — 1-arg stdcall
  // (comctl32). MISSING -> stub ret 0 -> 4 bytes leaked; winmine calls it
  // during startup before RegisterClassW.
  'initcommoncontrolsex': 1,
  'createwindowexw': 12,
  'translatemessage': 1,
  'charlowerbuffw': 2,
  'callwindowprocw': 5,
  'charupperw': 1,
  'peekmessagew': 5,
  'getsystemmetrics': 1,
  // GetMenuItemRect(hWnd, hMenu, uItem, lprcItem) — 4-arg stdcall. MISSING
  // argCount -> stub ret 0 -> 16 bytes leaked per call; winmine's window
  // positioner calls it twice and the epilogue `ret` then popped the window
  // title buffer 0x1005aa0 as the return address.
  'getmenuitemrect': 4,
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
  'charupperbuffa': 2,
  'charuppera': 1,
  'charnextw': 1,
  'msgwaitformultipleobjects': 5,
  'registerwindowmessagew': 1,
  'registerwindowmessagea': 1,
  // User32 GUI stubs used by notepad's window-init + message loop. These are
  // stdcall; without the arg counts the caller's stack drifts after each call.
  'registerclassexw': 1,
  'registerclassexa': 1,
  // RegisterClassW/A(const WNDCLASS*) — 1-arg stdcall. MISSING -> stub ret 0
  // -> 4 bytes leaked; winmine registers its board window class through it.
  'registerclassw': 1,
  'registerclassa': 1,
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
  // PlaySoundW(pszSound, hmod, fdwSound) — 3-arg stdcall (winmm). MISSING
  // argCount -> stub ret 0 -> 12 bytes leaked; winmine's sound helper then
  // `ret`s from a stack slot holding 0 -> eip=0 -> "entry returned without
  // ExitProcess" right before CreateWindowExW.
  'playsoundw': 3,
  'getdc': 1,
  'getwindowdc': 1,
  'releasedc': 2,
  'getdcorgex': 2,
  // LoadCursorW(hInstance, lpCursorName) / LoadAcceleratorsW(hInstance,
  // lpTableName) — 2-arg stdcall. MISSING argCount -> stub ret 0 -> 8 bytes
  // leaked per call. In notepad's 0x41325f init this drifts esp so the
  // `pop ebx` inside 0x41f8cf (RegisterClassExW wrapper) pops a leaked arg
  // instead of the caller's saved ebx (the file arg) — notepad then skips
  // the command-line file open entirely (root-caused 2026-08-20).
  'loadcursorw': 2,
  'loadcursora': 2,
  'loadiconw': 2,
  'loadicona': 2,
  'loadimagew': 6,
  'loadimagea': 6,
  'loadacceleratorsw': 2,
  'loadacceleratorsa': 2,
  'setcursor': 1,
  'getkeyboardlayout': 1,
  // winmine (classic Minesweeper) message-loop / dialog helpers. Missing
  // argCounts leak 4-16 bytes per call; winmine's timer + dialog paths then
  // `ret` from a shifted stack slot.
  'settimer': 4,
  'killtimer': 2,
  'getdesktopwindow': 0,
  'loadmenu': 2,
  // LoadMenuW(hInstance, lpMenuName) — 2-arg stdcall. MISSING -> stub ret 0
  // -> 8 bytes leaked; winmine loads its menu right after RegisterClassW.
  'loadmenuw': 2,
  'loadmenua': 2,
  'setmenu': 2,
  'getdlgitemint': 4,
  'setdlgitemint': 4,
  'releasecapture': 0,
  'setcapture': 1,
  'mapwindowpoints': 4,
  'ptinrect': 3,
  // SetRect(lprc, xLeft, yTop, xRight, yBottom) — 5-arg stdcall. MISSING ->
  // stub ret 0 -> 20 bytes leaked; winmine's window positioner 0x1001950
  // calls it right before InvalidateRect, so the drift shifts the epilogue
  // `ret 4` to pop a leftover return address (0x1002823) and fault.
  'setrect': 5,
  'winhelpw': 4,
  // --- more User32/GDI/kernel32 stdcall arg counts observed in notepad ---
  // (each missing count makes the trap stub `ret 0` and leak the args —
  // register-restoring `pop reg` sequences then read leaked values).
  'getsystemmenu': 2,
  'monitorfromwindow': 2,
  'getdpiforwindow': 1,
  // GetDpiForMonitor(hmonitor, dpiType, dpiX, dpiY) — 4-arg stdcall (shcore,
  // delay-loaded via notepad's DPI helpers 0x41313f/0x413179). Missing ->
  // stub ret 0 -> 16 bytes leaked per call in the main init flow.
  'getdpiformonitor': 4,
  'lstrcmpiw': 2,
  'lstrcmpia': 2,
  'setthreaddpiawarenesscontext': 1,
  'setwindowplacement': 2,
  'getwindowplacement': 2,
  'istextunicode': 2,
  'getmodulehandleexw': 3,
  'getfileinformationbyhandle': 2,
  'createfilemappingw': 6,
  'mapviewoffile': 5,
  'unmapviewoffile': 1,
  'flushviewoffile': 2,
  'muldiv': 3,
  'setwindowpos': 7,
  'movewindow': 6,
  'invalidaterect': 3,
  'redrawwindow': 4,
  'enablewindow': 2,
  'iswindow': 1,
  'setfocus': 1,
  'isiconic': 1,
  'setactivewindow': 1,
  'getmenu': 1,
  'getsubmenu': 2,
  'checkmenuitem': 3,
  'enablemenuitem': 3,
  'notifywinevent': 6,
  'trackmouseevent': 1,
  'getdlgitem': 2,
  'getdlgitemtextw': 4,
  'senddlgitemmessagew': 4,
  'setdlgitemtextw': 3,
  'isdlgbuttonchecked': 2,
  'checkdlgbutton': 2,
  'checkradiobutton': 4,
  'enddialog': 2,
  'messagebeep': 1,
  'isclipboardformatavailable': 1,
  'openclipboard': 1,
  'closeclipboard': 0,
  'getwindowtextlengthw': 1,
  'getpropw': 2,
  'setpropw': 3,
  'removepropw': 2,
  'setscrollpos': 5,
  'destroyicon': 1,
  'getmodulefilenameexw': 4,
  'globalalloc': 2,
  'globalfree': 1,
  'globallock': 1,
  'globalunlock': 1,
  'regsetvalueexw': 4,
  'regcreatekeyw': 3,
  'regcreatekeyexw': 9,
  'regdeletekeyexw': 6,
  'regenumvaluew': 6,
  'regqueryinfokeyw': 5,
  'regsetkeyvaluew': 5,
  'getfiletime': 4,
  'setfiletime': 4,
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
  // GetDateFormatW/A and GetTimeFormatW/A are 6 stdcall args (Locale,
  // dwFlags, lpDate/lpTime, lpFormat, lpBuffer, cchBuffer). The old 8
  // over-cleaned 8 bytes/call and 0 (missing) under-popped 8 bytes/call;
  // either drifts cmd's stack while it formats dir row dates.
  'getdateformata': 6,
  'getdateformatw': 6,
  'gettimeformata': 6,
  'gettimeformatw': 6,
  // FILETIME <-> SYSTEMTIME conversions (cmd formats dir row dates/times):
  // FileTimeToSystemTime(ft, st), SystemTimeToFileTime(st, ft),
  // FileTimeToLocalFileTime(ft, out) — all 2-arg stdcall.
  'filetimetosystemtime': 2,
  'systemtimetofiletime': 2,
  'filetimetolocalfiletime': 2,
  'enumcalendarinfow': 6,
  'tlsgetvalue': 1,
  'tlssetvalue': 2,
  'heapcreate': 3,
  'heapdestroy': 1,
  // HeapSize(hHeap, dwFlags, lpMem) is 3 stdcall args. With 2 the stub ret 8
  // under-pops 4 bytes/call; cmd's heap-string helper 0x411cd0 (called from
  // the dir path) then pops its epilogue 4 bytes low — esi/ebx get the saved
  // edi/esi, and `ret` pops the caller's saved ebx (a heap string pointer
  // like 0x20612d0) as the return address -> the emulator executes data.
  'heapsize': 3,
  'heaprealloc': 4,
  'localalloc': 2,
  'localfree': 1,
  'localrealloc': 3,
  'localsize': 1,
  // LocalLock/LocalUnlock: 1-arg stdcall. Missing argCount -> stub ret 0 ->
  // 4 bytes leak per call. notepad's save routine calls LocalLock between
  // CreateFileW and WideCharToMultiByte; the drift shifts every later
  // [esp+X] read by +4, so the encoding value written at [esp+0x18] by
  // 0x410d2a is read at [esp+0x14] instead and the write helper bails.
  'locallock': 1,
  'localunlock': 1,
  'virtualprotect': 3,
  'virtualqueryex': 4,
  'queryperformancefrequency': 1,
  'queryperformancecounter': 1,
  'setfilepointerex': 5,
  'setfileattributesa': 2,
  'setfileattributesw': 2,
  // FindFirstFileW/A and FindNextFileW/A each take exactly 2 stdcall args
  // (FindFirstFile: lpFileName, lpFindFileData; FindNextFile: hFindFile,
  // lpFindFileData). The IAT trap stub is `mov eax,idx; int 0x2E; ret args*4`,
  // so an over-count of 1 makes the stub pop 4 extra bytes and corrupt esp,
  // which in turn desyncs the MSVC /GS cookie check and triggers 0xc0000409.
  'findfirstfilea': 2,
  'findfirstfilew': 2,
  'findnextfilea': 2,
  'findnextfilew': 2,
  // FindFirstFileExW/A: (lpFileName, fInfoLevelId, lpFindFileData, fSearchOp,
  // lpSearchFilter, dwAdditionalFlags) = 6 stdcall args. cmd.exe's `dir`
  // enumerates with FindFirstFileExW(FindExInfoBasic); without the entry the
  // stub ret 0 leaks 24 bytes/call and dir fails with ERROR_CALL_NOT_IMPLEMENTED.
  'findfirstfileexa': 6,
  'findfirstfileexw': 6,
  'findclose': 1,
  'createdirectorya': 2,
  'createdirectoryw': 2,
  'removedirectorya': 1,
  'removedirectoryw': 1,
  'movefilea': 3,
  'movefilew': 3,
  'createprocessa': 10,
  'createprocessw': 10,
  'formatmessagea': 7,
  'formatmessagew': 7,
  'getconsolecp': 0,
  // GetConsoleTitleW/A(LPTSTR lpConsoleTitle, DWORD nSize) — 2-arg stdcall.
  // Missing -> stub ret 0 -> 8 bytes leaked -> caller's esp drifts -> every
  // later push/call lands at the wrong slot -> the next function's EBP comes
  // out as 0x07000000 (cmd.exe: 0x40b991 call [0x450044]=GetConsoleTitleW,
  // then 0x40ba01 call 0x42d39c reads a garbage EBP -> [ebp-4] cookie copy
  // lands at the wrong address -> __security_check_cookie FAIL @0x42d47a).
  'getconsoletitlew': 2,
  'getconsoletitlea': 2,
  'setconsoletitlew': 1,
  'setconsoletitlea': 1,
  // Console I/O family (cmd.exe 0x40a1f5 = console/error-format helper):
  // GetConsoleScreenBufferInfo(hConsoleOutput, LPSCREEN_BUFFER_INFO) = 2-arg
  // stdcall. Missing -> stub ret 0 -> 8 bytes leaked -> 0x40a1f5 epilogue's
  // pop edi/esi/ebx read shifted slots (saved edi lands in ebx) -> the caller
  // then derefs a pseudo-handle (0xfffffff4) -> OOB at 0x40baa6.
  'getconsolescreenbufferinfo': 2,
  'writeconsolew': 5,
  'writeconsolea': 5,
  'readconsolew': 4,
  'readconsolea': 4,
  'setconsolecursorposition': 2,
  'getconsolecursorinfo': 2,
  'scrollconsolescreenbufferw': 5,
  'fillconsoleoutputattribute': 5,
  'fillconsoleoutputcharacterw': 5,
  'setconsoletextattribute': 2,
  'flushconsoleinputbuffer': 1,
  'setconsolectrlhandler': 2,
  'getconsolewindow': 0,
  'setconsoleactivebuffer': 1,
  'getconsoleprocesslist': 2,
  'setconsolecp': 1,
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
  // ApiSetQueryApiSetPresence(PCWSTR Namespace, PBOOLEAN Present) — 2-arg
  // stdcall (api-ms-win-core-apiquery -> kernel32). Missing argCount made the
  // stub `ret 0`, leaking 8 bytes; the default no-handler return (0) made cmd
  // treat it as success and the Present output slot (a stack byte adjacent to
  // the saved caller EBP) was left uninitialised, but the real corruption came
  // from the 8-byte stack drift shifting the caller's frame. Declare explicitly.
  'apisetqueryapisetpresence': 2,
  // RtlCreateUnicodeStringFromAsciiz(PUNICODE_STRING Dest, PCSTR Src) — 2-arg
  // stdcall (ntdll). Missing argCount -> stub ret 0 -> 8 bytes leaked per call,
  // drifting the caller's stack in cmd's string-init path (0x42d3e7).
  'rtlcreateunicodestringfromasciiz': 2,
  // netapi32 + version.dll for 32-bit installers (VSCode Setup ia32). All are
  // WINAPI (stdcall): a missing argCount makes the stub `ret 0` and drift the
  // guest stack — NetWkstaGetInfo's 3 args leaked 12 bytes (fault at 0x7fffe00).
  'netwkstagetinfo': 3,
  'netapibufferfree': 1,
  'getfileversioninfosizew': 2,
  'getfileversioninfow': 4,
  'verqueryvaluew': 4,
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

      // IAT slot: image base + iatRva + slot*8 (thunks are 8 bytes on PE32+).
      // The slot must use the entry's ILT index: dropping entries (e.g. ordinal
      // imports) earlier would shift later slots and mispatch `call [IAT]` sites.
      const slot = fn.index ?? imp.functions.indexOf(fn);
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
