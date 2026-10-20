import type {
  TerminalEndReason,
  TerminalGroup,
  TerminalSession,
  TerminalStatus,
} from '@atlas/contracts';
import type { TerminalGroupRepository, TerminalSessionRepository } from '@atlas/terminal';
import { AtlasError } from '@atlas/shared';
import type { Database } from './database.js';

interface TerminalSessionRow {
  id: string;
  project_id: string | null;
  auto_title: string;
  custom_title: string | null;
  group_id: string | null;
  group_position: number;
  shell_id: string;
  shell_name: string;
  shell_path: string;
  cwd: string;
  current_cwd: string;
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

interface TerminalGroupRow {
  id: string;
  name: string;
  position: number;
  collapsed: number;
  created_at: string;
}

function persistenceError(entity: string, operation: string, error: unknown): AtlasError {
  return new AtlasError('PROJECT_PERSISTENCE_ERROR', `${entity} repository ${operation} failed.`, {
    cause: error,
    details: { operation },
  });
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
          `INSERT INTO terminal_sessions (id, project_id, auto_title, custom_title, group_id,
             group_position, shell_id, shell_name, shell_path, cwd, current_cwd, status, pid,
             exit_code, signal, end_reason, failure_message, columns, rows, created_at,
             started_at, ended_at)
           VALUES (:id, :projectId, :autoTitle, :customTitle, :groupId, :groupPosition, :shellId,
             :shellName, :shellPath, :cwd, :currentCwd, :status, :pid, :exitCode, :signal,
             :endReason, :failureMessage, :columns, :rows, :createdAt, :startedAt, :endedAt)
           ON CONFLICT (id) DO UPDATE SET project_id = excluded.project_id,
             auto_title = excluded.auto_title, custom_title = excluded.custom_title,
             group_id = excluded.group_id, group_position = excluded.group_position,
             current_cwd = excluded.current_cwd, status = excluded.status, pid = excluded.pid,
             exit_code = excluded.exit_code, signal = excluded.signal,
             end_reason = excluded.end_reason, failure_message = excluded.failure_message,
             columns = excluded.columns, rows = excluded.rows, started_at = excluded.started_at,
             ended_at = excluded.ended_at`,
        )
        .run({
          id: session.id,
          projectId: session.projectId,
          autoTitle: session.autoTitle,
          customTitle: session.customTitle,
          groupId: session.groupId,
          groupPosition: session.groupPosition,
          shellId: session.shell.id,
          shellName: session.shell.name,
          shellPath: session.shell.path,
          cwd: session.cwd,
          currentCwd: session.currentCwd,
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
      throw persistenceError('Terminal session', operation, error);
    }
  }
}

/** Terminal groups. Memberships are stored on the terminal sessions. */
export class SqliteTerminalGroupRepository implements TerminalGroupRepository {
  constructor(private readonly db: Database) {}

  async findAll(): Promise<TerminalGroup[]> {
    return this.run('findAll', () => {
      const rows = this.db
        .prepare('SELECT * FROM terminal_groups ORDER BY position, created_at')
        .all() as unknown as TerminalGroupRow[];
      return rows.map(toGroup);
    });
  }

  async save(group: TerminalGroup): Promise<void> {
    this.run('save', () => {
      this.db
        .prepare(
          `INSERT INTO terminal_groups (id, name, position, collapsed, created_at)
           VALUES (:id, :name, :position, :collapsed, :createdAt)
           ON CONFLICT (id) DO UPDATE SET name = excluded.name, position = excluded.position,
             collapsed = excluded.collapsed`,
        )
        .run({
          id: group.id,
          name: group.name,
          position: group.position,
          collapsed: group.collapsed ? 1 : 0,
          createdAt: group.createdAt,
        });
    });
  }

  async saveAll(groups: TerminalGroup[]): Promise<void> {
    this.run('saveAll', () => {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const update = this.db.prepare('UPDATE terminal_groups SET position = ? WHERE id = ?');
        for (const group of groups) update.run(group.position, group.id);
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    });
  }

  async delete(id: string): Promise<void> {
    this.run('delete', () => {
      this.db.prepare('DELETE FROM terminal_groups WHERE id = ?').run(id);
    });
  }

  private run<T>(operation: string, fn: () => T): T {
    try {
      return fn();
    } catch (error) {
      throw persistenceError('Terminal group', operation, error);
    }
  }
}

function toSession(row: TerminalSessionRow): TerminalSession {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.custom_title ?? row.auto_title,
    customTitle: row.custom_title,
    autoTitle: row.auto_title,
    groupId: row.group_id,
    groupPosition: row.group_position,
    shell: { id: row.shell_id, name: row.shell_name, path: row.shell_path },
    cwd: row.cwd,
    currentCwd: row.current_cwd,
    cwdSource: row.current_cwd === row.cwd ? 'initial' : 'detected',
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

function toGroup(row: TerminalGroupRow): TerminalGroup {
  return {
    id: row.id,
    name: row.name,
    position: row.position,
    collapsed: row.collapsed === 1,
    createdAt: row.created_at,
  };
}
