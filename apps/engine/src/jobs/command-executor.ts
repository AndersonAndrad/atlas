import type { JobOutputPage } from '@atlas/contracts';
import type {
  CreateJobRequest,
  JobExecutionContext,
  JobExecutionResult,
  JobExecutor,
  JobRecord,
  PreparedJob,
} from '@atlas/jobs';
import {
  LogBuffer,
  commandDangers,
  type CheckOutcome,
  type PreflightExecutor,
  type PreflightLogStore,
} from '@atlas/preflight';
import { AtlasError, describeError, type Logger } from '@atlas/shared';

/** Local changes that cannot be undone; the external ones come from Preflight's list. */
const LOCAL_DANGERS: readonly (readonly [RegExp, string])[] = [
  [/(?:^|[\s;&|(])rm\s+(?:-\S*\s+)*-\S*[rR]/, 'deletes files recursively'],
  [/\bgit\s+(?:reset\s+--hard|clean\s+-\S*f)/, 'discards Git changes'],
  [/\bgit\s+push\b[^\n]*(?:--force|\s-f\b)/, 'force-pushes to a Git remote'],
  [/(?:^|[\s;&|(])(?:sudo|doas)\s/, 'runs with administrator rights'],
  [/(?:^|[\s;&|(])(?:mkfs|dd|diskutil|format)\b/, 'writes to a disk directly'],
];

/** Why ATLAS asks for confirmation before queueing the command (SDD-012 §10). */
export function commandJobDangers(command: string): string[] {
  const reasons = new Set(commandDangers(command));
  for (const [pattern, reason] of LOCAL_DANGERS) {
    if (pattern.test(command)) reasons.add(reason);
  }
  return [...reasons];
}

export interface CommandJobProjectLookup {
  /** The registered project and whether its folder is reachable; null when removed. */
  find(
    projectId: string,
  ): Promise<{ id: string; name: string; workspacePath: string; available: boolean } | null>;
}

export interface CommandJobExecutorOptions {
  /** Preflight's shell executor: the same process handling as a check (FR-1203). */
  runner: PreflightExecutor;
  projects: CommandJobProjectLookup;
  /** Output of finished attempts: `<jobId>/<attempt>.json`. */
  logs: PreflightLogStore;
  /** Removes credentials from a line of output. */
  redact: (text: string) => string;
  logger: Logger;
}

/** Only a zero exit code completes the job. */
export function commandJobResult(outcome: CheckOutcome): JobExecutionResult {
  switch (outcome.kind) {
    case 'exited':
      return outcome.exitCode === 0
        ? { status: 'COMPLETED', exitCode: 0 }
        : {
            status: 'FAILED',
            exitCode: outcome.exitCode,
            errorSummary: `The command ${outcome.detail}.`,
          };
    case 'cancelled':
      return { status: 'CANCELLED', errorSummary: 'The command was stopped.' };
    case 'timed-out':
      return { status: 'FAILED', errorSummary: `The command ${outcome.detail}.` };
    case 'start-failed':
      return { status: 'FAILED', errorSummary: 'The command could not start.' };
  }
}

const firstLine = (command: string) => command.split(/\r?\n/, 1)[0]!.trim();

/**
 * Runs a command the user typed, in the project folder, through the user's shell
 * (SDD-012 COMMAND jobs). It is not a terminal: no PTY, no input, output kept in a
 * bounded and redacted log. Cancelling stops the whole process tree.
 */
export class CommandJobExecutor implements JobExecutor {
  readonly type = 'COMMAND' as const;
  readonly cancellable = true;
  readonly notifiesOutcome = false;
  /** Output of running attempts, by `<jobId>:<attempt>`. */
  private readonly buffers = new Map<string, LogBuffer>();

  constructor(private readonly options: CommandJobExecutorOptions) {}

  async prepare(request: CreateJobRequest): Promise<PreparedJob> {
    if (request.type !== 'COMMAND') throw new AtlasError('VALIDATION_FAILED');
    const project = await this.options.projects.find(request.projectId);
    if (project === null) throw new AtlasError('PROJECT_NOT_FOUND');
    if (!project.available) throw new AtlasError('PROJECT_PATH_UNAVAILABLE');
    const dangers = commandJobDangers(request.command);
    if (dangers.length > 0 && !request.confirmDangerous) {
      throw new AtlasError('JOB_CONFIRMATION_REQUIRED', undefined, {
        issues: dangers.map((message) => ({ field: 'confirmDangerous', message })),
      });
    }
    return {
      // The title reaches lists and notifications: never a token typed in the command.
      title: this.options.redact(firstLine(request.command)),
      description: null,
      projectId: project.id,
      workspacePath: project.workspacePath,
      payload: {
        type: 'COMMAND',
        command: request.command,
        timeoutMinutes: request.timeoutMinutes,
        confirmedDangerous: dangers.length > 0,
      },
    };
  }

  async execute(context: JobExecutionContext): Promise<JobExecutionResult> {
    const { job } = context;
    if (job.payload.type !== 'COMMAND') throw new AtlasError('VALIDATION_FAILED');
    // Only inside a project that is still registered at the same folder.
    const project = job.projectId === null ? null : await this.options.projects.find(job.projectId);
    if (project === null || project.workspacePath !== job.workspacePath) {
      return { status: 'FAILED', errorSummary: 'The project is no longer registered in ATLAS.' };
    }
    if (!project.available) {
      return { status: 'FAILED', errorSummary: 'The project folder is not available.' };
    }
    const key = `${job.id}:${context.attempt}`;
    const buffer = new LogBuffer(this.options.redact);
    this.buffers.set(key, buffer);
    context.progress({ stage: 'Running', message: null });
    try {
      const outcome = await this.options.runner.run({
        invocation: { kind: 'shell', command: job.payload.command },
        cwd: project.workspacePath,
        env: {},
        timeoutMs: job.payload.timeoutMinutes * 60_000,
        signal: context.signal,
        onOutput: (stream, chunk) => {
          buffer.append(stream, chunk);
          context.progress({});
        },
      });
      buffer.note(`ATLAS: ${outcome.detail}.`);
      return commandJobResult(outcome);
    } finally {
      buffer.finish();
      try {
        await this.options.logs.write(job.id, context.attempt, buffer.snapshot());
      } catch (error) {
        this.options.logger.warn('Background job log could not be saved', {
          jobId: job.id,
          error: describeError(error),
        });
      }
      this.buffers.delete(key);
    }
  }

  async output(
    job: JobRecord,
    attempt: number,
    after: number,
    limit: number,
  ): Promise<JobOutputPage> {
    const buffer = this.buffers.get(`${job.id}:${attempt}`);
    if (buffer !== undefined) {
      const lines = buffer.read(after, limit);
      const next = lines.at(-1)?.seq ?? Math.max(after, buffer.firstSeq - 1);
      return {
        lines,
        next,
        complete: buffer.complete && next >= buffer.count - 1,
        truncatedBefore: after + 1 < buffer.firstSeq,
      };
    }
    const log = await this.options.logs.read(job.id, attempt);
    if (log === null) {
      // The current attempt may not have started its process yet: more output may come.
      const starting = job.status === 'RUNNING' && attempt === job.retryCount + 1;
      return { lines: [], next: after, complete: !starting, truncatedBefore: false };
    }
    const start = Math.max(0, after + 1 - log.firstSeq);
    const lines = log.lines.slice(start, start + limit);
    return {
      lines,
      next: lines.at(-1)?.seq ?? Math.max(after, log.firstSeq - 1),
      complete: start + lines.length >= log.lines.length,
      truncatedBefore: after + 1 < log.firstSeq,
    };
  }

  removeLogs(jobId: string): Promise<void> {
    return this.options.logs.remove(jobId);
  }
}
