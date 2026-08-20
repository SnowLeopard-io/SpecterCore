/**
 * 通用只读探针：对给定 VA 列表做 dump / decode / compile。
 *
 *   node probe-va.mjs <exe> 0x4058c2 0x4058b6 ...
 *
 * 用来定位「JIT 在某个 VA fault」时到底是哪条指令不支持。不改任何核心文件。
 */
import { readFileSync } from 'node:fs';
import { JitEngineImpl, WasmRuntimeImpl, X86Decoder } from '@specter-core/core';

const [exePath, ...vaArgs] = process.argv.slice(2);
if (!exePath || vaArgs.length === 0) {
  console.error('usage: probe-va <exe> <va> [va...]');
  process.exit(1);
}

const exe = readFileSync(exePath);

// --- 解析 PE 段表，得到 VA -> 文件偏移的通用映射 -------------------------
const peOff = exe.readUInt32LE(0x3c);
const numSections = exe.readUInt16LE(peOff + 6);
const optSize = exe.readUInt16LE(peOff + 20);
const imageBase = exe.readUInt32LE(peOff + 24 + 28);
const secTableOff = peOff + 24 + optSize;

interface Section {
  name: string;
  va: number;
  vsize: number;
  raw: number;
  rsize: number;
}
const sections: Section[] = [];
for (let i = 0; i < numSections; i++) {
  const o = secTableOff + i * 40;
  sections.push({
    name: exe.toString('ascii', o, o + 8).replace(/\0+$/, ''),
    va: exe.readUInt32LE(o + 12),
    vsize: exe.readUInt32LE(o + 8),
    raw: exe.readUInt32LE(o + 20),
    rsize: exe.readUInt32LE(o + 16),
  });
}

const findSection = (va: number): Section | undefined => {
  const rva = va - imageBase;
  return sections.find((s) => rva >= s.va && rva < s.va + Math.max(s.vsize, s.rsize));
};

const va2off = (va: number): number | undefined => {
  const s = findSection(va);
  if (!s) return undefined;
  return s.raw + (va - imageBase - s.va);
};

console.log(`imageBase=0x${imageBase.toString(16)} sections=${sections.map((s) => s.name).join(',')}`);

for (const arg of vaArgs) {
  const va = Number.parseInt(arg, 16) || Number.parseInt(arg, 10);
  const off = va2off(va);
  const sec = findSection(va);
  console.log(`\n=== VA 0x${va.toString(16)} [${sec?.name ?? '?'}] off=${off === undefined ? '?' : `0x${off.toString(16)}`} ===`);
  if (off === undefined) {
    console.log('  (VA not backed by a section — runtime-allocated memory?)');
    continue;
  }

  const bytes = new Uint8Array(exe.subarray(off, off + 80));
  console.log('  bytes:', [...bytes.slice(0, 32)].map((b) => b.toString(16).padStart(2, '0')).join(' '));

  const dec = new X86Decoder('x86');
  try {
    const r = dec.decode(bytes, va);
    console.log(`  decode OK: terminated=${r.terminated} end=0x${(r.endAddress >>> 0).toString(16)}`);
    for (const d of r.instructions) {
      const i = d.inst;
      const extra =
        (i.rep ? ' rep' : '') +
        (i.repne ? ' repne' : '') +
        (i.size !== undefined ? ` size=${i.size}` : '') +
        (i.cond ? ` cond=${i.cond}` : '');
      console.log(`    -> ${i.op}${extra}`);
    }
  } catch (e) {
    const err = e as Error & { address?: number };
    const at = err.address !== undefined ? ` @0x${(err.address >>> 0).toString(16)}` : '';
    console.log(`  DECODE ERROR: ${err.message}${at}`);
    // 打印出错处的字节，便于人工识别指令
    if (err.address !== undefined) {
      const eoff = va2off(err.address);
      if (eoff !== undefined) {
        const eb = new Uint8Array(exe.subarray(eoff, eoff + 12));
        console.log(`  at bytes: ${[...eb].map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);
      }
    }
    continue;
  }

  try {
    const rt = new WasmRuntimeImpl();
    rt.ensure(0x600000);
    rt.writeBytes(va, bytes);
    const jit = new JitEngineImpl(rt, 'x86');
    jit.compile(va);
    console.log('  compile OK');
  } catch (e) {
    console.log(`  COMPILE ERROR: ${(e as Error).message}`);
  }
}
