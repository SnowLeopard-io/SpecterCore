/**
 * Diagnostic CLI: explain WHY a guest faulted (memory OOB / unsupported op).
 *
 *   pnpm diag:exe -- path/to/app.exe
 *
 * Reuses the full run pipeline (GuestProcessRunner) and, on fault, dumps the
 * register file, the decoded block at the faulting EIP, and the effective
 * address of every memory operand computed from the dumped registers — the
 * candidate(s) that hit "memory access out of bounds" light up immediately.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ApiHost, FileSystemBridge, WinError } from '@specter-core/contracts';
import {
  ApiInterceptorImpl,
  GuestProcessRunner,
  JitEngineImpl,
  mapPeImage,
  PeLoaderImpl,
  registerDefaultHandlers,
  REG32_LIST,
  WasmRuntimeImpl,
  X86Decoder,
} from '@specter-core/core';
import type { ApiCallContext, ApiResult, Instruction, MemOperand } from '@specter-core/core';
import { normalizeApiSetModule } from '@specter-core/core';

/** Logs every API trap so we can see what the guest queried before the fault. */
class LoggingInterceptor extends ApiInterceptorImpl {
  private readonly memHost: ApiHost;
  private readonly rt: typeof runtime;
  constructor(host: ApiHost, rt: typeof runtime) {
    super(host);
    this.memHost = host;
    this.rt = rt;
  }
  override async dispatch(ctx: ApiCallContext): Promise<ApiResult> {
    if (ctx.proc.toLowerCase().includes('command_line') || ctx.proc.toLowerCase() === 'charnextw') {
      console.error(`[dbg] ${ctx.module}!${ctx.proc} normalized=${normalizeApiSetModule(ctx.module)} handler=${this.getHandler(normalizeApiSetModule(ctx.module), ctx.proc) ? 'YES' : 'NO'}`);
    }
    const args = ctx.rawArgs.slice(0, 12).map((a) => `0x${(a >>> 0).toString(16)}`);
    const espNow = this.rt.getReg('esp') >>> 0;
    const result = await super.dispatch(ctx);
    console.error(
      `[api] esp=0x${espNow.toString(16)} ${ctx.module}!${ctx.proc}(${args.join(', ')}) -> 0x${(result.returnValue >>> 0).toString(16)}${result.returnValueHigh !== undefined ? `:0x${(result.returnValueHigh >>> 0).toString(16)}` : ''}`,
    );
    // Dump the wide string at a GetCommandLineW return address to verify the
    // guest actually received the intended command line (not an empty string).
    if (ctx.proc.toLowerCase() === 'getcommandlinew') {
      const p = result.returnValue >>> 0;
      const raw = this.memHost.memory.read(p, 128);
      const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
      let s = '';
      for (let i = 0; i + 1 < raw.byteLength; i += 2) {
        const c = view.getUint16(i, true);
        if (c === 0) break;
        s += String.fromCharCode(c);
      }
      console.error(`[dbg]   GetCommandLineW => @0x${p.toString(16)} ${JSON.stringify(s)}`);
    }
    if (ctx.proc.toLowerCase() === 'verifyversioninfow') {
      const addr = ctx.rawArgs[0] ?? 0;
      const b = this.memHost.memory.read(addr, 24);
      const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join(' ');
      console.error(`[api]   OSVERSIONINFOEXW @0x${addr.toString(16)}: ${h}`);
    }
    if (ctx.proc.toLowerCase() === 'isprocessorfeaturepresent') {
      const feat = ctx.rawArgs[0] ?? 0;
      if (feat === 0x17) {
        // This IsProcessorFeaturePresent(0x17) is cmd's OWN call (slot 0x452440),
        // the last API before the GS failure. At this point esp -> return address
        // into the FAILING function (right after `call IsProcessorFeaturePresent`).
        const espVal = this.rt.getReg('esp') >>> 0;
        const rd32 = (a: number) => {
          const b = this.memHost.memory.read(a >>> 0, 4);
          return b.byteLength < 4 ? NaN : new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true);
        };
        // __report_gsfailure prologue: push ebp; mov ebp,esp; sub esp,0x324;
        //   push 0x17; call IsProcFeat. At the call trap (IsProcFeat entry) esp has
        //   been decremented by push ebp(4) + sub 0x324 + push 0x17(4) + call(4)
        //   = 0x330 from the pre-prologue esp. gsEbp was set by `mov ebp,esp`
        //   right after `push ebp`, i.e. 4 less than pre-prologue esp.
        //   => gsEbp = esp + 0x330 - 4 = esp + 0x32c.
        //   [gsEbp] = saved ebp = FAILING FN ebp;
        //   [gsEbp+4] = ret into failing fn (just after `call __report_gsfailure`).
        const retIntoGs = rd32(espVal);                 // [esp] = ret into __report_gsfailure
        const gsEbp = espVal + 0x32c;                   // __report_gsfailure.ebp (computed)
        const failingEbp = rd32(gsEbp);                // failing fn ebp
        const retIntoFailing = rd32(gsEbp + 4);        // ret into failing fn
        const callerEbp = rd32(failingEbp);
        const retIntoCaller = rd32(failingEbp + 4);
        const stackDump: string[] = [];
        for (let i = 0; i <= 0x300; i += 4) {
          const v = rd32(espVal + i);
          if (v >= 0x400000 && v < 0x440000 && (v & 0x3) === 0) stackDump.push(`[esp+0x${i.toString(16)}]=0x${v.toString(16)}`);
        }
        console.error(`[gs2] IsProcessorFeaturePresent(0x17) inside __report_gsfailure; esp=0x${espVal.toString(16)}`);
        console.error(`[gs2] [esp]=0x${retIntoGs.toString(16)}  gsEbp=0x${gsEbp.toString(16)}`);
        console.error(`[gs2] FAILING_FN ebp=0x${failingEbp.toString(16)} retIntoFailingFn=0x${retIntoFailing.toString(16)}`);
        console.error(`[gs2] caller ebp=0x${callerEbp.toString(16)} retIntoCaller=0x${retIntoCaller.toString(16)}`);
        console.error(`[gs2] cookie@0x4340c0=0x${rd32(0x4340c0).toString(16)}  cookieSlot[failingEbp-4]=0x${rd32(failingEbp - 4).toString(16)}`);
        console.error(`[gs2] stack(.text): ${stackDump.join(' ')}`);
      }
    }
    if (ctx.proc.toLowerCase() === 'createfilew') {
      const addr = ctx.rawArgs[0] ?? 0;
      const raw = this.memHost.memory.read(addr, 256);
      const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
      let s = '';
      for (let i = 0; i + 1 < raw.byteLength; i += 2) {
        const c = view.getUint16(i, true);
        if (c === 0) break;
        s += String.fromCharCode(c);
      }
      console.error(`[api]   CreateFileW path: ${JSON.stringify(s)}`);
    }
    if (ctx.proc.toLowerCase() === 'findfirstfilew' || ctx.proc.toLowerCase() === 'findfirstfileexw') {
      const addr = ctx.rawArgs[0] ?? 0;
      const raw = this.memHost.memory.read(addr, 512);
      const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
      let s = '';
      for (let i = 0; i + 1 < raw.byteLength; i += 2) {
        const c = view.getUint16(i, true);
        if (c === 0) break;
        s += String.fromCharCode(c);
      }
      console.error(`[api]   ${ctx.proc} path: ${JSON.stringify(s)}`);
      // dump the find-data buffer after the handler filled it
      const fd = ctx.rawArgs[2] ?? 0;
      if (ctx.proc.toLowerCase() === 'findfirstfileexw' && fd) {
        const fb = this.memHost.memory.read(fd, 592);
        const fv = new DataView(fb.buffer, fb.byteOffset, fb.byteLength);
        const attrs = fv.getUint32(0, true);
        const size = fv.getUint32(32, true);
        let fn = '';
        for (let i = 0; i < 259; i++) {
          const c = fv.getUint16(44 + i * 2, true);
          if (c === 0) break;
          fn += String.fromCharCode(c);
        }
        const ftc = fv.getUint32(8, true); // ftCreationTime low
        console.error(`[api]   findData@0x${fd.toString(16)} attrs=0x${attrs.toString(16)} size=${size} ftCreationLow=0x${ftc.toString(16)} name=${JSON.stringify(fn)}`);
      }
    }
    if (ctx.proc.toLowerCase() === 'messageboxw') {
      const text = ctx.rawArgs[1] ?? 0;
      const cap = ctx.rawArgs[2] ?? 0;
      const readW = (addr: number): string => {
        const b = this.memHost.memory.read(addr, 512);
        const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
        let s = '';
        for (let i = 0; i + 1 < b.byteLength; i += 2) {
          const c = v.getUint16(i, true);
          if (c === 0) break;
          s += String.fromCharCode(c);
        }
        return s;
      };
      console.error(`[api]   MessageBoxW text=${JSON.stringify(readW(text))} caption=${JSON.stringify(readW(cap))}`);
    }
    if (ctx.proc.toLowerCase() === 'loadstringw') {
      const id = (ctx.rawArgs[1] ?? 0) >>> 0;
      const buf = (ctx.rawArgs[2] ?? 0) >>> 0;
      const cch = (ctx.rawArgs[3] ?? 0) >>> 0;
      console.error(
        `[api]   LoadStringW hInst=0x${(ctx.rawArgs[0] ?? 0).toString(16)} id=${id} buf=0x${(buf >>> 0).toString(16)} cch=${cch}`,
      );
    }
    if (ctx.proc.toLowerCase() === 'registerwindowmessagew') {
      const addr = ctx.rawArgs[0] ?? 0;
      const raw = this.memHost.memory.read(addr, 64);
      const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
      let s = '';
      for (let i = 0; i + 1 < raw.byteLength; i += 2) {
        const c = view.getUint16(i, true);
        if (c === 0) break;
        s += String.fromCharCode(c);
      }
      console.error(`[api]   RegisterWindowMessageW text=${JSON.stringify(s)}`);
    }
    if (ctx.proc.toLowerCase() === 'getenvironmentstringsw' || ctx.proc.toLowerCase() === 'getenvironmentstringsa') {
      const addr = result.returnValue >>> 0;
      const raw = this.memHost.memory.read(addr, 96);
      const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
      let s = '';
      let zeros = 0;
      for (let i = 0; i + 1 < raw.byteLength; i += 2) {
        const c = view.getUint16(i, true);
        s += c === 0 ? '\u0000' : String.fromCharCode(c);
        if (c === 0) zeros++;
      }
      console.error(`[api]   ${ctx.proc} block @0x${addr.toString(16)}: ${JSON.stringify(s)} zeros=${zeros}`);
    }
    if (ctx.proc.toLowerCase() === 'writeconsolew' || ctx.proc.toLowerCase() === 'writefile') {
      const buf = ctx.rawArgs[1] ?? 0;
      const n = (ctx.rawArgs[2] ?? 0) >>> 0;
      const cap = Math.min(n, 4096);
      const rawb = this.memHost.memory.read(buf, cap);
      const view = new DataView(rawb.buffer, rawb.byteOffset, rawb.byteLength);
      // Dump as wide chars if it looks like UTF-16LE text, else raw hex.
      let s = '';
      for (let i = 0; i + 1 < rawb.byteLength; i += 2) {
        const c = view.getUint16(i, true);
        if (c === 0) break;
        s += String.fromCharCode(c);
      }
      const printable = s.length > 0 && [...s].every((ch) => ch === '\r' || ch === '\n' || ch === '\t' || (ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) < 0x7f) || ch.charCodeAt(0) > 0x7f);
      if (printable) {
        console.error(`[api]   ${ctx.proc} buf=0x${buf.toString(16)} n=${n} wide=${JSON.stringify(s)}`);
      } else {
        const hex = [...rawb.subarray(0, Math.min(64, rawb.byteLength))].map((x) => x.toString(16).padStart(2, '0')).join(' ');
        console.error(`[api]   ${ctx.proc} buf=0x${buf.toString(16)} n=${n} hex=${hex}`);
      }
    }
    if (ctx.proc.toLowerCase().includes('vswprintf') || ctx.proc.toLowerCase().includes('vsnwprintf')) {
      const buf = ctx.rawArgs[2] ?? 0;
      const count = ctx.rawArgs[3] ?? 0;
      const fmt = ctx.rawArgs[4] ?? 0;
      const va = ctx.rawArgs[6] ?? 0;
      const readW = (a: number, len = 128) => {
        const b = this.memHost.memory.read(a >>> 0, len);
        const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
        let s = '';
        for (let i = 0; i + 1 < b.byteLength; i += 2) {
          const c = v.getUint16(i, true);
          if (c === 0) break;
          s += String.fromCharCode(c);
        }
        return s;
      };
      const rd32 = (a: number) => {
        const b = this.memHost.memory.read(a >>> 0, 4);
        return b.byteLength < 4 ? NaN : new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true);
      };
      const vaDump: string[] = [];
      for (let i = 0; i < 8; i++) {
        const v = rd32(va + i * 4);
        if (!v) break;
        const s = readW(v, 64);
        vaDump.push(`[va+${i * 4}]=0x${v.toString(16)}${s ? ' ' + JSON.stringify(s) : ''}`);
      }
      console.error(
        `[api]   ${ctx.proc} buf=0x${buf.toString(16)} count=${count} fmt=0x${fmt.toString(16)} ${JSON.stringify(readW(fmt))} va=0x${va.toString(16)} ${vaDump.join(' ')}`,
      );
    }
    if (ctx.proc.toLowerCase() === 'formatmessagew') {
      const flags = ctx.rawArgs[0] ?? 0;
      const msgId = ctx.rawArgs[2] ?? 0;
      const bufPtr = ctx.rawArgs[4] ?? 0;
      const argsPtr = ctx.rawArgs[6] ?? 0;
      const rd32 = (a: number) => {
        const b = this.memHost.memory.read(a >>> 0, 4);
        return b.byteLength < 4 ? NaN : new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true);
      };
      const readW = (a: number) => {
        const b = this.memHost.memory.read(a >>> 0, 128);
        const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
        let s = '';
        for (let i = 0; i + 1 < b.byteLength; i += 2) {
          const c = v.getUint16(i, true);
          if (c === 0) break;
          s += String.fromCharCode(c);
        }
        return s;
      };
      const argDump: string[] = [];
      for (let i = 0; i < 6; i++) {
        const v = rd32(argsPtr + i * 4);
        if (!v) break;
        const s = readW(v, 64);
        argDump.push(`[args+${i * 4}]=0x${v.toString(16)}${s ? ' ' + JSON.stringify(s) : ''}`);
      }
      const postBuf = rd32(bufPtr) >>> 0;
      console.error(
        `[api]   FormatMessageW flags=0x${(flags >>> 0).toString(16)} msgId=0x${(msgId >>> 0).toString(16)} bufPtr=0x${bufPtr.toString(16)} nSize=0x${(ctx.rawArgs[5] ?? 0).toString(16)} argsPtr=0x${argsPtr.toString(16)} ${argDump.join(' ')} -> ret=0x${(result.returnValue >>> 0).toString(16)} out@0x${postBuf.toString(16)} ${JSON.stringify(readW(postBuf))}`,
      );
      // va_list* semantics probe: [argsPtr] = va_list; args live at [va_list]
      const vaList = rd32(argsPtr) >>> 0;
      const deeper: string[] = [];
      for (let i = 0; i < 4; i++) {
        const v = rd32(vaList + i * 4);
        if (!v) break;
        const s = readW(v, 64);
        deeper.push(`[vaList+${i * 4}]=0x${v.toString(16)}${s ? ' ' + JSON.stringify(s) : ''}`);
      }
      console.error(`[api]     vaList=0x${vaList.toString(16)} ${deeper.join(' ')} | 44f240=${JSON.stringify(readW(0x44f240))}`);
    }
    return result;
  }
}

