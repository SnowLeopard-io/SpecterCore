import { useCallback, useEffect, useRef, useState } from 'react';
import { extractPeIcon, parsePe } from '@bk/shared';
import { tokens } from '@bk/contracts';
import {
  GuestProcessRunner,
  JitEngineImpl,
  UnsupportedError,
  WasmRuntimeImpl,
  X86Decoder,
  type GuestProcessResult,
} from '@bk/core';
import { useUi } from '../context';

interface RunExecutableProps {
  /** 要运行的 .exe（store 路径），来自 open 动词或桌面拖入。 */
  initialFile?: string;
}

type Phase = 'confirm' | 'running' | 'installing' | 'cancelled' | 'error';

interface PeMeta {
  arch: string;
  subsystem: string;
  sections: number;
}

/** 已准备好的镜像：store 路径或本地选择的文件。 */
interface Source {
  name: string;
  image: Uint8Array;
}

/** Sniffs whether `image` is a 64-bit PE32+ from its optional-header magic. */
function is64(image: Uint8Array): boolean {
  try {
    const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
    if (view.getUint16(0, true) !== 0x5a4d) return false;
    const eLfanew = view.getUint32(0x3c, true);
    return view.getUint16(eLfanew + 4 + 20, true) === 0x20b;
  } catch {
    return false;
  }
}

