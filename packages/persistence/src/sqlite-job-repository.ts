import type {
  JobAttempt,
  JobExecutionReference,
  JobOrigin,
  JobPayload,
  JobPriority,
  JobProgress,
  JobStatus,
  JobStatusChange,
  JobType,
} from '@atlas/contracts';
import type { JobRecord, JobRepository } from '@atlas/jobs';
import { AtlasError } from '@atlas/shared';
import type { Database } from './database.js';

type Row = Record<string, string | number | null>;

const str = (row: Row, key: string) => row[key] as string;
const strOrNull = (row: Row, key: string) => (row[key] as string | null) ?? null;
const numOrNull = (row: Row, key: string) => (row[key] === null ? null : Number(row[key]));
const json = <T>(row: Row, key: string): T | null => {
  const value = strOrNull(row, key);
  return value === null ? null : (JSON.parse(value) as T);
};

const UNFINISHED = "('QUEUED', 'RUNNING', 'WAITING_APPROVAL')";
const FINISHED = "('COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED')";

function toJob(row: Row): JobRecord {
  return {
    id: str(row, 'id'),
    type: str(row, 'type') as JobType,
    status: str(row, 'status') as JobStatus,
    priority: str(row, 'priority') as JobPriority,
    projectId: strOrNull(row, 'project_id'),
    workspacePath: strOrNull(row, 'workspace_path'),
    sessionId: strOrNull(row, 'session_id'),
    title: str(row, 'title'),
    description: strOrNull(row, 'description'),
    origin: str(row, 'origin') as JobOrigin,
    payload: json<JobPayload>(row, 'payload')!,
    createdAt: str(row, 'created_at'),
    queuedAt: str(row, 'queued_at'),
    startedAt: strOrNull(row, 'started_at'),
    finishedAt: strOrNull(row, 'finished_at'),
    progress: json<JobProgress>(row, 'progress')!,
    retryCount: Number(row.retry_count),
    maxRetries: Number(row.max_retries),
    executionReference: json<JobExecutionReference>(row, 'execution_reference'),
    errorSummary: strOrNull(row, 'error_summary'),
    exitCode: numOrNull(row, 'exit_code'),
    cancelRequested: Number(row.cancel_requested) === 1,
  };
}

function toAttempt(row: Row): JobAttempt {
  return {
    jobId: str(row, 'job_id'),
    attempt: Number(row.attempt),
    status: str(row, 'status') as JobStatus,
    startedAt: str(row, 'started_at'),
    finishedAt: strOrNull(row, 'finished_at'),
    exitCode: numOrNull(row, 'exit_code'),
    errorSummary: strOrNull(row, 'error_summary'),
    executionReference: json<JobExecutionReference>(row, 'execution_reference'),
  };
}

const optionalJson = (value: unknown) => (value === null ? null : JSON.stringify(value));

/** SQLite storage of background jobs (migration v13). */
export class SqliteJobRepository implements JobRepository {
  constructor(private readonly db: Database) {}

  private run<T>(operation: string, action: () => T): T {
    try {
      return action();
    } catch (error) {
      if (error instanceof AtlasError) throw error;
      throw new AtlasError('PROJECT_PERSISTENCE_ERROR', 'Background jobs could not be saved.', {
        cause: error,
        details: { operation },
      });
    }
  }

  private transaction<T>(operation: string, action: () => T): T {
    return this.run(operation, () => {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const result = action();
        this.db.exec('COMMIT');
        return result;
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    });
  }

  private writeChange(change: JobStatusChange): void {
    this.db
      .prepare(
        'INSERT INTO background_job_status_history (job_id, status, at, detail) VALUES (?, ?, ?, ?)',
      )
      .run(change.jobId, change.status, change.at, change.detail);
  }

