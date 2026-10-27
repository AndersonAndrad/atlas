import type { TerminalActivity } from '@atlas/contracts';
import type { TerminalActivityStore } from '@atlas/terminal';
import { AtlasError } from '@atlas/shared';
import type { Database } from './database.js';

interface Row {
  terminal_id: string;
  ref: string;
  kind: 'ai';
  provider: 'claude' | 'codex';
  state: TerminalActivity['state'];
  started_at: string | null;
  finished_at: string | null;
  exit_code: number | null;
  acknowledged_at: string | null;
  context_session_id: string | null;
}

const toActivity = (row: Row): TerminalActivity => ({
  terminalId: row.terminal_id,
  ref: row.ref,
  kind: row.kind,
  provider: row.provider,
  state: row.state,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  exitCode: row.exit_code,
  acknowledgedAt: row.acknowledged_at,
  contextSessionId: row.context_session_id,
});

/** Tracked terminal activities (migration v19). */
export class SqliteTerminalActivityRepository implements TerminalActivityStore {
  constructor(private readonly db: Database) {}

  private run<T>(operation: string, action: () => T): T {
    try {
      return action();
    } catch (error) {
      if (error instanceof AtlasError) throw error;
      throw new AtlasError('PROJECT_PERSISTENCE_ERROR', 'Terminal activity could not be saved.', {
        cause: error,
        details: { operation },
      });
    }
  }

  async list(): Promise<TerminalActivity[]> {
    return this.run('list', () =>
      (this.db.prepare('SELECT * FROM terminal_activities').all() as unknown as Row[]).map(
        toActivity,
      ),
    );
  }

  async upsert(activity: TerminalActivity): Promise<boolean> {
    return this.run('upsert', () => {
      // A terminal unknown to the database (e.g. removed meanwhile) gets no row.
      const result = this.db
        .prepare(
          `INSERT INTO terminal_activities (terminal_id, ref, kind, provider, state, started_at,
             finished_at, exit_code, acknowledged_at, context_session_id)
           SELECT id, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM terminal_sessions WHERE id = ?
           ON CONFLICT (terminal_id, ref) DO UPDATE SET state = excluded.state,
             started_at = excluded.started_at, finished_at = excluded.finished_at,
             exit_code = excluded.exit_code, acknowledged_at = excluded.acknowledged_at,
             context_session_id = excluded.context_session_id`,
        )
        .run(
          activity.ref,
          activity.kind,
          activity.provider,
          activity.state,
          activity.startedAt,
          activity.finishedAt,
          activity.exitCode,
          activity.acknowledgedAt,
          activity.contextSessionId,
          activity.terminalId,
        );
      return Number(result.changes) > 0;
    });
  }

  async pruneAcknowledged(terminalId: string, keepRef: string): Promise<void> {
    this.run('pruneAcknowledged', () => {
      this.db
        .prepare(
          `DELETE FROM terminal_activities
           WHERE terminal_id = ? AND acknowledged_at IS NOT NULL AND ref <> ?`,
        )
        .run(terminalId, keepRef);
    });
  }
}
