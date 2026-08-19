import { useEffect, useState } from 'react';
import type { AppPackage } from '@specter-core/contracts';
import { loadPackageFile } from '@specter-core/shared';
import { useUi } from '../context';
import { helloWorldPackage, loadExecutablePackage, packageToManifest } from './installer-packages';

type Step = 'overview' | 'installing' | 'done';

interface InstallerProps {
  /** 来自 open 动词：双击 .bkapp 清单文件时传入其 store 路径。 */
  initialPackagePath?: string;
}

const ENCODER = new TextEncoder();

/**
 * Installer (Windows 11 style wizard): installs an app package onto the
 * virtual C: drive via the reusable installer core (@specter-core/shared/shell/installer).
 */
export function InstallerApp({ initialPackagePath }: InstallerProps) {
  const { controller } = useUi();
  const fs = controller.getFileSystem();

  const [pkg, setPkg] = useState<AppPackage | null>(initialPackagePath ? null : helloWorldPackage());
  const [step, setStep] = useState<Step>('overview');
  const [error, setError] = useState<string | null>(null);
  const [installed, setInstalled] = useState<AppPackage | null>(null);

  // 从包清单加载（.bkapp 为 JSON 清单，.exe 为真实 PE 可执行文件）。
  useEffect(() => {
    if (!initialPackagePath || !fs || pkg) return;
    const loader = initialPackagePath.toLowerCase().endsWith('.exe')
      ? loadExecutablePackage(fs, initialPackagePath)
      : loadPackageFile(fs, initialPackagePath);
    void loader
      .then(setPkg)
      .catch((err: unknown) => setError(`Cannot load package: ${String(err)}`));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPackagePath, fs]);

  const alreadyInstalled =
    pkg !== null && controller.listInstalledApps().some((a) => a.packageId === pkg.packageId);

  const runInstall = async (): Promise<void> => {
    if (!pkg) return;
    setError(null);
    setStep('installing');
    try {
      await controller.installPackage(pkg);
      // 顺带把清单写回 C:\，这样资源管理器里能看到 .bkapp 并可双击重装。
      if (fs && initialPackagePath !== `${pkg.packageId}.bkapp`) {
        const file = await fs.openFile(`${pkg.packageId}.bkapp`, 'create').catch(() => null);
        if (file) {
          try {
            const data = ENCODER.encode(packageToManifest(pkg));
            await file.write(0, data);
            await file.truncate(data.byteLength);
          } finally {
            await file.close();
          }
        }
      }
      setInstalled(pkg);
      setStep('done');
    } catch (err: unknown) {
      setError(`Install failed: ${String(err)}`);
      setStep('overview');
    }
  };

  if (!pkg) {
    return (
      <div className="sc-installer">
        <div className="sc-installer-empty">
          {error ?? 'Loading package…'}
        </div>
      </div>
    );
  }

  return (
    <div className="sc-installer">
      {error && <div className="sc-installer-error">{error}</div>}

      {step === 'overview' && (
        <>
          <div className="sc-installer-head">
            <span className="sc-installer-icon">{pkg.icon}</span>
            <div>
              <div className="sc-installer-name">{pkg.name}</div>
              <div className="sc-installer-version">Version {pkg.version}</div>
            </div>
          </div>
          <p className="sc-installer-desc">{pkg.description}</p>
          {initialPackagePath?.toLowerCase().endsWith('.exe') && (
            <div className="sc-installer-warn">
              Native Windows executable (.exe). Its bytes will be copied to Program Files and
              registered in the Start Menu. Running it requires the PE execution engine
              (design doc P3 milestone); the install pipeline is fully real.
            </div>
          )}
          <div className="sc-installer-row">
            <span>Install to</span>
            <span className="sc-installer-value">C:\Program Files\{pkg.packageId}</span>
          </div>
          <div className="sc-installer-row">
            <span>Files</span>
            <span className="sc-installer-value">{pkg.files.length} file(s)</span>
          </div>
          {alreadyInstalled && (
            <div className="sc-installer-warn">This application is already installed. Reinstalling will upgrade it.</div>
          )}
          <div className="sc-installer-actions">
            <button className="sc-nt-btn" onClick={() => setStep('overview')} disabled>
              Cancel
            </button>
            <button className="sc-nt-btn primary" onClick={() => void runInstall()}>
              {alreadyInstalled ? 'Reinstall' : 'Install'}
            </button>
          </div>
        </>
      )}

      {step === 'installing' && (
        <div className="sc-installer-progress">
          <div className="sc-installer-spinner" />
          <span>Installing {pkg.name} to C:\Program Files\{pkg.packageId}…</span>
        </div>
      )}

      {step === 'done' && installed && (
        <>
          <div className="sc-installer-done-icon">✓</div>
          <div className="sc-installer-name">{installed.name} installed successfully</div>
          <p className="sc-installer-desc">
            {installed.name} has been added to the Start Menu and desktop. A .bkapp manifest
            was also written to C:\{installed.packageId}.bkapp — double-click it in File
            Explorer to re-run the installer.
          </p>
          <div className="sc-installer-actions">
            <button className="sc-nt-btn" onClick={() => setStep('overview')}>
              Close
            </button>
            <button
              className="sc-nt-btn primary"
              onClick={() => void controller.launch(`installed:${installed.packageId}`)}
            >
              Launch
            </button>
          </div>
        </>
      )}
    </div>
  );
}
