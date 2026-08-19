/**
 * Diagnostic CLI: trace which APIs a guest exe actually calls and where
 * execution ends. Usage:
 *   node scripts/diag-exe.ts path/to/app.exe
 *
 * Unlike run-exe.ts it wraps the interceptor so every trapped API call is
 * logged (module!proc -> return value), and it dumps the PE entry point plus
 * the first instructions at the entry point.
 */
import { readFile } from 'node:fs/promises';
import type { ApiCallContext, ApiInterceptor, ApiResult } from '@specter-core/contracts';
import {
  ApiInterceptorImpl,
  GuestProcessRunner,
  JitEngineImpl,
  PeLoaderImpl,
  UnsupportedError,
  WasmRuntimeImpl,
  X86Decoder,
  registerDefaultHandlers,
} from '@specter-core/core';

function traceInterceptor(inner: ApiInterceptor, rt: { getEip(): number }): ApiInterceptor {
  let count = 0;
  const summary = new Map<string, number>();
  return {
    hook: (m, p, h) => inner.hook(m, p, h),
    hookBatch: (m, hs) => inner.hookBatch(m, hs),
    unHook: (m, p) => inner.unHook(m, p),
    getHandler: (m, p) => inner.getHandler(m, p),
    async dispatch(ctx: ApiCallContext): Promise<ApiResult> {
      const result = await inner.dispatch(ctx);
      const key = `${ctx.module}!${ctx.proc}`;
      summary.set(key, (summary.get(key) ?? 0) + 1);
      if (count < 80) {
        const args = ctx.rawArgs
          .slice(0, 8)
          .map((a) => (a === 0 ? '0' : `0x${(a >>> 0).toString(16)}`))
          .join(', ');
        console.error(
          `[trace #${count}] ${key}(${args}) -> 0x${(result.returnValue >>> 0).toString(16)} err=${result.errorCode} eip=0x${(rt.getEip() >>> 0).toString(16)}`,
        );
        count += 1;
      }
      return result;
    },
    listHooks: () => inner.listHooks(),
    setLastError: (pid, e) => inner.setLastError(pid, e),
    getLastError: (pid) => inner.getLastError(pid),
  };
}

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: diag-exe <path-to.exe>');
    process.exit(2);
  }
  const image = new Uint8Array(await readFile(file));
  const is64 = sniff64(image);

  const runtime = new WasmRuntimeImpl();
  const host = {
    memory: {
      read: (address: number, length: number) => runtime.readBytes(address, length),
      write: (address: number, data: Uint8Array) => runtime.writeBytes(address, data),
    },
  } as never;
  const inner = new ApiInterceptorImpl(host as never);
  registerDefaultHandlers(inner);
  const interceptor = traceInterceptor(inner, runtime);

  const loader = new PeLoaderImpl();
  const pe = await loader.load(image);
  // EXPERIMENT: GetModuleHandleW(NULL) must return the exe image base for the
  // CRT startup to proceed; GetProcAddress must resolve the exe's own exports.
  const guestExports = new Map<string, number>();
  for (const e of pe.exports) guestExports.set(e.name.toLowerCase(), e.address);
  inner.hook('kernel32.dll', 'GetModuleHandleW', (ctx) => {
    const namePtr = ctx.rawArgs[0] ?? 0;
    return { returnValue: namePtr === 0 ? pe.baseAddress : 0, errorCode: 0 };
  });
  inner.hook('kernel32.dll', 'GetModuleHandleA', (ctx) => {
    const namePtr = ctx.rawArgs[0] ?? 0;
    return { returnValue: namePtr === 0 ? pe.baseAddress : 0, errorCode: 0 };
  });
  inner.hook('kernel32.dll', 'GetProcAddress', (ctx) => {
    const mod = ctx.rawArgs[0] ?? 0;
    const name = ctx.rawArgs[1] ?? 0;
    const address = mod === pe.baseAddress || mod === 0 ? guestExports.get(nameStr(runtime, name)) ?? 0 : 0;
    return { returnValue: address === 0 ? 0 : pe.baseAddress + address, errorCode: 0 };
  });
  console.error(`[diag] PE: is64=${pe.is64} machine=0x${pe.machine.toString(16)} subsystem=${pe.subsystem}`);
  console.error(
    `[diag] base=0x${pe.baseAddress.toString(16)} entryRVA=0x${(pe.entryPoint - pe.baseAddress).toString(16)} entry=0x${pe.entryPoint.toString(16)} size=0x${pe.imageSize.toString(16)}`,
  );
  console.error(
    `[diag] imports=${pe.imports.reduce((n, m) => n + m.functions.length, 0)} modules=${pe.imports.map((m) => m.moduleName).join(', ')}`,
  );
  console.error(
    `[diag] sections=${pe.sections.map((s) => `${s.name}@0x${s.virtualAddress.toString(16)}`).join(', ')}`,
  );
  console.error(`[diag] relocations=${pe.relocations.length}`);

  const runner = new GuestProcessRunner(runtime, new JitEngineImpl(runtime), loader, interceptor);
  const stepTrace: number[] = [];
  const result = await runner.run(image, {
    createEngine: (mode) => new JitEngineImpl(runtime, mode),
    onOutput: (bytes, stderr) => process[stderr ? 'stderr' : 'stdout'].write(Buffer.from(bytes)),
    onStep: (eip) => {
      if (stepTrace.length < 40 || eip < 0x400000) stepTrace.push(eip);
    },
  });
  console.error(`[diag] last step trace (${stepTrace.length} recorded):`);
  for (const eip of stepTrace.slice(-24)) {
    console.error(`[diag]   eip=0x${(eip >>> 0).toString(16)}`);
  }
  // Decode the tail of the Wine-detection stub: 0x40f724..0x40f7c0
  try {
    const decoder = new X86Decoder(is64 ? 'x64' : 'x86');
    const tail = decoder.decode(runtime.readBytes(0x40f790, 0x80), 0x40f790);
    console.error('[diag] wine-check tail 0x40f790..0x40f810:');
    for (const di of tail.instructions) {
      console.error(
        `[diag]   0x${(di.nextAddress - di.length).toString(16)} ${di.inst.op} (len ${di.length})`,
      );
    }
  } catch (error) {
    console.error('[diag] tail decode:', error instanceof UnsupportedError ? `unsupported: ${error.message}` : String(error));
  }

  // Post-run probes: what does the "module name" argument of the second
  // GetModuleHandleW call actually point to after mapping?
  const probe = runtime.readBytes(0x40f7bc, 64);
  console.error(
    `[diag] probe 0x40f7bc: ${[...probe].map((b) => b.toString(16).padStart(2, '0')).join(' ')}`,
  );
  console.error(`[diag] probe str: ${JSON.stringify(nameStr(runtime, 0x40f7bc))}`);
  for (const [va, label] of [
    [0x401000, '.text start'],
    [0x4a7000, '.itext start'],
    [0x4a7f98, 'entry'],
  ] as const) {
    const b = runtime.readBytes(va, 16);
    console.error(
      `[diag] mem 0x${va.toString(16)} (${label}): ${[...b].map((x) => x.toString(16).padStart(2, '0')).join(' ')}`,
    );
  }

  const label =
    result.status === 'exit'
      ? `exit code ${result.exitCode}`
      : result.status === 'fault'
        ? 'fault'
        : result.status === 'trap'
          ? 'trapped'
          : 'step limit';
  console.error(`\n[diag] ${label} (eip=0x${result.eip.toString(16)}, stubs=${result.stubs.length})`);
  if (result.error) console.error('[diag] error:', result.error);
  if (result.status !== 'exit') {
    const regs: [string, number][] = [];
    for (const r of ['eax', 'ebx', 'ecx', 'edx', 'esi', 'edi', 'ebp', 'esp', 'eip']) {
      regs.push([r, runtime.getReg(r as never) & 0xffffffff]);
    }
    console.error(
      '[diag] regs: ' + regs.map(([r, v]) => `${r}=0x${v.toString(16)}`).join(' '),
    );
  }
  if (result.output.byteLength > 0) console.error(`[diag] stdout: ${JSON.stringify(new TextDecoder().decode(result.output))}`);
  if (result.stderrOutput.byteLength > 0) console.error(`[diag] stderr: ${JSON.stringify(new TextDecoder().decode(result.stderrOutput))}`);

  // Decode the entry point so we can see what "the first thing that runs" is.
  const epBytes = runtime.readBytes(pe.entryPoint, 32);
  console.error(`[diag] entry bytes: ${[...epBytes].map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);
  try {
    const decoder = new X86Decoder(is64 ? 'x64' : 'x86');
    const decoded = decoder.decode(runtime.readBytes(pe.entryPoint, 0x300), pe.entryPoint);
    console.error(`[diag] entry flow (${decoded.instructions.length} total, terminated=${decoded.terminated}):`);
    for (const di of decoded.instructions) {
      console.error(
        `[diag]   0x${(di.nextAddress - di.length).toString(16)} ${di.inst.op} (len ${di.length})`,
      );
    }
  } catch (error) {
    console.error('[diag]   entry decode:', error instanceof UnsupportedError ? `unsupported: ${error.message}` : String(error));
  }

  if (result.status !== 'exit') {
    const bytes = runtime.readBytes(result.eip, 16);
    console.error(`[diag] stop bytes: ${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);
  }
}

function sniff64(image: Uint8Array): boolean {
  try {
    const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
    if (view.getUint16(0, true) !== 0x5a4d) return false;
    const eLfanew = view.getUint32(0x3c, true);
    return view.getUint16(eLfanew + 4 + 20, true) === 0x20b;
  } catch {
    return false;
  }
}

/** Reads a NUL-terminated latin1 string at `address` in guest memory. */
function nameStr(memory: { readBytes(address: number, length: number): Uint8Array }, address: number): string {
  if (!address) return '';
  const bytes = memory.readBytes(address, 256);
  let end = 0;
  while (end < bytes.byteLength && bytes[end] !== 0) end += 1;
  return new TextDecoder('latin1').decode(bytes.subarray(0, end));
}

main().catch((error) => {
  console.error('[diag] failed', error);
  process.exit(1);
});
