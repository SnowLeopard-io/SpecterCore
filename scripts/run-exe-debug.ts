import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ApiInterceptorImpl, GuestProcessRunner, JitEngineImpl, PeLoaderImpl, registerDefaultHandlers, WasmRuntimeImpl } from '@specter-core/core';

async function main(): Promise<void> {
  const [file] = process.argv.slice(2);
  const image = new Uint8Array(await readFile(file));
  const modulePath = resolve(file);
  const runtime = new WasmRuntimeImpl();
  const interceptor = new ApiInterceptorImpl({ fs: { createFile: async () => ({ handle: 0, error: 2 as any }) }, memory: { read: () => new Uint8Array(0), write: () => {} } } as any);
  registerDefaultHandlers(interceptor);
  const runner = new GuestProcessRunner(runtime, new JitEngineImpl(runtime), new PeLoaderImpl(), interceptor);
  const result = await runner.run(image, {
    createEngine: (m) => new JitEngineImpl(runtime, m),
    modulePath,
    maxSteps: 400_000_000,
    readFile: async () => null,
  });
  console.error(`[debug] done status=${result.status} eip=0x${result.eip.toString(16)} err=${String(result.error)}`);
}
main().catch((e) => { console.error('failed', e); process.exit(1); });
