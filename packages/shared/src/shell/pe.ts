/**
 * PE 文件头解析（Windows 可执行文件识别层，UI 无关）。
 *
 * 用于"安装 exe"流程：从真实 .exe 字节中提取机器类型/子系统/入口点等
 * 元数据，生成安装包清单。完整 PE 加载与 x86 执行属于 core/pe + core/jit
 * 里程碑（设计文档 P3），本模块只做头部识别。
 */

export interface PeInfo {
  /** 是否为合法 PE（MZ + PE\0\0 + 可选头 magic 有效）。 */
  isPe: boolean;
  /** COFF Machine 值（0x14C=x86, 0x8664=x64, 0xAA64=ARM64...）。 */
  machine: number;
  /** 人类可读架构名。 */
  arch: string;
  numberOfSections: number;
  timeDateStamp: number;
  /** OptionalHeader Subsystem（2=GUI, 3=Console）。 */
  subsystem: number;
  /** 人类可读子系统名。 */
  subsystemName: string;
  entryPointRva: number;
  /** PE32(0x10B) / PE32+(0x20B)。 */
  magic: number;
}

const MACHINE_NAMES: Readonly<Record<number, string>> = {
  0x014c: 'x86',
  0x8664: 'x64',
  0xaa64: 'arm64',
  0x01c0: 'arm',
  0x01c4: 'armv7',
  0x0200: 'ia64',
};

const SUBSYSTEM_NAMES: Readonly<Record<number, string>> = {
  1: 'Native',
  2: 'Windows GUI',
  3: 'Windows Console',
  9: 'Windows CE GUI',
  10: 'EFI Application',
};

function readU16(data: Uint8Array, offset: number): number {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint16(offset, true);
}

function readU32(data: Uint8Array, offset: number): number {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset, true);
}

/**
 * 解析 PE 头部。数据不是合法 PE 时返回 null（调用方可回退为普通文件）。
 * 只读取头部区域，不触碰节区数据，安全可复用。
 */
export function parsePe(data: Uint8Array): PeInfo | null {
  if (data.byteLength < 0x40) return null;
  if (data[0] !== 0x4d || data[1] !== 0x5a) return null; // "MZ"

  const e_lfanew = readU32(data, 0x3c);
  // PE\0\0 签名 + 20 字节 COFF 头 + 2 字节 optional magic
  if (e_lfanew + 26 > data.byteLength) return null;
  if (data[e_lfanew] !== 0x50 || data[e_lfanew + 1] !== 0x45 || data[e_lfanew + 2] !== 0 || data[e_lfanew + 3] !== 0) {
    return null; // 非 "PE\0\0"
  }

  const coff = e_lfanew + 4;
  const machine = readU16(data, coff);
  const numberOfSections = readU16(data, coff + 2);
  const timeDateStamp = readU32(data, coff + 4);
  const opt = coff + 20;
  const magic = readU16(data, opt);

  const is32 = magic === 0x10b;
  const is64 = magic === 0x20b;
  if (!is32 && !is64) return null;

  // OptionalHeader 内偏移：Subsystem 位于 PE32 的 0x44 / PE32+ 的 0x4C（76）。
  const subsystem = readU16(data, opt + (is64 ? 76 : 68));
  const entryPointRva = readU32(data, opt + 16);

  return {
    isPe: true,
    machine,
    arch: MACHINE_NAMES[machine] ?? `unknown(0x${machine.toString(16)})`,
    numberOfSections,
    timeDateStamp,
    subsystem,
    subsystemName: SUBSYSTEM_NAMES[subsystem] ?? `unknown(${subsystem})`,
    entryPointRva,
    magic,
  };
}

/** 是否看起来像可执行文件（PE32/PE32+，排除 DLL 场景暂不处理）。 */
export function isExecutable(data: Uint8Array): boolean {
  return parsePe(data) !== null;
}
