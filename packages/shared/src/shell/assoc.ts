/**
 * 文件关联（ShellExecute 的 "open" 动词映射）。
 *
 * 给定文件名，返回应处理它的应用标识（DesktopAppInfo.appId）。
 * 这是 Windows 逻辑的一部分，与 UI 解耦，可被桌面控制器、文件资源管理器
 * 或任何需要"打开文件"语义的调用方复用。
 */

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'log', 'ini', 'cfg', 'conf',
  'bat', 'cmd', 'ps1',
  'json', 'jsonc', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx',
  'css', 'scss', 'html', 'htm', 'xml', 'svg', 'csv', 'yml', 'yaml',
  'gitignore', 'env', 'toml',
]);

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico']);

/** 是否为可用记事本打开的文本文件。 */
export function isTextFile(name: string): boolean {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return false;
  return TEXT_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

/** 是否为图片文件（图片查看器可打开）。 */
export function isImageFile(name: string): boolean {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return false;
  return IMAGE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

/**
 * 根据文件名推断关联的应用。
 * 返回 null 表示当前没有注册的应用可打开该文件（调用方可回退到预览等）。
 */
export function appForFile(name: string): string | null {
  const lower = name.toLowerCase();
  if (lower.endsWith('.bkapp')) return 'installer';
  // .exe 运行优先：双击进入「运行确认」，可运行（JIT 容器）或转安装器。
  if (lower.endsWith('.exe')) return 'exe-runner';
  if (isImageFile(name)) return 'image-viewer';
  if (isTextFile(name)) return 'notepad';
  return null;
}
