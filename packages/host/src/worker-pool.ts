import type { Dispose, WorkerHandle, WorkerMessage, WorkerPool, WorkerPoolOptions, WorkerReply } from '@specter-core/contracts';
import { createDeferred, nextId } from '@specter-core/shared';

/**
 * Worker 池：每个 Windows 进程映射到一个 Web Worker（进程隔离）。
 * 采用请求/回复协议（消息含 id）支持异步 RPC；跨 Worker 共享内存由 SharedArrayBuffer 承担（未来）。
 */
export class WebWorkerPool implements WorkerPool {
  readonly available: boolean;
  readonly maxWorkers: number;
  private readonly workers = new Map<number, WorkerEntry>();
  private readonly opts: Required<Pick<WorkerPoolOptions, 'maxWorkers'>> &
    Pick<WorkerPoolOptions, 'workerUrl'>;

  constructor(options: WorkerPoolOptions = {}) {
    this.opts = {
      maxWorkers: options.maxWorkers ?? 32,
      ...(options.workerUrl ? { workerUrl: options.workerUrl } : {}),
    };
    this.available = typeof Worker !== 'undefined';
    this.maxWorkers = this.opts.maxWorkers;
  }

  get activeWorkers(): number {
    return this.workers.size;
  }

  async spawn(): Promise<WorkerHandle> {
    if (!this.available) throw new Error('Web Workers are not available');
    if (this.workers.size >= this.maxWorkers) throw new Error('Worker pool exhausted');

    const workerUrl =
      this.opts.workerUrl ?? new URL('./process-worker.ts', import.meta.url);
    const worker = new Worker(workerUrl, { type: 'module' });
    const id = nextId();
    const entry: WorkerEntry = {
      worker,
      pending: new Map(),
      listeners: new Set(),
    };
    worker.onmessage = (event: MessageEvent) => {
      const message = event.data as WorkerMessage;
      if (message.id !== undefined && entry.pending.has(message.id)) {
        const deferred = entry.pending.get(message.id)!;
        entry.pending.delete(message.id);
        deferred.resolve(message as unknown as WorkerReply);
        return;
      }
      for (const listener of entry.listeners) listener(message);
    };
    worker.onerror = (event) => {
      const errorMessage = event.message ?? 'Unknown worker error';
      for (const deferred of entry.pending.values()) {
        deferred.reject(new Error(errorMessage));
      }
      entry.pending.clear();
    };
    this.workers.set(id, entry);

    return {
      id,
      state: 'idle',
      post: (message) => this.post(entry, message),
      onMessage: (listener) => this.subscribe(entry, listener),
      terminate: async () => {
        await this.terminate(id);
      },
    };
  }

  private post(entry: WorkerEntry, message: WorkerMessage): Promise<WorkerReply> {
    const id = message.id ?? nextId();
    const deferred = createDeferred<WorkerReply>();
    entry.pending.set(id, deferred);
    entry.worker.postMessage({ ...message, id });
    return deferred.promise;
  }

  private subscribe(entry: WorkerEntry, listener: (message: WorkerMessage) => void): Dispose {
    entry.listeners.add(listener);
    return () => {
      entry.listeners.delete(listener);
    };
  }

  private async terminate(id: number): Promise<void> {
    const entry = this.workers.get(id);
    if (!entry) return;
    entry.worker.terminate();
    for (const deferred of entry.pending.values()) deferred.reject(new Error('Worker terminated'));
    entry.pending.clear();
    this.workers.delete(id);
  }

  async terminateAll(): Promise<void> {
    const ids = [...this.workers.keys()];
    await Promise.all(ids.map((id) => this.terminate(id)));
  }
}

interface WorkerEntry {
  worker: Worker;
  pending: Map<number, { resolve: (reply: WorkerReply) => void; reject: (reason?: unknown) => void }>;
  listeners: Set<(message: WorkerMessage) => void>;
}