  private writeAttempt(attempt: JobAttempt): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO background_job_attempts (job_id, attempt, status, started_at,
           finished_at, exit_code, error_summary, execution_reference)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        attempt.jobId,
        attempt.attempt,
        attempt.status,
        attempt.startedAt,
        attempt.finishedAt,
        attempt.exitCode,
        attempt.errorSummary,
        optionalJson(attempt.executionReference),
      );
  }

  private values(job: JobRecord) {
    return [
      job.type,
      job.status,
      job.priority,
      job.projectId,
      job.workspacePath,
      job.sessionId,
      job.title,
      job.description,
      job.origin,
      JSON.stringify(job.payload),
      JSON.stringify(job.progress),
      job.retryCount,
      job.maxRetries,
      optionalJson(job.executionReference),
      job.errorSummary,
      job.exitCode,
      job.cancelRequested ? 1 : 0,
      job.createdAt,
      job.queuedAt,
      job.startedAt,
      job.finishedAt,
    ] as const;
  }

  async insert(job: JobRecord, change: JobStatusChange): Promise<void> {
    this.transaction('insert', () => {
      this.db
        .prepare(
          `INSERT INTO background_jobs (type, status, priority, project_id, workspace_path,
             session_id, title, description, origin, payload, progress, retry_count, max_retries,
             execution_reference, error_summary, exit_code, cancel_requested, created_at,
             queued_at, started_at, finished_at, id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(...this.values(job), job.id);
      this.writeChange(change);
    });
  }

  async save(
    job: JobRecord,
    change: JobStatusChange | null,
    attempt: JobAttempt | null,
  ): Promise<void> {
    this.transaction('save', () => {
      const updated = this.db
        .prepare(
          `UPDATE background_jobs SET type = ?, status = ?, priority = ?, project_id = ?,
             workspace_path = ?, session_id = ?, title = ?, description = ?, origin = ?,
             payload = ?, progress = ?, retry_count = ?, max_retries = ?,
             execution_reference = ?, error_summary = ?, exit_code = ?, cancel_requested = ?,
             created_at = ?, queued_at = ?, started_at = ?, finished_at = ?
           WHERE id = ?`,
        )
        .run(...this.values(job), job.id);
      // A job removed meanwhile (its project's history was pruned) is not recreated.
      if (Number(updated.changes) === 0) return;
      if (change !== null) this.writeChange(change);
      if (attempt !== null) this.writeAttempt(attempt);
    });
  }

  async find(id: string): Promise<JobRecord | null> {
    return this.run('find', () => {
      const row = this.db.prepare('SELECT * FROM background_jobs WHERE id = ?').get(id) as
        Row | undefined;
      return row === undefined ? null : toJob(row);
    });
  }

  async list(query: {
    statuses?: readonly JobStatus[];
    projectId?: string;
    limit: number;
    before?: string;
  }): Promise<JobRecord[]> {
    return this.run('list', () => {
      const where: string[] = [];
      const params: (string | number)[] = [];
      if (query.statuses !== undefined && query.statuses.length > 0) {
        where.push(`status IN (${query.statuses.map(() => '?').join(', ')})`);
        params.push(...query.statuses);
      }
      if (query.projectId !== undefined) {
        where.push('project_id = ?');
        params.push(query.projectId);
      }
      if (query.before !== undefined) {
        const anchor = this.db
          .prepare('SELECT created_at, rowid FROM background_jobs WHERE id = ?')
          .get(query.before) as Row | undefined;
        if (anchor === undefined) return [];
        where.push('(created_at < ? OR (created_at = ? AND rowid < ?))');
        params.push(str(anchor, 'created_at'), str(anchor, 'created_at'), Number(anchor.rowid));
      }
      const rows = this.db
        .prepare(
          `SELECT * FROM background_jobs ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
           ORDER BY created_at DESC, rowid DESC LIMIT ?`,
        )
        .all(...params, query.limit) as Row[];
      return rows.map(toJob);
    });
  }

  async attempts(jobId: string): Promise<JobAttempt[]> {
    return this.run('attempts', () =>
      (
        this.db
          .prepare('SELECT * FROM background_job_attempts WHERE job_id = ? ORDER BY attempt')
          .all(jobId) as Row[]
      ).map(toAttempt),
    );
  }

  async history(jobId: string): Promise<JobStatusChange[]> {
    return this.run('history', () =>
      (
        this.db
          .prepare(
            'SELECT job_id, status, at, detail FROM background_job_status_history WHERE job_id = ? ORDER BY id',
          )
          .all(jobId) as Row[]
      ).map((row) => ({
        jobId: str(row, 'job_id'),
        status: str(row, 'status') as JobStatus,
        at: str(row, 'at'),
        detail: strOrNull(row, 'detail'),
      })),
    );
  }

  async interruptUnfinished(at: string, detail: string): Promise<JobRecord[]> {
    return this.transaction('interruptUnfinished', () => {
      const jobs = (
        this.db
          .prepare(`SELECT * FROM background_jobs WHERE status IN ${UNFINISHED} ORDER BY rowid`)
          .all() as Row[]
      ).map(toJob);
      for (const job of jobs) {
        this.db
          .prepare(
            `UPDATE background_jobs SET status = 'INTERRUPTED', finished_at = ?,
               error_summary = ?, cancel_requested = 0 WHERE id = ?`,
          )
          .run(at, detail, job.id);
        this.db
          .prepare(
            `UPDATE background_job_attempts SET status = 'INTERRUPTED', finished_at = ?,
               error_summary = ? WHERE job_id = ? AND finished_at IS NULL`,
          )
          .run(at, detail, job.id);
        this.writeChange({ jobId: job.id, status: 'INTERRUPTED', at, detail });
      }
      return jobs.map((job) => ({
        ...job,
        status: 'INTERRUPTED' as const,
        finishedAt: at,
        errorSummary: detail,
        cancelRequested: false,
      }));
    });
  }

  async prune(keep: number): Promise<string[]> {
    return this.transaction('prune', () => {
      const ids = (
        this.db
          .prepare(
            `SELECT id FROM background_jobs WHERE status IN ${FINISHED}
             ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?`,
          )
          .all(keep) as Row[]
      ).map((row) => str(row, 'id'));
      const remove = this.db.prepare('DELETE FROM background_jobs WHERE id = ?');
      for (const id of ids) remove.run(id);
      return ids;
    });
  }
}
