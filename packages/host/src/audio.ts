import type { AudioHostAdapter, AudioHostConfig, AudioPcm, AudioStream } from '@specter-core/contracts';
import { AUDIO_WORKLET_NAME, AUDIO_WORKLET_SOURCE, createAudioWorkletModuleUrl } from './audio-worklet';

/**
 * 音频宿主适配器：通过 AudioWorklet 混音输出。
 *
 * 设计文档 1.8 / 3.3.2：多路音频流在独立音频线程中混音并输出。
 * 每路流（waveOut 设备 / DirectSound 辅助缓冲）在 worklet 中拥有独立
 * 环缓冲与音量；主音量统一作用于混音输出。`play()` 作为一次性播放的
 * 兼容入口，实现为"临时流 + 定时关闭"。
 */
export class WebAudioHostAdapter implements AudioHostAdapter {
  readonly available = typeof AudioContext !== 'undefined' || typeof webkitAudioContext !== 'undefined';

  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private nextStreamId = 1;
  private masterVolume = 1;
  private outputChannels = 2;

  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 44100;
  }

  get outputLatencyMs(): number {
    if (!this.ctx) return 0;
    const base = this.ctx.baseLatency ? this.ctx.baseLatency * 1000 : 0;
    // 混音器环缓冲延迟（按默认容量的一半估算稳态缓冲）
    const ringMs = (8192 / 2 / this.sampleRate) * 1000;
    return base + ringMs;
  }

  async init(config: AudioHostConfig = {}): Promise<void> {
    if (!this.available) throw new Error('Web Audio is not available');
    const Ctor = (typeof AudioContext !== 'undefined' ? AudioContext : webkitAudioContext) as typeof AudioContext;
    this.ctx = new Ctor({
      sampleRate: config.sampleRate,
      latencyHint: config.latencyHint ?? 'interactive',
    });
    this.outputChannels = config.channels ?? 2;
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    await this.installWorklet();
  }

  private async installWorklet(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) throw new Error('Audio host not initialized');
    const url = createAudioWorkletModuleUrl();
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    const node = new AudioWorkletNode(ctx, AUDIO_WORKLET_NAME, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [this.outputChannels],
    });
    node.connect(ctx.destination);
    this.node = node;
    this.post({ type: 'master', volume: this.masterVolume });
  }

  private post(message: Record<string, unknown>): void {
    this.node?.port.postMessage(message);
  }

  openStream(channels: number): AudioStream {
    const node = this.node;
    if (!node) throw new Error('Audio host not initialized');
    const id = this.nextStreamId++;
    const safeChannels = channels === 1 ? 1 : 2;
    this.post({ type: 'open', id, channels: safeChannels });
    return new WorkletAudioStream(node, id, safeChannels);
  }

  async play(buffer: AudioPcm): Promise<void> {
    const channels = buffer.channels === 1 ? 1 : 2;
    const stream = this.openStream(channels);
    // 转换为 Float32 交错样本（AudioPcm.data 已是 Float32Array）
    const samples = new Float32Array(buffer.data);
    stream.write(samples);
    const durationMs = (samples.length / channels / buffer.sampleRate) * 1000;
    setTimeout(() => stream.close(), Math.max(50, durationMs + 100));
  }

  setMasterVolume(volume: number): void {
    this.masterVolume = Math.max(0, Math.min(1, volume));
    this.post({ type: 'master', volume: this.masterVolume });
  }

  async destroy(): Promise<void> {
    this.node?.disconnect();
    this.node = null;
    await this.ctx?.close();
    this.ctx = null;
  }
}

class WorkletAudioStream implements AudioStream {
  constructor(
    private readonly node: AudioWorkletNode,
    readonly id: number,
    readonly channels: number,
  ) {}

  write(samples: Float32Array): void {
    // 结构化克隆（不转移）：调用方仍可复用 samples 缓冲
    this.node.port.postMessage({ type: 'write', id: this.id, samples });
  }

  setVolume(volume: number): void {
    this.node.port.postMessage({ type: 'volume', id: this.id, volume: Math.max(0, Math.min(1, volume)) });
  }

  close(): void {
    this.node.port.postMessage({ type: 'close', id: this.id });
  }
}

declare global {
  var webkitAudioContext: typeof AudioContext | undefined;
}

export { AUDIO_WORKLET_SOURCE };
