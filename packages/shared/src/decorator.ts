/** 参数装饰：将纯同步逻辑包装为可安全 await 的形态。 */

import type { Awaitable } from '@specter-core/contracts';

export async function resolveAwaitable<T>(value: Awaitable<T>): Promise<T> {
  return value instanceof Promise ? value : Promise.resolve(value);
}

/** 将返回值统一为 Promise 风格的接口适配（兼容同步/异步实现） */
export function toPromise<T>(fn: () => Awaitable<T>): Promise<T> {
  try {
    return Promise.resolve(fn());
  } catch (err) {
    return Promise.reject(err);
  }
}