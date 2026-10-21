import {
  GitOperationLogSettingsSchema,
  UpdateGitOperationLogSettingsSchema,
  parseInput,
  type GitCommandRecord,
  type GitOperation,
  type GitOperationKind,
  type GitOperationLogDetails,
  type GitOperationLogEntry,
  type GitOperationLogPage,
  type GitOperationLogSettings,
  type GitOperationStatus,
  type GitReflogEntry,
} from '@atlas/contracts';
import { AtlasError, describeError, noopLogger, type Logger } from '@atlas/shared';
import type { GitOperationCoordinator, GitOperationJournal } from './coordinator.js';
import { GitCommandError, type GitExecutor } from './runner.js';
import { redactCredentials, redactTail } from './sanitize.js';

export const GIT_LOG_SETTINGS_KEY = 'git.operationLog';
/** Output kept per stream and command; longer output keeps its end. */
export const GIT_LOG_OUTPUT_LIMIT = 64 * 1024;
/**
 * Output stored for all commands of one operation. Once used up (e.g. large status
 * listings), later commands keep only GIT_LOG_OUTPUT_MINIMUM characters per stream.
 */
export const GIT_LOG_OPERATION_OUTPUT_BUDGET = 256 * 1024;
export const GIT_LOG_OUTPUT_MINIMUM = 4 * 1024;
/** Pruning runs at start and after this many finished operations. */
const PRUNE_EVERY = 50;
const DAY_MS = 86_400_000;
/** Reflog times have second precision; a change this close to an operation matches it. */
const REFLOG_MATCH_SLACK_MS = 1000;

/**
 * Operations that can write each kind of reflog entry. Staging, fetching and pushing
 * never move HEAD, so a change during them always came from elsewhere.
 */
const REFLOG_SOURCES: [RegExp, GitOperationKind[]][] = [
  [/^commit\b/, ['commit']],
  [/^checkout$/, ['switch-branch', 'create-branch']],
  [/^merge\b/, ['merge']],
  [/^pull\b/, ['pull']],
  [/^reset$/, ['abort-merge']],
  [/^branch$/i, ['rename-branch']],
];

const sourcesOf = (action: string): GitOperationKind[] =>
  REFLOG_SOURCES.find(([pattern]) => pattern.test(action))?.[1] ?? [];

export interface GitOperationLogFilter {
  repositoryRoot?: string;
  kind?: GitOperationKind;
  status?: GitOperationStatus;
  before?: string;
  limit: number;
}

/** Persistence of the operation log (SQLite in `@atlas/persistence`). */
export interface GitOperationLogStore {
  /** Inserts or replaces the operation's current state. */
  saveOperation(operation: GitOperation): Promise<void>;
  saveCommand(record: GitCommandRecord): Promise<void>;
  /** Newest first. */
  listOperations(filter: GitOperationLogFilter): Promise<GitOperationLogEntry[]>;
  getOperation(id: string): Promise<GitOperationLogEntry | null>;
  listCommands(operationId: string): Promise<GitCommandRecord[]>;
  /** Operations of a repository that were running at some time between `from` and `to`. */
  operationsBetween(repositoryRoot: string, from: string, to: string): Promise<GitOperation[]>;
  /** Marks operations left queued or running (ATLAS stopped) as cancelled. */
  interruptUnfinished(at: string): Promise<number>;
  /** Removes operations that started before `before` and all but the newest `keep`. */
  prune(before: string, keep: number): Promise<number>;
}

/** Application settings storage (`application_settings`). */
export interface LogSettingsStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

export interface GitOperationLogOptions {
  store: GitOperationLogStore;
  settings: LogSettingsStore;
  now?: () => Date;
  logger?: Logger;
}

function storedOutput(text: string, limit: number): { text: string | null; truncated: boolean } {
  // Porcelain output is NUL-separated; NUL is not useful (nor safe) in stored text.
  const plain = text.replace(/\0/g, '\n');
  if (plain.trim() === '') return { text: null, truncated: false };
  if (plain.length <= limit) return { text: redactCredentials(plain), truncated: false };
  return { text: redactTail(plain, limit), truncated: true };
}

/** Output characters already stored per running operation. */
const storedPerOperation = new WeakMap<object, number>();

