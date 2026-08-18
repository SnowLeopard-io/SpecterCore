import type { KernelObject, KernelObjectManager, SyncObjectKind } from '@bk/contracts';
import { nextId } from '@bk/shared';

/**
 * Kernel object manager (design doc 4.4).
 * Reference-counted handle table for mutexes, events, semaphores and other
 * kernel objects, with a system-wide named-object namespace.
 */
export class ObjectManagerImpl implements KernelObjectManager {
  private readonly objects = new Map<number, KernelObject>();
  private readonly named = new Map<string, KernelObject>();

  createObject<T>(kind: SyncObjectKind, name: string | undefined, data: T): number {
    const handle = nextId();
    const obj: KernelObject<T> = { handle, kind, name, refCount: 1, data };
    this.objects.set(handle, obj as KernelObject);
    if (name !== undefined) this.putNamed(obj as KernelObject);
    return handle;
  }

  lookup(handle: number): KernelObject<unknown> | null {
    return this.objects.get(handle) ?? null;
  }

  retain(handle: number): boolean {
    const obj = this.objects.get(handle);
    if (!obj) return false;
    obj.refCount += 1;
    return true;
  }

  release(handle: number): boolean {
    const obj = this.objects.get(handle);
    if (!obj) return false;
    obj.refCount -= 1;
    if (obj.refCount <= 0) {
      this.delete(handle);
    }
    return true;
  }

  duplicate(handle: number, _targetProcessPid: number): number {
    const obj = this.objects.get(handle);
    if (!obj) return 0;
    this.retain(handle);
    const dupHandle = nextId();
    this.objects.set(dupHandle, obj);
    return dupHandle;
  }

  delete(handle: number): boolean {
    const obj = this.objects.get(handle);
    if (!obj) return false;
    this.objects.delete(handle);
    if (obj.name !== undefined && this.named.get(obj.name) === obj) {
      this.named.delete(obj.name);
    }
    return true;
  }

  getNamed(name: string): KernelObject<unknown> | null {
    return this.named.get(name) ?? null;
  }

  putNamed(obj: KernelObject<unknown>): void {
    if (obj.name !== undefined) this.named.set(obj.name, obj);
  }

  list(): KernelObject<unknown>[] {
    return [...this.objects.values()];
  }

  clear(): void {
    this.objects.clear();
    this.named.clear();
  }
}