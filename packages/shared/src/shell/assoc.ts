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
 * 注意：.exe 与 .bkapp 由 DesktopController.openFile 直接特殊处理
 * （真实 guest 进程 / 安装），不走应用注册表，这里返回 null。
 */
export function appForFile(name: string): string | null {
  const lower = name.toLowerCase();
  if (isImageFile(name)) return 'image-viewer';
  // Text files open in the REAL bundled Windows notepad.exe (windows-notepad,
  // launched via DesktopController). The old TS-simulated NotepadApp is gone.
  if (isTextFile(name)) return 'windows-notepad';
  return null;
}