/** Minimal read-only fs bridge serving the exe itself (same as run-exe). */
function buildExeFs(exePath: string, exeBytes: Uint8Array): FileSystemBridge {
  const handles = new Map<number, { ptr: number }>();
  let next = 1;
  const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();
  const self = norm(exePath);
  const ok0 = 0 as WinError;
  const notFound = 2 as WinError;
  const denied = 5 as WinError;
  const invalidHandle = 6 as WinError;
  const notImpl = 120 as WinError;
  return {
    async createFile(path) {
      if (norm(path) === self) {
        handles.set(next, { ptr: 0 });
        return { handle: next++, error: ok0 };
      }
      return { handle: 0, error: notFound };
    },
    async readFile(handle, bytesToRead) {
      const rec = handles.get(handle);
      if (!rec) return { bytesRead: 0, data: new Uint8Array(0), error: invalidHandle };
      const end = Math.min(rec.ptr + bytesToRead, exeBytes.length);
      const data = exeBytes.slice(rec.ptr, end);
      rec.ptr = end;
      return { bytesRead: data.length, data, error: ok0 };
    },
    async writeFile() {
      return { bytesWritten: 0, error: denied };
    },
    async setFilePointer(handle, distance, moveMethod) {
      const rec = handles.get(handle);
      if (!rec) return { newPointer: 0xffffffff, error: invalidHandle };
      const base = moveMethod === 2 ? exeBytes.length : moveMethod === 1 ? rec.ptr : 0;
      rec.ptr = Math.max(0, base + distance);
      return { newPointer: rec.ptr, error: ok0 };
    },
    async getFileSize() {
      return exeBytes.length;
    },
    getFilePointer(handle) {
      return handles.get(handle)?.ptr ?? 0;
    },
    async closeHandle(handle) {
      handles.delete(handle);
      return ok0;
    },
    async findFirstFile() {
      return {
        searchHandle: 0x7001,
        entries: [{ attributes: 0x20, size: exeBytes.length, name: exePath.replace(/^.*[\\/]/, '') }],
        error: ok0,
      };
    },
    async findNextFile() {
      // Enumeration end must be ERROR_NO_MORE_FILES (18), not ERROR_FILE_NOT_FOUND (2).
      return { entries: [], error: 18 as WinError };
    },
    async findClose() {},
    async createDirectory() {
      return denied;
    },
    async removeDirectory() {
      return notFound;
    },
    async deleteFile() {
      return denied;
    },
    async getFileAttributes() {
      return { attributes: 0x20, error: ok0 };
    },
    async setFileAttributes() {
      return denied;
    },
    async moveFile() {
      return denied;
    },
    async lockFile() {
      return notImpl;
    },
    async unlockFile() {
      return notImpl;
    },
    async releaseAll() {
      handles.clear();
    },
  };
}

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: diag:exe <path-to.exe> [decodeAddr]');
    process.exit(2);
  }
  const image = new Uint8Array(await readFile(file));
  const is64 = peekIs64(image);
  const modulePath = resolve(file);

  const runtime = new WasmRuntimeImpl();
  const host = {
    memory: {
      read: (address: number, length: number) => runtime.readBytes(address, length),
      write: (address: number, data: Uint8Array) => runtime.writeBytes(address, data),
    },
    fs: buildExeFs(modulePath, image),
  } as unknown as ApiHost;

  const interceptor = new LoggingInterceptor(host, runtime);
  const trace: number[] = [];
  const loader = new PeLoaderImpl();
  const decoder = new X86Decoder(is64 ? 'x64' : 'x86');

  // `decodeAddr <addr>`: map the image and decode a LINEAR window (ignores
  // basic-block terminators) for offline study (no execution).
  if (process.argv[3]) {
    const pe = await loader.load(image);
    mapPeImage(runtime, image, pe);
    const start = Number.parseInt(process.argv[3], 16);
    const windowSize = 0x140;
    const raw = runtime.readBytes(start, 0x40);
    console.error(`[raw] ${[...raw].map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);
    for (let at = start; at < start + windowSize; ) {
      const bytes = runtime.readBytes(at, 64);
      if (bytes.byteLength === 0) break;
      try {
        const decoded = decoder.decode(bytes, at);
        const di = decoded.instructions[0];
        if (!di) break;
        console.error(`  0x${di.nextAddress.toString(16).padStart(8, '0')}: ${di.inst.op} (len ${di.length})`);
        at = di.nextAddress;
        if (di.length === 0) break;
      } catch (error) {
        console.error(`  0x${(at + 1).toString(16)}: decode-error ${String(error)}`);
        at += 1;
      }
    }
    return;
  }
  registerDefaultHandlers(interceptor);
  // Enable the SEH dispatcher's temporary [seh] diagnostics.
  (globalThis as { __bk_seh_debug?: boolean }).__bk_seh_debug = true;
  const runner = new GuestProcessRunner(
    runtime,
    new JitEngineImpl(runtime),
    loader,
    interceptor,
  );

  // Section info for mapping an address back to a PE section name.
  const pe = await loader.load(image);
  const sectionOf = (address: number): string => {
    for (const s of pe.sections) {
      const start = (is64 ? 0x01000000 : 0x400000) + s.virtualAddress; // base mirrors mapper
      if (address >= start && address < start + Math.max(s.virtualSize, s.rawSize)) {
        return `${s.name} (rva 0x${(address - (is64 ? 0x01000000 : 0x400000)).toString(16)})`;
      }
    }
    return '?';
  };

  const result = await runner.run(image, {
    maxSteps: 8_000_000,
    createEngine: (mode) => new JitEngineImpl(runtime, mode),
    modulePath,
    commandLine: process.env.BK_ARGS ?? '',
    readFile: async (p) => {
      if (process.env.BK_NO_MUI === '1') return null; // mimic browser env
      try {
        return new Uint8Array(await readFile(p));
      } catch {
        return null;
      }
    },
    onOutput: (bytes, stderr) => {
      const h = [...bytes.subarray(0, 96)].map((x) => x.toString(16).padStart(2, '0')).join(' ');
      const nz = [...bytes].filter((b) => b !== 0).length;
      console.error(`[out] ${stderr ? 'ERR' : 'OUT'} len=${bytes.length} nonzero=${nz} hex=${h}`);
      process[stderr ? 'stderr' : 'stdout'].write(Buffer.from(bytes));
    },
    onStep: (eip, rt) => {
      // Keep the last 64 block starts for the fault/limit trace dump below.
      trace.push(eip);
      if (trace.length > 64) trace.shift();
      // ---- GS cookie fail-fast capture ----
      // 0x41e1e4 = cmd's __report_gsfailure. Its body calls IsProcessorFeaturePresent(0x17)
      // at 0x41e1f7. At that call site __report_gsfailure's frame is established, so
      // ebp points at its frame: [ebp]=caller(failing fn) ebp, [ebp+4]=ret into failing fn.
      if (eip === 0x41e1e4 || eip === 0x41e1f7) {
        const r = (n: string) => `0x${(rt.getReg(n as never) >>> 0).toString(16)}`;
        const rd32 = (a: number) => {
          const b = rt.readBytes(a >>> 0, 4);
          return b.byteLength < 4 ? NaN : new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true);
        };
        const esp = rt.getReg('esp') >>> 0;
        const ebp = rt.getReg('ebp') >>> 0;
        console.error(`[gs] __report_gsfailure ctx eip=0x${eip.toString(16)}`);
        console.error(
          `[gs] eax=${r('eax')} ecx=${r('ecx')} edx=${r('edx')} ebx=${r('ebx')} esi=${r('esi')} edi=${r('edi')} ebp=${r('ebp')} esp=${r('esp')}`,
        );
        // __report_gsfailure frame: [ebp]=failingFn ebp, [ebp+4]=ret into failingFn
        const failingFnEbp = rd32(ebp);
        const retIntoFailingFn = rd32(ebp + 4);
        const failingFnCallerEbp = rd32(failingFnEbp);
        const retIntoCaller = rd32(failingFnEbp + 4);
        console.error(`[gs] failingFn: ebp=0x${failingFnEbp.toString(16)} retIntoFailingFn=0x${retIntoFailingFn.toString(16)}`);
        console.error(`[gs] failingFn's caller: ebp=0x${failingFnCallerEbp.toString(16)} retIntoCaller=0x${retIntoCaller.toString(16)}`);
        console.error(`[gs] failingFn saved-ebp=[ebp]=0x${rd32(failingFnEbp).toString(16)} cookieSlot=[ebp-4]=0x${rd32(failingFnEbp - 4).toString(16)} _security_cookie@0x4340c0=0x${rd32(0x4340c0).toString(16)}`);
        // stack walk
        const frames: string[] = [];
        for (let i = 0; i + 4 <= 0x300; i += 4) {
          const v = rd32(esp + i);
          if (v >= 0x400000 && v < 0x500000 && (v & 0xf) === 0) frames.push(`[esp+0x${i.toString(16)}]=0x${v.toString(16)}`);
        }
        console.error(`[gs] stack: ${frames.join(' ') || '(none)'}`);
      }
      // ---- GS cookie scan (failing fn @ 0x4158d7, FPO frame) ----
      // onStep is BLOCK-level, so only block-start eips fire. 0x415943 is the start of
      // the block that does: mov ecx,[esp+0x27c]; pop edi/esi/ebx; xor ecx,esp; call 0x41dea0.
      // esp here is PRE-pop (= E_store - 12); esp_at_check = esp + 12.
      // The correct cookie value at the slot must equal global XOR esp_at_check.
      if (eip >= 0x4158d0 && eip <= 0x415980) {
        const esp = rt.getReg('esp') >>> 0;
        const ebp = rt.getReg('ebp') >>> 0;
        const rd32 = (a: number) => {
          const b = rt.readBytes(a >>> 0, 4);
          return b.byteLength < 4 ? NaN : new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true);
        };
        const gv = new DataView(rt.readBytes(0x4340c0, 4).buffer, 0, 4).getUint32(0, true);
        console.error(
          `[gspro] eip=0x${eip.toString(16)} esp=0x${esp.toString(16)} ebp=0x${ebp.toString(16)} global=0x${gv.toString(16)} ` +
          `[esp+0x270]=0x${rd32(esp + 0x270).toString(16)} [esp+0x27c]=0x${rd32(esp + 0x27c).toString(16)} [ebp-4]=0x${rd32(ebp - 4).toString(16)} [ebp]=0x${rd32(ebp).toString(16)}`,
        );
      }
      if (eip === 0x415943) {
        const esp = rt.getReg('esp') >>> 0;
        const ebp = rt.getReg('ebp') >>> 0;
        const rd32 = (a: number) => {
          const b = rt.readBytes(a >>> 0, 4);
          return b.byteLength < 4 ? NaN : new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true);
        };
        const gv = new DataView(rt.readBytes(0x4340c0, 4).buffer, 0, 4).getUint32(0, true);
        const espAtCheck = (esp + 12) >>> 0;
        const needVal = (gv ^ espAtCheck) >>> 0;
        const cand: string[] = [];
        for (let off = -0x40; off < 0x300; off += 4) {
          const a = (esp + off) >>> 0;
          const v = rd32(a);
          if (((v ^ espAtCheck) >>> 0) === gv) cand.push(`[esp+0x${off.toString(16)}]=0x${v.toString(16)}`);
        }
        console.error(
          `[gscookie] eip=0x415943 esp=0x${esp.toString(16)} ebp=0x${ebp.toString(16)} espAtCheck=0x${espAtCheck.toString(16)} global=0x${gv.toString(16)} needVal=0x${needVal.toString(16)}`,
        );
        console.error(`[gscookie]   slotHoldingCookie=${cand.length ? cand.join(' ') : '(NONE)'} ; probes [esp+0x270]=0x${rd32(esp + 0x270).toString(16)} [esp+0x27c]=0x${rd32(esp + 0x27c).toString(16)} [ebp-4]=0x${rd32(ebp - 4).toString(16)} [ebp]=0x${rd32(ebp).toString(16)}`);
      }
      const TK = [
        0x40dfc5, // call 0x411c10 (heap alloc init)
        0x40dfce, // test eax,eax after init -> je 0x426cce
        0x40dfe4, // call 0x40e37e (find '/')
        0x40dfe9, // mov esi, eax (slash search result)
        0x40dff7, // call [0x4503dc] = _o_towlower(char after '/')
        0x40dfff, // movzx ecx, ax (classify result)
        0x40e020, // cmp ecx,0x63 ('c') -> je 0x40e088
        0x40e088, // 'c' case entry
        0x40e155, // quote-skip entry (block start; jne targets 0x40e155/0x40e19c)
        0x40e19c, // common tail: wcslen cmd + write slot[2] (block start)
        0x40e1bd, // mov [eax+8], esi  SUCCESS: write 3rd slot (block middle - trace miss)
        0x40b743, // parser entry (block start from call 0x415cfd)
        0x40b760, // prologue done (block start)
        0x40b768, // first API call (InitializeCriticalSection)
        0x40b795, // SetConsoleCtrlHandler call
        0x40b7c4, // call 0x4124d0
        0x40df9d, // real parser entry (called from 0x40b8d9)
        0x40b8de, // parser return (slots set?)
        0x40bac2, // epilogue start (block start?)
        0x415d02, // main resumes after parser call (block start)
        0x415d66, // main slot loop entry (block start; reads [ebp-0x14..-0x8])
        0x415d6a, // main reads 3 slots (block middle - trace miss)
        0x411d24, // heap-string helper: mov [0x44089c],edi (fault region)
        0x411d30, // heap-string helper: ret (should pop 0x41005f)
        0x41005f, // caller resume after 0x411cd0 (expected ret target)
        0x40c138, // dir path builder: append "\*" to target ([esi])
        0x40bfe0, // dir: find-last-backslash branch
        0x40c024, // dir: normal path (GetFullPathNameW)
        0x40c119, // dir: GetFullPathNameW ok -> store
        0x40c091, // dir: jump target after fail
        0x40bfd7, // dir: cmp bx,ax (first char vs '\')
        0x40bfda, // dir: je 0x40c138 (taken for relative path)
        0x40bf53, // dir handler entry (ecx = command object)
        0x40a9e9, // dir wrapper entry (ecx = target param string)
        0x40a320, // dir outer handler (ecx = context)
        0x409b0a, // X: dir executor (ecx = context)
        0x40c1a6, // param parser (ecx=cmdstr, edx=context)
        0x40c1d6, // after 0x40fed0 tokenize: ebx = result
        0x40dc0d, // string copy helper (NOT the resolver)
        0x40dc53, // dir resolve+enum (ecx = path)
        0x40dc77, // after wcschr('*') check in 0x40dc0d
        0x40dc89, // after wcschr('?') check in 0x40dc0d
        0x40dcb9, // after 0x41afe9 call in 0x40dc0d
        0x41afe9, // FindFirstFileExW wrapper (edx = lpFileName)
        0x41916d, // enum path build: [ebx] is lpFileName
        0x417ed4, // path concat (ecx, edx + stack args)
        0x414ad6, // path obj append (ecx=obj, [ebp+8]=src)
        0x40a376, // after 0x41ee28: check obj+0x208
        0x41eccc, // delay-load jmp [0x45042c]
        0x40a4ac, // copy 0x44ed08/[0x44ef10] -> [ebp-0x220]
        0x40a4b6, // after 0x414ad6: check [ebp-0x220] content
        0x40a60f, // after 0x40dc0d("Windows"): dump globals
        0x408ba9, // dir exec core entry (node in ecx)
        0x408b1c, // dir exec entry
        0x40652b, // output state finalize (ecx=state obj)
        0x4064f2, // line-count calc (ecx=state obj)
        0x406507, // line-count calc post-wcschr (ebx=[obj+8])
        0x40656a, // output state finalize v2 (ecx=state obj)
        0x409c4b, // obj-init gate: eax=0x4125b0 ret
        0x40a061, // obj-init (ecx=&[ebp-0x880])
        0x425a9e, // obj-init fail paths
        0x425ac3,
        0x425ad9,
        0x40a022, // list-free loop exit (restores esi from [ebp-0x880])
        0x40a04f, // final 0x40652b call site (ecx=esi)
        0x409ca6, // post-0x40a320 esi check
        0x409fd4, // free-loop entry
        0x409cce, // post-0x414ad6
        0x409e77, // post-0x408b1c esi check
        0x409df9, // pre-0x40656a esi check
        0x409f82, // post-0x430b52 esi check
        0x430cb1, // 0x430b52 pre-return (saved esi check)
        0x430b52, // 0x430b52 entry
        0x430cb2, // 0x430b52 pre-return alt (je target)
        0x42529c, // " Directory of %s" FormatMessageW call site
        0x410800, // dispatch entry (ecx=?, edx=slot string)
        0x4108a9, // [0x4406dc] = [ebp-4] = slot
        0x4108f6, // esi = 0x40e5ca ret (token ptr?)
        0x41090a, // call 0x410960 (read next token)
        0x410c28, // tokenizer: after setjmp3, reads [0x4406d4]
        0x410c5f, // tokenizer main loop start
      ];
      if (TK.includes(eip)) {
        const r = (n: string) => `0x${(rt.getReg(n as never) >>> 0).toString(16)}`;
        const rd32 = (a: number) => {
          const b = rt.readBytes(a >>> 0, 4);
          return b.byteLength < 4 ? NaN : new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true);
        };
        const wchar = (a: number) => {
          const b = rt.readBytes(a >>> 0, 2);
          return b.byteLength < 2 ? NaN : new DataView(b.buffer, b.byteOffset, 2).getUint16(0, true);
        };
        let extra = '';
        if (eip === 0x40dfe9) extra = ` [esi+2]=0x${wchar(rt.getReg('esi') + 2).toString(16)}`;
        if (eip === 0x40dff7) extra = ` charAfterSlash=0x${(rt.getReg('eax') & 0xffff).toString(16)}`;
        if (eip === 0x40dfff) extra = ` towlower(ax)=0x${(rt.getReg('eax') & 0xffff).toString(16)}`;
        if (eip === 0x40e1bd) extra = ` slotBase(eax)=${r('eax')} val(esi)=${r('esi')}`;
        if (eip === 0x40b8de) extra = ` [ebp-0x60]=${r('ebp')} slots@${r('esi')}`;
        if (eip === 0x40e19c) {
          // 0x40df9d's frame: [esp+0x10] = slot array ptr (edi saved). cmd is in esi.
          const slotBase = rd32(rt.getReg('esp') + 0x10);
          const s0 = rd32(slotBase), s1 = rd32(slotBase + 4), s2 = rd32(slotBase + 8);
          const s0c = rd32(s0), s1c = rd32(s1), s2c = rd32(s2);
          extra = ` slotBase=0x${slotBase.toString(16)} s0=0x${s0.toString(16)}(*0x${s0c.toString(16)}) s1=0x${s1.toString(16)}(*0x${s1c.toString(16)}) s2=0x${s2.toString(16)}(*0x${s2c.toString(16)})`;
          const cmdPtr = rt.getReg('esi') >>> 0;
          const b = rt.readBytes(cmdPtr, 64);
          const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
          let cs = '';
          for (let i = 0; i + 1 < b.byteLength; i += 2) {
            const c = v.getUint16(i, true);
            if (c === 0) break;
            cs += String.fromCharCode(c);
          }
          extra += ` cmdStr=${JSON.stringify(cs)}`;
        }
        if (eip === 0x40e155) {
          // just before quote-skip; dump the /c command string esi points at
          const esi = rt.getReg('esi') >>> 0;
          const b = rt.readBytes(esi, 64);
          const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
          let s = '';
          for (let i = 0; i + 1 < b.byteLength; i += 2) {
            const c = view.getUint16(i, true);
            if (c === 0) break;
            s += String.fromCharCode(c);
          }
          extra = ` cmdStr=0x${esi.toString(16)} ${JSON.stringify(s)}`;
        }
        if (eip === 0x415d66) {
          const ebp = rt.getReg('ebp') >>> 0;
          const s0 = rd32(ebp - 0x14), s1 = rd32(ebp - 0x10), s2 = rd32(ebp - 0xc);
          extra = ` slot0=0x${s0.toString(16)} slot1=0x${s1.toString(16)} slot2=0x${s2.toString(16)}`;
        }
        if (eip === 0x415d6a) extra = ` slot0=0x${rd32(rt.getReg('ebp') - 0x14).toString(16)} slot1=0x${rd32(rt.getReg('ebp') - 0x10).toString(16)} slot2=0x${rd32(rt.getReg('ebp') - 0xc).toString(16)}`;
        if (eip === 0x40b743 || eip === 0x415d02) {
          extra = ` esp=${r('esp')} ebx=${r('ebx')} esi=${r('esi')} edi=${r('edi')}`;
        }
        if (eip === 0x40b760 || eip === 0x40b8de || eip === 0x40bac2 || eip === 0x40df9d || eip === 0x40b768 || eip === 0x40b795 || eip === 0x40b7c4 || eip === 0x411d24 || eip === 0x411d30 || eip === 0x41005f) {
          extra = ` esp=${r('esp')} ebp=${r('ebp')} ebx=${r('ebx')}`;
          if (eip === 0x411d24 || eip === 0x411d30) {
            const esp = rt.getReg('esp') >>> 0;
            extra += ` [esp]=0x${rd32(esp).toString(16)} [esp+4]=0x${rd32(esp + 4).toString(16)} edi=${r('edi')}`;
          }
        }
        if (eip === 0x40bf53) {
          const obj = rt.getReg('ecx') >>> 0;
          const tgt = rd32(obj) >>> 0;
          const esp = rt.getReg('esp') >>> 0;
          const readW = (a: number) => {
            const b = rt.readBytes(a >>> 0, 64);
            const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
            let s = '';
            for (let i = 0; i + 1 < b.byteLength; i += 2) {
              const c = v.getUint16(i, true);
              if (c === 0) break;
              s += String.fromCharCode(c);
            }
            return s;
          };
          // ret addr + caller chain from stack
          const retInto = rd32(esp);
          const callerEbp = rd32(esp + 4);
          const retIntoCaller = rd32(callerEbp + 4);
          // obj layout: first 0x30 bytes
          const ob = rt.readBytes(obj, 0x30);
          const ov = new DataView(ob.buffer, ob.byteOffset, ob.byteLength);
          const objWords: string[] = [];
          for (let i = 0; i + 4 <= 0x30; i += 4) {
            const w = ov.getUint32(i, true);
            let tag = '';
            if (w >= 0x400000 && w < 0x500000) tag = `"${readW(w)}"`;
            objWords.push(`[+0x${i.toString(16)}]=0x${w.toString(16)}${tag}`);
          }
          extra = ` obj=0x${obj.toString(16)} target=0x${tgt.toString(16)} ${JSON.stringify(readW(tgt))} esp=0x${esp.toString(16)} retInto=0x${retInto.toString(16)} callerEbp=0x${callerEbp.toString(16)} retIntoCaller=0x${retIntoCaller.toString(16)} | obj: ${objWords.join(' ')}`;
        }
        if (eip === 0x410c28 || eip === 0x410c5f) {
          const rd32g = (a: number) => rd32(a);
          const p = rd32g(0x4406d4) >>> 0;
          const b = rt.readBytes(p, 128);
          const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
          let s = '';
          for (let i = 0; i + 1 < b.byteLength; i += 2) {
            const c = v.getUint16(i, true);
            if (c === 0) break;
            s += String.fromCharCode(c);
          }
          extra = ` cmd@0x${p.toString(16)} ${JSON.stringify(s)} [4406d0]=0x${(rd32g(0x4406d0) >>> 0).toString(16)} [4406d4]=0x${(rd32g(0x4406d4) >>> 0).toString(16)}`;
        }
        if (eip === 0x410800) {
          const edx = rt.getReg('edx') >>> 0;
          const ecx = rt.getReg('ecx') >>> 0;
          const readW = (a: number, len = 256) => {
            const b = rt.readBytes(a >>> 0, len);
            const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
            let s = '';
            for (let i = 0; i + 1 < b.byteLength; i += 2) {
              const c = v.getUint16(i, true);
              if (c === 0) break;
              s += String.fromCharCode(c);
            }
            return s;
          };
          extra = ` ecx=0x${ecx.toString(16)} slot(edx)=0x${edx.toString(16)} ${JSON.stringify(readW(edx))} 4386ca=${JSON.stringify(readW(0x4386ca))} 43c6d0=${JSON.stringify(readW(0x43c6d0))} [4406dc]=0x${(rd32(0x4406dc) >>> 0).toString(16)} [440890]=0x${(rd32(0x440890) >>> 0).toString(16)}`;
        }
        if (eip === 0x4108a9) {
          const ebp = rt.getReg('ebp') >>> 0;
          const sptr = rd32(ebp - 4) >>> 0;
          const b = rt.readBytes(sptr, 128);
          const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
          let s = '';
          for (let i = 0; i + 1 < b.byteLength; i += 2) {
            const c = v.getUint16(i, true);
            if (c === 0) break;
            s += String.fromCharCode(c);
          }
          extra = ` [ebp-4]=0x${sptr.toString(16)} ${JSON.stringify(s)} [4406dc]=0x${(rd32(0x4406dc) >>> 0).toString(16)} [4406d4]=0x${(rd32(0x4406d4) >>> 0).toString(16)}`;
        }
        if (eip === 0x4108f6) {
          const eax = rt.getReg('eax') >>> 0;
          const readW = (a: number) => {
            const b = rt.readBytes(a >>> 0, 128);
            const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
            let s = '';
            for (let i = 0; i + 1 < b.byteLength; i += 2) {
              const c = v.getUint16(i, true);
              if (c === 0) break;
              s += String.fromCharCode(c);
            }
            return s;
          };
          const tok = 0x44ac08;
          extra = ` eax(0x40e5ca ret)=0x${eax.toString(16)} ${JSON.stringify(readW(eax))} [440808]=0x${(rd32(0x440808) >>> 0).toString(16)} [440804]=0x${(rd32(0x440804) >>> 0).toString(16)} token@0x44ac08=${JSON.stringify(readW(tok))} [4406d4]=0x${(rd32(0x4406d4) >>> 0).toString(16)} ${JSON.stringify(readW(rd32(0x4406d4)))}`;
        }
        if (eip === 0x41090a) {
          extra = ` [4406d4]=0x${(rd32(0x4406d4) >>> 0).toString(16)} [4406dc]=0x${(rd32(0x4406dc) >>> 0).toString(16)} [440808]=0x${(rd32(0x440808) >>> 0).toString(16)}`;
        }
        if (eip === 0x40a9e9) {
          const ecx = rt.getReg('ecx') >>> 0;
          const esp = rt.getReg('esp') >>> 0;
          const retInto = rd32(esp);
          const readW = (a: number) => {
            const b = rt.readBytes(a >>> 0, 128);
            const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
            let s = '';
            for (let i = 0; i + 1 < b.byteLength; i += 2) {
              const c = v.getUint16(i, true);
              if (c === 0) break;
              s += String.fromCharCode(c);
            }
            return s;
          };
          const callerEbp = rd32(esp + 4);
          const retIntoCaller = rd32(callerEbp + 4);
          extra = ` targetParam(ecx)=0x${ecx.toString(16)} ${JSON.stringify(readW(ecx))} esp=0x${esp.toString(16)} retInto=0x${retInto.toString(16)} callerEbp=0x${callerEbp.toString(16)} retIntoCaller=0x${retIntoCaller.toString(16)}`;
        }
        if (eip === 0x40a320) {
          const ecx = rt.getReg('ecx') >>> 0;
          const esp = rt.getReg('esp') >>> 0;
          const retInto = rd32(esp);
          const readW = (a: number) => {
            const b = rt.readBytes(a >>> 0, 256);
            const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
            let s = '';
            for (let i = 0; i + 1 < b.byteLength; i += 2) {
              const c = v.getUint16(i, true);
              if (c === 0) break;
              s += String.fromCharCode(c);
            }
            return s;
          };
          const nArgs = rd32(ecx + 0x48);
          const argvPtr = rd32(ecx + 0x4c) >>> 0;
          const argv0 = rd32(argvPtr) >>> 0;
          extra = ` ctx=0x${ecx.toString(16)} nArgs([+0x48])=0x${nArgs.toString(16)} argvPtr([+0x4c])=0x${argvPtr.toString(16)} argv0=0x${argv0.toString(16)} ${JSON.stringify(readW(argv0))} esp=0x${esp.toString(16)} retInto=0x${retInto.toString(16)}`;
        }
        if (eip === 0x409b0a) {
          const ecx = rt.getReg('ecx') >>> 0;
          const edx = rt.getReg('edx') >>> 0;
          const esp = rt.getReg('esp') >>> 0;
          const retInto = rd32(esp);
          const a1 = rd32(esp + 4);
          const a2 = rd32(esp + 8);
          const readW = (a: number) => {
            const b = rt.readBytes(a >>> 0, 128);
            const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
            let s = '';
            for (let i = 0; i + 1 < b.byteLength; i += 2) {
              const c = v.getUint16(i, true);
              if (c === 0) break;
              s += String.fromCharCode(c);
            }
            return s;
          };
          extra = ` ecx=0x${ecx.toString(16)} edx=0x${edx.toString(16)} esp=0x${esp.toString(16)} retInto=0x${retInto.toString(16)} a1=0x${a1.toString(16)} a2=0x${a2.toString(16)} [4406dc]=0x${(rd32(0x4406dc) >>> 0).toString(16)} ${JSON.stringify(readW(rd32(0x4406dc)))} 4386ca=${JSON.stringify(readW(0x4386ca))}`;
        }
        if (eip === 0x40c1a6) {
          const ecx = rt.getReg('ecx') >>> 0;
          const edx = rt.getReg('edx') >>> 0;
          const esp = rt.getReg('esp') >>> 0;
          const readW = (a: number) => {
            const b = rt.readBytes(a >>> 0, 256);
            const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
            let s = '';
            for (let i = 0; i + 1 < b.byteLength; i += 2) {
              const c = v.getUint16(i, true);
              if (c === 0) break;
              s += String.fromCharCode(c);
            }
            return s;
          };
          const w0 = rd32(edx);
          const w4 = rd32(edx + 4);
          const w48 = rd32(edx + 0x48);
          const w4c = rd32(edx + 0x4c);
          extra = ` ecx=0x${ecx.toString(16)} ${JSON.stringify(readW(ecx))} ctx(edx)=0x${edx.toString(16)} [ctx+0]=0x${w0.toString(16)}${w0 >= 0x400000 && w0 < 0x500000 ? ` ${JSON.stringify(readW(w0))}` : ''} [ctx+4]=0x${w4.toString(16)} [ctx+48]=0x${w48.toString(16)} [ctx+4c]=0x${w4c.toString(16)}${w4c >= 0x400000 && w4c < 0x500000 ? ` ${JSON.stringify(readW(w4c))}` : ''} retInto=0x${(rd32(esp) >>> 0).toString(16)}`;
        }
        if (eip === 0x40c1d6) {
          const ret = rt.getReg('eax') >>> 0;
          const readW = (a: number) => {
            const b = rt.readBytes(a >>> 0, 128);
            const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
            let s = '';
            for (let i = 0; i + 1 < b.byteLength; i += 2) {
              const c = v.getUint16(i, true);
              if (c === 0) break;
              s += String.fromCharCode(c);
            }
            return s;
          };
          const esi = rt.getReg('esi') >>> 0;
          const c4c = rd32(esi + 0x4c) >>> 0;
          extra = ` eax(0x40fed0 ret)=0x${ret.toString(16)} ${JSON.stringify(readW(ret))} esi(ctx)=0x${esi.toString(16)} [ctx+0x4c]=0x${c4c.toString(16)} ${JSON.stringify(readW(c4c))}`;
        }
        if (eip === 0x40dc0d) {
          const ecx = rt.getReg('ecx') >>> 0;
          const esp = rt.getReg('esp') >>> 0;
          const readW = (a: number) => {
            const b = rt.readBytes(a >>> 0, 256);
            const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
            let s = '';
            for (let i = 0; i + 1 < b.byteLength; i += 2) {
              const c = v.getUint16(i, true);
              if (c === 0) break;
              s += String.fromCharCode(c);
            }
            return s;
          };
          extra = ` ecx(path)=0x${ecx.toString(16)} ${JSON.stringify(readW(ecx))} esp=0x${esp.toString(16)} retInto=0x${(rd32(esp) >>> 0).toString(16)} 4408e0=${JSON.stringify(readW(0x4408e0))}`;
        }
        if (eip === 0x41b00b) {
          const edx = rt.getReg('edx') >>> 0;
          const esp = rt.getReg('esp') >>> 0;
          const readW = (a: number) => {
            const b = rt.readBytes(a >>> 0, 256);
            const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
            let s = '';
            for (let i = 0; i + 1 < b.byteLength; i += 2) {
              const c = v.getUint16(i, true);
              if (c === 0) break;
              s += String.fromCharCode(c);
            }
            return s;
          };
          const s0 = rd32(esp + 4);
          const s1 = rd32(esp + 8);
          const s2 = rd32(esp + 0xc);
          extra = ` edx(lpFileName)=0x${edx.toString(16)} ${JSON.stringify(readW(edx))} esp=0x${esp.toString(16)} [esp+4]=0x${s0.toString(16)} ${JSON.stringify(readW(s0))} [esp+8]=0x${s1.toString(16)} ${JSON.stringify(readW(s1))} [esp+c]=0x${s2.toString(16)}`;
        }
        if (eip === 0x41afe9) {
          const edx = rt.getReg('edx') >>> 0;
          const esp = rt.getReg('esp') >>> 0;
          const readW = (a: number) => {
            const b = rt.readBytes(a >>> 0, 256);
            const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
            let s = '';
            for (let i = 0; i + 1 < b.byteLength; i += 2) {
              const c = v.getUint16(i, true);
              if (c === 0) break;
              s += String.fromCharCode(c);
            }
            return s;
          };
          const retInto = rd32(esp) >>> 0;
          extra = ` edx(lpFileName)=0x${edx.toString(16)} ${JSON.stringify(readW(edx))} ecx=0x${(rt.getReg('ecx') >>> 0).toString(16)} esp=0x${esp.toString(16)} retInto=0x${retInto.toString(16)} [esp+4]=0x${(rd32(esp + 4) >>> 0).toString(16)} [esp+8]=0x${(rd32(esp + 8) >>> 0).toString(16)} [esp+c]=0x${(rd32(esp + 0xc) >>> 0).toString(16)} [esp+10]=0x${(rd32(esp + 0x10) >>> 0).toString(16)} [esp+14]=0x${(rd32(esp + 0x14) >>> 0).toString(16)}`;
        }
        if (eip === 0x40dc77 || eip === 0x40dc89 || eip === 0x40dcb9) {
          const readW = (a: number) => {
            const b = rt.readBytes(a >>> 0, 128);
            const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
            let s = '';
            for (let i = 0; i + 1 < b.byteLength; i += 2) {
              const c = v.getUint16(i, true);
              if (c === 0) break;
              s += String.fromCharCode(c);
            }
            return s;
          };
          const esi = rt.getReg('esi') >>> 0;
          extra = ` eax(0x40e37e/41afe9 ret)=0x${(rt.getReg('eax') >>> 0).toString(16)} esi(path)=0x${esi.toString(16)} ${JSON.stringify(readW(esi))} [4408c0]=0x${(rd32(0x4408c0) >>> 0).toString(16)}`;
        }
        if (eip === 0x40dc53) {
          const ecx = rt.getReg('ecx') >>> 0;
          const esp = rt.getReg('esp') >>> 0;
          const readW = (a: number) => {
            const b = rt.readBytes(a >>> 0, 256);
            const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
            let s = '';
            for (let i = 0; i + 1 < b.byteLength; i += 2) {
              const c = v.getUint16(i, true);
              if (c === 0) break;
              s += String.fromCharCode(c);
            }
            return s;
          };
          extra = ` ecx(path)=0x${ecx.toString(16)} ${JSON.stringify(readW(ecx))} esp=0x${esp.toString(16)} retInto=0x${(rd32(esp) >>> 0).toString(16)} edx=0x${(rt.getReg('edx') >>> 0).toString(16)}`;
        }
        if (eip === 0x41916d) {
          const ebx = rt.getReg('ebx') >>> 0;
          const esp = rt.getReg('esp') >>> 0;
          const readW = (a: number) => {
            const b = rt.readBytes(a >>> 0, 256);
            const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
            let s = '';
            for (let i = 0; i + 1 < b.byteLength; i += 2) {
              const c = v.getUint16(i, true);
              if (c === 0) break;
              s += String.fromCharCode(c);
            }
            return s;
          };
          const w0 = rd32(ebx);
          const w4 = rd32(ebx + 4);
          const w8 = rd32(ebx + 8);
          const w18 = rd32(ebx + 0x18);
          extra = ` ebx=0x${ebx.toString(16)} [ebx]=0x${w0.toString(16)} ${JSON.stringify(readW(w0))} [ebx+4]=0x${w4.toString(16)} ${JSON.stringify(readW(w4))} [ebx+8]=0x${w8.toString(16)} ${JSON.stringify(readW(w8))} [ebx+18]=0x${w18.toString(16)} esp=0x${esp.toString(16)} retInto=0x${(rd32(esp) >>> 0).toString(16)}`;
        }
        if (eip === 0x417ed4) {
          const ecx = rt.getReg('ecx') >>> 0;
          const edx = rt.getReg('edx') >>> 0;
          const edi = rt.getReg('edi') >>> 0;
          const esp = rt.getReg('esp') >>> 0;
          const readW = (a: number) => {
            const b = rt.readBytes(a >>> 0, 256);
            const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
            let s = '';
            for (let i = 0; i + 1 < b.byteLength; i += 2) {
              const c = v.getUint16(i, true);
              if (c === 0) break;
              s += String.fromCharCode(c);
            }
            return s;
          };
          const a1 = rd32(esp + 4);
          const a2 = rd32(esp + 8);
          const a3 = rd32(esp + 0xc);
          // if this is the 0x408cac concat, edi = dir tree node
          let nodeDump = '';
          if (edi >= 0x2000000 && edi < 0x3000000) {
            const n0 = rd32(edi) >>> 0;
            const n4 = rd32(edi + 4) >>> 0;
            const nc = rd32(edi + 0xc) >>> 0;
            const nnc = rd32(nc) >>> 0;
            nodeDump = ` node(edi)=0x${edi.toString(16)} [n+0]=0x${n0.toString(16)} ${JSON.stringify(readW(n0))} [n+4]=0x${n4.toString(16)} ${JSON.stringify(readW(n4))} [n+c]=0x${nc.toString(16)} [[n+c]]=0x${nnc.toString(16)} ${JSON.stringify(readW(nnc))}`;
          }
          extra = ` ecx=0x${ecx.toString(16)} ${JSON.stringify(readW(ecx))} edx=0x${edx.toString(16)} ${JSON.stringify(readW(edx))} [esp+4]=0x${a1.toString(16)} ${JSON.stringify(readW(a1))} [esp+8]=0x${a2.toString(16)} ${JSON.stringify(readW(a2))} [esp+c]=0x${a3.toString(16)} ${JSON.stringify(readW(a3))} retInto=0x${(rd32(esp) >>> 0).toString(16)}${nodeDump}`;
        }
        if (eip === 0x40a4ac) {
          const edx = rt.getReg('edx') >>> 0;
          const readW = (a: number) => {
            const b = rt.readBytes(a >>> 0, 256);
            const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
            let s = '';
            for (let i = 0; i + 1 < b.byteLength; i += 2) {
              const c = v.getUint16(i, true);
              if (c === 0) break;
              s += String.fromCharCode(c);
            }
            return s;
          };
          const e44ef10 = rd32(0x44ef10) >>> 0;
          extra = ` edx(src)=0x${edx.toString(16)} ${JSON.stringify(readW(edx))} [44ef10]=0x${e44ef10.toString(16)} ${JSON.stringify(readW(e44ef10))} 44ed08=${JSON.stringify(readW(0x44ed08))} 44ed00=${JSON.stringify(readW(0x44ed00))}`;
        }
        if (eip === 0x40a60f) {
          const ebp = rt.getReg('ebp') >>> 0;
          const readW = (a: number) => {
            const b = rt.readBytes(a >>> 0, 256);
            const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
            let s = '';
            for (let i = 0; i + 1 < b.byteLength; i += 2) {
              const c = v.getUint16(i, true);
              if (c === 0) break;
              s += String.fromCharCode(c);
            }
            return s;
          };
          const p220 = rd32(ebp - 0x220) >>> 0;
          const p18 = rd32(ebp - 0x18) >>> 0;
          const e44ef10 = rd32(0x44ef10) >>> 0;
          const e44ed08 = rd32(0x44ed08) >>> 0;
          extra = ` ebp=0x${ebp.toString(16)} [ebp-0x220]=0x${p220.toString(16)} ${JSON.stringify(readW(p220))} [ebp-0x18]=0x${p18.toString(16)} ${JSON.stringify(readW(p18))} [44ef10]=0x${e44ef10.toString(16)} ${JSON.stringify(readW(e44ef10))} 44ed08=0x${e44ed08.toString(16)} ${JSON.stringify(readW(e44ed08))} 44ed00=${JSON.stringify(readW(0x44ed00))}`;
        }
        if (eip === 0x40a4b6) {
          const ebp = rt.getReg('ebp') >>> 0;
          const readW = (a: number) => {
            const b = rt.readBytes(a >>> 0, 128);
            const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
            let s = '';
            for (let i = 0; i + 1 < b.byteLength; i += 2) {
              const c = v.getUint16(i, true);
              if (c === 0) break;
              s += String.fromCharCode(c);
            }
            return s;
          };
          extra = ` ebp=0x${ebp.toString(16)} [ebp-0x220]=0x${(rd32(ebp - 0x220) >>> 0).toString(16)} 220str=${JSON.stringify(readW(ebp - 0x220))} [ebp-0x18]=0x${(rd32(ebp - 0x18) >>> 0).toString(16)} ${JSON.stringify(readW(rd32(ebp - 0x18)))} eax=0x${(rt.getReg('eax') >>> 0).toString(16)}`;
        }
        if (eip === 0x414ad6) {
          const ecx = rt.getReg('ecx') >>> 0;
          const esp = rt.getReg('esp') >>> 0;
          const readW = (a: number) => {
            const b = rt.readBytes(a >>> 0, 128);
            const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
            let s = '';
            for (let i = 0; i + 1 < b.byteLength; i += 2) {
              const c = v.getUint16(i, true);
              if (c === 0) break;
              s += String.fromCharCode(c);
            }
            return s;
          };
          const src = rd32(esp + 4) >>> 0;
          extra = ` obj(ecx)=0x${ecx.toString(16)} objStr=${JSON.stringify(readW(ecx))} [obj+208]=0x${(rd32(ecx + 0x208) >>> 0).toString(16)} src([esp+4])=0x${src.toString(16)} ${JSON.stringify(readW(src))} retInto=0x${(rd32(esp) >>> 0).toString(16)} edx=0x${(rt.getReg('edx') >>> 0).toString(16)}`;
        }
        if (eip === 0x40a376) {
          const ebp = rt.getReg('ebp') >>> 0;
          const readW = (a: number) => {
            const b = rt.readBytes(a >>> 0, 128);
            const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
            let s = '';
            for (let i = 0; i + 1 < b.byteLength; i += 2) {
              const c = v.getUint16(i, true);
              if (c === 0) break;
              s += String.fromCharCode(c);
            }
            return s;
          };
          const obj208 = rd32(ebp - 0x220 + 0x208) >>> 0;
          extra = ` [obj+208]=0x${obj208.toString(16)} ${JSON.stringify(readW(obj208))} [44ef10]=0x${(rd32(0x44ef10) >>> 0).toString(16)} ${JSON.stringify(readW(rd32(0x44ef10)))} 44ed08str=${JSON.stringify(readW(0x44ed08))}`;
        }
        if (eip === 0x41eccc) {
          const esp = rt.getReg('esp') >>> 0;
          const readW = (a: number) => {
            const b = rt.readBytes(a >>> 0, 128);
            const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
            let s = '';
            for (let i = 0; i + 1 < b.byteLength; i += 2) {
              const c = v.getUint16(i, true);
              if (c === 0) break;
              s += String.fromCharCode(c);
            }
            return s;
          };
          const tgt = rd32(0x45042c) >>> 0;
          const a1 = rd32(esp + 4) >>> 0;
          const a2 = rd32(esp + 8) >>> 0;
          const a3 = rd32(esp + 0xc) >>> 0;
          const a4 = rd32(esp + 0x10) >>> 0;
          const a5 = rd32(esp + 0x14) >>> 0;
          extra = ` [45042c]=0x${tgt.toString(16)} [esp+4]=0x${a1.toString(16)} [esp+8]=0x${a2.toString(16)} [esp+c]=0x${a3.toString(16)} ${JSON.stringify(readW(a3))} [esp+10]=0x${a4.toString(16)} [esp+14]=0x${a5.toString(16)}`;
        }
      if (eip === 0x408ba9 || eip === 0x408b1c) {
        const ecx = rt.getReg('ecx') >>> 0;
        const esp = rt.getReg('esp') >>> 0;
        const rd32m = (a: number) => {
          const b = rt.readBytes(a >>> 0, 4);
          return b.byteLength < 4 ? NaN : new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true);
        };
        const readW = (a: number) => {
          const b = rt.readBytes(a >>> 0, 128);
          const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
          let s = '';
          for (let i = 0; i + 1 < b.byteLength; i += 2) {
            const c = v.getUint16(i, true);
            if (c === 0) break;
            s += String.fromCharCode(c);
          }
          return s;
        };
        const node = ecx;
        const f = (a: number) => {
          const v = rd32m(a) >>> 0;
          const s = v >= 0x400000 && v < 0x500000 ? ` ${JSON.stringify(readW(v))}` : '';
          return `0x${v.toString(16)}${s}`;
        };
        extra = ` eip=0x${eip.toString(16)} node(ecx)=0x${node.toString(16)} [n+0]=${f(node)} [n+4]=${f(node + 4)} [n+8]=${f(node + 8)} [n+c]=${f(node + 0xc)} [n+10]=${f(node + 0x10)} [n+14]=${f(node + 0x14)} [n+18]=${f(node + 0x18)} [[n+c]]=${f(rd32m(node + 0xc))} esp=0x${esp.toString(16)} retInto=0x${(rd32m(esp) >>> 0).toString(16)}`;
      }
      if (eip === 0x40652b || eip === 0x4064f2 || eip === 0x40656a) {
        const obj = rt.getReg('ecx') >>> 0;
        const esp = rt.getReg('esp') >>> 0;
        const rd32m = (a: number) => {
          const b = rt.readBytes(a >>> 0, 4);
          return b.byteLength < 4 ? NaN : new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true);
        };
        const readW = (a: number) => {
          const b = rt.readBytes(a >>> 0, 256);
          const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
          let s = '';
          for (let i = 0; i + 1 < b.byteLength; i += 2) {
            const c = v.getUint16(i, true);
            if (c === 0) break;
            s += String.fromCharCode(c);
          }
          return s;
        };
        const f = (a: number) => {
          const v = rd32m(a) >>> 0;
          const s = v >= 0x400000 && v < 0x500000 ? ` ${JSON.stringify(readW(v))}` : '';
          return `0x${v.toString(16)}${s}`;
        };
        let d = ` obj(ecx)=0x${obj.toString(16)}`;
        for (let off = 0; off <= 0x30; off += 4) d += ` [+${off.toString(16)}]=${f(obj + off)}`;
        const p8 = rd32m(obj + 8) >>> 0;
        if (p8 >= 0x2000000 && p8 < 0x3000000 || (p8 >= 0x7fe0000 && p8 < 0x8000000)) {
          d += ` | *obj+8: [+0]=${f(p8)} [+4]=${f(p8 + 4)} [+8]=${f(p8 + 8)} [+c]=${f(p8 + 0xc)} [+10]=${f(p8 + 0x10)} [+20]=${f(p8 + 0x20)} str=${JSON.stringify(readW(p8))}`;
        }
        const p10 = rd32m(obj + 0x10) >>> 0;
        if (p10 >= 0x400000 && p10 < 0x500000) d += ` [+10]str=${JSON.stringify(readW(p10))}`;
        extra = ` eip=0x${eip.toString(16)}${d} esp=0x${esp.toString(16)} retInto=0x${(rd32m(esp) >>> 0).toString(16)}`;
      }
      if (eip === 0x406507) {
        const ebx = rt.getReg('ebx') >>> 0;
        const esi = rt.getReg('esi') >>> 0;
        const ecx = rt.getReg('ecx') >>> 0;
        const edi = rt.getReg('edi') >>> 0;
        const rd32m = (a: number) => {
          const b = rt.readBytes(a >>> 0, 4);
          return b.byteLength < 4 ? NaN : new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true);
        };
        extra = ` ebx=0x${ebx.toString(16)} [ebx+8]=0x${(rd32m(ebx + 8) >>> 0).toString(16)} [ebx+0x20]=0x${(rd32m(ebx + 0x20) >>> 0).toString(16)} esi=0x${esi.toString(16)} ecx=0x${ecx.toString(16)} edi=0x${edi.toString(16)} [0x7ffeb08]=0x${(rd32m(0x7ffeb08) >>> 0).toString(16)} [0x7ffeb10]=0x${(rd32m(0x7ffeb10) >>> 0).toString(16)} [0x7ffeb28]=0x${(rd32m(0x7ffeb28) >>> 0).toString(16)}`;
      }
      if (eip === 0x409c4b) {
        const rd32m = (a: number) => {
          const b = rt.readBytes(a >>> 0, 4);
          return b.byteLength < 4 ? NaN : new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true);
        };
        const ebp = rt.getReg('ebp') >>> 0;
        extra = ` eax(4125b0 ret)=0x${(rt.getReg('eax') >>> 0).toString(16)} ebp=0x${ebp.toString(16)} [ebp-0x880]=0x${(rd32m(ebp - 0x880) >>> 0).toString(16)} [ebp-0x884]=0x${(rd32m(ebp - 0x884) >>> 0).toString(16)} &[ebp-0x880]=0x${((ebp - 0x880) >>> 0).toString(16)}`;
      }
      if (eip === 0x40a061) {
        const ecx = rt.getReg('ecx') >>> 0;
        const rd32m = (a: number) => {
          const b = rt.readBytes(a >>> 0, 4);
          return b.byteLength < 4 ? NaN : new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true);
        };
        extra = ` ecx(&obj)=0x${ecx.toString(16)} [ecx]=0x${(rd32m(ecx) >>> 0).toString(16)} [ecx+4]=0x${(rd32m(ecx + 4) >>> 0).toString(16)} [0x44089c]=0x${(rd32m(0x44089c) >>> 0).toString(16)} [0x440890]=0x${(rd32m(0x440890) >>> 0).toString(16)}`;
      }
      if (eip === 0x425a9e || eip === 0x425ac3 || eip === 0x425ad9) {
        const rd32m = (a: number) => {
          const b = rt.readBytes(a >>> 0, 4);
          return b.byteLength < 4 ? NaN : new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true);
        };
        const ebp = rt.getReg('ebp') >>> 0;
        extra = ` [ebp-0x880]=0x${(rd32m(ebp - 0x880) >>> 0).toString(16)} [ebp-0x884]=0x${(rd32m(ebp - 0x884) >>> 0).toString(16)} esi=0x${(rt.getReg('esi') >>> 0).toString(16)} eax=0x${(rt.getReg('eax') >>> 0).toString(16)}`;
      }
      if (eip === 0x40a022 || eip === 0x40a04f) {
        const rd32m = (a: number) => {
          const b = rt.readBytes(a >>> 0, 4);
          return b.byteLength < 4 ? NaN : new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true);
        };
        const ebp = rt.getReg('ebp') >>> 0;
        const esi = rt.getReg('esi') >>> 0;
        extra = ` eip=0x${eip.toString(16)} ebp=0x${ebp.toString(16)} [ebp-0x880]=0x${(rd32m(ebp - 0x880) >>> 0).toString(16)} [ebp-0x884]=0x${(rd32m(ebp - 0x884) >>> 0).toString(16)} [ebp-0x874]=0x${(rd32m(ebp - 0x874) >>> 0).toString(16)} esi=0x${esi.toString(16)} &[ebp-0x880]=0x${((ebp - 0x880) >>> 0).toString(16)}`;
      }
      if (eip === 0x409ca6) {
        const rd32m = (a: number) => {
          const b = rt.readBytes(a >>> 0, 4);
          return b.byteLength < 4 ? NaN : new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true);
        };
        const ebp = rt.getReg('ebp') >>> 0;
        extra = ` eax(40a320 ret)=0x${(rt.getReg('eax') >>> 0).toString(16)} esi=0x${(rt.getReg('esi') >>> 0).toString(16)} edi=0x${(rt.getReg('edi') >>> 0).toString(16)} ebx=0x${(rt.getReg('ebx') >>> 0).toString(16)} [ebp-0x880]=0x${(rd32m(ebp - 0x880) >>> 0).toString(16)}`;
      }
      if (eip === 0x409fd4 || eip === 0x409cce) {
        const rd32m = (a: number) => {
          const b = rt.readBytes(a >>> 0, 4);
          return b.byteLength < 4 ? NaN : new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true);
        };
        const ebp = rt.getReg('ebp') >>> 0;
        extra = ` eip=0x${eip.toString(16)} eax=0x${(rt.getReg('eax') >>> 0).toString(16)} esi=0x${(rt.getReg('esi') >>> 0).toString(16)} edi=0x${(rt.getReg('edi') >>> 0).toString(16)} ebx=0x${(rt.getReg('ebx') >>> 0).toString(16)} ecx=0x${(rt.getReg('ecx') >>> 0).toString(16)} [ebp-0x880]=0x${(rd32m(ebp - 0x880) >>> 0).toString(16)} [ebx+8]=0x${(rd32m((rt.getReg('ebx') >>> 0) + 8) >>> 0).toString(16)} [ebx+4]=0x${(rd32m((rt.getReg('ebx') >>> 0) + 4) >>> 0).toString(16)} [ebx]=0x${(rd32m(rt.getReg('ebx') >>> 0) >>> 0).toString(16)}`;
      }
      if (eip === 0x409e77 || eip === 0x409df9) {
        const rd32m = (a: number) => {
          const b = rt.readBytes(a >>> 0, 4);
          return b.byteLength < 4 ? NaN : new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true);
        };
        const ebp = rt.getReg('ebp') >>> 0;
        extra = ` eip=0x${eip.toString(16)} eax=0x${(rt.getReg('eax') >>> 0).toString(16)} esi=0x${(rt.getReg('esi') >>> 0).toString(16)} edi=0x${(rt.getReg('edi') >>> 0).toString(16)} ebx=0x${(rt.getReg('ebx') >>> 0).toString(16)} ecx=0x${(rt.getReg('ecx') >>> 0).toString(16)} [ebp-0x870]=0x${(rd32m(ebp - 0x870) >>> 0).toString(16)} [ebp-0x874]=0x${(rd32m(ebp - 0x874) >>> 0).toString(16)} [ebp-0x880]=0x${(rd32m(ebp - 0x880) >>> 0).toString(16)}`;
      }
      if (eip === 0x409f82) {
        const rd32m = (a: number) => {
          const b = rt.readBytes(a >>> 0, 4);
          return b.byteLength < 4 ? NaN : new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true);
        };
        const ebp = rt.getReg('ebp') >>> 0;
        extra = ` eax(430b52 ret)=0x${(rt.getReg('eax') >>> 0).toString(16)} esi=0x${(rt.getReg('esi') >>> 0).toString(16)} edi=0x${(rt.getReg('edi') >>> 0).toString(16)} ebx=0x${(rt.getReg('ebx') >>> 0).toString(16)} ecx=0x${(rt.getReg('ecx') >>> 0).toString(16)} [ebp-0x880]=0x${(rd32m(ebp - 0x880) >>> 0).toString(16)}`;
      }
      if (eip === 0x430cb1) {
        const rd32m = (a: number) => {
          const b = rt.readBytes(a >>> 0, 4);
          return b.byteLength < 4 ? NaN : new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true);
        };
        const ebp = rt.getReg('ebp') >>> 0;
        const esp = rt.getReg('esp') >>> 0;
        extra = ` ebp=0x${ebp.toString(16)} esp=0x${esp.toString(16)} esi=0x${(rt.getReg('esi') >>> 0).toString(16)} savedEsi@[ebp-0x24c]=0x${(rd32m(ebp - 0x24c) >>> 0).toString(16)} savedEdi@[ebp-0x250]=0x${(rd32m(ebp - 0x250) >>> 0).toString(16)} savedEbx@[ebp-0x254]=0x${(rd32m(ebp - 0x254) >>> 0).toString(16)} [esp+0]=0x${(rd32m(esp) >>> 0).toString(16)} [esp+4]=0x${(rd32m(esp + 4) >>> 0).toString(16)} [esp+8]=0x${(rd32m(esp + 8) >>> 0).toString(16)} [0x7ffeb08]=0x${(rd32m(0x7ffeb08) >>> 0).toString(16)} [0x7ffeaf8]=0x${(rd32m(0x7ffeaf8) >>> 0).toString(16)} [0x7ffeb00]=0x${(rd32m(0x7ffeb00) >>> 0).toString(16)}`;
      }
      if (eip === 0x430b52) {
        const rd32m = (a: number) => {
          const b = rt.readBytes(a >>> 0, 4);
          return b.byteLength < 4 ? NaN : new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true);
        };
        const esp = rt.getReg('esp') >>> 0;
        extra = ` ecx=0x${(rt.getReg('ecx') >>> 0).toString(16)} edx=0x${(rt.getReg('edx') >>> 0).toString(16)} esi=0x${(rt.getReg('esi') >>> 0).toString(16)} edi=0x${(rt.getReg('edi') >>> 0).toString(16)} [esp+4]=0x${(rd32m(esp + 4) >>> 0).toString(16)} [esp+8]=0x${(rd32m(esp + 8) >>> 0).toString(16)}`;
      }
      if (eip === 0x430cb2) {
        const rd32m = (a: number) => {
          const b = rt.readBytes(a >>> 0, 4);
          return b.byteLength < 4 ? NaN : new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true);
        };
        const ebp = rt.getReg('ebp') >>> 0;
        const esp = rt.getReg('esp') >>> 0;
        extra = ` ebp=0x${ebp.toString(16)} esp=0x${esp.toString(16)} esi=0x${(rt.getReg('esi') >>> 0).toString(16)} savedEsi@[ebp-0x22c]=0x${(rd32m(ebp - 0x22c) >>> 0).toString(16)} [esp+4]=0x${(rd32m(esp + 4) >>> 0).toString(16)} [esp+8]=0x${(rd32m(esp + 8) >>> 0).toString(16)} [ebp-0x230]=0x${(rd32m(ebp - 0x230) >>> 0).toString(16)} [ebp-0x220]=0x${(rd32m(ebp - 0x220) >>> 0).toString(16)}`;
      }
      if (eip === 0x42529c) {
        const ebp = rt.getReg('ebp') >>> 0;
        const rd32m = (a: number) => {
          const b = rt.readBytes(a >>> 0, 4);
          return b.byteLength < 4 ? NaN : new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true);
        };
        const readW = (a: number) => {
          const b = rt.readBytes(a >>> 0, 128);
          const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
          let s = '';
          for (let i = 0; i + 1 < b.byteLength; i += 2) {
            const c = v.getUint16(i, true);
            if (c === 0) break;
            s += String.fromCharCode(c);
          }
          return s;
        };
        const a0 = rd32m(ebp + 8) >>> 0;
        const a4 = rd32m(a0 + 4) >>> 0;
        extra = ` ebp=0x${ebp.toString(16)} [ebp+8]=0x${a0.toString(16)} [a0+0]=0x${(rd32m(a0) >>> 0).toString(16)} ${JSON.stringify(readW(rd32m(a0)))} [a0+4]=0x${a4.toString(16)} ${JSON.stringify(readW(a4))} [a0+c]=0x${(rd32m(a0 + 0xc) >>> 0).toString(16)}`;
      }
      console.error(
        `[tk] eip=0x${eip.toString(16)} eax=${r('eax')} ecx=${r('ecx')} edx=${r('edx')} esi=${r('esi')} edi=${r('edi')} ebx=${r('ebx')}${extra}`,
      );
      }
    },
    onFault: (rt, res) => {
      console.error('[trace] last blocks:');
      for (const e of trace) console.error(`  [trace]   0x${e.toString(16)}`);
      // dump the faulting state object region raw bytes
      const rd32m = (a: number) => {
        const b = rt.readBytes(a >>> 0, 4);
        return b.byteLength < 4 ? NaN : new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true);
      };
      console.error(
        `[fobj] ebx=0x${(rt.getReg('ebx') >>> 0).toString(16)} [ebx+8]=0x${(rd32m((rt.getReg('ebx') >>> 0) + 8) >>> 0).toString(16)} [ebx+0x20]=0x${(rd32m((rt.getReg('ebx') >>> 0) + 0x20) >>> 0).toString(16)}`,
      );
      for (const base of [0x7ffeb00, 0x7ffe9c0]) {
        const b = rt.readBytes(base, 0x60);
        if (b.byteLength === 0) continue;
        console.error(
          `[fobj] 0x${base.toString(16)}: ${[...b].map((x) => x.toString(16).padStart(2, '0')).join(' ')}`,
        );
      }
      dumpFault(rt, res.eip, is64, sectionOf, res.error);
    },
  });

  console.error(`\n[diag] status=${result.status} eip=0x${result.eip.toString(16)} stubs=${result.stubs.length}`);
  if (result.windows && result.windows.length > 0) {
    console.error('[diag] windows:');
    for (const w of result.windows) {
      console.error(
        `  [win] hwnd=0x${w.hwnd.toString(16)} class="${w.className}" wndProc=0x${w.wndProc.toString(16)} parent=0x${w.parent.toString(16)} text="${w.text}"`,
      );
      if (w.menu && w.menu.length > 0) {
        for (const s of w.menu) {
          const items = s.items.map((it) => `${it.id}:${it.label}`).join(', ');
          console.error(`  [menu] "${s.title}": ${items}`);
        }
      }
    }
  }
  if (result.paintCommands && result.paintCommands.length > 0) {
    console.error(`[diag] paint: ${result.paintCommands.length} commands`);
    for (const p of result.paintCommands.slice(0, 40)) {
      console.error(`  [paint] ${p.op} hdc=0x${p.hdc.toString(16)} x=${p.x} y=${p.y} w=${p.w ?? ''} h=${p.h ?? ''} ${p.text ? `"${p.text}"` : ''}`);
    }
    if (result.paintCommands.length > 40) console.error(`  ... ${result.paintCommands.length - 40} more`);
  }
  if (result.status === 'limit') {
    console.error('[trace] last blocks (limit):');
    for (const e of trace) console.error(`  [trace]   0x${e.toString(16)}`);
  }
  if (result.status === 'exit' && !result.cleanExit) {
    console.error('[trace] last blocks before exit:');
    for (const e of trace) console.error(`  [trace]   0x${e.toString(16)}`);
  }
  if (result.status !== 'exit') process.exit(1);
}

