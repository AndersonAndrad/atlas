import type { TaskExecution } from '@atlas/contracts';
import type { TaskExecutionStore } from '@atlas/context';
import { AtlasError } from '@atlas/shared';
import type { Database } from './database.js';

interface Row {
  id: string;
  request_id: string;
  task_id: string;
  project_id: string | null;
  workspace_path: string | null;
  mode: TaskExecution['mode'];
  provider: TaskExecution['provider'];
  profile_id: string | null;
  profile_name: string | null;
  terminal_id: string;
  terminal_title: string;
  ai_session_id: string | null;
  run_ref: string | null;
  status: TaskExecution['status'];
  exit_code: number | null;
  end_reason: TaskExecution['endReason'];
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  cancel_requested_at: string | null;
  reviewed_at: string | null;
}

const toExecution = (row: Row): TaskExecution => ({
  id: row.id,
  requestId: row.request_id,
  taskId: row.task_id,
  projectId: row.project_id,
  workspacePath: row.workspace_path,
  mode: row.mode,
  provider: row.provider,
  profileId: row.profile_id,
  profileName: row.profile_name,
  terminalId: row.terminal_id,
  terminalTitle: row.terminal_title,
  aiSessionId: row.ai_session_id,
  runRef: row.run_ref,
  status: row.status,
  exitCode: row.exit_code,
  endReason: row.end_reason,
  createdAt: row.created_at,
  startedAt: row.started_at,
  endedAt: row.ended_at,
  cancelRequestedAt: row.cancel_requested_at,
  reviewedAt: row.reviewed_at,
});

const ACTIVE = `status IN ('LAUNCHING', 'RUNNING')`;

/** Task executions (migration v20). */
export class SqliteTaskExecutionRepository implements TaskExecutionStore {
  constructor(private readonly db: Database) {}

  private run<T>(operation: string, action: () => T): T {
    try {
      return action();
    } catch (error) {
      if (error instanceof AtlasError) throw error;
      throw new AtlasError('PROJECT_PERSISTENCE_ERROR', 'Task execution could not be saved.', {
        cause: error,
        details: { operation },
      });
    }
  }

  private select(where: string, ...params: (string | number)[]): TaskExecution[] {
    return (
      this.db
        .prepare(`SELECT * FROM task_executions WHERE ${where}`)
        .all(...params) as unknown as Row[]
    ).map(toExecution);
  }

  async insert(execution: TaskExecution): Promise<void> {
    this.run('insert', () => {
      this.db
        .prepare(
          `INSERT INTO task_executions (id, request_id, task_id, project_id, workspace_path, mode,
             provider, profile_id, profile_name, terminal_id, terminal_title, ai_session_id,
             run_ref, status, exit_code, end_reason, created_at, started_at, ended_at,
             cancel_requested_at, reviewed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          execution.id,
          execution.requestId,
          execution.taskId,
          execution.projectId,
          execution.workspacePath,
          execution.mode,
          execution.provider,
          execution.profileId,
          execution.profileName,
          execution.terminalId,
          execution.terminalTitle,
          execution.aiSessionId,
          execution.runRef,
          execution.status,
          execution.exitCode,
          execution.endReason,
          execution.createdAt,
          execution.startedAt,
          execution.endedAt,
          execution.cancelRequestedAt,
          execution.reviewedAt,
        );
    });
  }

  /** Only the lifecycle fields change after creation. */
  async update(execution: TaskExecution): Promise<void> {
    this.run('update', () => {
      this.db
        .prepare(
          `UPDATE task_executions SET run_ref = ?, status = ?, exit_code = ?, end_reason = ?,
             started_at = ?, ended_at = ?, cancel_requested_at = ?, reviewed_at = ?
           WHERE id = ?`,
        )
        .run(
          execution.runRef,
          execution.status,
          execution.exitCode,
          execution.endReason,
          execution.startedAt,
          execution.endedAt,
          execution.cancelRequestedAt,
          execution.reviewedAt,
          execution.id,
        );
    });
  }

  async get(id: string): Promise<TaskExecution | null> {
    return this.run('get', () => this.select('id = ?', id)[0] ?? null);
  }

  async findByRequestId(requestId: string): Promise<TaskExecution | null> {
    return this.run('findByRequestId', () => this.select('request_id = ?', requestId)[0] ?? null);
  }

  async listForTask(taskId: string, limit: number): Promise<TaskExecution[]> {
    return this.run('listForTask', () =>
      this.select('task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?', taskId, limit),
    );
  }

  async listActive(): Promise<TaskExecution[]> {
    return this.run('listActive', () => this.select(`${ACTIVE} ORDER BY created_at`));
  }

  async listUnreviewedForTerminal(terminalId: string): Promise<TaskExecution[]> {
    return this.run('listUnreviewedForTerminal', () =>
      this.select(
        `terminal_id = ? AND NOT (${ACTIVE}) AND reviewed_at IS NULL ORDER BY created_at`,
        terminalId,
      ),
    );
  }
}
