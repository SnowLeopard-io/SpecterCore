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
  constructor(host: ApiHost) {
    super(host);
    this.memHost = host;
  }
  override async dispatch(ctx: ApiCallContext): Promise<ApiResult> {
    if (ctx.proc.toLowerCase().includes('command_line') || ctx.proc.toLowerCase() === 'charnextw') {
      console.error(`[dbg] ${ctx.module}!${ctx.proc} normalized=${normalizeApiSetModule(ctx.module)} handler=${this.getHandler(normalizeApiSetModule(ctx.module), ctx.proc) ? 'YES' : 'NO'}`);
    }
    const args = ctx.rawArgs.slice(0, 12).map((a) => `0x${(a >>> 0).toString(16)}`);
    const result = await super.dispatch(ctx);
    console.error(
      `[api] ${ctx.module}!${ctx.proc}(${args.join(', ')}) -> 0x${(result.returnValue >>> 0).toString(16)}${result.returnValueHigh !== undefined ? `:0x${(result.returnValueHigh >>> 0).toString(16)}` : ''}`,
    );
    if (ctx.proc.toLowerCase() === 'verifyversioninfow') {
      const addr = ctx.rawArgs[0] ?? 0;
      const b = this.memHost.memory.read(addr, 24);
      const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join(' ');
      console.error(`[api]   OSVERSIONINFOEXW @0x${addr.toString(16)}: ${h}`);
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
      return { searchHandle: 0, entries: [], error: notFound };
    },
    async findNextFile() {
      return { entries: [], error: notFound };
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

  const interceptor = new LoggingInterceptor(host);
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
    onOutput: (bytes, stderr) => process[stderr ? 'stderr' : 'stdout'].write(Buffer.from(bytes)),
    onStep: (eip, rt) => {
      // Keep the last 64 block starts for the fault/limit trace dump below.
      trace.push(eip);
      if (trace.length > 64) trace.shift();
      if ([0x40b9f9, 0x40b9fc, 0x40ba01, 0x40ba06, 0x40ba11, 0x40ba21, 0x40ba2b, 0x40ba4f, 0x40ba52, 0x40ba59, 0x40ba5d, 0x40ba63, 0x40baa6, 0x40a1c7, 0x40a1eb, 0x40a1f5, 0x42d3cd, 0x42d3d2, 0x42d3d8, 0x42d47a, 0x42d47f].includes(eip)) {
        const r = (n: string) => `0x${(rt.getReg(n as never) >>> 0).toString(16)}`;
        const rd32 = (a: number) => {
          const b = rt.readBytes(a >>> 0, 4);
          return b.byteLength < 4 ? NaN : new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true);
        };
        const e60 = rt.getReg('ebp') - 0x60;
        console.error(
          `[bp] eip=0x${eip.toString(16)} edi=${r('edi')} esi=${r('esi')} ebx=${r('ebx')} ebp=${r('ebp')} esp=${r('esp')} [ebp-0x60]=0x${(rd32(e60) >>> 0).toString(16)} [edi]=0x${(rd32(rt.getReg('edi')) >>> 0).toString(16)} [edi+8]=0x${(rd32(rt.getReg('edi') + 8) >>> 0).toString(16)}`,
        );
      }
    },
    onFault: (rt, res) => {
      console.error('[trace] last blocks:');
      for (const e of trace) console.error(`  [trace]   0x${e.toString(16)}`);
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
