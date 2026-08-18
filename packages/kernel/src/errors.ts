import type { KernelEvents } from '@bk/contracts';
import { createToken } from '@bk/contracts';

export const CONTAINER_TOKEN = createToken<unknown>('kernel.container');
export const EVENT_BUS_TOKEN = createToken<unknown>('kernel.events');

export class KernelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KernelError';
  }
}

/** 解析 KernelEvents 的 void 类型为 undefined，便于 emit 无载荷事件 */
export type EmitPayload<K extends keyof KernelEvents> = KernelEvents[K] extends void ? undefined : KernelEvents[K];