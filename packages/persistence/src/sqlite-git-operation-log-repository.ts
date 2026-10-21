import type { GitCommandRecord, GitOperation, GitOperationLogEntry } from '@atlas/contracts';
import type { GitOperationLogFilter, GitOperationLogStore } from '@atlas/git';
import { AtlasError } from '@atlas/shared';
import type { Database } from './database.js';

type Row = Record<string, string | number | null>;

const str = (row: Row, key: string) => row[key] as string;
const strOrNull = (row: Row, key: string) => (row[key] as string | null) ?? null;

function toOperation(row: Row): GitOperationLogEntry {
  return {
    id: str(row, 'id'),
    kind: str(row, 'kind') as GitOperation['kind'],
    repositoryRoot: str(row, 'repository_root'),
    status: str(row, 'status') as GitOperation['status'],
    startedAt: str(row, 'started_at'),
    finishedAt: strOrNull(row, 'finished_at'),
    // Progress is live state only; a logged operation has none.
    progress: null,
    summary: strOrNull(row, 'summary'),
    error: row.error === null ? null : (JSON.parse(row.error as string) as GitOperation['error']),
    cancellable: false,
    steps: row.steps === null ? null : (JSON.parse(row.steps as string) as GitOperation['steps']),
    commandCount: (row.command_count as number | undefined) ?? 0,
  };
}

function toCommand(row: Row): GitCommandRecord {
  return {
    operationId: str(row, 'operation_id'),
    sequence: row.sequence as number,
    args: JSON.parse(row.args as string) as string[],
    startedAt: str(row, 'started_at'),
    durationMs: row.duration_ms as number,
    exitCode: (row.exit_code as number | null) ?? null,
    outcome: str(row, 'outcome') as GitCommandRecord['outcome'],
    stdout: strOrNull(row, 'stdout'),
    stderr: strOrNull(row, 'stderr'),
    truncated: row.truncated === 1,
  };
}

const SELECT_OPERATIONS = `SELECT o.*,
  (SELECT COUNT(*) FROM git_command_log c WHERE c.operation_id = o.id) AS command_count
  FROM git_operation_log o`;

/** SQLite storage of the Git operation log (migration v7). */
export class SqliteGitOperationLogRepository implements GitOperationLogStore {
  constructor(private readonly db: Database) {}

  private run<T>(operation: string, action: () => T): T {
    try {
      return action();
    } catch (error) {
      if (error instanceof AtlasError) throw error;
      throw new AtlasError(
        'PROJECT_PERSISTENCE_ERROR',
        'The Git operation log could not be saved.',
        {
          cause: error,
          details: { operation },
        },
      );
    }
  }

  async saveOperation(operation: GitOperation): Promise<void> {
    this.run('saveOperation', () =>
      this.db
        .prepare(
          `INSERT INTO git_operation_log (id, repository_root, kind, status, started_at,
             finished_at, summary, error, steps) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET status = excluded.status,
             finished_at = excluded.finished_at, summary = excluded.summary,
             error = excluded.error, steps = excluded.steps`,
        )
        .run(
          operation.id,
          operation.repositoryRoot,
          operation.kind,
          operation.status,
          operation.startedAt,
          operation.finishedAt,
          operation.summary,
          operation.error === null ? null : JSON.stringify(operation.error),
          operation.steps === null ? null : JSON.stringify(operation.steps),
        ),
    );
  }

  async saveCommand(record: GitCommandRecord): Promise<void> {
    this.run('saveCommand', () =>
      this.db
        .prepare(
          `INSERT OR REPLACE INTO git_command_log (operation_id, sequence, args, started_at,
             duration_ms, exit_code, outcome, stdout, stderr, truncated)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.operationId,
          record.sequence,
          JSON.stringify(record.args),
          record.startedAt,
          record.durationMs,
          record.exitCode,
          record.outcome,
          record.stdout,
          record.stderr,
          record.truncated ? 1 : 0,
        ),
    );
  }

  async listOperations(filter: GitOperationLogFilter): Promise<GitOperationLogEntry[]> {
    return this.run('listOperations', () => {
      const clauses: string[] = [];
      const params: (string | number)[] = [];
      const add = (clause: string, value: string | undefined) => {
        if (value === undefined) return;
        clauses.push(clause);
        params.push(value);
      };
      add('o.repository_root = ?', filter.repositoryRoot);
      add('o.kind = ?', filter.kind);
      add('o.status = ?', filter.status);
      add('o.started_at < ?', filter.before);
      const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`;
      return (
        this.db
          .prepare(`${SELECT_OPERATIONS}${where} ORDER BY o.started_at DESC, o.id DESC LIMIT ?`)
          .all(...params, filter.limit) as Row[]
      ).map(toOperation);
    });
  }

  async getOperation(id: string): Promise<GitOperationLogEntry | null> {
    return this.run('getOperation', () => {
      const row = this.db.prepare(`${SELECT_OPERATIONS} WHERE o.id = ?`).get(id) as Row | undefined;
      return row ? toOperation(row) : null;
    });
  }

  async listCommands(operationId: string): Promise<GitCommandRecord[]> {
    return this.run('listCommands', () =>
      (
        this.db
          .prepare('SELECT * FROM git_command_log WHERE operation_id = ? ORDER BY sequence')
          .all(operationId) as Row[]
      ).map(toCommand),
    );
  }

  async operationsBetween(
    repositoryRoot: string,
    from: string,
    to: string,
  ): Promise<GitOperation[]> {
    return this.run('operationsBetween', () =>
      (
        this.db
          .prepare(
            `${SELECT_OPERATIONS} WHERE o.repository_root = ? AND o.started_at <= ?
               AND COALESCE(o.finished_at, o.started_at) >= ? ORDER BY o.started_at`,
          )
          .all(repositoryRoot, to, from) as Row[]
      ).map(toOperation),
    );
  }

  async interruptUnfinished(at: string): Promise<number> {
    return this.run('interruptUnfinished', () =>
      Number(
        this.db
          .prepare(
            `UPDATE git_operation_log SET status = 'cancelled', finished_at = ?,
               summary = 'ATLAS stopped before the operation finished.'
             WHERE status IN ('queued', 'running')`,
          )
          .run(at).changes,
      ),
    );
  }

  async prune(before: string, keep: number): Promise<number> {
    return this.run('prune', () => {
      const old = this.db
        .prepare(
          `DELETE FROM git_operation_log WHERE started_at < ?
             AND status NOT IN ('queued', 'running')`,
        )
        .run(before).changes;
      const excess = this.db
        .prepare(
          `DELETE FROM git_operation_log WHERE status NOT IN ('queued', 'running')
             AND id NOT IN (SELECT id FROM git_operation_log ORDER BY started_at DESC LIMIT ?)`,
        )
        .run(keep).changes;
      return Number(old) + Number(excess);
    });
  }
}
