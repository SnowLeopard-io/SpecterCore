import type { DesktopAppInfo } from '@specter-core/contracts';
import { SystemInfoApp } from './apps/SystemInfoApp';
import { MinesweeperApp } from './apps/MinesweeperApp';
import { FileExplorerApp } from './apps/FileExplorerApp';
import { InstallerApp } from './apps/InstallerApp';
import { ImageViewerApp } from './apps/ImageViewerApp';
import { RunExecutableApp } from './apps/RunExecutableApp';
import type { AppDefinition } from './types';

/**
 * Demo application registry. Adding a desktop app is: implement a component,
 * add an AppDefinition here. Real PE-launched apps appear via core:process:created
 * and bind their windows in the P3 milestone.
 */
export const DEFAULT_APPS: AppDefinition[] = [
  {
    appId: 'minesweeper',
    name: 'Minesweeper',
    icon: '💣',
    description: 'Classic minesweeper',
    group: 'Games',
    render: () => <MinesweeperApp />,
  },
  {
    appId: 'system-info',
    name: 'System Information',
    icon: '🖥',
    description: 'Kernel, processes and disk status',
    group: 'System',
    render: () => <SystemInfoApp />,
  },
  {
    appId: 'file-explorer',
    name: 'File Explorer',
    icon: '📂',
    description: 'Browse the virtual disk',
    group: 'System',
    render: (args) => <FileExplorerApp initialPath={args?.path} />,
  },
  {
    appId: 'command-prompt',
    name: 'Command Prompt',
    icon: '🖥',
    description: 'Run the bundled Windows cmd.exe (real x86 PE) over the virtual disk',
    group: 'System',
    // Launch is special-cased in DesktopController: it runs the bundled
    // cmd.exe as a real guest process with a console terminal (stdin/stdout),
    // replacing the old JS interpreter shell.
    render: () => null,
  },
  {
    appId: 'installer',
    name: 'Installer',
    icon: '📦',
    description: 'Install applications (.bkapp) onto the virtual disk',
    group: 'System',
    render: (args) => <InstallerApp initialPackagePath={args?.path} />,
  },
  {
    appId: 'image-viewer',
    name: 'Photos',
    icon: '🖼️',
    description: 'View images from the virtual disk',
    group: 'Accessories',
    render: (args) => <ImageViewerApp initialFile={args?.path} />,
  },
  {
    appId: 'exe-runner',
    name: 'Run Executable',
    icon: '⚙️',
    description: 'Run a Windows executable from the virtual disk',
    group: 'System',
    render: (args) => <RunExecutableApp initialFile={args?.path} />,
  },
  {
    appId: 'windows-notepad',
    name: 'Notepad',
    icon: '📝',
    description: 'Run the bundled Windows notepad.exe with its MUI resources',
    group: 'System',
    // Launch is special-cased in DesktopController: it runs the bundled
    // notepad as a real guest window (no application-shell window).
    render: () => null,
  },
];

export function toDesktopApp(app: AppDefinition): DesktopAppInfo {
  return {
    appId: app.appId,
    name: app.name,
    icon: app.icon,
    description: app.description,
    group: app.group,
    launch: () => Promise.resolve(),
  };
}