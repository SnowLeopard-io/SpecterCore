import type { Logger } from '@bk/contracts';

export enum LogLevel {
  TRACE = 0,
  DEBUG = 1,
  INFO = 2,
  WARN = 3,
  ERROR = 4,
  SILENT = 5,
}

const LEVEL_NAMES: Record<number, string> = {
  [LogLevel.TRACE]: 'TRACE',
  [LogLevel.DEBUG]: 'DEBUG',
  [LogLevel.INFO]: 'INFO',
  [LogLevel.WARN]: 'WARN',
  [LogLevel.ERROR]: 'ERROR',
};

export class ConsoleLogger implements Logger {
  constructor(
    private readonly level: LogLevel = LogLevel.INFO,
    private readonly sink: Pick<Console, 'debug' | 'info' | 'warn' | 'error' | 'log'> = console,
    private readonly scope = 'kernel',
  ) {}

  private write(lvl: LogLevel, method: keyof Pick<Console, 'debug' | 'info' | 'warn' | 'error' | 'log'>, message: string, args: unknown[]): void {
    if (lvl < this.level) return;
    const label = LEVEL_NAMES[lvl];
    const call = this.sink[method] as (...a: unknown[]) => void;
    call(`[${label}] [${this.scope}] ${message}`, ...args);
  }

  trace(message: string, ...args: unknown[]): void {
    this.write(LogLevel.TRACE, 'debug', message, args);
  }
  debug(message: string, ...args: unknown[]): void {
    this.write(LogLevel.DEBUG, 'debug', message, args);
  }
  info(message: string, ...args: unknown[]): void {
    this.write(LogLevel.INFO, 'info', message, args);
  }
  warn(message: string, ...args: unknown[]): void {
    this.write(LogLevel.WARN, 'warn', message, args);
  }
  error(message: string, ...args: unknown[]): void {
    this.write(LogLevel.ERROR, 'error', message, args);
  }
}

export const silentLogger: Logger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
};