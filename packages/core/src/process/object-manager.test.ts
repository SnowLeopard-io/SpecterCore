import { describe, expect, it } from 'vitest';
import { ObjectManagerImpl } from './object-manager';

describe('ObjectManagerImpl', () => {
  it('creates objects and assigns unique handles', () => {
    const m = new ObjectManagerImpl();
    const a = m.createObject('mutex', undefined, { ownerPid: null, recursion: 0 });
    const b = m.createObject('event', undefined, { manualReset: true, signaled: false });
    expect(a).not.toBe(b);
    expect(m.lookup(a)).toBeTruthy();
    expect(m.lookup(b)).toBeTruthy();
  });

  it('reference counting destroys on release-to-zero', () => {
    const m = new ObjectManagerImpl();
    const h = m.createObject('mutex', undefined, { ownerPid: null, recursion: 0 });
    m.retain(h);
    expect(m.lookup(h)!.refCount).toBe(2);
    m.release(h);
    expect(m.lookup(h)).toBeTruthy();
    m.release(h);
    expect(m.lookup(h)).toBeNull();
  });

  it('duplicate shares the same object', () => {
    const m = new ObjectManagerImpl();
    const h = m.createObject('event', undefined, { manualReset: false, signaled: true });
    const dup = m.duplicate(h, 0);
    expect(m.lookup(dup)).toBe(m.lookup(h));
    m.release(dup);
    expect(m.lookup(h)).toBeTruthy();
  });

  it('named objects are resolvable and removed with the object', () => {
    const m = new ObjectManagerImpl();
    const h = m.createObject('mutex', 'Global\\MyMutex', { ownerPid: null, recursion: 0 });
    expect(m.getNamed('Global\\MyMutex')).toBe(m.lookup(h));
    m.delete(h);
    expect(m.getNamed('Global\\MyMutex')).toBeNull();
  });

  it('putNamed registers in the namespace', () => {
    const m = new ObjectManagerImpl();
    const h = m.createObject('semaphore', undefined, { count: 1, maxCount: 5 });
    const obj = m.lookup(h)!;
    obj.name = 'Global\\Sem';
    m.putNamed(obj);
    expect(m.getNamed('Global\\Sem')).toBe(obj);
  });

  it('list returns all live objects', () => {
    const m = new ObjectManagerImpl();
    m.createObject('mutex', undefined, { ownerPid: null, recursion: 0 });
    m.createObject('event', undefined, { manualReset: true, signaled: false });
    expect(m.list()).toHaveLength(2);
  });
});