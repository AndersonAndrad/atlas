import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import type { LogContext, LogLevel, Logger } from '@atlas/shared';

const MAX_LOG_BYTES = 5 * 1024 * 1024;
const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface FileLoggerOptions {
  filePath: string;
  minLevel?: LogLevel;
  component: string;
}

/**
 * Writes newline-delimited JSON logs. Logging failures are swallowed so that
 * diagnostics can never break application behavior.
 */
export class FileLogger implements Logger {
  private readonly minLevel: LogLevel;
  private ready = false;

  constructor(private readonly options: FileLoggerOptions) {
    this.minLevel = options.minLevel ?? 'info';
  }

  debug(message: string, context?: LogContext): void {
    this.write('debug', message, context);
  }
  info(message: string, context?: LogContext): void {
    this.write('info', message, context);
  }
  warn(message: string, context?: LogContext): void {
    this.write('warn', message, context);
  }
  error(message: string, context?: LogContext): void {
    this.write('error', message, context);
  }

  private write(level: LogLevel, message: string, context?: LogContext): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) return;
    try {
      if (!this.ready) {
        mkdirSync(path.dirname(this.options.filePath), { recursive: true });
        this.ready = true;
      }
      this.rotateIfNeeded();
      const entry = {
        time: new Date().toISOString(),
        level,
        component: this.options.component,
        message,
        ...(context ? { context } : {}),
      };
      appendFileSync(this.options.filePath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    } catch {
      // Intentionally ignored.
    }
  }

  private rotateIfNeeded(): void {
    const size = statSync(this.options.filePath, { throwIfNoEntry: false })?.size ?? 0;
    if (size > MAX_LOG_BYTES) {
      renameSync(this.options.filePath, `${this.options.filePath}.1`);
    }
  }
}
