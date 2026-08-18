/** Promise 工具。 */

export interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
  settled: boolean;
}

export function createDeferred<T = void>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  let settled = false;
  const promise = new Promise<T>((res, rej) => {
    resolve = (v) => {
      settled = true;
      res(v);
    };
    reject = (e) => {
      settled = true;
      rej(e);
    };
  });
  return { promise, resolve, reject, settled };
}

export function timeout<T>(ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(fallback), ms);
  });
}

export async function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => void): Promise<T | null> {
  const result = await Promise.race([promise, timeout(ms, null as T | null)]);
  if (result === null) onTimeout();
  return result;
}