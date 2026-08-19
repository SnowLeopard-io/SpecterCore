import type { AudioBridge, AudioHostAdapter, AudioStream, DsBufferDesc, WaveBufferHeader, WaveFormat } from '@specter-core/contracts';
import { WinError as E } from '@specter-core/contracts';

/**
 * waveOut / DirectSound 桥接实现。
 *
 * 设计文档 3.3.1–3.3.4：
 *  - waveOutOpen/Write 把 PCM 写入宿主混音流（AudioWorklet），采样率 ≥ 44100Hz；
 *  - DirectSound 主缓冲（primary）映射到主音量，辅助缓冲（secondary）映射到独立流；
 *  - 多路音频流自动混音（宿主侧）；
 *  - 支持主音量与每路流独立音量。
 *
 * 不依赖 L3：本桥接层只对接 AudioHostAdapter（L1 契约），在无音频宿主
 * （Node / 测试 / 无 AudioContext）时退化为静默成功，不抛错。
 */
export class WaveOutAudioBridge implements AudioBridge {
  private readonly host: AudioHostAdapter | null;
  /** waveOut 设备表：deviceId → { stream, volume } */
  private readonly waveDevices = new Map<number, { stream: AudioStream | null; volume: number }>();
  /** DirectSound 缓冲表：bufferId → { stream | null(primary), desc, volume } */
  private readonly dsBuffers = new Map<number, { stream: AudioStream | null; desc: DsBufferDesc; volume: number }>();
  private waveSeq = 0x100;
  private dsSeq = 0x1000;
  private masterVolume = 1;
  private hostReady = false;

  constructor(host: AudioHostAdapter | null = null) {
    this.host = host;
  }

  private async ensureHost(): Promise<void> {
    if (this.hostReady || !this.host) return;
    if (!this.host.available) return;
    await this.host.init({ latencyHint: 'interactive', sampleRate: 44100 });
    this.host.setMasterVolume(this.masterVolume);
    this.hostReady = true;
  }

