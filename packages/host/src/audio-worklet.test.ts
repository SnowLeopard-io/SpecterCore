import { describe, expect, it } from 'vitest';
import { AUDIO_WORKLET_NAME, AUDIO_WORKLET_SOURCE } from './audio-worklet';

interface ProcessorInstance {
  port: { postMessage: (m: unknown) => void };
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}

function instantiateProcessor(): { processor: ProcessorInstance } {
  const registered = new Map<string, new () => ProcessorInstance>();

  const sandbox = {
    // AudioWorklet 全局环境：基类提供 this.port（MessagePort 子集），
    // postMessage → onmessage 回流，模拟真实端口行为
    AudioWorkletProcessor: class {
      port: { onmessage: ((e: { data: unknown }) => void) | null; postMessage: (m: unknown) => void };
      constructor() {
        const port: { onmessage: ((e: { data: unknown }) => void) | null; postMessage: (m: unknown) => void } = {
          onmessage: null,
          postMessage: function (m: unknown) {
            if (port.onmessage) port.onmessage({ data: m });
          },
        };
        this.port = port;
      }
    },
    sampleRate: 44100,
    currentTime: 0,
    registerProcessor: (name: string, ctor: new () => ProcessorInstance) => {
      registered.set(name, ctor);
    },
  };

  // 求值内嵌源码
  const fn = new Function(
    'AudioWorkletProcessor',
    'sampleRate',
    'currentTime',
    'registerProcessor',
    AUDIO_WORKLET_SOURCE,
  );
  fn(
    sandbox.AudioWorkletProcessor,
    sandbox.sampleRate,
    sandbox.currentTime,
    sandbox.registerProcessor,
  );

  expect(registered.has(AUDIO_WORKLET_NAME)).toBe(true);
  const Ctor = registered.get(AUDIO_WORKLET_NAME)!;
  const processor = new Ctor();
  return { processor };
}

function makeOutput(channels: number, frames: number): Float32Array[][] {
  const out: Float32Array[][] = [];
  const channelData: Float32Array[] = [];
  for (let c = 0; c < channels; c++) channelData.push(new Float32Array(frames));
  out.push(channelData);
  return out;
}

/** outputs[0][ch][frame] 安全取值 */
function sampleAt(out: Float32Array[][], ch: number, frame: number): number {
  return out[0]?.[ch]?.[frame] ?? 0;
}

function open(processor: ProcessorInstance, id: number, channels: number): void {
  processor.port.postMessage({ type: 'open', id, channels });
}

function write(processor: ProcessorInstance, id: number, samples: Float32Array): void {
  processor.port.postMessage({ type: 'write', id, samples });
}

function setVolume(processor: ProcessorInstance, id: number, volume: number): void {
  processor.port.postMessage({ type: 'volume', id, volume });
}

function setMaster(processor: ProcessorInstance, volume: number): void {
  processor.port.postMessage({ type: 'master', volume });
}

function closeStream(processor: ProcessorInstance, id: number): void {
  processor.port.postMessage({ type: 'close', id });
}

describe('audio-worklet mixer processor', () => {
  it('registers the processor under the expected name', () => {
    const { processor } = instantiateProcessor();
    expect(processor).toBeTruthy();
  });

  it('mixes a single mono stream into stereo output', () => {
    const { processor } = instantiateProcessor();
    open(processor, 1, 1);
    write(processor, 1, new Float32Array([0.5, -0.5, 0.25, 0.0]));
    const out = makeOutput(2, 4);
    const keepAlive = processor.process([], out);
    expect(keepAlive).toBe(true);
    // mono → 双声道复制
    expect(sampleAt(out, 0, 0)).toBeCloseTo(0.5, 6);
    expect(sampleAt(out, 1, 0)).toBeCloseTo(0.5, 6);
    expect(sampleAt(out, 0, 1)).toBeCloseTo(-0.5, 6);
    expect(sampleAt(out, 1, 1)).toBeCloseTo(-0.5, 6);
    expect(sampleAt(out, 0, 2)).toBeCloseTo(0.25, 6);
    expect(sampleAt(out, 0, 3)).toBeCloseTo(0.0, 6);
  });

  it('mixes two streams together (自动混音)', () => {
    const { processor } = instantiateProcessor();
    open(processor, 1, 2);
    open(processor, 2, 2);
    write(processor, 1, new Float32Array([0.2, 0.2, 0.2, 0.2]));
    write(processor, 2, new Float32Array([0.3, 0.3]));
    const out = makeOutput(2, 2);
    processor.process([], out);
    expect(sampleAt(out, 0, 0)).toBeCloseTo(0.5, 6);
    expect(sampleAt(out, 1, 0)).toBeCloseTo(0.5, 6);
    // 流 2 只有 1 帧，第二帧仅流 1
    expect(sampleAt(out, 0, 1)).toBeCloseTo(0.2, 6);
    expect(sampleAt(out, 1, 1)).toBeCloseTo(0.2, 6);
  });

  it('applies per-stream volume (3.3.4)', () => {
    const { processor } = instantiateProcessor();
    open(processor, 1, 1);
    write(processor, 1, new Float32Array([0.5]));
    setVolume(processor, 1, 0.4);
    const out = makeOutput(1, 1);
    processor.process([], out);
    expect(sampleAt(out, 0, 0)).toBeCloseTo(0.2, 6);
  });

  it('applies master volume on top of stream volume (3.3.4)', () => {
    const { processor } = instantiateProcessor();
    open(processor, 1, 1);
    write(processor, 1, new Float32Array([0.5]));
    setVolume(processor, 1, 0.5);
    setMaster(processor, 0.5);
    const out = makeOutput(1, 1);
    processor.process([], out);
    expect(sampleAt(out, 0, 0)).toBeCloseTo(0.125, 6);
  });

  it('removes a stream on close', () => {
    const { processor } = instantiateProcessor();
    open(processor, 1, 1);
    write(processor, 1, new Float32Array([0.5]));
    closeStream(processor, 1);
    const out = makeOutput(1, 1);
    processor.process([], out);
    expect(sampleAt(out, 0, 0)).toBeCloseTo(0.0, 6);
  });

  it('outputs silence before any data arrives', () => {
    const { processor } = instantiateProcessor();
    open(processor, 1, 1);
    const out = makeOutput(2, 8);
    processor.process([], out);
    for (const ch of out[0] ?? []) for (const s of ch) expect(s).toBeCloseTo(0.0, 6);
  });
  it('clamps volume to [0,1]', () => {
    const { processor } = instantiateProcessor();
    open(processor, 1, 1);
    write(processor, 1, new Float32Array([0.5]));
    setVolume(processor, 1, 3.0);
    const out = makeOutput(1, 1);
    processor.process([], out);
    expect(sampleAt(out, 0, 0)).toBeCloseTo(0.5, 6);
  });

  it('does not overflow the ring buffer (capacity bound)', () => {
    const { processor } = instantiateProcessor();
    open(processor, 1, 1);
    // 写入远超容量：环缓冲丢弃最旧数据，不抛错
    const big = new Float32Array(8192 * 2 + 512);
    big.fill(0.5);
    write(processor, 1, big);
    const out = makeOutput(1, 64);
    processor.process([], out);
    for (const s of out[0]?.[0] ?? []) expect(s).toBeCloseTo(0.5, 6);
  });
});
