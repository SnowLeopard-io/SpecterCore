/**
 * 从 PE 可执行文件中提取应用图标（设计文档 6.7）。
 *
 * 解析资源目录树：RT_GROUP_ICON(14) 提供图标目录（GRPICONDIR），
 * RT_ICON(3) 提供各尺寸的图标数据，合并后输出标准 .ico 文件字节。
 * 失败（非 PE / 无图标资源 / 结构异常）返回 null，调用方回退到默认图标。
 */

function readU16(data: Uint8Array, offset: number): number {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint16(offset, true);
}

function readU32(data: Uint8Array, offset: number): number {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset, true);
}

function writeU16(out: Uint8Array, offset: number, value: number): void {
  new DataView(out.buffer).setUint16(offset, value, true);
}

function writeU32(out: Uint8Array, offset: number, value: number): void {
  new DataView(out.buffer).setUint32(offset, value, true);
}

interface ResourceEntry {
  nameOrId: number;
  offset: number;
}

interface ResourceDir {
  entries: ResourceEntry[];
}

interface GroupIconEntry {
  width: number;
  height: number;
  colorCount: number;
  planes: number;
  bitCount: number;
  bytesInRes: number;
  id: number;
}

interface RvaMapper {
  (rva: number): number | null;
}

function readResourceDir(data: Uint8Array, base: number): ResourceDir | null {
  if (base < 0 || base + 16 > data.byteLength) return null;
  const namedCount = readU16(data, base + 8);
  const idCount = readU16(data, base + 12);
  const total = namedCount + idCount;
  const entries: ResourceEntry[] = [];
  for (let i = 0; i < total; i++) {
    const off = base + 16 + i * 8;
    if (off + 8 > data.byteLength) return null;
    entries.push({ nameOrId: readU32(data, off), offset: readU32(data, off + 4) });
  }
  return { entries };
}

function findIdEntry(dir: ResourceDir, id: number): ResourceEntry | null {
  for (const entry of dir.entries) {
    if ((entry.nameOrId & 0x80000000) === 0 && entry.nameOrId === id) return entry;
  }
  return null;
}

/**
 * 在资源树中定位 (type, id) 的资源数据块。id 省略时取该类型下第一个。
 * 返回 { offset, size }（文件偏移）。
 */
function findResourceData(
  data: Uint8Array,
  resBase: number,
  rvaToOffset: RvaMapper,
  type: number,
  id?: number,
): { offset: number; size: number } | null {
  const typeDir = readResourceDir(data, resBase);
  if (!typeDir) return null;
  const typeEntry = findIdEntry(typeDir, type);
  if (!typeEntry || (typeEntry.offset & 0x80000000) === 0) return null;

  const idDir = readResourceDir(data, resBase + (typeEntry.offset & 0x7fffffff));
  if (!idDir) return null;
  const idEntry = id === undefined ? idDir.entries[0] : findIdEntry(idDir, id);
  if (!idEntry || (idEntry.offset & 0x80000000) === 0) return null;

  const langDir = readResourceDir(data, resBase + (idEntry.offset & 0x7fffffff));
  if (!langDir) return null;
  const langEntry = langDir.entries[0];
  if (!langEntry || (langEntry.offset & 0x80000000) !== 0) return null;

  const dataEntryOff = resBase + langEntry.offset;
  if (dataEntryOff + 8 > data.byteLength) return null;
  const rva = readU32(data, dataEntryOff);
  const size = readU32(data, dataEntryOff + 4);
  const off = rvaToOffset(rva);
  if (off === null || off + size > data.byteLength) return null;
  return { offset: off, size };
}

/**
 * 提取 .ico 文件字节；失败返回 null。
 * 只读取头部与资源区，不改动输入。
 */
