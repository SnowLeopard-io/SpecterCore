/**
 * SEH (structured exception handling) dispatch: RaiseException search/unwind, RtlUnwind, setjmp/longjmp, _initterm, and the sentinel continuation.
 *
 * Split out of guest-process.ts (design doc 4.2.x); pure code movement, no logic changes.
 */

import type { ApiHandler, ApiInterceptor, JitEngine } from '@specter-core/contracts';
import { WinError as E } from '@specter-core/contracts';
import { ApiTrapDispatcher } from '../jit/trap-dispatcher';
import { Executor } from '../jit/executor';
import type { ArchBackend } from '../arch';
import type { WasmRuntimeImpl } from '../jit/runtime';
import type { RegName } from '../jit/ir';
import type { RunState } from './guest-common';

// SEH exception dispositions returned by guest handlers (winnt.h).
const EXCEPTION_CONTINUE_EXECUTION = 0;
const EXCEPTION_EXECUTE_HANDLER = 2;
// Exception flags: EXCEPTION_NONCONTINUABLE / EXCEPTION_UNWINDING (cUnwinding).
const EXCEPTION_UNWINDING = 2;
const EXCEPTION_UNWINDING_FOR_EXIT = 4;
/** Sentinel vector: a trap with this vector means "guest handler returned". */
export const SEH_SENTINEL_VECTOR = 0x2d;
/**
 * Internal callHandler result: the guest handler accepted the exception by
 * calling RtlUnwind, which transferred control to the unwind target — the
 * transfer has already been applied to the runtime; do not restore registers.
 */
const EXCEPTION_TRANSFERRED = -2;
/** x86 CONTEXT record size (CONTEXT_FULL, 0x2CC bytes). */
export const X86_CONTEXT_SIZE = 0x2cc;

/** Full GP register file + flags + eip snapshot (nested executor save/restore). */
export interface RegSnapshot {
  regs: Array<[RegName, number]>;
  eflags: number;
  eip: number;
}

/** Saves the full GP register file, flags and eip. */
export function snapshotRegs(arch: ArchBackend, runtime: WasmRuntimeImpl): RegSnapshot {
  const names = arch.gpRegisterNames();
  return {
    regs: names.map((r) => [r, runtime.getReg64(r)]),
    eflags: runtime.getEflags(),
    eip: runtime.getEip(),
  };
}

/** Restores a snapshot taken by snapshotRegs. */
export function restoreRegs(runtime: WasmRuntimeImpl, s: RegSnapshot): void {
  for (const [r, v] of s.regs) runtime.setReg64(r, v);
  runtime.setEflags(s.eflags);
  runtime.setEip(s.eip);
}

/** Dependencies for the SEH dispatch install. */
export interface SehDeps {
  runtime: WasmRuntimeImpl;
  interceptor: ApiInterceptor;
  arch: ArchBackend;
  state: RunState;
}

/** Owns the SEH scratch addresses and dispatch state for one runner. */
export class SehController {
  /** SEH scratch guest addresses (allocated by the startup handlers). */
  sentinelAddr = 0;
  excAddr = 0;
  ctxAddr = 0;
  /** Accepting record of the phase-2 transfer (sentinel fallback target). */
  pending = 0;
  /** Nested RaiseException dispatch recursion guard. */
  depth = 0;
  /** Set by the RtlUnwind handler when it transfers control (unwind target). */
  transfer: { eip: number; esp: number } | null = null;

  /** Resets the per-run dispatch state. */
  reset(): void {
    this.pending = 0;
    this.depth = 0;
    this.transfer = null;
  }

