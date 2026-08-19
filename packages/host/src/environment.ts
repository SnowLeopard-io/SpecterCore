import type { BrowserCapabilities, EnvironmentProbe } from '@specter-core/contracts';

/**
 * 浏览器环境能力探测。
 * 设计文档要求：HTTPS/localhost 安全上下文、跨域隔离头（SharedArrayBuffer）、OPFS、WebGPU、WebUSB。
 */

export class EnvironmentProbeError extends Error {
  constructor(public readonly missing: readonly string[]) {
    super(`Missing required browser capabilities: ${missing.join(', ')}`);
    this.name = 'EnvironmentProbeError';
  }
}

export function probeCapabilities(globalObj: unknown = globalThis): BrowserCapabilities {
  const g = globalObj as {
    navigator?: {
      gpu?: unknown;
      usb?: unknown;
      storage?: { getDirectory?: unknown };
    };
    crossOriginIsolated?: boolean;
    SharedArrayBuffer?: unknown;
    AudioContext?: unknown;
    Worker?: unknown;
    isSecureContext?: boolean;
    self?: unknown;
  };
  const workerContext = typeof (globalObj as { importScripts?: unknown }).importScripts === 'function';

  return {
    secureContext: Boolean(g.isSecureContext ?? true),
    crossOriginIsolated: Boolean(g.crossOriginIsolated),
    opfs: Boolean(g.navigator?.storage?.getDirectory),
    webgpu: Boolean(g.navigator?.gpu),
    webusb: Boolean(g.navigator?.usb),
    audioWorklet: Boolean(g.AudioContext) && !workerContext,
    webWorker: Boolean(g.Worker) || workerContext,
    sharedArrayBuffer: Boolean(g.SharedArrayBuffer),
  };
}

export function createProbe(): EnvironmentProbe {
  const capabilities = probeCapabilities();
  const missing: string[] = [];
  if (!capabilities.secureContext) missing.push('HTTPS/localhost (secure context)');
  if (!capabilities.opfs) missing.push('OPFS (File System Access API)');
  if (!capabilities.webWorker) missing.push('Web Workers');
  if (!capabilities.crossOriginIsolated) missing.push('cross-origin isolation (COOP/COEP headers)');

  return {
    capabilities,
    missing,
    assertSatisfied() {
      if (missing.length > 0) throw new EnvironmentProbeError(missing);
    },
  };
}