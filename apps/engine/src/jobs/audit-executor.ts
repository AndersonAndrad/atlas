import type { JobOutputPage, JobPayload } from '@atlas/contracts';
import type { ProjectAuditService } from '@atlas/audit';
import type {
  CreateJobRequest,
  JobExecutionContext,
  JobExecutionResult,
  JobExecutor,
  JobRecord,
  PreparedJob,
} from '@atlas/jobs';
import { LogBuffer, type PreflightLogStore } from '@atlas/preflight';
import { AtlasError, describeError, type Logger } from '@atlas/shared';
import { readJobOutput } from './job-log.js';

type AgentPayload = Extract<JobPayload, { type: 'AGENT' }>;

export interface AuditJobExecutorOptions {
  audits: () => ProjectAuditService;
  /** Output of finished attempts: `<jobId>/<attempt>.json`. */
  logs: PreflightLogStore;
  /** Removes credentials from a line of output. */
  redact: (text: string) => string;
  logger: Logger;
}

/**
 * Runs a project audit the user confirmed as an AGENT job (SDD-026 FR-005). The audit
 * service does the work; the job gives it a queue, cancellation, progress and a
 * redacted log. Audits are never retried: a new audit is started instead.
 */
export class AuditJobExecutor implements JobExecutor {
  readonly type = 'AGENT' as const;
  readonly cancellable = true;
  readonly retryable = false;
  readonly notifiesOutcome = false;
  private readonly buffers = new Map<string, LogBuffer>();

  constructor(private readonly options: AuditJobExecutorOptions) {}

  duplicateKey(payload: JobPayload): string | null {
    return payload.type === 'AGENT' ? payload.auditId : null;
  }

  async prepare(request: CreateJobRequest): Promise<PreparedJob> {
    if (request.type !== 'AGENT') throw new AtlasError('VALIDATION_FAILED');
    const prepared = await this.options.audits().jobPreparation(request.auditId);
    const payload: AgentPayload = {
      type: 'AGENT',
      kind: 'project-audit',
      auditId: request.auditId,
    };
    return {
      title: prepared.title,
      description: null,
      projectId: prepared.projectId,
      workspacePath: prepared.workspacePath,
      payload,
    };
  }

  async execute(context: JobExecutionContext): Promise<JobExecutionResult> {
    const { job } = context;
    if (job.payload.type !== 'AGENT') throw new AtlasError('VALIDATION_FAILED');
    const { auditId } = job.payload;
    context.reference({ type: 'project-audit', auditId });
    const key = `${job.id}:${context.attempt}`;
    const buffer = new LogBuffer(this.options.redact);
    this.buffers.set(key, buffer);
    try {
      const result = await this.options.audits().execute(auditId, {
        signal: context.signal,
        log: (line) => {
          buffer.note(line);
          context.progress({});
        },
        output: (chunk) => {
          buffer.append('err', chunk);
          context.progress({});
        },
        progress: (stage) => context.progress({ stage, message: null }),
      });
      return { status: result.status, errorSummary: result.errorSummary };
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

  output(job: JobRecord, attempt: number, after: number, limit: number): Promise<JobOutputPage> {
    return readJobOutput(
      { job, attempt, after, limit },
      this.buffers.get(`${job.id}:${attempt}`),
      this.options.logs,
    );
  }

  removeLogs(jobId: string): Promise<void> {
    return this.options.logs.remove(jobId);
  }
}
