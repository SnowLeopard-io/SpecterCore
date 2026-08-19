import { useEffect, useState } from 'react';
import type { SystemInfo } from '@specter-core/contracts';
import { useUi } from '../context';

function fmtBytes(bytes: number): string {
  if (bytes >= 1 << 30) return `${(bytes / (1 << 30)).toFixed(2)} GiB`;
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(2)} MiB`;
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

/** System information app: shows kernel version, running processes and disk usage. */
export function SystemInfoApp() {
  const { controller } = useUi();
  const [info, setInfo] = useState<SystemInfo | null>(null);

  useEffect(() => {
    let active = true;
    void controller.getSystemInfo().then((value) => {
      if (active) setInfo(value);
    });
    return () => {
      active = false;
    };
  }, [controller]);

  if (!info) return <div className="sc-app-body">Loading system info...</div>;

  return (
    <div className="sc-app-body sc-sysinfo">
      <h3>About SpecterCore</h3>
      <dl>
        <dt>Kernel version</dt>
        <dd>{info.version}</dd>
        <dt>Running processes</dt>
        <dd>{info.processCount}</dd>
        <dt>Virtual disk</dt>
        <dd>
          {fmtBytes(info.diskUsed)} / {fmtBytes(info.diskCapacity)}
        </dd>
        <dt>Capabilities</dt>
        <dd>{info.capabilities.length > 0 ? info.capabilities.join(', ') : '(not available)'}</dd>
      </dl>
      <h3>Processes</h3>
      <ul className="sc-sysinfo-list">
        {info.processes.map((p) => (
          <li key={p.pid}>
            <b>{p.name}</b> pid={p.pid} state={p.state} threads={p.threadCount} memory={fmtBytes(p.memoryBytes)}
          </li>
        ))}
      </ul>
    </div>
  );
}