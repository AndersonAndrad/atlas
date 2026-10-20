export const ERROR_CODES = [
  'PROJECT_NOT_FOUND',
  'PROJECT_ALREADY_EXISTS',
  'PROJECT_PATH_INVALID',
  'PROJECT_PATH_UNAVAILABLE',
  'PROJECT_PERMISSION_DENIED',
  'PROJECT_PERSISTENCE_ERROR',
  'TERMINAL_NOT_FOUND',
  'TERMINAL_NOT_RUNNING',
  'TERMINAL_LIMIT_REACHED',
  'TERMINAL_SHELL_UNAVAILABLE',
  'TERMINAL_START_FAILED',
  'SESSION_NOT_FOUND',
  'SESSION_TRANSITION_INVALID',
  'SESSION_CONFLICT',
  'SESSION_TASK_NOT_FOUND',
  'SESSION_TASK_CYCLE',
  'ENGINE_UNAVAILABLE',
  'VALIDATION_FAILED',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * Messages safe to show to end users. They intentionally omit filesystem
 * paths, SQL, and stack traces; technical details belong in `details` and logs.
 */
export const USER_MESSAGES: Record<ErrorCode, string> = {
  PROJECT_NOT_FOUND: 'The project could not be found. It may have been removed.',
  PROJECT_ALREADY_EXISTS: 'This directory is already registered as a project.',
  PROJECT_PATH_INVALID: 'The selected path is not a valid directory.',
  PROJECT_PATH_UNAVAILABLE: 'The selected directory does not exist or is not reachable.',
  PROJECT_PERMISSION_DENIED: 'ATLAS does not have permission to access this directory.',
  PROJECT_PERSISTENCE_ERROR: 'The project registry could not be saved. Please try again.',
  TERMINAL_NOT_FOUND: 'The terminal could not be found. It may have been closed.',
  TERMINAL_NOT_RUNNING: 'The terminal is no longer running.',
  TERMINAL_LIMIT_REACHED: 'Too many terminals are open. Close a terminal and try again.',
  TERMINAL_SHELL_UNAVAILABLE: 'The selected shell is not available on this computer.',
  TERMINAL_START_FAILED: 'The shell could not be started.',
  SESSION_NOT_FOUND: 'The session could not be found.',
  SESSION_TRANSITION_INVALID: 'This action is not available in the current session status.',
  SESSION_CONFLICT: 'The session was changed elsewhere. Reload it and try again.',
  SESSION_TASK_NOT_FOUND: 'The task could not be found. It may have been removed.',
  SESSION_TASK_CYCLE: 'Task dependencies cannot form a cycle.',
  ENGINE_UNAVAILABLE:
    'The ATLAS Engine is not running. Start (or restart) ATLAS Control and try again.',
  VALIDATION_FAILED: 'Some fields are invalid. Review them and try again.',
  INTERNAL_ERROR: 'An unexpected error occurred.',
};

export interface FieldIssue {
  field: string;
  message: string;
}

export interface AtlasErrorOptions {
  /** Internal diagnostic data. Never shown to users; may be logged. */
  details?: Record<string, unknown>;
  /** Field-level validation issues, safe to show to users. */
  issues?: FieldIssue[];
  cause?: unknown;
}

export class AtlasError extends Error {
  readonly code: ErrorCode;
  readonly userMessage: string;
  readonly details: Record<string, unknown>;
  readonly issues: FieldIssue[];

  constructor(code: ErrorCode, message?: string, options: AtlasErrorOptions = {}) {
    super(message ?? USER_MESSAGES[code], { cause: options.cause });
    this.name = 'AtlasError';
    this.code = code;
    this.userMessage = USER_MESSAGES[code];
    this.details = options.details ?? {};
    this.issues = options.issues ?? [];
  }
}

export function isAtlasError(value: unknown): value is AtlasError {
  return value instanceof AtlasError;
}

/** Serializable error shape for crossing process boundaries (IPC, CLI output). */
export interface SerializedError {
  code: ErrorCode;
  message: string;
  issues: FieldIssue[];
}

export function toSerializedError(error: unknown): SerializedError {
  if (isAtlasError(error)) {
    return { code: error.code, message: error.userMessage, issues: error.issues };
  }
  return { code: 'INTERNAL_ERROR', message: USER_MESSAGES.INTERNAL_ERROR, issues: [] };
}
