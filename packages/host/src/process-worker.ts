/**
 * 进程 Worker 脚本：每个 Windows 进程的容器。
 * P1 里程碑后，此脚本将承载 x86 指令解释/JIT 与 WASM 线性内存。
 * 目前提供占位协议，验证 Worker 隔离与 RPC 链路。
 */

const ctx = self as unknown as {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown): void;
};

interface WorkerCommand {
  id: number;
  type: string;
  payload?: unknown;
}

ctx.onmessage = (event: MessageEvent) => {
  const command = event.data as WorkerCommand;
  const { id, type } = command;

  try {
    switch (type) {
      case 'ping':
        ctx.postMessage({ id, ok: true, payload: { pong: true } });
        return;
      case 'capabilities':
        ctx.postMessage({
          id,
          ok: true,
          payload: {
            worker: true,
            sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
            memoryBytes:
              (performance as unknown as { memory?: { jsHeapSizeLimit?: number } }).memory?.jsHeapSizeLimit ?? null,
          },
        });
        return;
      case 'exec': {
        // P1 后：加载 PE → JIT → 执行
        ctx.postMessage({
          id,
          ok: false,
          error: 'exec: not implemented until P1 (PE loader + JIT)',
        });
        return;
      }
      default:
        ctx.postMessage({ id, ok: false, error: `unknown command: ${type}` });
    }
  } catch (error) {
    ctx.postMessage({ id, ok: false, error: String(error) });
  }
};