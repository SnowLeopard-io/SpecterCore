/**
 * Flow：基本块级执行轨迹。用公开的 `onStep(eip, runtime)` 钩子记录每个基本块的
 * 起始 eip + esp，环形缓冲保留最后 N 条，并在 API 调用发生的基本块上打标记。
 *
 * 目的：32 位 VSCode 安装器（Inno Setup / Delphi）在 17 次 API 调用后 entry 静默
 * 返回（eip=0）。API 层面已看不到线索，需要看纯计算代码的执行路径，找出到底是
 * 哪个基本块把控制流带回了 null 返回地址。
 *
 * 零核心文件改动：只用 RunOptions 的公开选项 + 拦截器子类。
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ApiCallContext, ApiHost, ApiInterceptor, ApiResult, FileSystemBridge, WinError } from '@specter-core/contracts';
import {
  ApiInterceptorImpl,
  GuestProcessRunner,
  JitEngineImpl,
  PeLoaderImpl,
  registerDefaultHandlers,
  WasmRuntimeImpl,
} from '@specter-core/core';

const STACK_TOP = 0x08000000;
const FLOW_CAP = 8000; // 保留最后 8000 个基本块

// ---------- 环形轨迹缓冲 ----------
const eips = new Int32Array(FLOW_CAP);
const esps = new Int32Array(FLOW_CAP);
const tags: Array<string | null> = new Array(FLOW_CAP).fill(null);
let total = 0;

function pushStep(eip: number, esp: number): void {
  const i = total % FLOW_CAP;
  eips[i] = eip | 0;
  esps[i] = esp | 0;
  tags[i] = null;
  total++;
}

function tagCurrent(text: string): void {
  if (total === 0) return;
  const i = (total - 1) % FLOW_CAP;
  tags[i] = tags[i] ? `${tags[i]} | ${text}` : text;
}

function sectionOf(va: number): string {
  const rva = (va >>> 0) - 0x400000;
  if (rva >= 0x1000 && rva < 0xb4604) return '.text';
  if (rva >= 0xb5000 && rva < 0xb6684) return '.itext';
  if (rva >= 0xb7000 && rva < 0xba7a4) return '.data';
  if (rva >= 0xbb000 && rva < 0xc1da0) return '.bss';
  if (rva >= 0xc2000 && rva < 0xc2f36) return '.idata';
  if (rva >= 0xc3000 && rva < 0xc31a4) return '.didata';
  if ((va >>> 0) === 0) return 'NULL';
  if ((va >>> 0) >= 0x70000000) return 'stub/fake-dll';
  return '?';
}

function dumpFlow(tailCount: number): void {
  const start = Math.max(0, total - Math.min(FLOW_CAP, tailCount));
  console.error(`\n[flow] total basic blocks executed: ${total}`);
  console.error(`[flow] === last ${total - start} blocks (eip / esp / section) ===`);
  let prevEsp = -1;
  for (let k = start; k < total; k++) {
    const i = k % FLOW_CAP;
    const eip = eips[i] >>> 0;
    const esp = esps[i] >>> 0;
    const dEsp = prevEsp < 0 ? '' : (() => {
      const d = esp - prevEsp;
      return d === 0 ? '' : ` (esp${d > 0 ? '+' : ''}${d})`;
    })();
    prevEsp = esp;
    const tag = tags[i] ? `   <<< ${tags[i]}` : '';
    console.error(
      `  [${String(k).padStart(6)}] eip=0x${eip.toString(16).padStart(8, '0')} ` +
        `esp=0x${esp.toString(16)}${dEsp} ${sectionOf(eip)}${tag}`,
    );
  }
}

// ---------- 拦截器：打标记 ----------
class FlowInterceptor extends ApiInterceptorImpl implements ApiInterceptor {
  private count = 0;
  constructor(host: ApiHost, private readonly rt: WasmRuntimeImpl) {
    super(host);
  }
  async dispatch(ctx: ApiCallContext): Promise<ApiResult> {
    this.count++;
    const n = this.count;
    let ra = 0;
    try {
      ra = this.rt.readInt32(this.rt.getReg('esp')) >>> 0;
    } catch {
      /* ignore */
    }
    const result = await super.dispatch(ctx);
    if (/^Tls/i.test(ctx.proc)) {
      const args = (ctx.rawArgs ?? []).map((a) => `0x${(a >>> 0).toString(16)}`).join(',');
      console.error(
        `[tls] API #${n} ${ctx.module}.${ctx.proc}(${args}) ra=0x${ra.toString(16)} ` +
          `-> 0x${(result.returnValue >>> 0).toString(16)} err=${result.errorCode}`,
      );
    }
    if (/^LoadLibrary/i.test(ctx.proc)) {
      const args = (ctx.rawArgs ?? []).map((a) => `0x${(a >>> 0).toString(16)}`).join(',');
      let name = '';
      try {
        const p = (ctx.rawArgs?.[0] ?? 0) >>> 0;
        if (p) {
          const bytes: number[] = [];
          for (let i = 0; i < 512; i += 2) {
            const w = this.rt.readInt16(p + i);
            if (!w) break;
            bytes.push(w);
          }
          name = String.fromCharCode(...bytes);
        }
      } catch {
        /* ignore */
      }
      console.error(
        `[loadlib] API #${n} ${ctx.module}.${ctx.proc}(${args}) name="${name}" ra=0x${ra.toString(16)} ` +
          `-> 0x${(result.returnValue >>> 0).toString(16)} err=${result.errorCode}`,
      );
    }
    tagCurrent(
      `API #${n} ${ctx.module}.${ctx.proc} ra=0x${ra.toString(16)} ` +
        `-> 0x${(result.returnValue >>> 0).toString(16)} err=${result.errorCode}`,
    );
    return result;
  }
  get apiCount(): number {
    return this.count;
  }
}

