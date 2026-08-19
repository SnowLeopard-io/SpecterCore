/**
 * AudioWorklet 混音处理器。
 *
 * 设计文档 1.8 / 3.3.x：
 *  - 音频流在独立音频线程（AudioWorklet）中混音和输出；
 *  - 支持多路并发流（waveOut 设备 / DirectSound 辅助缓冲），自动混音；
 *  - 每路流独立音量 + 主音量；
 *  - 端到端延迟 ≤ 100ms（每通道环缓冲容量 8192 帧 ≈ 186ms@44.1k，
 *    实际延迟 = 已缓冲帧数，guest 写入节奏正常时远低于 100ms）。
 *
 * 处理器源码以字符串内嵌，原因是 AudioWorklet 模块不能 import 本地 TS 模块，
 * 需通过 Blob URL 经 `audioWorklet.addModule()` 加载。该源码为自包含实现，
 * 在 Node 测试中用沙箱直接求值验证（见 audio-worklet.test.ts）。
 */

export const AUDIO_WORKLET_NAME = 'specter-core-audio-mixer';

/** 每通道环缓冲容量（帧）。8192 帧 @ 44.1kHz ≈ 186ms，上限容忍突发写入。 */
export const AUDIO_WORKLET_CAPACITY_FRAMES = 8192;

export const AUDIO_WORKLET_SOURCE = `
'use strict';
var CAPACITY = ${AUDIO_WORKLET_CAPACITY_FRAMES};

function createStream(channels) {
  var buf = new Array(channels);
  for (var c = 0; c < channels; c++) buf[c] = new Float32Array(CAPACITY);
  return { channels: channels, buf: buf, w: 0, r: 0, volume: 1 };
}

function writeStream(s, samples) {
  var channels = s.channels;
  if (channels === 0) return;
  var n = samples.length;
  var frames = Math.floor(n / channels);
  if (frames === 0) return;
  var start = s.w;
  for (var i = 0; i < n; i++) {
    var ch = i % channels;
    var frame = Math.floor(i / channels);
    s.buf[ch][(start + frame) % CAPACITY] = samples[i];
  }
  s.w = start + frames;
  var overflow = s.w - s.r - CAPACITY;
  if (overflow > 0) s.r += overflow;
}

function mixStream(s, out, frames, outChannels) {
  var ch = s.channels;
  var avail = s.w - s.r;
  var n = Math.min(frames, avail);
  if (n <= 0) return 0;
  var base = s.r;
  var vol = s.volume;
  for (var f = 0; f < n; f++) {
    for (var oc = 0; oc < outChannels; oc++) {
      var sc = oc < ch ? oc : ch - 1;
      out[oc][f] += s.buf[sc][(base + f) % CAPACITY] * vol;
    }
  }
  s.r = base + n;
  return n;
}

class SpecterCoreMixerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._streams = new Map();
    this._masterVolume = 1;
    this.port.onmessage = (e) => this._onMessage(e.data);
  }
  _onMessage(msg) {
    switch (msg.type) {
      case 'open': {
        var channels = msg.channels | 0;
        if (channels < 1) channels = 2;
        this._streams.set(msg.id | 0, createStream(channels));
        break;
      }
      case 'write': {
        var st = this._streams.get(msg.id | 0);
        if (st) writeStream(st, msg.samples);
        break;
      }
      case 'volume': {
        var s2 = this._streams.get(msg.id | 0);
        if (s2) s2.volume = clamp01(msg.volume);
        break;
      }
      case 'master': {
        this._masterVolume = clamp01(msg.volume);
        break;
      }
      case 'close': {
        this._streams.delete(msg.id | 0);
        break;
      }
    }
  }
  process(_inputs, outputs) {
    var out = outputs[0];
    if (!out || out.length === 0) return true;
    var frames = out[0].length;
    var outChannels = out.length;
    for (var c = 0; c < outChannels; c++) out[c].fill(0);
    var master = this._masterVolume;
    for (var entry of this._streams.values()) {
      mixStream(entry, out, frames, outChannels);
    }
    if (master !== 1) {
      for (var c2 = 0; c2 < outChannels; c2++) {
        var ch2 = out[c2];
        for (var f2 = 0; f2 < frames; f2++) ch2[f2] *= master;
      }
    }
    return true;
  }
}

function clamp01(v) {
  v = Number(v);
  if (Number.isNaN(v)) return 1;
  return Math.max(0, Math.min(1, v));
}

registerProcessor(${JSON.stringify(AUDIO_WORKLET_NAME)}, SpecterCoreMixerProcessor);
`;

/**
 * 生成可供 `audioWorklet.addModule()` 加载的 Blob URL。
 * 调用方应在 addModule 完成后立即 `URL.revokeObjectURL(url)`。
 */
export function createAudioWorkletModuleUrl(): string {
  const blob = new Blob([AUDIO_WORKLET_SOURCE], { type: 'application/javascript' });
  return URL.createObjectURL(blob);
}
