import type {
  CreateProcessOptions,
  IEventBus,
  KernelEvents,
  ProcessHandle,
  ProcessInfo,
  ProcessManager,
  ThreadInfo,
  WaitResult,
  WorkerPool,
} from '@specter-core/contracts';
import { WinError as E } from '@specter-core/contracts';
import { basename, nextId } from '@specter-core/shared';
import type { KernelObjectManager } from '@specter-core/contracts';
import type { MemoryManager } from '@specter-core/contracts';

interface ProcessRecord {
  info: ProcessInfo;
  threads: Set<number>;
}

interface ThreadRecord {
  info: ThreadInfo;
  workerId: number | null;
}

/**
 * Process & thread manager (design doc 4.3).
 * Each Windows process maps to a Web Worker from the host worker pool,
 * providing crash isolation. Round-robin scheduling is a skeleton: real
 * context switching arrives with the JIT (P1).
 */
export class ProcessManagerImpl implements ProcessManager {
  private readonly processes = new Map<number, ProcessRecord>();
  private readonly threads = new Map<number, ThreadRecord>();
  private readonly schedulers = new Map<number, number[]>();

  constructor(
    private readonly objects: KernelObjectManager,
    private readonly memory: MemoryManager,
    private readonly workerPool: WorkerPool | null = null,
    private readonly events?: IEventBus<KernelEvents>,
  ) {}

  async createProcess(imagePath: string, options: CreateProcessOptions = {}): Promise<ProcessHandle> {
    const pid = nextId();
    const info: ProcessInfo = {
      pid,
      name: basename(imagePath) || imagePath,
      state: options.suspended ? 'suspended' : 'running',
      imagePath,
      args: options.args ?? [],
      memoryBytes: options.initialMemoryBytes ?? 0,
      threadCount: 0,
      startTime: Date.now(),
    };
    this.processes.set(pid, { info, threads: new Set() });
    this.schedulers.set(pid, []);
    this.events?.emit('core:process:created', info);
    return { pid };
  }

  async terminateProcess(pid: number, exitCode = 0): Promise<void> {
    const record = this.processes.get(pid);
    if (!record) return;
    record.info.state = 'exited';
    for (const tid of record.threads) {
      this.terminateThread(tid, exitCode);
    }
    this.events?.emit('core:process:exited', { pid, exitCode });
  }

  getProcess(pid: number): ProcessInfo | null {
    return this.processes.get(pid)?.info ?? null;
  }

  listProcesses(): ProcessInfo[] {
    return [...this.processes.values()].map((p) => ({ ...p.info }));
  }

  async createThread(pid: number, entryPoint: number, _arg = 0): Promise<number> {
    const record = this.processes.get(pid);
    if (!record) return 0;
    const tid = nextId();
    const info: ThreadInfo = { tid, pid, state: 'running', stackBytes: 1024 * 1024, entryPoint };
    this.threads.set(tid, { info, workerId: null });
    record.threads.add(tid);
    record.info.threadCount += 1;

    // Spawn a worker to host the thread when the pool is available
    if (this.workerPool?.available) {
      const handle = await this.workerPool.spawn();
      this.threads.get(tid)!.workerId = handle.id;
    }
    this.events?.emit('core:thread:created', info);
    this.schedulers.get(pid)!.push(tid);
    return tid;
  }

  async suspendThread(tid: number): Promise<void> {
    const t = this.threads.get(tid);
    if (t) t.info.state = 'suspended';
  }

  async resumeThread(tid: number): Promise<void> {
    const t = this.threads.get(tid);
    if (t) t.info.state = 'running';
  }

  async terminateThread(tid: number, _exitCode = 0): Promise<void> {
    const t = this.threads.get(tid);
    if (!t) return;
    const record = this.processes.get(t.info.pid);
    record?.threads.delete(tid);
    if (record) record.info.threadCount = Math.max(0, record.info.threadCount - 1);
    t.info.state = 'exited';
    // TODO(P1): terminate the exact worker hosting this thread
    this.threads.delete(tid);
  }

  tick(): void {
    // Simple round-robin: mark the oldest runnable thread of each process as running
    for (const [pid, queue] of this.schedulers) {
      const record = this.processes.get(pid);
      if (!record) continue;
      for (const tid of queue) {
        const t = this.threads.get(tid);
        if (t && t.info.state === 'running') {
          t.info.state = 'running';
          queue.push(queue.shift()!);
          break;
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Synchronization objects (delegated to the kernel object manager)
  // -------------------------------------------------------------------------

  async createMutex(_pid: number, name?: string): Promise<number> {
    const handle = this.objects.createObject('mutex', name, { ownerPid: null, recursion: 0 });
    return handle;
  }

  async createEvent(_pid: number, manualReset: boolean, initialState: boolean, name?: string): Promise<number> {
    return this.objects.createObject('event', name, { manualReset, signaled: initialState });
  }

  async createSemaphore(_pid: number, initialCount: number, maxCount: number, name?: string): Promise<number> {
    return this.objects.createObject('semaphore', name, { count: initialCount, maxCount });
  }

  async waitForSingleObject(handle: number, _timeoutMs = 0): Promise<WaitResult> {
    const obj = this.objects.lookup(handle);
    if (!obj) return 'failed';
    switch (obj.kind) {
      case 'mutex': {
        const data = obj.data as { ownerPid: number | null; recursion: number };
        if (data.ownerPid === null) {
          data.ownerPid = 0;
          data.recursion = 1;
          return 'object';
        }
        return 'timeout';
      }
      case 'event': {
        const data = obj.data as { manualReset: boolean; signaled: boolean };
        if (data.signaled) {
          if (!data.manualReset) data.signaled = false;
          return 'object';
        }
        return 'timeout';
      }
      case 'semaphore': {
        const data = obj.data as { count: number; maxCount: number };
        if (data.count > 0) {
          data.count -= 1;
          return 'object';
        }
        return 'timeout';
      }
      default:
        return 'failed';
    }
  }

  async releaseMutex(handle: number): Promise<number> {
    const obj = this.objects.lookup(handle);
    if (!obj || obj.kind !== 'mutex') return E.ERROR_INVALID_HANDLE;
    const data = obj.data as { ownerPid: number | null; recursion: number };
    if (data.recursion > 0) data.recursion -= 1;
    if (data.recursion === 0) data.ownerPid = null;
    return E.NO_ERROR;
  }

  async setEvent(handle: number): Promise<void> {
    const obj = this.objects.lookup(handle);
    if (obj && obj.kind === 'event') (obj.data as { signaled: boolean }).signaled = true;
  }

  async resetEvent(handle: number): Promise<void> {
    const obj = this.objects.lookup(handle);
    if (obj && obj.kind === 'event') (obj.data as { signaled: boolean }).signaled = false;
  }

  async releaseSemaphore(handle: number, releaseCount: number): Promise<number> {
    const obj = this.objects.lookup(handle);
    if (!obj || obj.kind !== 'semaphore') return E.ERROR_INVALID_HANDLE;
    const data = obj.data as { count: number; maxCount: number };
    data.count = Math.min(data.maxCount, data.count + releaseCount);
    return E.NO_ERROR;
  }

  async closeObject(handle: number): Promise<void> {
    this.objects.release(handle);
  }
}