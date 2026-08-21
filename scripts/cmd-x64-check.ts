/**
 * Headless boot check for the 64-bit guest cmd-x64.exe (PE32+) through the
 * SpecterCore x64 JIT. Adapted from scripts/cmd-cwd-check.ts. Boots against a
 * real MemoryFileStore + FileSystemBridgeImpl, feeds a few commands on stdin,
 * and prints output so we can see whether the x64 guest reaches an interactive
 * prompt (or dies on the GS-cookie check / some x64 boot issue).
 *
 *   node scripts/cmd-x64-check.mjs [path/to/cmd-x64.exe] [cwd]
 *   set BK_PATCH=41dea0 & set BK_BYTES=c3  to apply an optional opcode patch
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { MemoryFileStore } from '../packages/host/src/memory-store';
import { FileSystemBridgeImpl } from '@specter-core/bridges';
import type { ApiHost, FileStore } from '@specter-core/contracts';
import type { ApiCallContext, ApiResult } from '@specter-core/core';
import {
  ApiInterceptorImpl,
  GuestProcessRunner,
  JitEngineImpl,
  PeLoaderImpl,
  registerDefaultHandlers,
  UnsupportedError,
  WasmRuntimeImpl,
  X86Decoder,
} from '@specter-core/core';

class LoggingInterceptor extends ApiInterceptorImpl {
  private count = 0;
  override async dispatch(ctx: ApiCallContext): Promise<ApiResult> {
    const result = await super.dispatch(ctx);
    if (this.count < 250) {
      this.count++;
      const args = ctx.rawArgs.slice(0, 6).map((a) => `0x${(a >>> 0).toString(16)}`);
      console.error(`[api ${this.count}] ${ctx.module}!${ctx.proc}(${args.join(', ')}) -> 0x${(result.returnValue >>> 0).toString(16)}${result.errorCode ? ` err=${result.errorCode}` : ''}`);
    }
    return result;
  }
}

async function seed(store: FileStore, path: string, data: Uint8Array): Promise<void> {
  const f = await store.openFile(path, 'create');
  await f.write(0, data);
  await f.close();
}

async function main(): Promise<void> {
  const file = resolve(process.argv[2] ?? 'apps/web/public/win/cmd-x64.exe');
  const cwd = process.argv[3] ?? 'C:\\Windows';
  const image = new Uint8Array(await readFile(file));
  const modulePath = 'C:/Windows/System32/cmd.exe';

  const store = new MemoryFileStore('C', 2 * 1024 * 1024 * 1024);
  await store.createDirectory('Windows');
  await store.createDirectory('Windows/System32');
  await store.createDirectory('Windows/System32/en-US');
  await store.createDirectory('Windows/System32/zh-CN');
  await seed(store, 'Windows/System32/cmd.exe', image);
  for (const lang of ['en-US', 'zh-CN']) {
    try {
      const mui = new Uint8Array(await readFile(`apps/web/public/win/${lang}/cmd.exe.mui`));
      await seed(store, `Windows/System32/${lang}/cmd.exe.mui`, mui);
    } catch {
      /* MUI optional */
    }
  }

  const runtime = new WasmRuntimeImpl();
  const host = {
    memory: {
      read: (address: number, length: number) => runtime.readBytes(address, length),
      write: (address: number, data: Uint8Array) => runtime.writeBytes(address, data),
    },
    fs: new FileSystemBridgeImpl(store),
  } as unknown as ApiHost;
  const interceptor = new LoggingInterceptor(host);
  registerDefaultHandlers(interceptor);

  const runner = new GuestProcessRunner(
    runtime,
    new JitEngineImpl(runtime),
    new PeLoaderImpl(),
    interceptor,
  );

  const bkPatch = process.env.BK_PATCH;
  const bkBytes = process.env.BK_BYTES ? process.env.BK_BYTES.split(',').map((h) => parseInt(h, 16)) : [0xc3];
  const patches = bkPatch ? [{ va: parseInt(bkPatch, 16), bytes: bkBytes }] : [];

  setTimeout(() => runner.postInput('echo hello-from-x64\r\n'), 1500);
  setTimeout(() => runner.postInput('cd Windows\r\n'), 3000);
  setTimeout(() => runner.postInput('cd\r\n'), 3500);
  setTimeout(() => runner.postInput('exit\r\n'), 5000);

  let out = '';
  const result = await runner.run(image, {
    createEngine: (mode) => new JitEngineImpl(runtime, mode),
    modulePath,
    commandLine: '',
    interactive: true,
    cwd,
    patches,
    readFile: async (p: string) => {
      const segs = p.split(/[\\/]/).filter(Boolean);
      if (segs.length && /^[A-Za-z]:$/.test(segs[0]!)) segs.shift();
      const sp = segs.join('/');
      try {
        const f = await store.openFile(sp, 'read');
        const size = await f.size();
        const data = await f.read(0, size);
        await f.close();
        return data;
      } catch {
        return null;
      }
    },
    onOutput: (bytes) => {
      out += new TextDecoder('utf-8').decode(bytes);
      process.stdout.write(Buffer.from(bytes));
    },
  });
  console.error(`\n[diag] status=${result.status} exitCode=${result.exitCode} eip=0x${(result.eip ?? 0).toString(16)} stubs=${result.stubs?.length ?? '?'}`);
  if (result.status === 'fault' && result.eip) {
    try {
      const bytes = runtime.readBytes(result.eip, 32);
      const dec = new X86Decoder('x64').decode(bytes, result.eip);
      console.error(`[diag] fault bytes: ${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);
      for (const di of dec.instructions) console.error(`[diag]   ${di.inst.op} (len ${di.length})`);
    } catch (e) {
      if (e instanceof UnsupportedError) console.error(`[diag]   unsupported: ${e.message}`);
      else console.error(`[diag]   decode err: ${String(e)}`);
    }
  }
  if (result.error) console.error(`[diag] error: ${String(result.error)}`);
  const od = new TextDecoder('utf-8').decode(result.output ?? new Uint8Array(0));
  const ed = new TextDecoder('utf-8').decode(result.stderrOutput ?? new Uint8Array(0));
  console.error(`[diag] result.output=${JSON.stringify(od.slice(0, 300))}`);
  console.error(`[diag] result.stderrOutput=${JSON.stringify(ed.slice(0, 300))}`);
  console.error(`[diag] captured onOutput length=${out.length}`);
  const printed = out.replace(/\0/g, '');
  const ok = printed.includes('hello-from-x64') || printed.includes('C:\\Windows');
  console.error(`[diag] interactive boot ${ok ? 'PASS' : 'FAIL'} (saw prompt/echo output?)`);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