  /**
   * SEH exception dispatch for RaiseException (x86 only; x64 SEH needs the
   * .pdata unwind metadata and is out of scope — those images keep the legacy
   * "return 0" behaviour).
   *
   * The decoder maps fs:[0] to guest address 0 (segment prefixes are ignored),
   * so the SEH chain head lives at guest address 0 and each record is
   * `{ Next @R+0, Handler @R+4 }` pushed by the frame's prologue. We emulate
   * the two-phase Windows protocol:
   *   1. walk the chain, calling each handler with (ExceptionRecord,
   *      EstablisherFrame, ContextRecord, DispatcherContext);
   *   2. on EXCEPTION_EXECUTE_HANDLER, call the intermediate frames again with
   *      cUnwinding set (cleanup/finally), then transfer control into the
   *      accepting handler — it rebuilds its frame below the record and the
   *      frame's own epilogue eventually `ret`s to the real caller, continuing
   *      the guest program without ever returning through RaiseException.
   *
   * Handlers are guest code that may call APIs, so each search/unwind call
   * runs inside a NESTED executor whose trap handler forwards API traps and
   * treats the sentinel vector as "handler returned; EAX = disposition".
   * Registers are restored after every call except the final transfer.
   */

  handleSentinel(rt: WasmRuntimeImpl): void {
    const rec = this.pending;
    this.pending = 0;
    if (rec) {
      rt.setReg('esp', rec + 16);
      rt.setEip(rt.readInt32(rec + 12) >>> 0);
    } else {
      rt.setEip(0);
    }
  }

