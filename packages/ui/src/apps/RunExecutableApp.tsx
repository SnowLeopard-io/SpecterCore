import { useCallback, useEffect, useRef, useState } from 'react';
import { CanvasGdiBridge } from '@specter-core/bridges';
import { extractPeIcon, parsePe, toStorePath } from '@specter-core/shared';
import { tokens } from '@specter-core/contracts';
import {
  GuestProcessRunner,
  JitEngineImpl,
  UnsupportedError,
  WasmRuntimeImpl,
  X86Decoder,
  type GuestMenuSection,
  type GuestProcessResult,
} from '@specter-core/core';
import { useUi } from '../context';
import { setGuestText, useGuestText } from '../guest-text';
import { setGuestGdiBridge, guestGdiBridgeProvider } from '../gdi-bridge-registry';

interface RunExecutableProps {
  /** 要运行的 .exe（store 路径），来自 open 动词或桌面拖入。 */
  initialFile?: string;
  /**
   * Windows-style module path used for MUI satellite lookup and reported to
   * GetModuleFileNameW. Set for built-in apps (e.g. the bundled notepad) so
   * readFile can resolve "<dir>/<lang>/<base>.mui" against the virtual disk.
   */
  modulePath?: string;
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

interface GuestWindowViewProps {
  runner: GuestProcessRunner;
  hwnd: number;
  editHwnd: number | null;
  menu: GuestMenuSection[];
}
/** Content of a guest window hosted as a real L6 desktop window (Layer 3).
 * Renders the menu bar + a GDI canvas for pixel output, with the EDIT control
 * textarea overlaid on top (transparent background) so typing goes straight
 * into the guest via runner.postText. Closing the window posts WM_CLOSE so
 * the guest process terminates. */
export function GuestWindowView({ runner, hwnd, editHwnd, menu }: GuestWindowViewProps) {
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Live text of the guest EDIT control: notepad's own WM_SETTEXT (New,
  // paste, ...) flows back through onTextChanged -> setGuestText.
  const text = useGuestText(editHwnd);

  // Register a CanvasGdiBridge for this window so guest GDI calls
  // (BeginPaint/TextOut/FillRect/...) render pixels to our canvas.
  // Post WM_PAINT afterwards so the guest repaints through the new bridge.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const bridge = new CanvasGdiBridge(canvas);
    setGuestGdiBridge(hwnd, bridge);
    // Trigger a repaint through the pixel path.
    runner.postMessage({ hwnd, msg: 0x000f /* WM_PAINT */, wParam: 0, lParam: 0 });
    return () => {
      setGuestGdiBridge(hwnd, null);
    };
  }, [hwnd, runner]);

  // Resize: when the desktop window (and thus the canvas CSS box) changes
  // size, sync the canvas pixel buffer to match and notify the guest with
  // WM_SIZE so it repaints into the new client area. MAKELONG(cx, cy):
  // low 16 = cx, high 16 = cy. Setting canvas.width/height clears the
  // surface, so we coalesce into a rAF and always follow with WM_SIZE.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === 'undefined') return;
    let raf = 0;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const w = Math.max(1, Math.round(entry.contentRect.width));
      const h = Math.max(1, Math.round(entry.contentRect.height));
      if (canvas.width === w && canvas.height === h) return;
      canvas.width = w;
      canvas.height = h;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const lParam = ((h & 0xffff) << 16) | (w & 0xffff);
        runner.postMessage({ hwnd, msg: 0x0005 /* WM_SIZE */, wParam: 0 /* SIZE_RESTORED */, lParam });
      });
    });
    ro.observe(canvas);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [hwnd, runner]);

  useEffect(() => {
    // Window closed (unmounted) -> tell the guest to close too.
    return () => {
      runner.postMessage({ hwnd, msg: 0x0010 /* WM_CLOSE */, wParam: 0, lParam: 0 });
    };
  }, [runner, hwnd]);

  // Real menu only — no fallback: keep the sections the RT_MENU parser
  // produced (File/Edit parse fully; nested submenus flatten into items).
  // Ampersands are Win32 accelerator markers ("&File" -> "File").
  const stripAmps = (s: string): string => s.replace(/&/g, '');
  const sections = menu.filter(
    (s) => s.items.length > 0 && !s.title.includes('\t') && /^[A-Za-z&]/.test(s.title),
  );
  return (
    <div className="sc-gwin">
      {sections.length > 0 && (
        <div className="sc-gwin-menubar">
        {sections.map((s) => (
          <div className={`sc-gwin-menu ${openMenu === s.title ? 'open' : ''}`} key={s.title}>
            <span
              className="sc-gwin-menu-title"
              onClick={() => setOpenMenu(openMenu === s.title ? null : s.title)}
            >
              {stripAmps(s.title)}
            </span>
            {openMenu === s.title && (
              <div className="sc-gwin-menu-pop">
                {s.items.map((it) => (
                  <button
                    key={`${s.title}-${it.id}-${it.label}`}
                    className="sc-gwin-menu-item"
                    onClick={() => {
                      setOpenMenu(null);
                      runner.postMessage({ hwnd, msg: 0x0111 /* WM_COMMAND */, wParam: it.id, lParam: 0 });
                    }}
                  >
                    {stripAmps(it.label)}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
        </div>
      )}
      <div className="sc-gwin-canvas-container">
        <canvas ref={canvasRef} width={800} height={560} className="sc-gwin-canvas" />
        {editHwnd && (
          <textarea
            className="sc-gwin-edit-overlay"
            value={text}
            onChange={(e) => {
              const t = e.target.value;
              if (editHwnd) {
                runner.postText(editHwnd, t);
                setGuestText(editHwnd, t);
              }
            }}
            spellCheck={false}
          />
        )}
      </div>
    </div>
  );
}

export function RunExecutableApp({ initialFile, modulePath }: RunExecutableProps) {
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
  const [guestResult, setGuestResult] = useState<GuestProcessResult | null>(null);
  const [tab, setTab] = useState<'console' | 'windows'>('windows');
  const [liveWindows, setLiveWindows] = useState<GuestProcessResult['windows']>([]);
  const [editText, setEditText] = useState('');
  const [interacting, setInteracting] = useState(false);
  const iconRef = useRef<string | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const runnerRef = useRef<GuestProcessRunner | null>(null);
  const editHwndRef = useRef<number | null>(null);
  /** guest HWND -> L6 window id, so each guest top-level window is created once. */
  const guestWinIds = useRef<Map<number, string>>(new Map());

  const ensureGuestWindows = useCallback(
    async (runner: GuestProcessRunner): Promise<void> => {
      const wins = runner.getWindows();
      const wm = kernel.container.resolve(tokens.uiWindows);
      for (const w of wins) {
        if (w.parent !== 0 || guestWinIds.current.has(w.hwnd)) continue;
        const edit = wins.find((c) => c.parent === w.hwnd && c.className.toLowerCase() === 'edit');
        const handle = await wm.createWindow({
          title: `${w.className}${w.text ? ` — ${w.text}` : ''}`,
          width: 680,
          height: 500,
          icon: '📝',
          resizable: true,
          appId: 'guest-window',
          content: {
            kind: 'react',
            render: () => (
              <GuestWindowView
                runner={runner}
                hwnd={w.hwnd}
                editHwnd={edit ? edit.hwnd : null}
                menu={w.menu}
              />
            ),
          },
        });
        guestWinIds.current.set(w.hwnd, handle.id);
      }
    },
    [kernel],
  );

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
    setGuestResult(null);
    setLiveWindows([]);
    setEditText('');
    setInteracting(false);
    setTab('windows');
    const image = source.image;
    const decode = new TextDecoder();

    let runtime: WasmRuntimeImpl;
    try {
      const interceptor = kernel.container.resolve(tokens.coreApi);
      const loader = kernel.container.resolve(tokens.corePe);
      runtime = kernel.container.resolve(tokens.coreWasmRuntime) as WasmRuntimeImpl;
      const jit = kernel.container.resolve(tokens.coreJit);
      const runner = new GuestProcessRunner(runtime, jit, loader, interceptor);
      runnerRef.current = runner;
      // Bundled notepad: even when dragged in from outside, resolve its MUI
      // satellite resources from the virtual disk — real strings/menus, no
      // S<id> placeholders or fallback menus.
      const resolvedModulePath =
        modulePath ?? (source.name.toLowerCase() === 'notepad.exe' ? 'C:/Windows/SysWOW64/notepad.exe' : '');
      const result = await runner.run(image, {
        createEngine: (mode) => new JitEngineImpl(runtime, mode),
        modulePath: resolvedModulePath,
        // MUI satellite resources come from the virtual disk (the bundled
        // notepad + its .mui are provisioned there at startup).
        readFile: async (p) => {
          if (!fs) return null;
          const sp = toStorePath(p);
          try {
            const f = await fs.openFile(sp, 'read');
            try {
              const size = await f.size();
              return await f.read(0, size);
            } finally {
              await f.close();
            }
          } catch {
            return null;
          }
        },
        // Interactive: the message loop blocks at GetMessageW instead of
        // exiting, so the window panel below is a live, typeable notepad.
        interactive: true,
        gdiBridge: (hwnd) => guestGdiBridgeProvider(hwnd),
        onMessageWait: () => {
          const wins = runner.getWindows();
          setLiveWindows(wins);
          const edit = wins.find((w) => w.className.toLowerCase() === 'edit');
          editHwndRef.current = edit ? edit.hwnd : null;
          if (edit) setEditText(edit.text);
          setInteracting(true);
          // Host each guest top-level window as a real desktop window.
          void ensureGuestWindows(runner);
        },
        onTextChanged: (_hwnd, text) => setEditText(text),
        onOutput: (bytes) => {
          setOutput((prev) => prev + decode.decode(bytes).replace(/\r\n/g, '\n'));
        },
      });
      runnerRef.current = null;
      setInteracting(false);
      setGuestResult(result);
      let text: string;
      switch (result.status) {
        case 'exit':
          text = result.cleanExit
            ? `\n[process exited with code ${result.exitCode}]`
            : `\n[process returned without calling ExitProcess — startup aborted (eip=0x${result.eip.toString(16)})]`;
          if (result.muiLoaded) text += `\n[MUI] merged: ${result.muiSource}`;
          else text += '\n[MUI] NOT loaded — fallback strings/menus in use';
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
  }, [source, kernel, ensureGuestWindows, fs, modulePath]);

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
    <div className="sc-run">
      {phase === 'confirm' && (
        <>
          <div className="sc-run-head">
            <span className="sc-run-icon">
              {iconUrl ? <img src={iconUrl} alt="" /> : '⚠️'}
            </span>
            <div>
              <div className="sc-run-title">Open File — Security Warning</div>
              <div className="sc-run-subtitle">Do you want to run this file?</div>
            </div>
          </div>
          <div className="sc-run-file">
            <span className="sc-run-name">{name}</span>
            {pe && (
              <span className="sc-run-meta">
                {pe.arch} · {pe.subsystem} · {pe.sections} section(s)
              </span>
            )}
            {!pe && <span className="sc-run-meta">PE header not recognized</span>}
          </div>
          <p className="sc-run-note">
            Running executes the program inside the browser sandbox with the core
            PE loader and the x86/x64 JIT engine. Program output is rendered live
            in the console below.
          </p>
          <div className="sc-run-actions">
            <button className="sc-nt-btn" onClick={pickLocal}>
              Open local .exe…
            </button>
            <button className="sc-nt-btn" onClick={() => setPhase('cancelled')}>
              Cancel
            </button>
            <button className="sc-nt-btn" onClick={install} disabled={!initialFile}>
              Install
            </button>
            <button className="sc-nt-btn primary" onClick={() => void run()} disabled={!source}>
              Run
            </button>
          </div>
        </>
      )}

      {phase === 'running' && (
        <div className="sc-run-running">
          <div className="sc-tabs">
            <button className={tab === 'console' ? 'active' : ''} onClick={() => setTab('console')}>
              Console
            </button>
            <button className={tab === 'windows' ? 'active' : ''} onClick={() => setTab('windows')}>
              Windows{interacting ? ' (live)' : ''}
            </button>
          </div>

          {tab === 'console' ? (
            <div className="sc-console">
              <div className="sc-console-head">
                <span className="sc-console-dot" />
                <span className="sc-console-title">{name}</span>
              </div>
              <div className="sc-console-body" ref={bodyRef}>
                {output === '' && !status ? (
                  <div className="sc-console-empty">running…</div>
                ) : (
                  <pre className="sc-console-pre">
                    {output}
                    {status}
                  </pre>
                )}
              </div>
            </div>
          ) : interacting ? (
            <div className="sc-run-stage">
              <div className="sc-run-title">Guest window is open on the desktop</div>
              <p className="sc-run-note center">
                notepad runs as a real desktop window — type in its editor, use its menu,
                or close it to exit the process.
              </p>
            </div>
          ) : (
            <div className="sc-guest">
              <div className="sc-guest-head">
                <span className="sc-console-dot" />
                <span className="sc-console-title">Guest Window (GUI bridge)</span>
              </div>
              <div className="sc-guest-stage">
                {(() => {
                  const wins = liveWindows.length > 0 ? liveWindows : (guestResult?.windows ?? []);
                  return wins
                    .filter((w) => w.parent === 0)
                    .map((w, idx) => {
                      const edit = wins.find((c) => c.parent === w.hwnd && c.className.toLowerCase() === 'edit');
                      return (
                        <div className="sc-win" key={w.hwnd}>
                          <div className="sc-win-title">
                            <span className="sc-win-name">
                              {w.className}
                              {w.text ? ` — ${w.text}` : ''}
                            </span>
                            <span className="sc-win-id">0x{w.hwnd.toString(16)}</span>
                            <button
                              className="sc-win-close"
                              title="Close window (WM_CLOSE)"
                              onClick={() => {
                                runnerRef.current?.postMessage({ hwnd: w.hwnd, msg: 0x0010 /* WM_CLOSE */, wParam: 0, lParam: 0 });
                              }}
                            >
                              ✕
                            </button>
                          </div>
                          <div className="sc-win-body">
                            {idx === 0 &&
                              (guestResult?.paintCommands ?? []).map((p, i) => (
                                <span
                                  key={i}
                                  className={`sc-paint sc-paint-${p.op}`}
                                  style={{ left: p.x, top: p.y, width: p.w, height: p.h }}
                                >
                                  {p.text}
                                </span>
                              ))}
                            {edit ? (
                              <div
                                className="sc-win-edit"
                                contentEditable={interacting}
                                suppressContentEditableWarning
                                onInput={(e) => {
                                  const text = e.currentTarget.textContent ?? '';
                                  const hwnd = editHwndRef.current;
                                  if (hwnd) runnerRef.current?.postText(hwnd, text);
                                  setEditText(text);
                                }}
                              >
                                {editText}
                                {!interacting && <span className="sc-win-caret" />}
                              </div>
                            ) : (
                              idx === 0 &&
                              (guestResult?.paintCommands.length ?? 0) === 0 && (
                                <div className="sc-win-empty">no paint commands</div>
                              )
                            )}
                          </div>
                        </div>
                      );
                    });
                })()}
                {(() => {
                  const wins = liveWindows.length > 0 ? liveWindows : (guestResult?.windows ?? []);
                  return wins.filter((w) => w.parent === 0).length === 0 && (
                    <div className="sc-win-empty">no top-level windows</div>
                  );
                })()}
              </div>
              <div className="sc-guest-list">
                {(() => {
                  const wins = liveWindows.length > 0 ? liveWindows : (guestResult?.windows ?? []);
                  return wins.map((w) => (
                    <div className="sc-guest-item" key={w.hwnd}>
                      <span className="sc-guest-hwnd">0x{w.hwnd.toString(16)}</span>
                      <span className="sc-guest-class">{w.className}</span>
                      <span className="sc-guest-proc">wndProc=0x{w.wndProc.toString(16)}</span>
                      <span className="sc-guest-text">"{w.text}"</span>
                    </div>
                  ));
                })()}
              </div>
            </div>
          )}
        </div>
      )}

      {phase === 'installing' && (
        <div className="sc-run-stage">
          <div className="sc-installer-spinner" />
          <span className="sc-run-title">Opening installer for {name}…</span>
        </div>
      )}

      {phase === 'cancelled' && (
        <div className="sc-run-stage">
          <div className="sc-run-title">Launch cancelled</div>
          <p className="sc-run-note center">Nothing was executed or changed.</p>
        </div>
      )}

      {phase === 'error' && (
        <div className="sc-run-stage">
          <div className="sc-run-title">Cannot open {name}</div>
          <p className="sc-run-note center">{error}</p>
        </div>
      )}
    </div>
  );
}