  private openStream(channels: number): AudioStream | null {
    if (!this.host || !this.hostReady || !this.host.available) return null;
    try {
      return this.host.openStream(channels);
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // waveOut
  // -------------------------------------------------------------------------

  async waveOutOpen(): Promise<number> {
    await this.ensureHost();
    const id = this.waveSeq++;
    this.waveDevices.set(id, { stream: this.openStream(2), volume: 1 });
    return id;
  }

  async waveOutWrite(device: number, header: WaveBufferHeader): Promise<E> {
    const rec = this.waveDevices.get(device);
    if (!rec) return E.ERROR_INVALID_HANDLE;
    if (!rec.stream) return E.NO_ERROR;
    try {
      rec.stream.write(decodeWavePcm(header.data, header.format));
      return E.NO_ERROR;
    } catch {
      return E.ERROR_NOT_ENOUGH_MEMORY;
    }
  }

  async waveOutClose(device: number): Promise<E> {
    const rec = this.waveDevices.get(device);
    if (!rec) return E.ERROR_INVALID_HANDLE;
    rec.stream?.close();
    this.waveDevices.delete(device);
    return E.NO_ERROR;
  }

  async waveOutGetVolume(device: number): Promise<number> {
    const rec = this.waveDevices.get(device);
    if (!rec) return 0;
    return Math.round(rec.volume * 0xffff);
  }

  async waveOutSetVolume(device: number, volume: number): Promise<E> {
    const rec = this.waveDevices.get(device);
    if (!rec) return E.ERROR_INVALID_HANDLE;
    rec.volume = Math.max(0, Math.min(1, volume / 0xffff));
    rec.stream?.setVolume(rec.volume);
    return E.NO_ERROR;
  }

  async setMasterVolume(volume: number): Promise<void> {
    this.masterVolume = Math.max(0, Math.min(1, volume));
    await this.host?.setMasterVolume(this.masterVolume);
  }

  // -------------------------------------------------------------------------
  // DirectSound
  // -------------------------------------------------------------------------

  async dsCreateBuffer(desc: DsBufferDesc): Promise<number> {
    await this.ensureHost();
    const channels = desc.channels === 1 ? 1 : 2;
    const id = this.dsSeq++;
    const stream = desc.primary ? null : this.openStream(channels);
    this.dsBuffers.set(id, { stream, desc, volume: 1 });
    return id;
  }

  async dsWrite(buffer: number, header: WaveBufferHeader): Promise<E> {
    const rec = this.dsBuffers.get(buffer);
    if (!rec) return E.ERROR_INVALID_HANDLE;
    if (rec.desc.primary || !rec.stream) return E.NO_ERROR;
    try {
      rec.stream.write(decodeWavePcm(header.data, header.format));
      return E.NO_ERROR;
    } catch {
      return E.ERROR_NOT_ENOUGH_MEMORY;
    }
  }

  async dsPlay(buffer: number, _looping: boolean): Promise<E> {
    if (!this.dsBuffers.has(buffer)) return E.ERROR_INVALID_HANDLE;
    return E.NO_ERROR;
  }

  async dsStop(buffer: number): Promise<E> {
    if (!this.dsBuffers.has(buffer)) return E.ERROR_INVALID_HANDLE;
    return E.NO_ERROR;
  }

  async dsSetVolume(buffer: number, volume: number): Promise<E> {
    const rec = this.dsBuffers.get(buffer);
    if (!rec) return E.ERROR_INVALID_HANDLE;
    if (rec.desc.primary) {
      this.masterVolume = Math.max(0, Math.min(1, volume / 0xffff));
      await this.host?.setMasterVolume(this.masterVolume);
    } else {
      rec.volume = Math.max(0, Math.min(1, volume / 0xffff));
      rec.stream?.setVolume(rec.volume);
    }
    return E.NO_ERROR;
  }

  async dsRelease(buffer: number): Promise<E> {
    const rec = this.dsBuffers.get(buffer);
    if (!rec) return E.ERROR_INVALID_HANDLE;
    rec.stream?.close();
    this.dsBuffers.delete(buffer);
    return E.NO_ERROR;
  }
}

/**
 * 把 winmm waveOut/DirectSound 的 PCM 原始字节解码为交错 Float32 样本。
 * 支持 8/16/24/32 位，单/双声道；采样率以 header.format.sampleRate 为准
 * （宿主默认 44100Hz，≥ 设计文档 3.3.1 要求）。
 */
export function decodeWavePcm(data: Uint8Array, format: WaveFormat): Float32Array {
  const { channels, bitsPerSample } = format;
  const bytesPerSample = bitsPerSample / 8;
  const bytesPerFrame = channels * bytesPerSample;
  const frames = Math.floor(data.length / bytesPerFrame);
  const out = new Float32Array(frames * channels);
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channels; c++) {
      const off = f * bytesPerFrame + c * bytesPerSample;
      out[f * channels + c] = sampleToFloat(data, off, bitsPerSample);
    }
  }
  return out;
}

function sampleToFloat(data: Uint8Array, offset: number, bitsPerSample: number): number {
  switch (bitsPerSample) {
    case 8:
      // 8 位 PCM 为无符号，中心 0x80
      return ((data[offset] ?? 0) - 128) / 128;
    case 16: {
      const lo = data[offset] ?? 0;
      const hi = data[offset + 1] ?? 0;
      const v = (hi << 8) | lo;
      return ((v << 16) >> 16) / 32768;
    }
    case 24: {
      const b0 = data[offset] ?? 0;
      const b1 = data[offset + 1] ?? 0;
      const b2 = data[offset + 2] ?? 0;
      let v = (b2 << 16) | (b1 << 8) | b0;
      if (v & 0x800000) v |= 0xff000000;
      return v / 8388608;
    }
    case 32: {
      const b0 = data[offset] ?? 0;
      const b1 = data[offset + 1] ?? 0;
      const b2 = data[offset + 2] ?? 0;
      const b3 = data[offset + 3] ?? 0;
      const v = (b3 << 24) | (b2 << 16) | (b1 << 8) | b0;
      return v / 2147483648;
    }
    default:
      return 0;
  }
}

/**
 * 无音频宿主时的占位桥接：所有调用静默成功（与旧行为一致），
 * 供 Node / 无 AudioContext 环境使用。
 */
export class NullAudioBridge extends WaveOutAudioBridge {
  constructor() {
    super(null);
  }
}
