import type { AppPackage, FileStore } from '@specter-core/contracts';
import { parsePe } from '@specter-core/shared';

/**
 * 演示应用包、.bkapp 清单序列化与 .exe 安装包构造。
 * 独立于组件文件，保证 InstallerApp.tsx 只导出组件（react-refresh 要求）。
 */

const ENCODER = new TextEncoder();

/** 内置演示包：安装后可从开始菜单启动一个真实窗口。 */
export function helloWorldPackage(): AppPackage {
  const readme = [
    'Hello World 1.0.0',
    '',
    'This application was installed through the BK installer.',
    'It lives on the virtual C: drive under Program Files.',
    '',
    'The installer pipeline (manifest -> Program Files -> registry)',
    'is the same foundation that will run native PE executables.',
  ].join('\n');
  return {
    packageId: 'hello-world',
    name: 'Hello World',
    version: '1.0.0',
    icon: '👋',
    description: 'A sample app installed via the BK Windows installer',
    entryAppId: 'installed:hello-world',
    entryTitle: 'Hello World',
    entryWidth: 400,
    entryHeight: 280,
    files: [{ path: 'README.txt', data: ENCODER.encode(readme) }],
  };
}

function bytesToBase64(data: Uint8Array): string {
  let bin = '';
  for (const byte of data) bin += String.fromCharCode(byte);
  return btoa(bin);
}

/** 把包序列化为 .bkapp 清单（files.data 为 base64），可写回虚拟盘供 Explorer 双击安装。 */
export function packageToManifest(pkg: AppPackage): string {
  return JSON.stringify(
    {
      ...pkg,
      files: pkg.files.map((f) => ({ path: f.path, data: bytesToBase64(f.data) })),
    },
    null,
    2,
  );
}

function sanitizeId(name: string): string {
  const id = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return id === '' ? 'app' : id;
}

/**
 * 从真实 .exe 构建安装包：解析 PE 头取元数据，原始字节作为包文件
 * 原样拷贝到 Program Files。完整 x86 执行属于 core/pe + core/jit
 * 里程碑（设计文档 P3），安装/注册/开始菜单链路现在就是真实的。
 */
export async function loadExecutablePackage(fs: FileStore, path: string): Promise<AppPackage> {
  const file = await fs.openFile(path, 'read');
  let data: Uint8Array;
  try {
    const size = await file.size();
    data = await file.read(0, size);
  } finally {
    await file.close();
  }

  const pe = parsePe(data);
  const base = (path.split('/').filter(Boolean).pop() ?? 'app').replace(/\.exe$/i, '');
  const name = base === '' ? 'Application' : base;
  const id = sanitizeId(name);
  const description = pe
    ? `Windows executable — ${pe.arch}, ${pe.subsystemName}, ${pe.numberOfSections} section(s)`
    : 'Windows executable (PE header not recognized; installed as-is)';

  return {
    packageId: id,
    name,
    version: '1.0.0',
    icon: '⚙️',
    description,
    entryAppId: `installed:${id}`,
    entryTitle: name,
    entryWidth: 440,
    entryHeight: 300,
    files: [{ path: `${name}.exe`, data }],
  };
}