/**
 * Persistent log of the Git operations ATLAS runs (PLAN-016): every status change of
 * an operation and every Git command it executed, with credential-free output.
 * Logging never changes the outcome of an operation: failures are only reported.
 */
export class GitOperationLog implements GitOperationJournal {
  private readonly logger: Logger;
  private readonly now: () => Date;
  private finished = 0;

  constructor(private readonly options: GitOperationLogOptions) {
    this.logger = options.logger ?? noopLogger;
    this.now = options.now ?? (() => new Date());
  }

  /** Closes what a previous run left unfinished and applies the retention. */
  async start(): Promise<void> {
    const interrupted = await this.options.store.interruptUnfinished(this.now().toISOString());
    if (interrupted > 0) {
      this.logger.warn('Git operations left unfinished by a previous run were closed', {
        count: interrupted,
      });
    }
    await this.prune();
  }

  operationChanged(operation: GitOperation): void {
    void this.options.store.saveOperation(operation).catch((error: unknown) => {
      this.logger.warn('Git operation could not be logged', {
        kind: operation.kind,
        error: describeError(error),
      });
    });
    if (operation.status === 'queued' || operation.status === 'running') return;
    this.finished += 1;
    if (this.finished % PRUNE_EVERY === 0) void this.prune();
  }

  commandFinished(record: GitCommandRecord): void {
    void this.options.store.saveCommand(record).catch((error: unknown) => {
      this.logger.warn('Git command could not be logged', { error: describeError(error) });
    });
  }

  async list(filter: GitOperationLogFilter): Promise<GitOperationLogPage> {
    const operations = await this.options.store.listOperations({
      ...filter,
      limit: filter.limit + 1,
    });
    const page = operations.slice(0, filter.limit);
    return {
      operations: page,
      nextBefore: operations.length > filter.limit ? page.at(-1)!.startedAt : null,
    };
  }

  async details(id: string): Promise<GitOperationLogDetails> {
    const operation = await this.options.store.getOperation(id);
    if (operation === null) throw new AtlasError('GIT_OPERATION_NOT_FOUND');
    return { operation, commands: await this.options.store.listCommands(id) };
  }

  /**
   * Marks reflog entries made while a logged ATLAS operation that can produce them was
   * running. Matched by time and kind only: a terminal change at the same second as an
   * ATLAS operation of the same kind is indistinguishable.
   */
  async attribute(
    repositoryRoot: string,
    entries: Omit<GitReflogEntry, 'atlasOperationId'>[],
  ): Promise<GitReflogEntry[]> {
    const times = entries
      .map((entry) => (entry.date === null ? Number.NaN : Date.parse(entry.date)))
      .filter((time) => !Number.isNaN(time));
    if (times.length === 0) return entries.map((entry) => ({ ...entry, atlasOperationId: null }));
    const operations = await this.options.store.operationsBetween(
      repositoryRoot,
      new Date(Math.min(...times) - REFLOG_MATCH_SLACK_MS).toISOString(),
      new Date(Math.max(...times) + REFLOG_MATCH_SLACK_MS).toISOString(),
    );
    return entries.map((entry) => {
      const time = entry.date === null ? Number.NaN : Date.parse(entry.date);
      const kinds = sourcesOf(entry.action);
      const match = operations.find((operation) => {
        if (Number.isNaN(time) || operation.status !== 'succeeded') return false;
        if (!kinds.includes(operation.kind)) return false;
        const start = Date.parse(operation.startedAt) - REFLOG_MATCH_SLACK_MS;
        const end = Date.parse(operation.finishedAt ?? operation.startedAt) + REFLOG_MATCH_SLACK_MS;
        return time >= start && time <= end;
      });
      return { ...entry, atlasOperationId: match?.id ?? null };
    });
  }

  async settings(): Promise<GitOperationLogSettings> {
    const raw = await this.options.settings.get(GIT_LOG_SETTINGS_KEY);
    let value: unknown;
    try {
      value = raw === null ? {} : JSON.parse(raw);
    } catch {
      value = undefined;
    }
    const parsed = GitOperationLogSettingsSchema.safeParse(value);
    if (!parsed.success) {
      this.logger.warn('Stored Git log settings are invalid; using defaults');
      return GitOperationLogSettingsSchema.parse({});
    }
    return parsed.data;
  }

