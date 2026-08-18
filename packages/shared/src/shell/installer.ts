import type { AppPackage, FileStore, InstalledApp } from '@bk/contracts';

/**
 * Windows 应用安装底层（installer 核心，完全 UI 无关）。
 *
 * 职责（对应设计文档 6.8 安装/卸载语义）：
 *  - 把包文件拷贝到虚拟盘的 `Program Files/<packageId>`；
 *  - 把安装记录写入注册表文件 `Windows/registry.json`；
 *  - 提供 list / install / uninstall / 从 .bkapp 清单加载 四种操作。
 *
 * 注入一个 FileStore（虚拟 C: 盘）即可运行，测试可直接用内存实现驱动，
 * 未来 PE/exe 入口落地后此管道原样复用。
 */

export const PROGRAM_FILES = 'Program Files';
export const REGISTRY_PATH = 'Windows/registry.json';

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder('utf-8');

/** .bkapp 清单文件中的序列化形态（files.data 为 base64 字符串）。 */
interface PackageJson {
  packageId: string;
  name: string;
  version: string;
  icon: string;
  description: string;
  entryAppId: string;
  entryTitle: string;
  entryWidth: number;
  entryHeight: number;
  files?: { path: string; data: Uint8Array | string }[];
}

interface RegistryJson {
  version?: number;
  apps?: InstalledApp[];
}

async function readAll(fs: FileStore, path: string): Promise<Uint8Array> {
  const file = await fs.openFile(path, 'read');
  try {
    const size = await file.size();
    return await file.read(0, size);
  } finally {
    await file.close();
  }
}

async function writeAll(fs: FileStore, path: string, data: Uint8Array): Promise<void> {
  let file;
  try {
    file = await fs.openFile(path, 'create');
  } catch {
    file = await fs.openFile(path, 'write');
  }
  try {
    await file.write(0, data);
    await file.truncate(data.byteLength);
  } finally {
    await file.close();
  }
}

async function ensureDir(fs: FileStore, dir: string): Promise<void> {
  // 已存在则忽略（OPFS createDirectory 幂等语义）
  await fs.createDirectory(dir).catch(() => {});
}

function parentOf(storePath: string): string {
  const idx = storePath.lastIndexOf('/');
  return idx === -1 ? '' : storePath.slice(0, idx);
}

/** 读取注册表；不存在或损坏时返回空列表。 */
export async function listInstalledApps(fs: FileStore): Promise<InstalledApp[]> {
  try {
    const raw = await readAll(fs, REGISTRY_PATH);
    const parsed = JSON.parse(DECODER.decode(raw)) as RegistryJson;
    return Array.isArray(parsed.apps) ? parsed.apps : [];
  } catch {
    return [];
  }
}

export async function isInstalled(fs: FileStore, packageId: string): Promise<boolean> {
  return (await listInstalledApps(fs)).some((a) => a.packageId === packageId);
}

/**
 * 安装应用包：
 *  1. 建 `Program Files/<packageId>` 目录并写入所有包文件；
 *  2. 追加/覆盖注册表记录（同 id 视为升级）；
 * 返回注册表记录。
 */
export async function installPackage(fs: FileStore, pkg: AppPackage): Promise<InstalledApp> {
  const installDir = `${PROGRAM_FILES}/${pkg.packageId}`;
  await ensureDir(fs, installDir);
  for (const file of pkg.files) {
    const target = `${installDir}/${file.path}`;
    const parent = parentOf(target);
    if (parent) await ensureDir(fs, parent);
    await writeAll(fs, target, file.data);
  }
  const record: InstalledApp = {
    packageId: pkg.packageId,
    name: pkg.name,
    version: pkg.version,
    icon: pkg.icon,
    description: pkg.description,
    entryAppId: pkg.entryAppId,
    entryTitle: pkg.entryTitle,
    entryWidth: pkg.entryWidth,
    entryHeight: pkg.entryHeight,
    installDir,
    installedAt: Date.now(),
  };
  const apps = (await listInstalledApps(fs)).filter((a) => a.packageId !== pkg.packageId);
  apps.push(record);
  await writeRegistry(fs, apps);
  return record;
}

/** 卸载：删除安装目录（递归）与注册表项。 */
export async function uninstallPackage(fs: FileStore, packageId: string): Promise<void> {
  const apps = await listInstalledApps(fs);
  const app = apps.find((a) => a.packageId === packageId);
  if (app) {
    await fs.removeDirectory(app.installDir).catch(() => {});
  }
  await writeRegistry(fs, apps.filter((a) => a.packageId !== packageId));
}

/** 从虚拟盘上的 .bkapp 清单文件加载包（files.data 按 base64 解码）。 */
export async function loadPackageFile(fs: FileStore, path: string): Promise<AppPackage> {
  const raw = await readAll(fs, path);
  const parsed = JSON.parse(DECODER.decode(raw)) as PackageJson;
  if (!parsed.packageId || !parsed.name) throw new Error(`Invalid package manifest: ${path}`);
  const files = (parsed.files ?? []).map((f) => ({
    path: f.path,
    data: typeof f.data === 'string' ? base64ToBytes(f.data) : f.data,
  }));
  return {
    packageId: parsed.packageId,
    name: parsed.name,
    version: parsed.version,
    icon: parsed.icon,
    description: parsed.description,
    entryAppId: parsed.entryAppId,
    entryTitle: parsed.entryTitle,
    entryWidth: parsed.entryWidth,
    entryHeight: parsed.entryHeight,
    files,
  };
}

async function writeRegistry(fs: FileStore, apps: InstalledApp[]): Promise<void> {
  // 注册表位于 Windows/ 下；该目录可能尚不存在（MemoryFileStore 会校验父目录）。
  await ensureDir(fs, parentOf(REGISTRY_PATH));
  await writeAll(fs, REGISTRY_PATH, ENCODER.encode(JSON.stringify({ version: 1, apps }, null, 2)));
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