export function extractPeIcon(data: Uint8Array): Uint8Array | null {
  try {
    if (data.byteLength < 0x40 || data[0] !== 0x4d || data[1] !== 0x5a) return null;
    const e_lfanew = readU32(data, 0x3c);
    if (e_lfanew + 26 > data.byteLength) return null;
    if (data[e_lfanew] !== 0x50 || data[e_lfanew + 1] !== 0x45) return null;

    const coff = e_lfanew + 4;
    const numberOfSections = readU16(data, coff + 2);
    const sizeOfOptionalHeader = readU16(data, coff + 16);
    const opt = coff + 20;
    const magic = readU16(data, opt);
    if (magic !== 0x10b && magic !== 0x20b) return null;

    // 数据目录在 OptionalHeader 内的偏移：PE32=96，PE32+=112。
    const dataDirOffset = magic === 0x20b ? 112 : 96;
    const resourceRva = readU32(data, opt + dataDirOffset + 2 * 8);
    const resourceSize = readU32(data, opt + dataDirOffset + 2 * 8 + 4);
    if (resourceRva === 0 || resourceSize === 0) return null;

    // 节表：解析 RVA → 文件偏移。
    const sectionTable = opt + sizeOfOptionalHeader;
    if (sectionTable + numberOfSections * 40 > data.byteLength) return null;
    const sections: { va: number; vsize: number; rawSize: number; rawPtr: number }[] = [];
    for (let i = 0; i < numberOfSections; i++) {
      const s = sectionTable + i * 40;
      sections.push({
        va: readU32(data, s + 12),
        vsize: readU32(data, s + 8),
        rawSize: readU32(data, s + 16),
        rawPtr: readU32(data, s + 20),
      });
    }
    const rvaToOffset: RvaMapper = (rva) => {
      for (const sec of sections) {
        const span = Math.max(sec.vsize, sec.rawSize);
        if (rva >= sec.va && rva < sec.va + span) {
          const off = rva - sec.va + sec.rawPtr;
          return off >= 0 && off < data.byteLength ? off : null;
        }
      }
      return null;
    };

    const resBase = rvaToOffset(resourceRva);
    if (resBase === null) return null;

    // 组图标（GRPICONDIR）。
    const group = findResourceData(data, resBase, rvaToOffset, 14);
    if (!group || group.size < 6) return null;
    const g = group.offset;
    const count = readU16(data, g + 4);
    if (count === 0 || group.size < 6 + count * 14) return null;

    const entries: GroupIconEntry[] = [];
    for (let i = 0; i < count; i++) {
      const e = g + 6 + i * 14;
      entries.push({
        width: data[e] ?? 0,
        height: data[e + 1] ?? 0,
        colorCount: data[e + 2] ?? 0,
        planes: readU16(data, e + 4),
        bitCount: readU16(data, e + 6),
        bytesInRes: readU32(data, e + 8),
        id: readU16(data, e + 12),
      });
    }

    // 逐个读取 RT_ICON 数据块。
    const blobs: Uint8Array[] = [];
    for (const entry of entries) {
      const icon = findResourceData(data, resBase, rvaToOffset, 3, entry.id);
      if (!icon || icon.size < entry.bytesInRes) return null;
      blobs.push(data.slice(icon.offset, icon.offset + entry.bytesInRes));
    }

    // 组装标准 .ico（ICONDIR + ICONDIRENTRY[] + DIB 数据）。
    const headerSize = 6 + count * 16;
    const out = new Uint8Array(headerSize + blobs.reduce((n, b) => n + b.byteLength, 0));
    writeU16(out, 0, 0); // reserved
    writeU16(out, 2, 1); // type: icon
    writeU16(out, 4, count);
    let cursor = headerSize;
    for (let i = 0; i < count; i++) {
      const entry = entries[i]!;
      const blob = blobs[i]!;
      const e = 6 + i * 16;
      out[e] = entry.width === 256 ? 0 : entry.width;
      out[e + 1] = entry.height === 256 ? 0 : entry.height;
      out[e + 2] = entry.colorCount;
      out[e + 3] = 0;
      writeU16(out, e + 4, entry.planes);
      writeU16(out, e + 6, entry.bitCount);
      writeU32(out, e + 8, blob.byteLength);
      writeU32(out, e + 12, cursor);
      out.set(blob, cursor);
      cursor += blob.byteLength;
    }
    return out;
  } catch {
    return null;
  }
}