function buildExeFs(exePath: string, exeBytes: Uint8Array): FileSystemBridge {
  const handles = new Map<number, { ptr: number }>();
  let next = 1;
  const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();
  const self = norm(exePath);
  const ok0 = 0 as WinError;
  const notFound = 2 as WinError;
  const denied = 5 as WinError;
  const invalidHandle = 6 as WinError;
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
      return 120 as WinError;
    },
    async unlockFile() {
      return 120 as WinError;
    },
    async releaseAll() {
      handles.clear();
    },
    onChange() {
      return () => {};
    },
  };
}

// ---------- 通用探针：在指定 VA 的基本块开始处 dump 寄存器 + 栈 ----------
const REGS = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi'] as const;

function dumpAt(label: string, rt: WasmRuntimeImpl, extraOffsets: number[]): void {
  const regs = REGS.map((r) => `${r}=0x${(rt.getReg(r as never) >>> 0).toString(16)}`).join(' ');
  let eflags = -1;
  try {
    eflags = rt.readInt32(0x1084) >>> 0; // CTX_BASE + EFLAGS_OFFSET
  } catch {
    /* ignore */
  }
  console.error(`\n[probe] ${label}`);
  console.error(`[probe]   ${regs} eflags=0x${eflags.toString(16)} (SF=${(eflags >> 7) & 1} OF=${(eflags >> 11) & 1} ZF=${(eflags >> 6) & 1} CF=${eflags & 1})`);
  const esp = rt.getReg('esp') >>> 0;
  const words: string[] = [];
  for (let i = 0; i < 8; i++) {
    words.push(`+${(i * 4).toString(16)}:0x${(rt.readInt32(esp + i * 4) >>> 0).toString(16)}`);
  }
  console.error(`[probe]   stack ${words.join(' ')}`);
  // TEMP: dump runtime bytes at 0x407440 to check .text mapping shift
  try {
    const b = rt.readBytes(0x407440, 48);
    console.error(`[probe]   mem@0x407440 = ${[...b].map((x) => x.toString(16).padStart(2, '0')).join(' ')}`);
  } catch { /* ignore */ }
  // TEMP: dump the magic-check target 0x41fda2 + the frame fields at edx
  try {
    const b = rt.readBytes(0x41fda2, 16);
    console.error(`[probe]   mem@0x41fda2 = ${[...b].map((x) => x.toString(16).padStart(2, '0')).join(' ')}`);
  } catch { /* ignore */ }
  try {
    const edx = rt.getReg('edx') >>> 0;
    if (edx) {
      const vals: string[] = [];
      for (let i = 0; i < 4; i++) {
        const v = rt.readInt32(edx + i * 4) >>> 0;
        vals.push(`[edx+0x${(i * 4).toString(16)}]=0x${v.toString(16)}${sectionOf(v) ? `(${sectionOf(v)})` : ''}`);
      }
      console.error(`[probe]   edx=0x${edx.toString(16)} ${vals.join(' ')}`);
    }
  } catch { /* ignore */ }
  for (const off of extraOffsets) {
    const addr = esp + off;
    console.error(
      `[probe]   [esp+0x${off.toString(16)}] = [0x${(addr >>> 0).toString(16)}] = ` +
        `0x${(rt.readInt32(addr) >>> 0).toString(16)}  ${sectionOf(rt.readInt32(addr) >>> 0)}`,
    );
  }
  // edi-relative dump: SEH record layout [edi]=Next [edi+4]=Handler [edi+8]=SavedEBP
  try {
    const edi = rt.getReg('edi') >>> 0;
    if (edi) {
      const vals: string[] = [];
      for (let i = 0; i < 8; i++) {
        const v = rt.readInt32(edi + i * 4) >>> 0;
        vals.push(`[edi+0x${(i * 4).toString(16)}]=0x${v.toString(16)}${sectionOf(v) ? `(${sectionOf(v)})` : ''}`);
      }
      console.error(`[probe]   edi=0x${edi.toString(16)} ${vals.join(' ')}`);
    }
  } catch {
    /* ignore */
  }
  // TLS slot 0 chain dump: eax = TLS slot 0 value. 0x40cc60 returns the slot
  // VALUE, which is a pointer to the head variable (&head); [&head] is the head
  // frame. Follow head -> [head] -> ... and dump [0]/[4]/[8]/[0xc] per node.
  try {
    const slot = rt.getReg('eax') >>> 0;
    if (slot) {
      const head = rt.readInt32(slot) >>> 0;
      const chain: string[] = [];
      let cur = head;
      for (let i = 0; i < 10; i++) {
        const next = rt.readInt32(cur) >>> 0;
        const f4 = rt.readInt32(cur + 4) >>> 0;
        const f8 = rt.readInt32(cur + 8) >>> 0;
        const fc = rt.readInt32(cur + 0xc) >>> 0;
        chain.push(`0x${cur.toString(16)}[0]=0x${next.toString(16)}[4]=0x${f4.toString(16)}[8]=0x${f8.toString(16)}${sectionOf(f8)}[c]=0x${fc.toString(16)}${sectionOf(fc)}`);
        if (!next || next === cur || next === 0xffffffff) break;
        cur = next;
      }
      console.error(`[probe]   TLSslot=0x${slot.toString(16)} head=0x${head.toString(16)} chain: ${chain.join(' -> ')}`);
    } else {
      // slot == 0: dump the TEB head + tlsArray to see where the frame head lives.
      const teb0 = rt.readInt32(0) >>> 0;
      const tlsptr = rt.readInt32(0x2c) >>> 0;
      const slot0 = tlsptr ? rt.readInt32(tlsptr) >>> 0 : 0;
      console.error(`[probe]   TLSslot=0x0 [0]=0x${teb0.toString(16)} [0x2c]=0x${tlsptr.toString(16)} [tlsArray+0]=0x${slot0.toString(16)}`);
      // Follow the chain from [0] (the head) to see the frame list.
      if (teb0) {
        const chain: string[] = [];
        let cur = teb0;
        for (let i = 0; i < 10; i++) {
          const next = rt.readInt32(cur) >>> 0;
          const f4 = rt.readInt32(cur + 4) >>> 0;
          const f8 = rt.readInt32(cur + 8) >>> 0;
          const fc = rt.readInt32(cur + 0xc) >>> 0;
          chain.push(`0x${cur.toString(16)}[0]=0x${next.toString(16)}[4]=0x${f4.toString(16)}[8]=0x${f8.toString(16)}${sectionOf(f8)}[c]=0x${fc.toString(16)}${sectionOf(fc)}`);
          if (!next || next === cur || next === 0xffffffff) break;
          cur = next;
        }
        console.error(`[probe]   [0]-chain: ${chain.join(' -> ')}`);
      }
    }
  } catch {
    /* ignore */
  }
  // TLS init state: [4b7c14] index, [4be630] flag, TLS array + slot value.
  try {
    const idx = rt.readInt32(0x4b7c14) >>> 0;
    const flag = rt.readInt32(0x4be630) >>> 0;
    const tlsptr = rt.readInt32(0x2c) >>> 0;
    const slotv = tlsptr && idx < 128 ? rt.readInt32(tlsptr + idx * 4) >>> 0 : 0;
    console.error(`[probe]   TLSidx=0x${idx.toString(16)} flag=0x${flag.toString(16)} tlsArray=0x${tlsptr.toString(16)} slot=0x${slotv.toString(16)}`);
  } catch {
    /* ignore */
  }
}

