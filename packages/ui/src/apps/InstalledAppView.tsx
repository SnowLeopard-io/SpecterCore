import { useEffect, useRef, useState } from 'react';
import type { InstalledApp } from '@bk/contracts';
import { decodeText, extractPeIcon } from '@bk/shared';
import { useUi } from '../context';

/** 读取安装目录内的文本文件（仅演示用途）。 */
async function readText(fs: { openFile: (p: string, m: 'read') => Promise<{ size(): Promise<number>; read(o: number, l: number): Promise<Uint8Array>; close(): Promise<void> }> }, path: string): Promise<string | null> {
  try {
    const file = await fs.openFile(path, 'read');
    try {
      const size = await file.size();
      const data = await file.read(0, size);
      return decodeText(data);
    } finally {
      await file.close();
    }
  } catch {
    return null;
  }
}

interface InstalledAppViewProps {
  app: InstalledApp;
}

/**
 * 已安装应用的入口窗口：展示包信息并读取其安装目录内容，
 * 证明"安装 → Program Files → 运行"链路是真实读写虚拟盘的。
 */
export function InstalledAppView({ app }: InstalledAppViewProps) {
  const { controller } = useUi();
  const fs = controller.getFileSystem();
  const [readme, setReadme] = useState<string | null>(null);
  const [hasExe, setHasExe] = useState(false);
  const [exeIcon, setExeIcon] = useState<string | null>(null);
  const iconUrlRef = useRef<string | null>(null);

  useEffect(() => {
    if (!fs) return;
    void readText(fs, `${app.installDir}/README.txt`).then(setReadme);
  }, [fs, app.installDir]);

  // 安装目录内含 .exe → 这是通过 exe 安装链路装进来的原生可执行文件，
  // 并从其 PE 资源中提取真实图标（设计文档 6.7）。
  useEffect(() => {
    if (!fs) return;
    let cancelled = false;
    void (async () => {
      try {
        const entries = await fs.listDirectory(app.installDir);
        const exe = entries.find((e) => e.name.toLowerCase().endsWith('.exe'));
        if (!exe) {
          if (!cancelled) setHasExe(false);
          return;
        }
        if (!cancelled) setHasExe(true);
        const file = await fs.openFile(`${app.installDir}/${exe.name}`, 'read');
        let data: Uint8Array;
        try {
          const size = await file.size();
          data = await file.read(0, size);
        } finally {
          await file.close();
        }
        const ico = extractPeIcon(data);
        if (ico && !cancelled) {
          if (iconUrlRef.current) URL.revokeObjectURL(iconUrlRef.current);
          iconUrlRef.current = URL.createObjectURL(new Blob([ico as BlobPart]));
          setExeIcon(iconUrlRef.current);
        }
      } catch {
        if (!cancelled) setHasExe(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fs, app.installDir]);

  // 卸载时释放图标 URL。
  useEffect(() => {
    return () => {
      if (iconUrlRef.current) URL.revokeObjectURL(iconUrlRef.current);
    };
  }, []);

  return (
    <div className="bk-installed">
      <div className="bk-installed-head">
        <span className="bk-installed-icon">
          {exeIcon ? <img className="bk-installed-exe-icon" src={exeIcon} alt="" /> : app.icon}
        </span>
        <div>
          <div className="bk-installed-name">{app.name}</div>
          <div className="bk-installed-version">Version {app.version}</div>
        </div>
      </div>
      <div className="bk-installed-desc">{app.description}</div>
      <div className="bk-installed-meta">
        <div>
          <span className="bk-installed-meta-label">Installed to</span>
          <span className="bk-installed-meta-value">C:\{app.installDir}</span>
        </div>
        <div>
          <span className="bk-installed-meta-label">Registered</span>
          <span className="bk-installed-meta-value">
            {new Date(app.installedAt).toLocaleString()}
          </span>
        </div>
      </div>
      {readme !== null && (
        <pre className="bk-installed-readme">
          <span className="bk-installed-readme-title">README.txt</span>
          {readme}
        </pre>
      )}
      {hasExe && (
        <div className="bk-installed-pe">
          <div className="bk-installed-pe-title">⚙️ Native executable payload</div>
          <p>
            This package contains a real Windows .exe, copied byte-for-byte to the virtual
            disk and registered in the Start Menu. The PE execution engine (core/pe + core/jit)
            is the next milestone of the design doc — once it lands, this window becomes the
            running application.
          </p>
        </div>
      )}
      <div className="bk-installed-hint">
        This window is the app&apos;s entry, launched from the Start Menu after installation.
      </div>
    </div>
  );
}
