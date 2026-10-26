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
  'GIT_REPOSITORY_UNAVAILABLE',
  'GIT_INDEX_CHANGED',
  'GIT_NO_UPSTREAM',
  'GIT_OPERATION_NOT_FOUND',
  'SKILL_NOT_FOUND',
  'SKILL_SOURCE_UNAUTHORIZED',
  'SKILL_REJECTED',
  'SKILL_SYNC_CONFLICT',
  'QUICK_COMMAND_NOT_FOUND',
  'USAGE_PROFILE_NOT_FOUND',
  'USAGE_PROFILE_UNAUTHORIZED',
  'PREFLIGHT_NOT_FOUND',
  'PREFLIGHT_UNAUTHORIZED',
  'PREFLIGHT_AUTHORIZATION_REQUIRED',
  'PREFLIGHT_BUSY',
  'NOTIFICATION_NOT_FOUND',
  'NOTE_NOT_FOUND',
  'NOTE_CONFLICT',
  'JOB_NOT_FOUND',
  'JOB_TRANSITION_INVALID',
  'JOB_NOT_CANCELLABLE',
  'JOB_CONFIRMATION_REQUIRED',
  'FILE_NOT_FOUND',
  'FILE_ALREADY_EXISTS',
  'FILE_CONFLICT',
  'FILE_TOO_LARGE',
  'FILE_UNSUPPORTED',
  'FILE_OUTSIDE_WORKSPACE',
  'FILE_PERMISSION_DENIED',
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
  GIT_REPOSITORY_UNAVAILABLE:
    'This Git repository is not available. Open it from a project or a terminal and try again.',
  GIT_INDEX_CHANGED:
    'The staged changes or the current commit changed since you reviewed them. Review the changes again.',
  GIT_NO_UPSTREAM: 'This branch has no upstream branch. Choose where to push it.',
  GIT_OPERATION_NOT_FOUND: 'The Git operation could not be found. It may have finished.',
  SKILL_NOT_FOUND: 'The skill could not be found. It may have been removed.',
  SKILL_SOURCE_UNAUTHORIZED:
    'This folder is not an authorized skill source. Choose it in the folder picker or add it as a source.',
  SKILL_REJECTED: 'The skill cannot be imported safely. Review the reported problems.',
  SKILL_SYNC_CONFLICT:
    'A folder with this name already exists and was not created by ATLAS. Nothing was changed.',
  QUICK_COMMAND_NOT_FOUND: 'The quick command could not be found. It may have been removed.',
  USAGE_PROFILE_NOT_FOUND: 'The account profile could not be found. It may have been removed.',
  USAGE_PROFILE_UNAUTHORIZED:
    'This folder cannot be used as an account profile. Choose it in the folder picker.',
  PREFLIGHT_NOT_FOUND:
    'The Preflight workspace or run could not be found. It may have been removed.',
  PREFLIGHT_UNAUTHORIZED:
    'This folder cannot be validated. Choose it in the folder picker or register it as a project.',
  PREFLIGHT_AUTHORIZATION_REQUIRED:
    'Some checks need your authorization before they run. Review them and try again.',
  PREFLIGHT_BUSY: 'A Preflight run is already in progress for this workspace.',
  NOTIFICATION_NOT_FOUND: 'The notification could not be found. It may have been deleted.',
  NOTE_NOT_FOUND: 'The note could not be found. It may have been deleted.',
  NOTE_CONFLICT:
    'The note was changed elsewhere since you opened it. Reload it or save your version again.',
  JOB_NOT_FOUND: 'The background job could not be found. It may have been removed.',
  JOB_TRANSITION_INVALID: 'This action is not available in the current job status.',
  JOB_NOT_CANCELLABLE: 'This job cannot be stopped safely. Wait for it to finish.',
  JOB_CONFIRMATION_REQUIRED:
    'This command may change or delete data. Review the warnings and confirm to queue it.',
  FILE_NOT_FOUND: 'The file or folder could not be found. It may have been moved or deleted.',
  FILE_ALREADY_EXISTS: 'A file or folder with this name already exists. Nothing was overwritten.',
  FILE_CONFLICT:
    'The file was changed on disk since you opened it. Reload it or save your version again.',
  FILE_TOO_LARGE: 'This file is too large to open in the editor.',
  FILE_UNSUPPORTED: 'This file is binary or uses an encoding the editor does not support.',
  FILE_OUTSIDE_WORKSPACE: 'This path is outside the project folder.',
  FILE_PERMISSION_DENIED: 'ATLAS does not have permission to change this file or folder.',
  ENGINE_UNAVAILABLE:
    'The ATLAS Engine is not running. Start (or restart) A.T.L.A.S and try again.',
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
