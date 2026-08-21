/**
 * L3 PE 文件加载器契约。
 * 解析 .exe/.dll 的 PE 格式，将代码段/数据段/资源段加载到 WASM 线性内存（P1 里程碑实现）。
 */

export enum PeSubsystem {
  UNKNOWN = 0,
  NATIVE = 1,
  WINDOWS_GUI = 2,
  WINDOWS_CUI = 3,
}

export interface PeSection {
  name: string;
  virtualAddress: number;
  virtualSize: number;
  rawSize: number;
  characteristics: number;
}

export interface PeImportFunction {
  name?: string;
  ordinal?: number;
  /** Index of this entry in the descriptor's ILT/FirstThunk array (thunk position). */
  index?: number;
}

export interface PeImport {
  moduleName: string;
  functions: PeImportFunction[];
  /** RVA of this descriptor's FirstThunk (IAT) — slots rewritten at map time. */
  iatRva: number;
}

export interface PeExport {
  name: string;
  ordinal: number;
  address: number;
}

/** IMAGE_TLS_DIRECTORY (data directory index 9), resolved to RVAs. */
export interface PeTls {
  /** RVA of the TLS template (StartAddressOfRawData - ImageBase). */
  templateRva: number;
  /** Size of the TLS template in bytes (End - Start). */
  templateSize: number;
  /** RVA of the TLS index variable (AddressOfIndex - ImageBase), 0 if none. */
  indexRva: number;
  /** RVA of the TLS callback array (AddressOfCallBacks - ImageBase), 0 if none. */
  callbacksRva: number;
  /** Bytes to zero-fill after the template. */
  zeroFillSize: number;
  /** Initial template bytes (zero-filled when the section has no raw data). */
  template: Uint8Array;
}

export interface PeImage {
  path: string;
  baseAddress: number;
  entryPoint: number;
  imageSize: number;
  subsystem: PeSubsystem;
  machine: number;
  sections: PeSection[];
  imports: PeImport[];
  exports: PeExport[];
  resources: Uint8Array;
  /** True when the image is a 64-bit PE32+ (magic 0x20B). */
  is64: boolean;
  /** Base-relocation entries (RVA + type), used to rebase the image. */
  relocations: readonly { rva: number; type: number }[];
  /** PE TLS directory (template + index variable), null when absent. */
  tls: PeTls | null;
  /** PE 头原始字节 */
  header: Uint8Array;
}

export interface PeLoader {
  load(image: Uint8Array, baseAddress?: number): Promise<PeImage>;
  getExports(image: PeImage): Map<string, PeExport>;
  getImports(image: PeImage): PeImport[];
  /** 从原始 .exe 字节中提取应用图标（.ico），失败返回 null */
  extractIcon(rawImage: Uint8Array): Promise<Uint8Array | null>;
  isPe(buffer: Uint8Array): boolean;
}

export const PE_MAGIC = 0x5a4d; // 'MZ'
export const PE_SIGNATURE = 0x00004550; // 'PE\0\0'