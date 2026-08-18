import { describe, expect, it } from 'vitest';
import { JitEngineImpl, IncompleteBlockError } from './engine';
import { WasmRuntimeImpl } from './runtime';
import { Executor } from './executor';
import { STATUS_CONTINUE, STATUS_FAULT, STATUS_TRAP, CTX_BASE, EIP_OFFSET } from './cpu';

function makeEngine() {
  const runtime = new WasmRuntimeImpl(64);
  const jit = new JitEngineImpl(runtime);
  return { runtime, jit };
}

// Guest code must not overlap the CPU-context struct at CTX_BASE (0x1000).

function hex(...bytes: number[]): Uint8Array {
  return new Uint8Array(bytes);
}

describe('JitEngineImpl', () => {
  it('compiles a mov-immediate + ret block into real WASM', async () => {
    const { runtime, jit } = makeEngine();
    // mov eax, 0x2a ; ret
    const block = { startAddress: 0x100000, code: hex(0xb8, 0x2a, 0x00, 0x00, 0x00, 0xc3), successorAddresses: [] };
    const compiled = await jit.compile(block);
    expect(compiled.size).toBe(6);
    const status = compiled.entry!();
    expect(status).toBe(STATUS_CONTINUE);
    expect(runtime.getReg('eax')).toBe(0x2a);
    // ret popped a fake return address of 0 (stack underflow) — eip is 0
    expect(runtime.getEip()).toBe(0);
  });

  it('executes arithmetic and stores to memory', async () => {
    const { runtime, jit } = makeEngine();
    // mov eax, 0x2a ; mov ebx, 5 ; add eax, ebx ; mov [0x2000], eax ; hlt
    const code = hex(0xb8, 0x2a, 0x00, 0x00, 0x00, 0xbb, 0x05, 0x00, 0x00, 0x00, 0x01, 0xd8, 0xa3, 0x00, 0x20, 0x00, 0x00, 0xf4);
    runtime.writeBytes(0x100000, code);
    const executor = new Executor(runtime, jit);
    const result = await executor.run(0x100000);
    expect(result.status).toBe('fault'); // hlt -> fault
    expect(runtime.getReg('eax')).toBe(0x2f);
    expect(runtime.readInt32(0x2000)).toBe(0x2f);
  });

  it('honours conditional jumps with correct flags', async () => {
    const { runtime, jit } = makeEngine();
    // mov eax,1; mov ecx,2; cmp eax,ecx; jne +1; nop; mov ebx,0x100000; hlt
    const code = hex(
      0xb8, 0x01, 0x00, 0x00, 0x00, // mov eax,1
      0xb9, 0x02, 0x00, 0x00, 0x00, // mov ecx,2
      0x39, 0xc8, // cmp eax,ecx
      0x75, 0x01, // jne +1 (target = mov ebx)
      0x90, // nop (fallthrough only when equal)
      0xbb, 0x00, 0x10, 0x00, 0x00, // mov ebx,0x100000
      0xf4, // hlt
    );
    runtime.writeBytes(0x100000, code);
    const executor = new Executor(runtime, jit);
    await executor.run(0x100000);
    // eax(1) != ecx(2) so the branch was taken
    expect(runtime.getReg('ebx')).toBe(0x1000);
  });

  it('executes call/ret with a return address', async () => {
    const { runtime, jit } = makeEngine();
    // mov esp,0x3000; call +6; mov eax,0x42; hlt; mov ebx,7; ret
    const code = hex(
      0xbc, 0x00, 0x30, 0x00, 0x00, // mov esp,0x3000
      0xe8, 0x06, 0x00, 0x00, 0x00, // call +6 -> 0x1010
      0xb8, 0x42, 0x00, 0x00, 0x00, // mov eax,0x42
      0xf4, // hlt
      0xbb, 0x07, 0x00, 0x00, 0x00, // mov ebx,7
      0xc3, // ret
    );
    runtime.writeBytes(0x100000, code);
    const executor = new Executor(runtime, jit);
    await executor.run(0x100000);
    expect(runtime.getReg('eax')).toBe(0x42);
    expect(runtime.getReg('ebx')).toBe(7);
    expect(runtime.getReg('esp')).toBe(0x3000);
  });

  it('executes a REP STOSD loop', async () => {
    const { runtime, jit } = makeEngine();
    // mov esp,0x3000; mov edi,0x2000; mov eax,0x41414141; mov ecx,4; rep stosd; mov ebx,edi; hlt
    const code = hex(
      0xbc, 0x00, 0x30, 0x00, 0x00, // mov esp,0x3000
      0xbf, 0x00, 0x20, 0x00, 0x00, // mov edi,0x2000
      0xb8, 0x41, 0x41, 0x41, 0x41, // mov eax,0x41414141
      0xb9, 0x04, 0x00, 0x00, 0x00, // mov ecx,4
      0xf3, 0xab, // rep stosd
      0x8b, 0xdf, // mov ebx,edi
      0xf4,
    );
    runtime.writeBytes(0x100000, code);
    const executor = new Executor(runtime, jit);
    await executor.run(0x100000);
    for (let i = 0; i < 4; i++) expect(runtime.readInt32(0x2000 + i * 4)).toBe(0x41414141);
    expect(runtime.getReg('edi')).toBe(0x2010);
    expect(runtime.getReg('ecx')).toBe(0);
  });

  it('traps on INT and dispatches the vector', async () => {
    const { runtime, jit } = makeEngine();
    // mov eax,7; int 0x2e
    const code = hex(0xb8, 0x07, 0x00, 0x00, 0x00, 0xcd, 0x2e);
    runtime.writeBytes(0x100000, code);
    const trapped: number[] = [];
    const executor = new Executor(runtime, jit, {
      handle(vector) {
        trapped.push(vector);
        runtime.setEip(0);
      },
    });
    const result = await executor.run(0x100000);
    expect(trapped).toEqual([0x2e]);
    expect(result.status).toBe('trap');
  });

  it('caches compiled blocks and tracks stats', async () => {
    const { jit } = makeEngine();
    const block = { startAddress: 0x100000, code: hex(0xb8, 0x01, 0x00, 0x00, 0x00, 0xc3), successorAddresses: [] };
    const a = await jit.compile(block);
    const b = await jit.compile(block);
    expect(a).toBe(b);
    const stats = jit.getStats();
    expect(stats.cacheMisses).toBe(1);
    expect(stats.cacheHits).toBe(1);
    expect(stats.compiledBlocks).toBe(1);
    jit.invalidate(0x100000);
    await jit.compile(block);
    expect(jit.getStats().cacheMisses).toBe(2);
    jit.clearCache();
    expect(jit.getStats().cacheMisses).toBe(0);
  });

  it('turns unsupported opcodes into faulting blocks', async () => {
    const { jit } = makeEngine();
    // 0F C8 = BSWAP eax (unsupported)
    const block = { startAddress: 0x100000, code: hex(0x0f, 0xc8), successorAddresses: [] };
    const compiled = await jit.compile(block);
    expect(compiled.entry!()).toBe(STATUS_FAULT);
  });

  it('throws on empty code blocks', async () => {
    const { jit } = makeEngine();
    await expect(jit.compile({ startAddress: 0x100000, code: new Uint8Array(0), successorAddresses: [] })).rejects.toThrow(IncompleteBlockError);
  });

  it('stores the EIP inside the CPU context', async () => {
    const { runtime, jit } = makeEngine();
    // mov eax,1 ; jmp +0 (self) — block ends at the jmp, eip stored in ctx
    const code = hex(0xb8, 0x01, 0x00, 0x00, 0x00, 0xeb, 0x00);
    const block = { startAddress: 0x100000, code, successorAddresses: [] };
    const compiled = await jit.compile(block);
    compiled.entry!();
    // jmp +0 -> next address of the jmp itself (0x100000+5+2=0x100007)
    expect(runtime.getEip()).toBe(0x100007);
    expect(runtime.readInt32(CTX_BASE + EIP_OFFSET)).toBe(0x100007);
  });
});

describe('JitEngine status contract', () => {
  it('statuses match BlockStatus enum values', async () => {
    const { jit } = makeEngine();
    const trap = await jit.compile({ startAddress: 0x100000, code: hex(0xcd, 0x2e), successorAddresses: [] });
    expect(trap.entry!()).toBe(STATUS_TRAP);
  });
});