// 帧链 dump：从 TLS array[0] 的 head 变量出发，打印整个 finally-frame 链。
function dumpFrameChain(rt: WasmRuntimeImpl, label: string): void {
  try {
    const tlsptr = rt.readInt32(0x2c) >>> 0;
    const headVar = tlsptr ? rt.readInt32(tlsptr) >>> 0 : 0;
    const head = headVar ? rt.readInt32(headVar) >>> 0 : 0;
    const chain: string[] = [];
    let cur = head;
    for (let i = 0; i < 12; i++) {
      const next = rt.readInt32(cur) >>> 0;
      const f4 = rt.readInt32(cur + 4) >>> 0;
      const f8 = rt.readInt32(cur + 8) >>> 0;
      const fc = rt.readInt32(cur + 0xc) >>> 0;
      chain.push(`0x${cur.toString(16)}[0]=0x${next.toString(16)}[4]=0x${f4.toString(16)}[8]=0x${f8.toString(16)}${sectionOf(f8)}[c]=0x${fc.toString(16)}${sectionOf(fc)}`);
      if (!next || next === cur || next === 0xffffffff) break;
      cur = next;
    }
    console.error(`[probe]   ${label}: tlsArray=0x${tlsptr.toString(16)} headVar=0x${headVar.toString(16)} head=0x${head.toString(16)} chain: ${chain.join(' -> ')}`);
  } catch {
    /* ignore */
  }
}

