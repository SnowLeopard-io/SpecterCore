import { describe, expect, it, vi } from 'vitest';
import { OpfsOpenedFile } from './opfs';

class FakeWritable {
  readonly options: { keepExistingData?: boolean };
  constructor(options: { keepExistingData?: boolean } = {}) {
    this.options = options;
  }
  write = vi.fn(async () => {});
  close = vi.fn(async () => {});
  abort = vi.fn(async () => {});
}

class FakeHandle {
  createWritable = vi.fn(async (options?: { keepExistingData?: boolean }) => new FakeWritable(options));
  getFile = vi.fn(async () => ({ size: 0 }));
}

function makeFile(): { file: OpfsOpenedFile; handle: FakeHandle } {
  const handle = new FakeHandle();
  const file = new OpfsOpenedFile('/test.txt', 'write', handle as unknown as FileSystemFileHandle, null as never);
  return { file, handle };
}

describe('OpfsOpenedFile', () => {
  it('truncate keeps existing data (createWritable with keepExistingData: true)', async () => {
    const { file, handle } = makeFile();
    await file.truncate(16);
    expect(handle.createWritable).toHaveBeenCalledWith({ keepExistingData: true });
  });

  it('write keeps existing data and writes at the given offset', async () => {
    const { file, handle } = makeFile();
    await file.write(0, new TextEncoder().encode('hello'));
    expect(handle.createWritable).toHaveBeenCalledWith({ keepExistingData: true });
    const writable = (await handle.createWritable.mock.results[0]!.value) as FakeWritable;
    expect(writable.write).toHaveBeenCalledWith({
      type: 'write',
      position: 0,
      data: expect.any(Uint8Array),
    });
  });
});