function peekIs64(image: Uint8Array): boolean {
  try {
    const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
    if (view.getUint16(0, true) !== 0x5a4d) return false;
    const eLfanew = view.getUint32(0x3c, true);
    return view.getUint16(eLfanew + 4 + 20, true) === 0x20b;
  } catch {
    return false;
  }
}

function dumpFault(
  runtime: WasmRuntimeImpl,
  eip: number,
  is64: boolean,
  sectionOf: (address: number) => string,
  error?: unknown,
): void {
  const memSize = runtime.memory.buffer.byteLength;
  console.error(`[diag] fault at eip=0x${eip.toString(16)} (${sectionOf(eip)})`);
  console.error(`[diag] linear memory: ${(memSize / 1024 / 1024).toFixed(1)} MiB`);
  console.error(`[diag] error: ${String(error)}`);

  // 1. register file
  const regs = new Map<string, number>();
  const regLine: string[] = [];
  for (const name of REG32_LIST) {
    const v = runtime.getReg(name) >>> 0;
    regs.set(name, v);
    regLine.push(`${name}=0x${v.toString(16).padStart(8, '0')}`);
  }
  console.error(`[diag] regs: ${regLine.join(' ')}`);
  if (is64) {
    const r64: string[] = ['r8', 'r9', 'r10', 'r11', 'r12', 'r13', 'r14', 'r15'].map(
      (n) => `${n}=0x${(runtime.getReg64(n as never) >>> 0).toString(16).padStart(8, '0')}`,
    );
    console.error(`[diag] regs: ${r64.join(' ')}`);
  }

  // 2. decode the block at the faulting EIP and compute every memory access
  const decoder = new X86Decoder(is64 ? 'x64' : 'x86');
  const bytes = runtime.readBytes(eip, 512);
  console.error(
    `[diag] bytes: ${[...bytes.subarray(0, 32)].map((b) => b.toString(16).padStart(2, '0')).join(' ')}`,
  );

  // 2c. Inno-specific MM state (why is GetMem's small-block table empty?)
  const rd32 = (a: number): number => {
    const b = runtime.readBytes(a, 4);
    return b.byteLength < 4 ? NaN : new DataView(b.buffer, b.byteOffset, 4).getInt32(0, true);
  };
  const initTab = rd32(0x4afba4) >>> 0;
  console.error(
    `[diag] mm: initTable@0x4afba4=0x${initTab.toString(16)} count=${rd32(initTab)} base=0x${(rd32(initTab + 4) >>> 0).toString(16)}` +
      ` flag=0x${rd32(0x4ad059).toString(16)} smallblockHead=0x${(rd32(0x4a9090) >>> 0).toString(16)}` +
      ` sizeclass[8]=0x${(rd32(0x4ad990 + 8) >>> 0).toString(16)}`,
  );
  const esp = runtime.getReg('esp') >>> 0;
  const stackBytes = runtime.readBytes(esp, 0x80);
  console.error(`[diag] stack@0x${esp.toString(16)}: ${[...stackBytes].map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);
  const ra: string[] = [];
  for (let i = 0; i + 4 <= 0x400; i += 4) {
    const sb = runtime.readBytes((esp + i) >>> 0, 4);
    if (sb.byteLength < 4) break;
    const v = new DataView(sb.buffer).getUint32(0, true);
    if (v >= 0x400000 && v < 0x500000) ra.push(`[esp+0x${i.toString(16)}]=0x${v.toString(16)}`);
  }
  console.error(`[diag] call-chain: ${ra.length ? ra.join(' ') : '(no .text addrs in 0x400 bytes)'}`);
  const ea = (mem: MemOperand): number => {
    let a = mem.disp | 0;
    if (mem.base) a = (a + (regs.get(mem.base) ?? 0)) | 0;
    if (mem.index) a = (a + ((regs.get(mem.index) ?? 0) * mem.scale)) | 0;
    return a >>> 0;
  };
  const accesses = (inst: Instruction): Array<{ addr: number; kind: 'read' | 'write' | 'rw' }> => {
    const out: Array<{ addr: number; kind: 'read' | 'write' | 'rw' }> = [];
    const memOf = (op: unknown): MemOperand | undefined =>
      op && typeof op === 'object' && (op as { kind?: string }).kind === 'mem'
        ? (op as MemOperand)
        : undefined;
    const m = memOf(inst.dst);
    if (m) out.push({ addr: ea(m), kind: inst.op === 'or' || inst.op === 'and' || inst.op === 'cmp' || inst.op === 'test' || inst.op === 'xchg' || inst.op === 'cmpxchg' || inst.op === 'add' || inst.op === 'sub' ? 'rw' : 'write' });
    const s = memOf(inst.src);
    if (s) out.push({ addr: ea(s), kind: 'read' });
    const esp = regs.get('esp') ?? 0;
    if (inst.op === 'push') out.push({ addr: (esp - 4) >>> 0, kind: 'write' });
    if (inst.op === 'pop') out.push({ addr: esp >>> 0, kind: 'read' });
    if (inst.op === 'call') out.push({ addr: (esp - 4) >>> 0, kind: 'write' });
    if (inst.op === 'ret') out.push({ addr: esp >>> 0, kind: 'read' });
    return out;
  };

  try {
    const decoded = decoder.decode(bytes, eip);
    for (const di of decoded.instructions) {
      const acc = accesses(di.inst);
      const accStr = acc
        .map((a) => {
          const oob = a.addr >= memSize ? '  <-- OUT OF BOUNDS' : '';
          return `[${a.kind}] 0x${a.addr.toString(16)}${oob}`;
        })
        .join(' ');
      console.error(
        `[diag]   0x${di.nextAddress.toString(16).padStart(8, '0')}: ${di.inst.op}${accStr ? '  ' + accStr : ''}`,
      );
    }
  } catch (error) {
    console.error(`[diag] decode error: ${String(error)}`);
  }
}

main().catch((error) => {
  console.error('[diag] failed', error);
  process.exit(1);
});
