import { describe, expect, it, vi } from 'vitest';
import { WinError as E } from '@specter-core/contracts';
import type { AudioHostAdapter, AudioStream, WaveFormat } from '@specter-core/contracts';
import { NullAudioBridge, WaveOutAudioBridge, decodeWavePcm } from './audio';

const fmt = (over: Partial<WaveFormat> = {}): WaveFormat => ({
  channels: 2,
  sampleRate: 44100,
  bitsPerSample: 16,
  blockAlign: 4,
  avgBytesPerSec: 176400,
  ...over,
});

// ---- PCM 解码 ----

describe('decodeWavePcm', () => {
  it('decodes 16-bit little-endian stereo', () => {
    const data = new Uint8Array([
      0x00, 0x00, 0x00, 0x00, // L=0, R=0
      0x00, 0x40, 0x00, 0xc0, // L=0x4000, R=0xc000
    ]);
    const out = decodeWavePcm(data, fmt());
    expect(out.length).toBe(4);
    expect(out[0]).toBeCloseTo(0, 6);
    expect(out[1]).toBeCloseTo(0, 6);
    expect(out[2]).toBeCloseTo(0.5, 6);
    expect(out[3]).toBeCloseTo(-0.5, 6);
  });

  it('decodes 8-bit unsigned mono', () => {
    const data = new Uint8Array([128, 160, 96]);
    const out = decodeWavePcm(data, fmt({ channels: 1, bitsPerSample: 8, blockAlign: 1, avgBytesPerSec: 44100 }));
    expect(Array.from(out)).toEqual([0, 0.25, -0.25]);
  });

  it('decodes 24-bit samples', () => {
    // 0x000080 = 128 → 128/8388608 ≈ 0.0000153
    const data = new Uint8Array([0x80, 0x00, 0x00]);
    const out = decodeWavePcm(data, fmt({ channels: 1, bitsPerSample: 24, blockAlign: 3, avgBytesPerSec: 132300 }));
    expect(out[0]).toBeCloseTo(128 / 8388608, 8);
  });

  it('decodes 32-bit samples', () => {
    const data = new Uint8Array([0x00, 0x00, 0x00, 0x40]); // 0x40000000 → 0.5
    const out = decodeWavePcm(data, fmt({ channels: 1, bitsPerSample: 32, blockAlign: 4, avgBytesPerSec: 176400 }));
    expect(out[0]).toBeCloseTo(0.5, 6);
  });

  it('truncates partial frames', () => {
    const data = new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x00]); // 5 字节，1.25 帧
    const out = decodeWavePcm(data, fmt());
    expect(out.length).toBe(2); // 完整 1 帧 = 2 样本
  });
});

// ---- 桥接（无宿主时静默成功） ----

describe('NullAudioBridge', () => {
  it('waveOut 全链路静默成功', async () => {
    const bridge = new NullAudioBridge();
    const device = await bridge.waveOutOpen();
    expect(device).toBeGreaterThan(0);
    await expect(bridge.waveOutWrite(device, { data: new Uint8Array(16), format: fmt() })).resolves.toBe(E.NO_ERROR);
    await expect(bridge.waveOutClose(device)).resolves.toBe(E.NO_ERROR);
  });

  it('waveOutGetVolume reflects set volume', async () => {
    const bridge = new NullAudioBridge();
    const device = await bridge.waveOutOpen();
    await bridge.waveOutSetVolume(device, 0x8000);
    expect(await bridge.waveOutGetVolume(device)).toBe(0x8000);
  });
});

// ---- 桥接（mock 宿主） ----

