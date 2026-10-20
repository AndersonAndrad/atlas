import type { TerminalEndReason, TerminalSession, TerminalStatus } from '@atlas/contracts';
import type { TerminalSessionRepository } from '@atlas/terminal';
import { AtlasError } from '@atlas/shared';
import type { Database } from './database.js';

interface TerminalSessionRow {
  id: string;
  project_id: string;
  title: string;
  shell_id: string;
  shell_name: string;
  shell_path: string;
  cwd: string;
  status: TerminalStatus;
  pid: number | null;
  exit_code: number | null;
  signal: number | null;
  end_reason: TerminalEndReason | null;
  failure_message: string | null;
  columns: number;
  rows: number;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
}

/** Terminal session metadata. Process handles and output are never stored. */
export class SqliteTerminalSessionRepository implements TerminalSessionRepository {
  constructor(private readonly db: Database) {}

  async findAll(): Promise<TerminalSession[]> {
    return this.run('findAll', () => {
      const rows = this.db
        .prepare('SELECT * FROM terminal_sessions ORDER BY created_at')
        .all() as unknown as TerminalSessionRow[];
      return rows.map(toSession);
    });
  }

  async save(session: TerminalSession): Promise<void> {
    this.run('save', () => {
      this.db
        .prepare(
          `INSERT INTO terminal_sessions (id, project_id, title, shell_id, shell_name, shell_path,
             cwd, status, pid, exit_code, signal, end_reason, failure_message, columns, rows,
             created_at, started_at, ended_at)
           VALUES (:id, :projectId, :title, :shellId, :shellName, :shellPath, :cwd, :status, :pid,
             :exitCode, :signal, :endReason, :failureMessage, :columns, :rows, :createdAt,
             :startedAt, :endedAt)
           ON CONFLICT (id) DO UPDATE SET title = excluded.title, status = excluded.status,
             pid = excluded.pid, exit_code = excluded.exit_code, signal = excluded.signal,
             end_reason = excluded.end_reason, failure_message = excluded.failure_message,
             columns = excluded.columns, rows = excluded.rows, started_at = excluded.started_at,
             ended_at = excluded.ended_at`,
        )
        .run({
          id: session.id,
          projectId: session.projectId,
          title: session.title,
          shellId: session.shell.id,
          shellName: session.shell.name,
          shellPath: session.shell.path,
          cwd: session.cwd,
          status: session.status,
          pid: session.pid ?? null,
          exitCode: session.exitCode ?? null,
          signal: session.signal ?? null,
          endReason: session.endReason ?? null,
          failureMessage: session.failureMessage ?? null,
          columns: session.columns,
          rows: session.rows,
          createdAt: session.createdAt,
          startedAt: session.startedAt ?? null,
          endedAt: session.endedAt ?? null,
        });
    });
  }

  async delete(id: string): Promise<void> {
    this.run('delete', () => {
      this.db.prepare('DELETE FROM terminal_sessions WHERE id = ?').run(id);
    });
  }

  async markInterrupted(endedAt: string): Promise<number> {
    return this.run('markInterrupted', () => {
      const result = this.db
        .prepare(
          `UPDATE terminal_sessions
             SET status = 'TERMINATED', end_reason = 'engine-lost', ended_at = ?
           WHERE status NOT IN ('EXITED', 'FAILED', 'TERMINATED')`,
        )
        .run(endedAt);
      return Number(result.changes);
    });
  }

  private run<T>(operation: string, fn: () => T): T {
    try {
      return fn();
    } catch (error) {
      throw new AtlasError(
        'PROJECT_PERSISTENCE_ERROR',
        `Terminal session repository ${operation} failed.`,
        { cause: error, details: { operation } },
      );
    }
  }
}

function toSession(row: TerminalSessionRow): TerminalSession {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    shell: { id: row.shell_id, name: row.shell_name, path: row.shell_path },
    cwd: row.cwd,
    status: row.status,
    ...(row.pid !== null ? { pid: row.pid } : {}),
    ...(row.exit_code !== null ? { exitCode: row.exit_code } : {}),
    ...(row.signal !== null ? { signal: row.signal } : {}),
    ...(row.end_reason !== null ? { endReason: row.end_reason } : {}),
    ...(row.failure_message !== null ? { failureMessage: row.failure_message } : {}),
    columns: row.columns,
    rows: row.rows,
    createdAt: row.created_at,
    ...(row.started_at !== null ? { startedAt: row.started_at } : {}),
    ...(row.ended_at !== null ? { endedAt: row.ended_at } : {}),
  };
}
