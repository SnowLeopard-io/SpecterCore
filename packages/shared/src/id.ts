/** 全局单调递增 ID 生成器（句柄、进程、线程等）。 */

let counter = 0x1000;

export function nextId(): number {
  counter += 1;
  return counter;
}

export function nextStringId(prefix = ''): string {
  return `${prefix}${Date.now().toString(36)}-${nextId().toString(36)}`;
}

export function resetIdCounter(value = 0x1000): void {
  counter = value;
}