function makeFakeHost(): { host: AudioHostAdapter; streams: Map<number, { channels: number; volumes: number[]; chunks: Float32Array[] }> } {
  const streams = new Map<number, { channels: number; volumes: number[]; chunks: Float32Array[] }>();
  const host = {
    available: true,
    sampleRate: 44100,
    outputLatencyMs: 20,
    init: vi.fn(async () => {}),
    openStream: vi.fn((channels: number) => {
      const id = streams.size + 1;
      const st = { channels, volumes: [1], chunks: [] as Float32Array[] };
      streams.set(id, st);
      return {
        id,
        channels,
        write: (samples: Float32Array) => st.chunks.push(samples),
        setVolume: (volume: number) => (st.volumes[0] = volume),
        close: () => streams.delete(id),
      } as AudioStream;
    }),
    play: vi.fn(async () => {}),
    setMasterVolume: vi.fn(),
    destroy: vi.fn(async () => {}),
  } as unknown as AudioHostAdapter;
  return { host, streams };
}

describe('WaveOutAudioBridge', () => {
  it('routes waveOut PCM to host stream (3.3.1)', async () => {
    const { host, streams } = makeFakeHost();
    const bridge = new WaveOutAudioBridge(host);
    const device = await bridge.waveOutOpen();
    await bridge.waveOutWrite(device, { data: new Uint8Array([0x00, 0x40, 0x00, 0xc0]), format: fmt() });
    expect(streams.size).toBe(1);
    const stream = [...streams.values()][0]!;
    expect(stream.chunks.length).toBe(1);
    expect(stream.chunks[0]).toEqual(new Float32Array([0.5, -0.5]));
  });

  it('waveOut volume passes through to host stream (3.3.4)', async () => {
    const { host } = makeFakeHost();
    const bridge = new WaveOutAudioBridge(host);
    const device = await bridge.waveOutOpen();
    await bridge.waveOutSetVolume(device, 0x8000);
    expect(await bridge.waveOutGetVolume(device)).toBe(0x8000);
  });

  it('setMasterVolume forwards to host adapter', async () => {
    const { host } = makeFakeHost();
    const bridge = new WaveOutAudioBridge(host);
    await bridge.setMasterVolume(0.5);
    expect(host.setMasterVolume).toHaveBeenCalledWith(0.5);
  });

  it('DirectSound secondary buffer writes PCM (3.3.2)', async () => {
    const { host } = makeFakeHost();
    const bridge = new WaveOutAudioBridge(host);
    const buf = await bridge.dsCreateBuffer({ channels: 2, sampleRate: 44100, bitsPerSample: 16, primary: false });
    const result = await bridge.dsWrite(buf, { data: new Uint8Array([0x00, 0x40, 0x00, 0xc0]), format: fmt() });
    expect(result).toBe(E.NO_ERROR);
    await expect(bridge.dsPlay(buf, false)).resolves.toBe(E.NO_ERROR);
    await expect(bridge.dsSetVolume(buf, 0x4000)).resolves.toBe(E.NO_ERROR);
    await expect(bridge.dsRelease(buf)).resolves.toBe(E.NO_ERROR);
  });

  it('DirectSound primary buffer sets master volume (3.3.2)', async () => {
    const { host } = makeFakeHost();
    const bridge = new WaveOutAudioBridge(host);
    const buf = await bridge.dsCreateBuffer({ channels: 2, sampleRate: 44100, bitsPerSample: 16, primary: true });
    (host.setMasterVolume as ReturnType<typeof vi.fn>).mockClear();
    await bridge.dsSetVolume(buf, 0x8000);
    expect(host.setMasterVolume).toHaveBeenCalledWith(expect.closeTo(0x8000 / 0xffff, 6));
    await expect(bridge.dsRelease(buf)).resolves.toBe(E.NO_ERROR);
  });

  it('invalid handles return ERROR_INVALID_HANDLE', async () => {
    const bridge = new NullAudioBridge();
    await expect(bridge.waveOutWrite(0xdead, { data: new Uint8Array(4), format: fmt() })).resolves.toBe(E.ERROR_INVALID_HANDLE);
    await expect(bridge.waveOutClose(0xdead)).resolves.toBe(E.ERROR_INVALID_HANDLE);
    await expect(bridge.dsWrite(0xdead, { data: new Uint8Array(4), format: fmt() })).resolves.toBe(E.ERROR_INVALID_HANDLE);
  });
});
