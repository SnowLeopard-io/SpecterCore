import { useEffect, useMemo, useRef, useState } from 'react';
import type { FileStore } from '@bk/contracts';
import { CommandInterpreter } from '@bk/shared';
import { useUi } from '../context';

interface Line {
  text: string;
  kind?: 'input' | 'error' | 'system';
}

/** Command Prompt (cmd.exe) — a thin UI over the reusable CommandInterpreter. */
export function CommandPromptApp() {
  const { controller } = useUi();
  const fs = controller.getFileSystem() as FileStore | null;

  const interpreter = useMemo(() => (fs ? new CommandInterpreter(fs) : null), [fs]);

  const [lines, setLines] = useState<Line[]>(() =>
    (interpreter?.banner ?? []).map((t) => ({ text: t, kind: 'system' as const })),
  );
  const [input, setInput] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [histIndex, setHistIndex] = useState(-1);

  const bodyRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [lines]);

  const print = (newLines: string[], kind?: Line['kind']): void => {
    setLines((prev) => [...prev, ...newLines.map((t) => ({ text: t, kind }))]);
  };

  const execute = async (raw: string): Promise<void> => {
    setLines((prev) => [...prev, { text: `${interpreter?.displayCwd() ?? 'C:\\'}>${raw}`, kind: 'input' }]);
    if (raw.trim() === '') return;
    setHistory((h) => [...h, raw]);
    setHistIndex(-1);

    if (!interpreter) {
      print(['No virtual disk available in this environment.'], 'error');
      return;
    }

    const result = await interpreter.execute(raw);
    if (result.clearScreen) {
      setLines([]);
      return;
    }
    if (result.lines.length > 0) print(result.lines, 'system');
  };

  const onSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    const value = input;
    setInput('');
    void execute(value);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (history.length === 0) return;
      const idx = histIndex < 0 ? history.length - 1 : Math.max(0, histIndex - 1);
      setHistIndex(idx);
      setInput(history[idx]!);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (histIndex < 0) return;
      const idx = histIndex + 1;
      if (idx >= history.length) {
        setHistIndex(-1);
        setInput('');
      } else {
        setHistIndex(idx);
        setInput(history[idx]!);
      }
    }
  };

  const cwd = interpreter?.displayCwd() ?? 'C:\\';

  return (
    <div className="bk-cmd" onClick={() => inputRef.current?.focus()}>
      <div className="bk-cmd-body" ref={bodyRef}>
        {lines.map((l, i) => (
          <div key={i} className={`bk-cmd-line ${l.kind ?? ''}`}>
            {l.text === '' ? ' ' : l.text}
          </div>
        ))}
      </div>
      <form className="bk-cmd-input-row" onSubmit={onSubmit}>
        <span className="bk-cmd-prompt">{cwd}</span>
        <input
          ref={inputRef}
          className="bk-cmd-input"
          value={input}
          autoFocus
          spellCheck={false}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
        />
      </form>
    </div>
  );
}
