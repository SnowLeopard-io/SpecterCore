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

/** DirectSound 缓冲描述（DSBUFFERDESC 子集） */
export interface DsBufferDesc {
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  /** true = 主缓冲（对应系统混音输出），false = 辅助缓冲（独立流） */
  primary?: boolean;
}

export interface AudioBridge {
  waveOutOpen(): Promise<number>;
  waveOutWrite(device: number, header: WaveBufferHeader): Promise<WinError>;
  waveOutClose(device: number): Promise<WinError>;
  waveOutGetVolume(device: number): Promise<number>;
  waveOutSetVolume(device: number, volume: number): Promise<WinError>;
  setMasterVolume(volume: number): Promise<void>;
  /** 创建 DirectSound 缓冲，返回缓冲句柄 */
  dsCreateBuffer(desc: DsBufferDesc): Promise<number>;
  /** 向 DirectSound 缓冲写入 PCM 数据 */
  dsWrite(buffer: number, header: WaveBufferHeader): Promise<WinError>;
  /** 播放缓冲（loop=true 循环播放） */
  dsPlay(buffer: number, looping: boolean): Promise<WinError>;
  /** 停止缓冲播放 */
  dsStop(buffer: number): Promise<WinError>;
  /** 设置缓冲音量（0..0xffff） */
  dsSetVolume(buffer: number, volume: number): Promise<WinError>;
  /** 释放缓冲 */
  dsRelease(buffer: number): Promise<WinError>;
}