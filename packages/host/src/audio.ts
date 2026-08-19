import type { AudioHostAdapter, AudioHostConfig, AudioPcm } from '@specter-core/contracts';

/**
 * 音频宿主适配器：通过 Web Audio 输出 PCM。
 * 低延迟混音（AudioWorklet）在 P4 里程碑接入；当前使用 AudioBufferSourceNode 占位。
 */
export class WebAudioHostAdapter implements AudioHostAdapter {
  readonly available = typeof AudioContext !== 'undefined' || typeof webkitAudioContext !== 'undefined';

  private ctx: AudioContext | null = null;
  private volume = 1;

  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 44100;
  }

  get outputLatencyMs(): number {
    return this.ctx?.baseLatency ? this.ctx.baseLatency * 1000 : 0;
  }

  async init(config: AudioHostConfig = {}): Promise<void> {
    if (!this.available) throw new Error('Web Audio is not available');
    const Ctor = (typeof AudioContext !== 'undefined' ? AudioContext : webkitAudioContext) as typeof AudioContext;
    this.ctx = new Ctor({
      sampleRate: config.sampleRate,
      latencyHint: config.latencyHint ?? 'interactive',
    });
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  async play(buffer: AudioPcm): Promise<void> {
    if (!this.ctx) throw new Error('Audio host not initialized');
    const frameCount = Math.floor(buffer.data.length / buffer.channels);
    const audioBuffer = this.ctx.createBuffer(buffer.channels, frameCount, buffer.sampleRate);
    for (let ch = 0; ch < buffer.channels; ch++) {
      const channel = audioBuffer.getChannelData(ch);
      for (let i = 0; i < frameCount; i++) {
        channel[i] = buffer.data[i * buffer.channels + ch] ?? 0;
      }
    }
    const source = this.ctx.createBufferSource();
    source.buffer = audioBuffer;
    const gain = this.ctx.createGain();
    gain.gain.value = this.volume;
    source.connect(gain).connect(this.ctx.destination);
    source.start();
  }

  setVolume(channel: string | null, volume: number): void {
    void channel;
    this.volume = Math.max(0, Math.min(1, volume));
  }

  async destroy(): Promise<void> {
    await this.ctx?.close();
    this.ctx = null;
  }
}

declare global {
  var webkitAudioContext: typeof AudioContext | undefined;
}