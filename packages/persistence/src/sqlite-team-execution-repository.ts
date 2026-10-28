import type { TeamExecution } from '@atlas/contracts';
import type { TeamExecutionStore } from '@atlas/context';
import { AtlasError } from '@atlas/shared';
import type { Database } from './database.js';

interface Row {
  id: string;
  request_id: string;
  task_id: string;
  project_id: string | null;
  workspace_path: string | null;
  status: TeamExecution['status'];
  data: string;
  approved_at: string;
  finished_at: string | null;
}

/** The plan and progress; the owner lives in its columns so it follows the project. */
type Data = Omit<
  TeamExecution,
  | 'id'
  | 'requestId'
  | 'taskId'
  | 'projectId'
  | 'workspacePath'
  | 'status'
  | 'approvedAt'
  | 'finishedAt'
>;

const toExecution = (row: Row): TeamExecution => ({
  ...(JSON.parse(row.data) as Data),
  id: row.id,
  requestId: row.request_id,
  taskId: row.task_id,
  projectId: row.project_id,
  workspacePath: row.workspace_path,
  status: row.status,
  approvedAt: row.approved_at,
  finishedAt: row.finished_at,
});

const dataOf = (execution: TeamExecution): string => {
  const {
    id: _id,
    requestId: _requestId,
    taskId: _taskId,
    projectId: _projectId,
    workspacePath: _workspacePath,
    status: _status,
    approvedAt: _approvedAt,
    finishedAt: _finishedAt,
    ...data
  } = execution;
  return JSON.stringify(data satisfies Data);
};

const ACTIVE = `status IN ('RUNNING', 'PAUSED', 'CHECKING')`;

/** ATLAS team executions (migration v22). */
export class SqliteTeamExecutionRepository implements TeamExecutionStore {
  constructor(private readonly db: Database) {}

  private run<T>(operation: string, action: () => T): T {
    try {
      return action();
    } catch (error) {
      if (error instanceof AtlasError) throw error;
      throw new AtlasError('PROJECT_PERSISTENCE_ERROR', 'Team execution could not be saved.', {
        cause: error,
        details: { operation },
      });
    }
  }

  private select(where: string, ...params: (string | number)[]): TeamExecution[] {
    return (
      this.db
        .prepare(`SELECT * FROM team_executions WHERE ${where}`)
        .all(...params) as unknown as Row[]
    ).map(toExecution);
  }

  async insert(execution: TeamExecution): Promise<void> {
    this.run('insert', () => {
      this.db
        .prepare(
          `INSERT INTO team_executions (id, request_id, task_id, project_id, workspace_path,
             status, data, approved_at, finished_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          execution.id,
          execution.requestId,
          execution.taskId,
          execution.projectId,
          execution.workspacePath,
          execution.status,
          dataOf(execution),
          execution.approvedAt,
          execution.finishedAt,
        );
    });
  }

  /** The owner never changes here: it follows its project (reassignProject). */
  async update(execution: TeamExecution): Promise<void> {
    this.run('update', () => {
      this.db
        .prepare('UPDATE team_executions SET status = ?, data = ?, finished_at = ? WHERE id = ?')
        .run(execution.status, dataOf(execution), execution.finishedAt, execution.id);
    });
  }

  async get(id: string): Promise<TeamExecution | null> {
    return this.run('get', () => this.select('id = ?', id)[0] ?? null);
  }

  async findByRequestId(requestId: string): Promise<TeamExecution | null> {
    return this.run('findByRequestId', () => this.select('request_id = ?', requestId)[0] ?? null);
  }

  async listForTask(taskId: string, limit: number): Promise<TeamExecution[]> {
    return this.run('listForTask', () =>
      this.select('task_id = ? ORDER BY approved_at DESC, rowid DESC LIMIT ?', taskId, limit),
    );
  }

  async listActive(): Promise<TeamExecution[]> {
    return this.run('listActive', () => this.select(`${ACTIVE} ORDER BY approved_at, rowid`));
  }
}
