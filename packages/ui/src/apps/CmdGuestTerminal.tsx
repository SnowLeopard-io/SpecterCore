import { useEffect, useRef, useState } from 'react';
import type { GuestProcessRunner } from '@specter-core/core';
import type { CmdConsoleChannel } from '../console-channel';

interface CmdGuestTerminalProps {
  runner: GuestProcessRunner;
  channel: CmdConsoleChannel;
  /** Closes the host window (provided by DesktopController). */
  onClose: () => void;
}

interface Line {
  text: string;
  kind?: 'input' | 'error' | 'system' | 'exit';
}

/**
 * Terminal view for a REAL guest cmd.exe (run by DesktopController via
 * GuestProcessRunner). Output streams in through `channel`; keystrokes are
 * posted to the guest stdin with a trailing CRLF (real console line
 * terminator). Because the emulator has no conhost, the guest does not echo
 * input — so we echo the submitted command locally.
 */
export function CmdGuestTerminal({ runner, channel, onClose }: CmdGuestTerminalProps) {
  const [lines, setLines] = useState<Line[]>([]);
  const [input, setInput] = useState('');
  const [exited, setExited] = useState<{ code: number; message: string | null } | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const decoder = useRef(new TextDecoder('utf-8'));

  useEffect(() => {
    const render = (bytes: Uint8Array, _stderr: boolean): void => {
      const text = decoder.current.decode(bytes, { stream: true });
      setLines((prev) => [...prev, { text, kind: 'system' }]);
    };
    channel.attach(render);
    channel.onExit((code, message) => setExited({ code, message }));
    return () => channel.detach();
  }, [channel]);

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    if (exited) inputRef.current?.blur();
  }, [lines, exited]);

  useEffect(() => {
    // Focus the input line whenever the guest is still alive.
    if (!exited) inputRef.current?.focus();
  }, [exited]);

  const onSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    if (exited) return;
    const value = input;
    setLines((prev) => [...prev, { text: value, kind: 'input' }]);
    setInput('');
    // Real console line terminator. We ship the finished line + CRLF to the
    // guest stdin queue; the guest performs its own line editing/echo path.
    runner.postInput(value + '\r\n');
  };

  return (
    <div className="sc-cmd" onClick={() => !exited && inputRef.current?.focus()}>
      <div className="sc-cmd-body" ref={bodyRef}>
        {lines.map((l, i) => (
          <div key={i} className={`sc-cmd-line ${l.kind ?? ''}`}>
            {l.text === '' ? ' ' : l.text}
          </div>
        ))}
        {exited && (
          <div className="sc-cmd-exit">
            <span>
              {exited.message
                ? `Process terminated: ${exited.message}`
                : `Process exited with code ${exited.code}.`}
            </span>
            <button type="button" className="sc-cmd-close" onClick={onClose}>
              Close
            </button>
          </div>
        )}
      </div>
      {!exited && (
        <form className="sc-cmd-input-row" onSubmit={onSubmit}>
          <span className="sc-cmd-caret">&gt;</span>
          <input
            ref={inputRef}
            className="sc-cmd-input"
            value={input}
            autoFocus
            spellCheck={false}
            onChange={(e) => setInput(e.target.value)}
          />
        </form>
      )}
    </div>
  );
}
