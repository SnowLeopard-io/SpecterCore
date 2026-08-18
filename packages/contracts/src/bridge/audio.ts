/**
 * L2 音频桥接契约：waveOut / DirectSound → AudioWorklet。
 */

import type { WinError } from './fs';

export interface WaveFormat {
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  blockAlign: number;
  avgBytesPerSec: number;
}

export interface WaveBufferHeader {
  /** PCM 数据 */
  data: Uint8Array;
  format: WaveFormat;
}

export interface AudioBridge {
  waveOutOpen(): Promise<number>;
  waveOutWrite(device: number, header: WaveBufferHeader): Promise<WinError>;
  waveOutClose(device: number): Promise<WinError>;
  waveOutGetVolume(device: number): Promise<number>;
  waveOutSetVolume(device: number, volume: number): Promise<WinError>;
  setMasterVolume(volume: number): Promise<void>;
}