async function main(): Promise<void> {
  const [file, tailArg, probeArg] = process.argv.slice(2);
  if (!file) {
    console.error('usage: node flow-vscode.mjs <path-to.exe> [tailCount] [va[+off,+off];va2...]');
    process.exit(2);
  }
  const tailCount = tailArg ? Number(tailArg) : 120;
  // 探针语法： 0x40e4c7+114+10 ; 0x40e4b0
  const probeSpecs = (probeArg ?? '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const parts = s.split('+');
      return { eip: Number(parts[0]), offsets: parts.slice(1).map((p) => parseInt(p, 16)) };
    });

  const image = new Uint8Array(await readFile(file));
  const modulePath = resolve(file);

  const runtime = new WasmRuntimeImpl();
  (globalThis as { __bk_seh_debug?: boolean }).__bk_seh_debug = true;
  const host = {
    memory: {
      read: (address: number, length: number) => runtime.readBytes(address, length),
      write: (address: number, data: Uint8Array) => runtime.writeBytes(address, data),
    },
    fs: buildExeFs(modulePath, image),
  } as unknown as ApiHost;

  const interceptor = new FlowInterceptor(host, runtime);
  registerDefaultHandlers(interceptor);
  // 注意：不要在这里 hook 启动关键 API 做实验。GuestProcessRunner.run() 内部会
  // 调用 installStartupHandlers()，它晚于这里执行，会把同名 hook 覆盖掉——之前
  // 就因此得出了错误结论。要改启动 API 的行为，请改 guest-process.ts 本身。

  const runner = new GuestProcessRunner(runtime, new JitEngineImpl(runtime), new PeLoaderImpl(), interceptor);

  const result = await runner.run(image, {
    createEngine: (mode) => new JitEngineImpl(runtime, mode),
    modulePath,
    readFile: async (p) => {
      try {
        return new Uint8Array(await readFile(p));
      } catch {
        return null;
      }
    },
    probes: [
      ...probeSpecs.map((p) => ({
        eip: p.eip,
        fn: (rt: WasmRuntimeImpl) => dumpAt(`hit 0x${p.eip.toString(16)} (block #${total})`, rt, p.offsets),
      })),
      {
        eip: 0x406e60,
        fn: (rt: WasmRuntimeImpl) => {
          const esp = rt.getReg('esp') >>> 0;
          console.error(`\n[probe] unwind-target @0x406e60 (block #${total}) esp=0x${esp.toString(16)}`);
          // dump the accepting record: [esp+0x28]
          try {
            const rec = rt.readInt32(esp + 0x28) >>> 0;
            const vals: string[] = [];
            for (let i = 0; i < 6; i++) {
              vals.push(`[+0x${(i * 4).toString(16)}]=0x${(rt.readInt32(rec + i * 4) >>> 0).toString(16)}`);
            }
            console.error(`[probe]   accepting record=0x${rec.toString(16)} ${vals.join(' ')}`);
          } catch { /* ignore */ }
          dumpFrameChain(rt, 'before-push');
        },
      },
      {
        eip: 0x406e8a,
        fn: (rt: WasmRuntimeImpl) => {
          const esp = rt.getReg('esp') >>> 0;
          console.error(`\n[probe] unwind-done @0x406e8a (block #${total}) esp=0x${esp.toString(16)}`);
          dumpFrameChain(rt, 'after-push');
        },
      },
      {
        eip: 0x40718c,
        fn: (rt: WasmRuntimeImpl) => {
          const esp = rt.getReg('esp') >>> 0;
          console.error(`\n[probe] frame-pop @0x40718c (block #${total}) esp=0x${esp.toString(16)}`);
          dumpFrameChain(rt, 'before-pop');
        },
      },
      {
        eip: 0x4ae51e,
        fn: (rt: WasmRuntimeImpl) => {
          const cookie = rt.readInt32(0x50602c) >>> 0;
          const enc = rt.readInt32(0x508734) >>> 0;
          const esi = rt.getReg('esi') >>> 0;
          console.error(
            `\n[probe] putty-decode @0x4ae51e (block #${total}) cookie=0x${cookie.toString(16)} ` +
              `enc[508734]=0x${enc.toString(16)} esi=0x${esi.toString(16)}`,
          );
        },
      },
      {
        eip: 0x4ae547,
        fn: (rt: WasmRuntimeImpl) => {
          const esi = rt.getReg('esi') >>> 0;
          const ecx = rt.getReg('ecx') >>> 0;
          const eax = rt.getReg('eax') >>> 0;
          console.error(
            `[probe] putty-call-esi @0x4ae547 (block #${total}) esi=0x${esi.toString(16)} ecx=0x${ecx.toString(16)} eax=0x${eax.toString(16)}`,
          );
        },
      },
    ],
    onStep: (eip, rt) => {
      let esp = 0;
      try {
        esp = rt.getReg('esp') >>> 0;
      } catch {
        /* ignore */
      }
      pushStep(eip, esp);
    },
    onOutput: (bytes, stderr) => {
      process[stderr ? 'stderr' : 'stdout'].write(Buffer.from(bytes));
    },
  });

  console.error(
    `\n[flow] status=${result.status} cleanExit=${result.cleanExit} ` +
      `eip=0x${result.eip.toString(16)} exitCode=${result.exitCode} apiCalls=${interceptor.apiCount}`,
  );
  if (result.error) console.error(`[flow] error:`, result.error);
  // On a fault, dump the raw bytes at the fault eip + the top of the guest stack,
  // so we can see whether eip landed on real code, zeros, or heap data.
  try {
    const feip = result.eip >>> 0;
    const fb = runtime.readBytes(feip, 48);
    console.error(`[flow] fault eip 0x${feip.toString(16)} bytes = ${[...fb].map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);
    const fesp = runtime.getReg('esp') >>> 0;
    const w: string[] = [];
    for (let i = 0; i < 8; i++) w.push(`[esp+${(i * 4).toString(16)}]=0x${(runtime.readInt32(fesp + i * 4) >>> 0).toString(16)}`);
    console.error(`[flow] fault esp 0x${fesp.toString(16)} ${w.join(' ')}`);
  } catch {
    /* guest memory may already be torn down — best effort */
  }
  console.error(`[flow] stack top = 0x${STACK_TOP.toString(16)}, initial esp = 0x${(STACK_TOP - 4).toString(16)}`);
  dumpFlow(tailCount);
}

main().catch((error) => {
  console.error('[flow] failed', error);
  process.exit(1);
});
