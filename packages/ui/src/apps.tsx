import type { DesktopAppInfo } from '@specter-core/contracts';
import { SystemInfoApp } from './apps/SystemInfoApp';
import { FileExplorerApp } from './apps/FileExplorerApp';
import { ImageViewerApp } from './apps/ImageViewerApp';
import { VideoViewerApp } from './apps/VideoViewerApp';
import { AudioPlayerApp } from './apps/AudioPlayerApp';
import { BrowserApp } from './apps/BrowserApp';
import type { AppDefinition } from './types';

/**
 * Demo application registry. Adding a desktop app is: implement a component,
 * add an AppDefinition here. Real PE-launched apps appear via core:process:created
 * and bind their windows in the P3 milestone.
 */
export const DEFAULT_APPS: AppDefinition[] = [
  {
    appId: 'system-info',
    name: 'System Information',
    icon: 'icons/this-pc.svg',
    description: 'Kernel, processes and disk status',
    group: 'System',
    render: () => <SystemInfoApp />,
  },
  {
    appId: 'file-explorer',
    name: 'File Explorer',
    icon: 'icons/explorer.svg',
    description: 'Browse the virtual disk',
    group: 'System',
    render: (args) => <FileExplorerApp initialPath={args?.path} />,
  },
  {
    appId: 'command-prompt',
    name: 'Command Prompt',
    icon: 'icons/cmd.svg',
    description: 'Run the bundled Windows cmd.exe (real x86 PE) over the virtual disk',
    group: 'System',
    // Launch is special-cased in DesktopController: it runs the bundled
    // cmd.exe as a real guest process with a console terminal (stdin/stdout),
    // replacing the old JS interpreter shell.
    render: () => null,
  },
  {
    appId: 'image-viewer',
    name: 'Photos',
    icon: 'icons/photos.svg',
    description: 'View images from the virtual disk',
    group: 'Accessories',
    render: (args) => <ImageViewerApp initialFile={args?.path} />,
  },
  {
    appId: 'video-viewer',
    name: 'Video Player',
    icon: 'icons/video-player.svg',
    description: 'Play videos from the virtual disk',
    group: 'Accessories',
    render: (args) => <VideoViewerApp initialFile={args?.path} />,
  },
  {
    appId: 'audio-player',
    name: 'Audio Player',
    icon: 'icons/audio-player.svg',
    description: 'Play audio from the virtual disk',
    group: 'Accessories',
    render: (args) => <AudioPlayerApp initialFile={args?.path} />,
  },
  {
    appId: 'browser',
    name: 'Browser',
    icon: 'icons/browser.svg',
    description: 'Browse the web and save downloads into the virtual disk',
    group: 'Internet',
    render: () => <BrowserApp />,
  },
  {
    appId: 'windows-notepad',
    name: 'Notepad',
    icon: 'icons/notepad.svg',
    description: 'Run the bundled Windows notepad.exe with its MUI resources',
    group: 'System',
    // Launch is special-cased in DesktopController: it runs the bundled
    // notepad as a real guest window (no application-shell window).
    render: () => null,
  },
  {
    appId: 'windows-notepad-x64',
    name: 'Notepad (x64)',
    icon: 'icons/notepad.svg',
    description: 'Run the bundled 64-bit notepad.exe (PE32+) with its MUI resources',
    group: 'System',
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