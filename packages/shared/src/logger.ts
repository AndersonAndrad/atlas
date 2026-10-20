export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogContext = Record<string, unknown>;

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
}

export const noopLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** Converts an unknown thrown value into log-friendly data, including the cause chain. */
export function describeError(error: unknown, depth = 0): LogContext {
  if (!(error instanceof Error)) {
    return { value: String(error) };
  }
  const described: LogContext = {
    name: error.name,
    message: error.message,
    stack: error.stack,
  };
  const code = (error as { code?: unknown }).code;
  if (code !== undefined) {
    described.code = code;
  }
  const details = (error as { details?: unknown }).details;
  if (details !== undefined) {
    described.details = details;
  }
  if (error.cause !== undefined && depth < 3) {
    described.cause = describeError(error.cause, depth + 1);
  }
  return described;
}
