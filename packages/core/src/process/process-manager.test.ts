import { describe, expect, it } from 'vitest';
import { ObjectManagerImpl } from './object-manager';
import { MemoryManagerImpl } from './memory-manager';
import { ProcessManagerImpl } from './process-manager';

function makeManager() {
  const objects = new ObjectManagerImpl();
  const memory = new MemoryManagerImpl();
  const pm = new ProcessManagerImpl(objects, memory, null, undefined);
  return { objects, memory, pm };
}

describe('ProcessManagerImpl', () => {
  it('creates and lists processes', async () => {
    const { pm } = makeManager();
    const { pid } = await pm.createProcess('C:/Windows/notepad.exe', { args: ['x.txt'] });
    const info = pm.getProcess(pid);
    expect(info?.name).toBe('notepad.exe');
    expect(info?.state).toBe('running');
    expect(info?.args).toEqual(['x.txt']);
    expect(pm.listProcesses()).toHaveLength(1);
  });

  it('starts processes suspended when requested', async () => {
    const { pm } = makeManager();
    const { pid } = await pm.createProcess('C:/a.exe', { suspended: true });
    expect(pm.getProcess(pid)?.state).toBe('suspended');
  });

  it('creates threads and tracks counts', async () => {
    const { pm } = makeManager();
    const { pid } = await pm.createProcess('C:/a.exe');
    const tid = await pm.createThread(pid, 0x401000);
    expect(tid).toBeGreaterThan(0);
    expect(pm.getProcess(pid)?.threadCount).toBe(1);
    await pm.suspendThread(tid);
    await pm.resumeThread(tid);
    await pm.terminateThread(tid);
    expect(pm.getProcess(pid)?.threadCount).toBe(0);
  });

  it('terminates processes and emits exit state', async () => {
    const { pm } = makeManager();
    const { pid } = await pm.createProcess('C:/a.exe');
    await pm.terminateProcess(pid, 5);
    expect(pm.getProcess(pid)?.state).toBe('exited');
  });

  it('waitForSingleObject on events', async () => {
    const { pm } = makeManager();
    const auto = await pm.createEvent(0, false, true);
    expect(await pm.waitForSingleObject(auto)).toBe('object');
    expect(await pm.waitForSingleObject(auto)).toBe('timeout'); // auto-reset cleared

    const manual = await pm.createEvent(0, true, false);
    expect(await pm.waitForSingleObject(manual)).toBe('timeout');
    await pm.setEvent(manual);
    expect(await pm.waitForSingleObject(manual)).toBe('object');
    expect(await pm.waitForSingleObject(manual)).toBe('object'); // stays signaled
    await pm.resetEvent(manual);
    expect(await pm.waitForSingleObject(manual)).toBe('timeout');
  });

  it('mutex ownership and release', async () => {
    const { pm } = makeManager();
    const mutex = await pm.createMutex(0, 'Global\\MyMutex');
    expect(await pm.waitForSingleObject(mutex)).toBe('object');
    expect(await pm.waitForSingleObject(mutex)).toBe('timeout');
    expect(await pm.releaseMutex(mutex)).toBe(0); // NO_ERROR
    expect(await pm.waitForSingleObject(mutex)).toBe('object');
  });

  it('semaphore counting and limits', async () => {
    const { pm } = makeManager();
    const sem = await pm.createSemaphore(0, 2, 5);
    expect(await pm.waitForSingleObject(sem)).toBe('object');
    expect(await pm.waitForSingleObject(sem)).toBe('object');
    expect(await pm.waitForSingleObject(sem)).toBe('timeout');
    await pm.releaseSemaphore(sem, 4);
    expect(await pm.waitForSingleObject(sem)).toBe('object');
    // count never exceeds max (5)
    expect(await pm.waitForSingleObject(sem)).toBe('object');
  });

  it('closeObject releases kernel objects', async () => {
    const { pm } = makeManager();
    const evt = await pm.createEvent(0, false, false);
    await pm.closeObject(evt);
    expect(await pm.waitForSingleObject(evt)).toBe('failed');
  });
});