  install(deps: SehDeps, dispatcher: ApiTrapDispatcher, jit: JitEngine): void {
    if (!deps.arch.supportsSeh || this.sentinelAddr === 0) return;
    const runtime = deps.runtime;
    const sentinel = this.sentinelAddr;
    const excAddr = this.excAddr;
    const ctxAddr = this.ctxAddr;

    // temporary diagnostic (enabled by diag-trap via __bk_seh_debug)
    const dbg = (...parts: unknown[]): void => {
      if ((globalThis as { __bk_seh_debug?: boolean }).__bk_seh_debug)
        console.error('[seh]', ...parts);
    };

    // Bounds-checked 32-bit guest read. Unlike runtime.readInt32 this never
    // grows the linear memory, so a corrupt chain can't balloon the heap.
    const peek = (a: number): number => {
      if (a < 0 || a + 4 > runtime.memory.buffer.byteLength) return 0;
      return new DataView(runtime.memory.buffer).getInt32(a, true) >>> 0;
    };

    const snapshot = (): { regs: Array<[RegName, number]>; eflags: number; eip: number } => ({
      regs: (['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi'] as const).map((r) => [
        r,
        runtime.getReg64(r),
      ]),
      eflags: runtime.getEflags(),
      eip: runtime.getEip(),
    });
    const restore = (s: { regs: Array<[RegName, number]>; eflags: number; eip: number }): void => {
      for (const [r, v] of s.regs) runtime.setReg64(r, v);
      runtime.setEflags(s.eflags);
      runtime.setEip(s.eip);
    };

    // EXCEPTION_RECORD (x86, 80 bytes) at `excAddr`.
    const buildExcRecord = (
      code: number,
      flags: number,
      nargs: number,
      argPtr: number,
      address: number,
    ): void => {
      const w = new Uint8Array(0x80);
      const view = new DataView(w.buffer);
      view.setUint32(0x00, code, true); // ExceptionCode
      view.setUint32(0x04, flags, true); // ExceptionFlags
      view.setUint32(0x08, 0, true); // nested record
      view.setUint32(0x0c, address, true); // ExceptionAddress
      view.setUint32(0x10, nargs, true); // NumberParameters
      for (let i = 0; i < 15; i++)
        view.setUint32(0x14 + i * 4, i < nargs ? peek(argPtr + i * 4) : 0, true);
      runtime.writeBytes(excAddr, w);
    };

    // x86 CONTEXT (CONTEXT_FULL, 0x2CC bytes) at `ctxAddr`, from live regs.
    const buildContext = (eip: number, esp: number, eflags: number): void => {
      const w = new Uint8Array(X86_CONTEXT_SIZE);
      const view = new DataView(w.buffer);
      view.setUint32(0x00, 0x10007, true); // ContextFlags
      view.setUint32(0x9c, runtime.getReg('edi') >>> 0, true);
      view.setUint32(0xa0, runtime.getReg('esi') >>> 0, true);
      view.setUint32(0xa4, runtime.getReg('ebx') >>> 0, true);
      view.setUint32(0xa8, runtime.getReg('edx') >>> 0, true);
      view.setUint32(0xac, runtime.getReg('ecx') >>> 0, true);
      view.setUint32(0xb0, runtime.getReg('eax') >>> 0, true);
      view.setUint32(0xb4, runtime.getReg('ebp') >>> 0, true);
      view.setUint32(0xb8, eip, true);
      view.setUint32(0xc0, eflags, true);
      view.setUint32(0xc4, esp, true);
      runtime.writeBytes(ctxAddr, w);
    };

    // Copies a guest-built EXCEPTION_RECORD (or zeros when the pointer is
    // null) into `excAddr` so cleanup handlers observe the real record.
    const copyExcRecord = (ptr: number): void => {
      const w = new Uint8Array(0x80);
      const view = new DataView(w.buffer);
      for (let i = 0; i < 0x80; i += 4) view.setUint32(i, peek(ptr + i), true);
      runtime.writeBytes(excAddr, w);
    };

    /**
     * Runs guest `handler` with a fresh 4-arg dispatch frame just below the
     * current ESP: [frame]=sentinel return address, then ExceptionRecord /
     * EstablisherFrame / ContextRecord / DispatcherContext. Returns the
     * disposition the handler left in EAX when it returned to the sentinel
     * (-1 if it faulted or never returned). Guest state is snapshotted first
     * and restored afterwards.
     */
    const callHandler = async (
      handler: number,
      record: number,
      flags: number,
      excCode: number,
      nargs: number,
      argPtr: number,
      address: number,
      prebuilt = false,
    ): Promise<number> => {
      const saved = snapshot();
      const frame = (runtime.getReg('esp') - 20) >>> 0;
      if (!prebuilt) buildExcRecord(excCode, flags, nargs, argPtr, address);
      runtime.writeInt32(frame + 0, sentinel);
      runtime.writeInt32(frame + 4, excAddr);
      runtime.writeInt32(frame + 8, record);
      runtime.writeInt32(frame + 12, ctxAddr);
      runtime.writeInt32(frame + 16, 0); // DispatcherContext
      runtime.setReg('esp', frame);
      runtime.setEip(handler);
      let disposition = -1;
      const nested = new Executor(
        runtime,
        jit,
        {
          handle: async (vector) => {
            if (vector === SEH_SENTINEL_VECTOR) {
              disposition = runtime.getReg('eax') >>> 0;
              runtime.setEip(0);
              return;
            }
            await dispatcher.handle(vector);
            if (this.transfer) {
              // The handler accepted via RtlUnwind and control moved to the
              // unwind target — stop the nested run; callHandler propagates
              // the transfer to the outer dispatch instead of restoring.
              runtime.setEip(0);
              return;
            }
            const last = dispatcher.lastCalled;
            if (last && last.proc.toLowerCase() === 'exitprocess') {
              deps.state.exitCode = runtime.getReg('eax') & 0xffffffff;
              deps.state.exitRequested = true;
              runtime.setEip(0);
            }
          },
        },
        { maxSteps: 500_000 },
      );
      await nested.run(handler);
      const transfer = this.transfer;
      this.transfer = null;
      if (transfer) {
        // Apply the unwind target (RtlUnwind already unwound intermediate
        // frames) and signal the caller not to restore the guest state.
        runtime.setEip(transfer.eip);
        runtime.setReg('esp', transfer.esp);
        return EXCEPTION_TRANSFERRED;
      }
      restore(saved);
      return disposition;
    };

    deps.interceptor.hook('kernel32.dll', 'RaiseException', async (ctx) => {
      const excCode = (ctx.rawArgs[0] ?? 0) >>> 0;
      const excFlags = (ctx.rawArgs[1] ?? 0) >>> 0;
      const nargs = (ctx.rawArgs[2] ?? 0) >>> 0;
      const argPtr = (ctx.rawArgs[3] ?? 0) >>> 0;
      const curEip = runtime.getEip() >>> 0;
      const address = (curEip - 2) >>> 0; // the int 0x2e inside the trap stub
      const eflags = runtime.getEflags();
      const esp = runtime.getReg('esp') >>> 0;

      dbg(
        `RaiseException code=0x${excCode.toString(16)} flags=${excFlags} nargs=${nargs} argPtr=0x${argPtr.toString(16)} esp=0x${esp.toString(16)} head=0x${peek(0).toString(16)}`,
      );
      if ((globalThis as { __bk_seh_debug?: boolean }).__bk_seh_debug) {
        const dump32 = (base: number, n: number): string => {
          const out: string[] = [];
          for (let i = 0; i < n; i++) out.push(`0x${peek(base + i * 4).toString(16)}`);
          return out.join(' ');
        };
        dbg(`  params@0x${argPtr.toString(16)}: ${dump32(argPtr, Math.min(nargs, 8))}`);
        dbg(`  stack@0x${(esp - 16).toString(16)}: ${dump32(esp - 16, 20)}`);
      }

      if (this.depth > 8) return { returnValue: 0, errorCode: E.NO_ERROR };
      this.depth += 1;
      try {
        // --- phase 1: search the chain for a handler ---
        let record = peek(0); // fs:[0] -> guest address 0
        let accepting = 0;
        for (let guard = 0; guard < 64 && record !== 0 && record !== 0xffffffff; guard++) {
          const handler = peek(record + 4);
          if (!handler) break;
          dbg(
            `search record=0x${record.toString(16)} handler=0x${handler.toString(16)} next=0x${peek(record).toString(16)}`,
          );
          buildContext(curEip, esp, eflags);
          const disp = await callHandler(
            handler,
            record,
            excFlags & 1,
            excCode,
            nargs,
            argPtr,
            address,
          );
          dbg(`  -> disposition=${disp}`);
          if (deps.state.exitRequested) {
            // a handler called ExitProcess — terminate the whole run
            runtime.setEip(0);
            return { returnValue: 0, errorCode: E.NO_ERROR };
          }
          if (disp === EXCEPTION_TRANSFERRED) {
            // a handler accepted via RtlUnwind and control already moved to
            // the unwind target — the main executor continues there.
            dbg('  -> transferred via RtlUnwind');
            return { returnValue: 0, errorCode: E.NO_ERROR };
          }
          if (disp === EXCEPTION_EXECUTE_HANDLER) {
            accepting = record;
            break;
          }
          if (disp === EXCEPTION_CONTINUE_EXECUTION) {
            // Resume after the raise (the trap already advanced EIP past the
            // int, so the stub's `ret` returns into the RaiseException caller).
            return { returnValue: 0, errorCode: E.NO_ERROR };
          }
          record = peek(record);
        }
        if (accepting === 0) {
          // Unhandled — keep the legacy behaviour (return 0 to the caller).
          dbg('unhandled (no accepting handler)');
          return { returnValue: 0, errorCode: E.NO_ERROR };
        }
        dbg(`accepting record=0x${accepting.toString(16)}`);

        // --- phase 2a: unwind the frames between the head and the accepting
        //     frame, letting their cleanup (finally) handlers run ---
        let u = peek(0);
        for (let guard = 0; guard < 64 && u !== 0 && u !== 0xffffffff && u !== accepting; guard++) {
          const uh = peek(u + 4);
          dbg(`unwind record=0x${u.toString(16)} handler=0x${uh.toString(16)}`);
          if (uh) {
            await callHandler(uh, u, EXCEPTION_UNWINDING, excCode, nargs, argPtr, address);
            if (deps.state.exitRequested) {
              runtime.setEip(0);
              return { returnValue: 0, errorCode: E.NO_ERROR };
            }
          }
          u = peek(u);
        }

        // --- phase 2b: transfer into the accepting handler's except block.
        //     NO register restore: the except block continues the guest
        //     program from here and the frame epilogue `ret`s to its caller.
        const ah = peek(accepting + 4);
        const frame = (accepting - 20) >>> 0;
        dbg(
          `transfer accepting=0x${accepting.toString(16)} handler=0x${ah.toString(16)} frame=0x${frame.toString(16)}`,
        );
        buildExcRecord(excCode, EXCEPTION_UNWINDING, nargs, argPtr, address);
        runtime.writeInt32(frame + 0, sentinel);
        runtime.writeInt32(frame + 4, excAddr);
        runtime.writeInt32(frame + 8, accepting);
        runtime.writeInt32(frame + 12, ctxAddr);
        runtime.writeInt32(frame + 16, 0);
        runtime.setReg('esp', frame);
        runtime.setEip(ah);
        this.pending = accepting;
        return { returnValue: 0, errorCode: E.NO_ERROR };
      } finally {
        this.depth -= 1;
      }
    });

    // ------------------------------------------------------------------
    // RtlUnwind(EstablisherFrame, TargetIp, ExceptionRecord, ReturnValue).
    // Unwinds the SEH chain from the current frame down to (but excluding)
    // EstablisherFrame — running each intermediate handler with
    // cUnwinding|cUnwindingForExit so finally-cleanup code executes — then
    // transfers control to TargetIp with ESP = EstablisherFrame and
    // EAX = ReturnValue. RtlUnwind NEVER returns to its caller; the transfer
    // is applied directly to the guest state. Guest handlers that accept an
    // exception call RtlUnwind(their own record, ...) — this is the path the
    // Inno/Delphi RTL uses instead of returning EXCEPTION_EXECUTE_HANDLER.
    // Registered under both ntdll and kernel32 (kernel32 forwards it).
    // ------------------------------------------------------------------
    const rtlUnwindHandler: ApiHandler = async (ctx) => {
      const targetFrame = (ctx.rawArgs[0] ?? 0) >>> 0;
      const targetIp = (ctx.rawArgs[1] ?? 0) >>> 0;
      const excRecPtr = (ctx.rawArgs[2] ?? 0) >>> 0;
      const returnValue = (ctx.rawArgs[3] ?? 0) >>> 0;
      dbg(
        `RtlUnwind frame=0x${targetFrame.toString(16)} target=0x${targetIp.toString(16)} exc=0x${excRecPtr.toString(16)} ret=0x${returnValue.toString(16)}`,
      );
      if ((globalThis as { __bk_seh_debug?: boolean }).__bk_seh_debug) {
        const dump32 = (base: number, n: number): string => {
          const out: string[] = [];
          for (let i = 0; i < n; i++) out.push(`0x${peek(base + i * 4).toString(16)}`);
          return out.join(' ');
        };
        dbg(`  excRec@0x${excRecPtr.toString(16)}: ${dump32(excRecPtr, 8)}`);
        dbg(`  stack@0x${(targetFrame - 0x10).toString(16)}: ${dump32(targetFrame - 0x10, 24)}`);
      }

      if (this.depth > 12) return { returnValue: 0, errorCode: E.NO_ERROR };

      let u = peek(0);
      let inner = 0;
      for (let guard = 0; guard < 64 && u !== 0 && u !== 0xffffffff && u !== targetFrame; guard++) {
        inner = u;
        const uh = peek(u + 4);
        dbg(`  unwind record=0x${u.toString(16)} handler=0x${uh.toString(16)}`);
        if (uh) {
          copyExcRecord(excRecPtr);
          const disp = await callHandler(
            uh,
            u,
            EXCEPTION_UNWINDING | EXCEPTION_UNWINDING_FOR_EXIT,
            0,
            0,
            0,
            0,
            true,
          );
          void disp;
          if (deps.state.exitRequested) {
            runtime.setEip(0);
            return { returnValue: 0, errorCode: E.NO_ERROR };
          }
          if (this.transfer) {
            // a nested unwind handler transferred again — propagate as-is
            return { returnValue: 0, errorCode: E.NO_ERROR };
          }
        }
        u = peek(u);
      }

      // Transfer: never returns; EAX = ReturnValue is set by the dispatcher
      // from the returned ApiResult.
      //
      // ESP: the unwind target (TargetIp) reads the ESTABLISHER FRAME back
      // from [esp+0x28]. The accepting record's address is stored in the
      // inner record's Next field at [inner] (the record just before
      // targetFrame in the chain). So the transfer ESP must be inner - 0x28;
      // then [esp+0x28] = [inner] = the accepting record, matching the unwind
      // target that reads Frame+4 / Frame+8 as jump target / saved EBP.
      dbg(`  transfer to 0x${targetIp.toString(16)} esp=0x${targetFrame.toString(16)}`);
      const transferEsp = (inner ? inner - 0x28 : targetFrame - 0x34) >>> 0;
      this.transfer = { eip: targetIp, esp: transferEsp };
      runtime.setEip(targetIp);
      runtime.setReg('esp', transferEsp);
      return { returnValue, errorCode: E.NO_ERROR };
    };
    deps.interceptor.hook('ntdll.dll', 'RtlUnwind', rtlUnwindHandler);
    deps.interceptor.hook('kernel32.dll', 'RtlUnwind', rtlUnwindHandler);

    // ApiSetQueryApiSetPresence(PCWSTR Namespace, PBOOLEAN Present) —
    // api-ms-win-core-apiquery-* normalizes to kernel32. cmd.exe calls this
    // during its console/string init (0x41efeb wrapper -> 0x41f181 IAT slot).
    // The Present output pointer sits at [ebp-1] in the wrapper frame, adjacent
    // to the saved caller EBP at [ebp]; writing 4 bytes (or any dword write)
    // would clobber [ebp] and make `leave` restore a garbage EBP (0x07000000),
    // cascading into every later [ebp-N] read and a GS-cookie FAIL. Write ONLY
    // 1 byte (BOOLEAN) and return STATUS_SUCCESS so cmd takes the "API set
    // present" path without touching the neighbouring stack slot.
    deps.interceptor.hook('kernel32.dll', 'ApiSetQueryApiSetPresence', (ctx, host) => {
      const present = (ctx.rawArgs[1] ?? 0) >>> 0;
      if (present) host.memory.write(present, new Uint8Array([1])); // TRUE
      return { returnValue: 0, errorCode: E.NO_ERROR }; // STATUS_SUCCESS
    });

    // RtlCreateUnicodeStringFromAsciiz(PUNICODE_STRING DestinationString,
    // PCSZ SourceString) — ntdll. cmd.exe's 0x42d39c string-init helper calls
    // this; without a handler the UNICODE_STRING output stays zeroed and the
    // helper returns NULL, sending cmd down its error-recovery path where
    // standard-handle values get misused as pointers (edi=0xfffffff4 -> OOB).
    // We allocate a temp wide buffer and fill the struct so the helper succeeds.
    deps.interceptor.hook('ntdll.dll', 'RtlCreateUnicodeStringFromAsciiz', (ctx, host) => {
      const dst = Number(ctx.rawArgs[0] ?? 0) >>> 0;
      const src = Number(ctx.rawArgs[1] ?? 0) >>> 0;
      if (!dst || !src) return { returnValue: 0xc0000001, errorCode: E.NO_ERROR }; // STATUS_UNSUCCESSFUL
      // Read source ASCII string
      const bytes = host.memory.read(src, 0x10000) ?? new Uint8Array(0);
      let n = 0;
      while (n < bytes.length && bytes[n] !== 0) n++;
      // Temp wide buffer at a fixed high address (reused across calls — cmd
      // consumes the string immediately in 0x42d39c, so this is safe enough).
      const wideBuf = 0x00600000;
      const wide = new Uint8Array((n + 1) * 2);
      for (let i = 0; i < n; i++) wide[i * 2] = bytes[i] ?? 0; // ASCII -> UTF-16LE
      host.memory.write(wideBuf, wide);
      // Fill UNICODE_STRING: Length(2) + MaximumLength(2) + Buffer(4)
      const us = new Uint8Array(8);
      const dv = new DataView(us.buffer);
      dv.setUint16(0, n * 2, true); // Length = bytes (not including null)
      dv.setUint16(2, (n + 1) * 2, true); // MaximumLength
      dv.setUint32(4, wideBuf, true); // Buffer
      host.memory.write(dst, us);
      return { returnValue: 0, errorCode: E.NO_ERROR }; // STATUS_SUCCESS
    });

    // ------------------------------------------------------------------
    // longjmp: non-local goto used by cmd.exe's error-recovery paths
    // (e.g. when a command fails or CreateFileW gets a bad path). The
    // default no-op handler returns 0 without restoring registers or
    // jumping, so cmd falls through the error path and faults into data
    // sections. MSVC x86 jmp_buf layout (first 6 dwords):
    //   [0]=Ebp [4]=Ebx [8]=Edi [12]=Esi [16]=Esp [20]=Eip
    // Restore them, set EAX = value (never 0 per C standard), and jump
    // to the saved EIP (the setjmp return site).
    // ------------------------------------------------------------------
    const longjmpHandler: ApiHandler = (ctx, _host) => {
      const jmpBuf = (ctx.rawArgs[0] ?? 0) >>> 0;
      const value = (ctx.rawArgs[1] ?? 0) >>> 0;
      if (!jmpBuf) return { returnValue: 0, errorCode: E.NO_ERROR };
      // Dump first 64 bytes to determine MSVC jmp_buf layout
      const dump: string[] = [];
      for (let i = 0; i < 16; i++) {
        dump.push(`[${i * 4}]=0x${(runtime.readInt32(jmpBuf + i * 4) >>> 0).toString(16)}`);
      }
      dbg(`longjmp buf=0x${jmpBuf.toString(16)} val=${value}: ${dump.join(' ')}`);
      const ebp = runtime.readInt32(jmpBuf + 0);
      const ebx = runtime.readInt32(jmpBuf + 4);
      const edi = runtime.readInt32(jmpBuf + 8);
      const esi = runtime.readInt32(jmpBuf + 12);
      const esp = runtime.readInt32(jmpBuf + 16);
      const eip = runtime.readInt32(jmpBuf + 20);
      dbg(
        `longjmp buf=0x${jmpBuf.toString(16)} val=${value} -> eip=0x${(eip >>> 0).toString(16)} esp=0x${(esp >>> 0).toString(16)}`,
      );
      runtime.setReg('ebp', ebp);
      runtime.setReg('ebx', ebx);
      runtime.setReg('edi', edi);
      runtime.setReg('esi', esi);
      runtime.setReg('esp', esp);
      runtime.setEip(eip);
      // longjmp must not return 0; return value goes in EAX (dispatcher
      // will overwrite EAX with returnValue after the handler returns, so
      // set it here too in case the dispatcher path changes).
      const ret = value === 0 ? 1 : value;
      runtime.setReg('eax', ret);
      return { returnValue: ret, errorCode: E.NO_ERROR };
    };
    deps.interceptor.hook('ucrtbase.dll', 'longjmp', longjmpHandler);
    deps.interceptor.hook('ucrtbase.dll', '_longjmp', longjmpHandler);
    deps.interceptor.hook('msvcrt.dll', 'longjmp', longjmpHandler);

    // ------------------------------------------------------------------
    // _setjmp3: the MSVC x86 companion of longjmp. setjmp/longjmp power
    // cmd.exe's error-recovery: a setjmp saves the register state, and the
    // error path calls longjmp to "return" non-zero from the setjmp call
    // site. Without this handler the jmp_buf stays all zeros, so longjmp
    // jumps to eip=0 and the process traps. Signature (cdecl, variadic):
    //   int _setjmp3(void* env, int savemask, ...);
    // We write the same MSVC x86 layout longjmp reads:
    //   [0]=Ebp [4]=Ebx [8]=Edi [12]=Esi [16]=Esp [20]=Eip
    // and return 0 (setjmp returns 0 the first time). At trap time esp
    // points at the return address (pushed by the call); arg0 sits at
    // [esp+4]. The stub is `ret 0` (cdecl, caller cleans the args), so the
    // saved Esp must be esp+4 — the caller's esp right after the call
    // returns, with its own args still on the stack to pop.
    // ------------------------------------------------------------------
    const setjmp3Handler: ApiHandler = (ctx, _host) => {
      const env = (ctx.rawArgs[0] ?? 0) >>> 0;
      if (!env) return { returnValue: 0, errorCode: E.NO_ERROR };
      const espAtTrap = runtime.getReg('esp') >>> 0;
      const eip = runtime.readInt32(espAtTrap) >>> 0; // return address = setjmp call site
      const ebp = runtime.getReg('ebp') >>> 0;
      const ebx = runtime.getReg('ebx') >>> 0;
      const edi = runtime.getReg('edi') >>> 0;
      const esi = runtime.getReg('esi') >>> 0;
      const esp = (espAtTrap + 4) >>> 0;
      runtime.writeInt32(env + 0, ebp);
      runtime.writeInt32(env + 4, ebx);
      runtime.writeInt32(env + 8, edi);
      runtime.writeInt32(env + 12, esi);
      runtime.writeInt32(env + 16, esp);
      runtime.writeInt32(env + 20, eip);
      dbg(
        `setjmp3 env=0x${env.toString(16)} eip=0x${eip.toString(16)} esp=0x${esp.toString(16)} ` +
          `ebp=0x${ebp.toString(16)} ebx=0x${ebx.toString(16)} edi=0x${edi.toString(16)} esi=0x${esi.toString(16)}`,
      );
      return { returnValue: 0, errorCode: E.NO_ERROR };
    };
    deps.interceptor.hook('ucrtbase.dll', '_setjmp3', setjmp3Handler);

    // ------------------------------------------------------------------
    // _initterm / _initterm_e: the CRT calls these to run the table of
    // static initializers (which includes __security_init_cookie and the C
    // runtime constructors). Not implementing them means __security_cookie
    // is never seeded and every __security_check_cookie fails fast. Each
    // entry is a guest function called with no arguments, driven through the
    // same nested-executor machinery as the SEH handler calls.
    // ------------------------------------------------------------------
    const runInitFn = async (fn: number): Promise<boolean> => {
      const saved = snapshot();
      const esp = runtime.getReg('esp') >>> 0;
      const frame = (esp - 4) >>> 0;
      runtime.writeInt32(frame, sentinel); // return address
      runtime.setReg('esp', frame);
      runtime.setEip(fn);
      const nested = new Executor(
        runtime,
        jit,
        {
          handle: async (vector) => {
            if (vector === SEH_SENTINEL_VECTOR) {
              runtime.setEip(0);
              return;
            }
            await dispatcher.handle(vector);
            const last = dispatcher.lastCalled;
            if (last && last.proc.toLowerCase() === 'exitprocess') {
              deps.state.exitCode = runtime.getReg('eax') & 0xffffffff;
              deps.state.exitRequested = true;
              runtime.setEip(0);
            }
          },
        },
        { maxSteps: 500_000 },
      );
      await nested.run(fn);
      const ok = !deps.state.exitRequested;
      restore(saved);
      return ok;
    };
    const inittermHandler: ApiHandler = async (ctx) => {
      const first = (ctx.rawArgs[0] ?? 0) >>> 0;
      const last = (ctx.rawArgs[1] ?? 0) >>> 0;
      for (let p = first; p < last && p + 4 <= runtime.memory.buffer.byteLength; p += 4) {
        const fn = peek(p);
        if (!fn) continue;
        if (!(await runInitFn(fn))) break;
      }
      return { returnValue: 0, errorCode: E.NO_ERROR };
    };
    deps.interceptor.hook('ucrtbase.dll', '_initterm', inittermHandler);
    deps.interceptor.hook('ucrtbase.dll', '_initterm_e', inittermHandler);
  }
}