/** 运行停止点（fault/trap/limit）的人类可读诊断。 */
function describeStop(runtime: WasmRuntimeImpl, result: GuestProcessResult, image: Uint8Array): string {
  const lines: string[] = [];
  if (result.error) lines.push(String(result.error));
  lines.push(`eip = 0x${result.eip.toString(16)}`);
  const bytes = runtime.readBytes(result.eip, 16);
  lines.push(
    'bytes = ' +
      [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(' '),
  );
  try {
    const decoder = new X86Decoder(is64(image) ? 'x64' : 'x86');
    const decoded = decoder.decode(bytes, result.eip);
    const first = decoded.instructions[0];
    if (first) lines.push(`next = ${first.inst.op} (len ${first.length})`);
  } catch (error) {
    if (error instanceof UnsupportedError) lines.push(`next = unsupported: ${error.message}`);
    else lines.push(`next = decode error: ${String(error)}`);
  }
  return lines.join('\n');
}

/**
 * Run Executable — 双击 .exe → Windows 风格「运行确认」→ [运行] 打开真实执行容器：
 * 用 core 的 PE32/PE32+ loader + x86/x64 JIT 在浏览器里执行，stdout/stderr 实时渲染。
 * 支持两个来源：虚拟盘上的文件（initialFile）或 File System Access 选择的本地文件。
 */
export function RunExecutableApp({ initialFile }: RunExecutableProps) {
  const { kernel, controller } = useUi();
  const fs = controller.getFileSystem();

  const [phase, setPhase] = useState<Phase>('confirm');
  const [name, setName] = useState(initialFile?.split('/').filter(Boolean).pop() ?? 'app.exe');
  const [pe, setPe] = useState<PeMeta | null>(null);
  const [iconUrl, setIconUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<Source | null>(null);
  const [output, setOutput] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const iconRef = useRef<string | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const applyImage = useCallback(
    (data: Uint8Array, label: string): void => {
      setName(label);
      setPe(null);
      setIconUrl(null);
      const info = parsePe(data);
      if (info) setPe({ arch: info.arch, subsystem: info.subsystemName, sections: info.numberOfSections });
      const ico = extractPeIcon(data);
      if (ico) {
        if (iconRef.current) URL.revokeObjectURL(iconRef.current);
        iconRef.current = URL.createObjectURL(new Blob([ico as BlobPart]));
        setIconUrl(iconRef.current);
      }
      setSource({ name: label, image: data });
    },
    [],
  );

  useEffect(() => {
    if (!initialFile || !fs) return;
    let cancelled = false;
    void (async () => {
      try {
        const file = await fs.openFile(initialFile, 'read');
        let data: Uint8Array;
        try {
          const size = await file.size();
          data = await file.read(0, size);
        } finally {
          await file.close();
        }
        if (cancelled) return;
        applyImage(data, initialFile.split('/').filter(Boolean).pop() ?? 'app.exe');
      } catch (err: unknown) {
        if (!cancelled) {
          setError(String(err));
          setPhase('error');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [initialFile, fs, applyImage]);

  useEffect(() => {
    return () => {
      if (iconRef.current) URL.revokeObjectURL(iconRef.current);
    };
  }, []);

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [output, status]);

  const run = useCallback(async (): Promise<void> => {
    if (!source) return;
    setPhase('running');
    setOutput('');
    setStatus(null);
    const image = source.image;
    const decode = new TextDecoder();

    let runtime: WasmRuntimeImpl;
    try {
      const interceptor = kernel.container.resolve(tokens.coreApi);
      const loader = kernel.container.resolve(tokens.corePe);
      runtime = kernel.container.resolve(tokens.coreWasmRuntime) as WasmRuntimeImpl;
      const jit = kernel.container.resolve(tokens.coreJit);
      const runner = new GuestProcessRunner(runtime, jit, loader, interceptor);
      const result = await runner.run(image, {
        createEngine: (mode) => new JitEngineImpl(runtime, mode),
        onOutput: (bytes) => {
          setOutput((prev) => prev + decode.decode(bytes).replace(/\r\n/g, '\n'));
        },
      });
      let text: string;
      switch (result.status) {
        case 'exit':
          text = result.cleanExit
            ? `\n[process exited with code ${result.exitCode}]`
            : `\n[process returned without calling ExitProcess — startup aborted (eip=0x${result.eip.toString(16)})]`;
          break;
        case 'fault':
          text = `\n[fault] ${describeStop(runtime, result, image)}`;
          break;
        case 'trap':
          text = `\n[trapped] eip = 0x${result.eip.toString(16)}`;
          break;
        default:
          text = `\n[step limit] eip = 0x${result.eip.toString(16)}`;
          break;
      }
      setStatus(text);
    } catch (err: unknown) {
      setStatus(`\n[error] ${String(err)}`);
    }
  }, [source, kernel]);

  const pickLocal = useCallback(async (): Promise<void> => {
    try {
      const picked = await controller.pickLocalFile();
      if (!picked) return;
      applyImage(picked.data, picked.name);
      setError(null);
      setPhase('confirm');
    } catch (err: unknown) {
      setError(String(err));
      setPhase('error');
    }
  }, [controller, applyImage]);

  const install = (): void => {
    setPhase('installing');
    if (initialFile) void controller.launch('installer', { path: initialFile });
  };

  return (
    <div className="bk-run">
      {phase === 'confirm' && (
        <>
          <div className="bk-run-head">
            <span className="bk-run-icon">
              {iconUrl ? <img src={iconUrl} alt="" /> : '⚠️'}
            </span>
            <div>
              <div className="bk-run-title">Open File — Security Warning</div>
              <div className="bk-run-subtitle">Do you want to run this file?</div>
            </div>
          </div>
          <div className="bk-run-file">
            <span className="bk-run-name">{name}</span>
            {pe && (
              <span className="bk-run-meta">
                {pe.arch} · {pe.subsystem} · {pe.sections} section(s)
              </span>
            )}
            {!pe && <span className="bk-run-meta">PE header not recognized</span>}
          </div>
          <p className="bk-run-note">
            Running executes the program inside the browser sandbox with the core
            PE loader and the x86/x64 JIT engine. Program output is rendered live
            in the console below.
          </p>
          <div className="bk-run-actions">
            <button className="bk-nt-btn" onClick={pickLocal}>
              Open local .exe…
            </button>
            <button className="bk-nt-btn" onClick={() => setPhase('cancelled')}>
              Cancel
            </button>
            <button className="bk-nt-btn" onClick={install} disabled={!initialFile}>
              Install
            </button>
            <button className="bk-nt-btn primary" onClick={() => void run()} disabled={!source}>
              Run
            </button>
          </div>
        </>
      )}

      {phase === 'running' && (
        <div className="bk-console">
          <div className="bk-console-head">
            <span className="bk-console-dot" />
            <span className="bk-console-title">{name}</span>
          </div>
          <div className="bk-console-body" ref={bodyRef}>
            {output === '' && !status ? (
              <div className="bk-console-empty">running…</div>
            ) : (
              <pre className="bk-console-pre">
                {output}
                {status}
              </pre>
            )}
          </div>
        </div>
      )}

      {phase === 'installing' && (
        <div className="bk-run-stage">
          <div className="bk-installer-spinner" />
          <span className="bk-run-title">Opening installer for {name}…</span>
        </div>
      )}

      {phase === 'cancelled' && (
        <div className="bk-run-stage">
          <div className="bk-run-title">Launch cancelled</div>
          <p className="bk-run-note center">Nothing was executed or changed.</p>
        </div>
      )}

      {phase === 'error' && (
        <div className="bk-run-stage">
          <div className="bk-run-title">Cannot open {name}</div>
          <p className="bk-run-note center">{error}</p>
        </div>
      )}
    </div>
  );
}