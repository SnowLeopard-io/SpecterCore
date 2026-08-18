import type { AudioBridge, WaveBufferHeader } from '@bk/contracts';
import { WinError as E } from '@bk/contracts';

const NOT_IMPLEMENTED = E.ERROR_NOT_IMPLEMENTED;

/**
 * Audio bridge placeholder. Real waveOut/DirectSound mixing lands at P4
 * (AudioWorklet in @bk/host).
 */
export class NullAudioBridge implements AudioBridge {
  private masterVolume = 1;

  async waveOutOpen(): Promise<number> {
    return 0;
  }

  async waveOutWrite(_device: number, _header: WaveBufferHeader): Promise<number> {
    return NOT_IMPLEMENTED;
  }

  async waveOutClose(_device: number): Promise<number> {
    return E.NO_ERROR;
  }

  async waveOutGetVolume(_device: number): Promise<number> {
    return Math.round(this.masterVolume * 0xffff);
  }

  async waveOutSetVolume(_device: number, volume: number): Promise<number> {
    this.masterVolume = Math.max(0, Math.min(1, volume / 0xffff));
    return E.NO_ERROR;
  }

  async setMasterVolume(volume: number): Promise<void> {
    this.masterVolume = Math.max(0, Math.min(1, volume));
  }
}