import type { FileStore } from '@bk/contracts';
import { resolveStorePath, storeToDisplay } from './path';
import { decodeText } from './text';

export interface CommandResult {
  /** 要追加到输出的文本行。 */
  lines: string[];
  /** 若为 true，调用方应清空当前屏幕（cls/clear）。 */
  clearScreen?: boolean;
}

const BANNER = [
  'Microsoft Windows [Version 10.0.22621]',
  '(c) Microsoft Corporation. All rights reserved.',
  '',
  'Type "help" for a list of commands.',
];

const MAX_TYPE_BYTES = 64 * 1024;

function fmtSize(n: number): string {
  return n.toLocaleString('en-US');
}

function fmtDate(ts: number): string {
  const d = new Date(ts);
  const p = (x: number): string => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}  ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * Windows 命令解释器（cmd.exe 的底层逻辑）。
 *
 * 完全 UI 无关：构造时注入一个 FileStore（虚拟 C: 盘），调用
 * execute(line) 返回纯文本输出行。UI 层（命令提示符）只负责渲染，
 * 测试/脚本也可直接驱动它。cwd 由解释器自身维护。
 */
export class CommandInterpreter {
  private _cwd = '';
  readonly fs: FileStore;

  constructor(fs: FileStore) {
    this.fs = fs;
  }

  /** 启动横幅。 */
  get banner(): string[] {
    return BANNER;
  }

  /** 当前工作目录（store 路径）。 */
  get cwd(): string {
    return this._cwd;
  }

  setCwd(path: string): void {
    this._cwd = path;
  }

  /** 当前目录的显示形式，如 C:\Windows。 */
  displayCwd(): string {
    return storeToDisplay(this._cwd);
  }

  async execute(line: string): Promise<CommandResult> {
    const trimmed = line.trim();
    if (trimmed === '') return { lines: [] };
    const parts = trimmed.split(/\s+/);
    const cmd = parts[0];
    if (!cmd) return { lines: [] };
    const args = parts.slice(1);
    const c = cmd.toLowerCase();

    try {
      switch (c) {
        case 'help':
          return {
            lines: [
              'Supported commands:',
              '  dir [path]        List directory contents',
              '  cd [path]         Change directory (cd .. to go up)',
              '  md / mkdir <name> Create a directory',
              '  rd / rmdir <name> Remove a directory',
              '  del / erase <file> Delete a file',
              '  type <file>       Print a text file',
              '  echo <text>       Print text',
              '  cls               Clear the screen',
              '  ver               Show version',
              '  whoami            Show current user',
              '  date / time       Show current date / time',
              '  exit              Close this window',
            ],
          };
        case 'ver':
          return { lines: ['Microsoft Windows [Version 10.0.22621]'] };
        case 'whoami':
          return { lines: ['BKPC\\user'] };
        case 'cls':
        case 'clear':
          return { lines: [], clearScreen: true };
        case 'date':
          return { lines: [fmtDate(Date.now()).split('  ')[0] ?? ''] };
        case 'time':
          return { lines: [fmtDate(Date.now()).split('  ')[1] ?? ''] };
        case 'echo':
          return { lines: [args.join(' ')] };
        case 'cd':
        case 'chdir': {
          if (args.length === 0 || args[0]!.trim() === '') {
            return { lines: [this.displayCwd()] };
          }
          const target = resolveStorePath(this._cwd, args[0]!);
          const stat = await this.fs.stat(target);
          if (!stat) return { lines: [`The system cannot find the path: ${storeToDisplay(target)}`] };
          if (stat.kind !== 'directory') return { lines: [`Not a directory: ${storeToDisplay(target)}`] };
          this._cwd = target;
          return { lines: [] };
        }
        case 'dir':
        case 'ls': {
          const target = args.length ? resolveStorePath(this._cwd, args[0]!) : this._cwd;
          const stat = await this.fs.stat(target);
          if (!stat) return { lines: [`The system cannot find the path: ${storeToDisplay(target)}`] };
          if (stat.kind === 'file') {
            return { lines: [`${storeToDisplay(target)}`, `  ${fmtSize(stat.size)} bytes`] };
          }
          const entries = await this.fs.listDirectory(target);
          const dirs = entries.filter((e) => e.kind === 'directory').sort((a, b) => a.name.localeCompare(b.name));
          const files = entries.filter((e) => e.kind === 'file').sort((a, b) => a.name.localeCompare(b.name));
          const out: string[] = [` Directory of ${storeToDisplay(target)}`, ''];
          for (const d of dirs) {
            out.push(`${(d.modified ? fmtDate(d.modified) : '').padEnd(20)}    <DIR>          ${d.name}`);
          }
          for (const f of files) {
            out.push(`${(f.modified ? fmtDate(f.modified) : '').padEnd(20)} ${fmtSize(f.size).padStart(14)} ${f.name}`);
          }
          let fileBytes = 0;
          for (const f of files) fileBytes += f.size;
          out.push('');
          out.push(`    ${files.length} File(s) ${fmtSize(fileBytes)} bytes`);
          out.push(`    ${dirs.length} Dir(s)`);
          return { lines: out };
        }
        case 'md':
        case 'mkdir': {
          const r = this.ensureFile(args[0]);
          if (!r.ok) return { lines: [r.err] };
          await this.fs.createDirectory(r.full);
          return { lines: [] };
        }
        case 'rd':
        case 'rmdir': {
          const r = this.ensureFile(args[0]);
          if (!r.ok) return { lines: [r.err] };
          await this.fs.removeDirectory(r.full);
          return { lines: [] };
        }
        case 'del':
        case 'erase': {
          const r = this.ensureFile(args[0]);
          if (!r.ok) return { lines: [r.err] };
          await this.fs.deleteFile(r.full);
          return { lines: [] };
        }
        case 'type': {
          const r = this.ensureFile(args[0]);
          if (!r.ok) return { lines: [r.err] };
          const file = await this.fs.openFile(r.full, 'read');
          try {
            const size = await file.size();
            if (size > MAX_TYPE_BYTES) {
              return { lines: [`File too large to display: ${storeToDisplay(r.full)} (${fmtSize(size)} bytes)`] };
            }
            const data = await file.read(0, size);
            return { lines: [decodeText(data)] };
          } finally {
            await file.close();
          }
        }
        case 'exit':
          return { lines: ['Use the window close button to exit.'] };
        default:
          return { lines: [`'${cmd}' is not recognized as a command. Type "help".`] };
      }
    } catch (err: unknown) {
      return { lines: [`Error: ${String(err)}`] };
    }
  }

  private ensureFile(name?: string): { ok: true; full: string } | { ok: false; err: string } {
    if (!name) return { ok: false, err: 'The syntax of the command is incorrect.' };
    const full = resolveStorePath(this._cwd, name);
    return { ok: true, full };
  }
}