  async updateSettings(input: unknown): Promise<GitOperationLogSettings> {
    const changes = parseInput(UpdateGitOperationLogSettingsSchema, input);
    const next = GitOperationLogSettingsSchema.parse({ ...(await this.settings()), ...changes });
    await this.options.settings.set(GIT_LOG_SETTINGS_KEY, JSON.stringify(next));
    await this.prune();
    return next;
  }

  /** Applies the retention; failures are logged and retried later. */
  async prune(): Promise<void> {
    try {
      const { retentionDays, maxOperations } = await this.settings();
      const before = new Date(this.now().getTime() - retentionDays * DAY_MS).toISOString();
      await this.options.store.prune(before, maxOperations);
    } catch (error) {
      this.logger.warn('Git operation log could not be pruned', { error: describeError(error) });
    }
  }
}

/**
 * Wraps the executor used by Git operations: every command run inside an operation
 * (see `GitOperationCoordinator.currentScope`) is reported with its arguments, exit
 * code, duration and sanitized output. Commands outside operations, such as status
 * polling, are not recorded. Standard input (e.g. a commit message) is never stored.
 */
export function recordingExecutor(
  exec: GitExecutor,
  coordinator: Pick<GitOperationCoordinator, 'currentScope'>,
  log: Pick<GitOperationLog, 'commandFinished'>,
  now: () => Date = () => new Date(),
): GitExecutor {
  return async (args, options) => {
    const scope = coordinator.currentScope();
    if (scope === undefined) return exec(args, options);
    scope.commands += 1;
    const sequence = scope.commands;
    const startedAt = now();
    const record = (
      outcome: GitCommandRecord['outcome'],
      exitCode: number | null,
      output: { stdout: string; stderr: string },
    ) => {
      const used = storedPerOperation.get(scope) ?? 0;
      const limit = Math.max(
        GIT_LOG_OUTPUT_MINIMUM,
        Math.min(GIT_LOG_OUTPUT_LIMIT, (GIT_LOG_OPERATION_OUTPUT_BUDGET - used) / 2),
      );
      const stdout = storedOutput(output.stdout, limit);
      const stderr = storedOutput(output.stderr, limit);
      storedPerOperation.set(scope, used + (stdout.text?.length ?? 0) + (stderr.text?.length ?? 0));
      log.commandFinished({
        operationId: scope.operationId,
        sequence,
        args: args.map((arg) => redactCredentials(arg)),
        startedAt: startedAt.toISOString(),
        durationMs: Math.max(0, now().getTime() - startedAt.getTime()),
        exitCode,
        outcome,
        stdout: stdout.text,
        stderr: stderr.text,
        truncated: stdout.truncated || stderr.truncated,
      });
    };
    try {
      const result = await exec(args, options);
      record('succeeded', result.exitCode, result);
      return result;
    } catch (error) {
      if (error instanceof GitCommandError) {
        record(error.kind === 'cancelled' ? 'cancelled' : 'failed', error.exitCode, error.output);
      } else {
        record('failed', null, { stdout: '', stderr: '' });
      }
      throw error;
    }
  };
}

const FIELD = '\x1f';
/** `git reflog show` format: hash, selector with date, subject, identity. */
export const REFLOG_FORMAT = ['%H', '%gd', '%gs', '%gn'].join('%x1f');

/** Parses `git reflog show --date=iso-strict --format=<REFLOG_FORMAT>`. */
export function parseReflog(output: string): Omit<GitReflogEntry, 'atlasOperationId'>[] {
  return output
    .split('\n')
    .filter((line) => line.includes(FIELD))
    .map((line, index) => {
      const [hash = '', selector = '', subject = '', identity = ''] = line.split(FIELD);
      const date = /@\{(.+)\}$/.exec(selector)?.[1] ?? null;
      // Subjects can contain remote URLs (e.g. "pull https://…"): credentials are removed.
      const clean = redactCredentials(subject);
      const separator = clean.indexOf(': ');
      return {
        index,
        hash,
        action: separator === -1 ? clean : clean.slice(0, separator),
        message: separator === -1 ? '' : clean.slice(separator + 2),
        date:
          date !== null && !Number.isNaN(Date.parse(date)) ? new Date(date).toISOString() : null,
        identity,
      };
    });
}
