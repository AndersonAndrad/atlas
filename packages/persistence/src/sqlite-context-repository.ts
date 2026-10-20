import type {
  AiSession,
  ContextEntry,
  ContextHandoff,
  ContextOverview,
  ContextOwner,
  ContextRevision,
  ContextSnapshot,
  ContextTask,
  DecisionRecord,
} from '@atlas/contracts';
import type { ContextRepository, EntryFilter } from '@atlas/context';
import { AtlasError } from '@atlas/shared';
import type { Database } from './database.js';

type Row = Record<string, string | number | null>;

const str = (row: Row, key: string) => row[key] as string;
const strOrNull = (row: Row, key: string) => (row[key] as string | null) ?? null;
const json = <T>(value: unknown): T => JSON.parse(value as string) as T;

/** `project_id IS ? AND workspace_path IS ?` matches both values and NULLs. */
const OWNER_CLAUSE = 'project_id IS ? AND workspace_path IS ?';
const ownerParams = (owner: ContextOwner) => [owner.projectId, owner.workspacePath];

function toEntry(row: Row): ContextEntry {
  return {
    id: str(row, 'id'),
    scope: str(row, 'scope') as ContextEntry['scope'],
    projectId: strOrNull(row, 'project_id'),
    workspacePath: strOrNull(row, 'workspace_path'),
    taskId: strOrNull(row, 'task_id'),
    sessionId: strOrNull(row, 'session_id'),
    category: str(row, 'category') as ContextEntry['category'],
    title: str(row, 'title'),
    body: str(row, 'body'),
    status: str(row, 'status') as ContextEntry['status'],
    verification: str(row, 'verification') as ContextEntry['verification'],
    source: {
      kind: str(row, 'source_kind') as ContextEntry['source']['kind'],
      ref: strOrNull(row, 'source_ref'),
      recordedBy: str(row, 'recorded_by'),
    },
    refs: json(row.refs),
    revision: row.revision as number,
    createdAt: str(row, 'created_at'),
    updatedAt: str(row, 'updated_at'),
  };
}

function toTask(row: Row): ContextTask {
  return {
    id: str(row, 'id'),
    projectId: strOrNull(row, 'project_id'),
    workspacePath: strOrNull(row, 'workspace_path'),
    title: str(row, 'title'),
    objective: str(row, 'objective'),
    status: str(row, 'status') as ContextTask['status'],
    baseCommit: strOrNull(row, 'base_commit'),
    createdAt: str(row, 'created_at'),
    updatedAt: str(row, 'updated_at'),
  };
}

function toDecision(row: Row): DecisionRecord {
  return {
    id: str(row, 'id'),
    projectId: strOrNull(row, 'project_id'),
    workspacePath: strOrNull(row, 'workspace_path'),
    taskId: strOrNull(row, 'task_id'),
    question: str(row, 'question'),
    decision: str(row, 'decision'),
    alternatives: json(row.alternatives),
    reasoning: str(row, 'reasoning'),
    evidence: json(row.evidence),
    affected: json(row.affected),
    status: str(row, 'status') as DecisionRecord['status'],
    supersededBy: strOrNull(row, 'superseded_by'),
    author: str(row, 'author'),
    createdAt: str(row, 'created_at'),
    updatedAt: str(row, 'updated_at'),
  };
}

function toSession(row: Row): AiSession {
  return {
    id: str(row, 'id'),
    provider: str(row, 'provider') as AiSession['provider'],
    captureMode: str(row, 'capture_mode') as AiSession['captureMode'],
    projectId: strOrNull(row, 'project_id'),
    workspacePath: strOrNull(row, 'workspace_path'),
    taskId: strOrNull(row, 'task_id'),
    terminalId: strOrNull(row, 'terminal_id'),
    handoffId: strOrNull(row, 'handoff_id'),
    startCommit: strOrNull(row, 'start_commit'),
    status: str(row, 'status') as AiSession['status'],
    startedAt: str(row, 'started_at'),
    endedAt: strOrNull(row, 'ended_at'),
  };
}

function toHandoff(row: Row): ContextHandoff {
  const payload = json<
    Omit<
      ContextHandoff,
      | 'id'
      | 'projectId'
      | 'workspacePath'
      | 'taskId'
      | 'sourceSessionId'
      | 'targetProvider'
      | 'sourceRevision'
      | 'createdAt'
    >
  >(row.payload);
  return {
    ...payload,
    id: str(row, 'id'),
    projectId: strOrNull(row, 'project_id'),
    workspacePath: strOrNull(row, 'workspace_path'),
    taskId: strOrNull(row, 'task_id'),
    sourceSessionId: strOrNull(row, 'source_session_id'),
    targetProvider: strOrNull(row, 'target_provider') as ContextHandoff['targetProvider'],
    sourceRevision: strOrNull(row, 'source_revision'),
    createdAt: str(row, 'created_at'),
  };
}

/**
 * Turns user text into an FTS5 query of quoted prefix terms, so operators or quotes
 * typed by the user are never interpreted as query syntax.
 */
function ftsQuery(search: string): string | null {
  const terms = search
    .split(/\s+/)
    .map((term) => term.replace(/"/g, ''))
    .filter((term) => term !== '');
  return terms.length === 0 ? null : terms.map((term) => `"${term}"*`).join(' ');
}

/** SQLite storage of shared context (migration v5). */
export class SqliteContextRepository implements ContextRepository {
  constructor(private readonly db: Database) {}

  private run<T>(operation: string, action: () => T): T {
    try {
      return action();
    } catch (error) {
      if (error instanceof AtlasError) throw error;
      throw new AtlasError('PROJECT_PERSISTENCE_ERROR', 'Shared context could not be saved.', {
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

  // Entries -----------------------------------------------------------------

  async insertEntry(entry: ContextEntry, revision: ContextRevision): Promise<void> {
    this.transaction('insertEntry', () => {
      this.db
        .prepare(
          `INSERT INTO context_entries (id, scope, project_id, workspace_path, task_id, session_id,
             category, title, body, status, verification, source_kind, source_ref, recorded_by,
             refs, revision, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          entry.id,
          entry.scope,
          entry.projectId,
          entry.workspacePath,
          entry.taskId,
          entry.sessionId,
          entry.category,
          entry.title,
          entry.body,
          entry.status,
          entry.verification,
          entry.source.kind,
          entry.source.ref,
          entry.source.recordedBy,
          JSON.stringify(entry.refs),
          entry.revision,
          entry.createdAt,
          entry.updatedAt,
        );
      this.insertRevision(revision);
      this.db
        .prepare('INSERT INTO context_search (entry_id, title, body) VALUES (?, ?, ?)')
        .run(entry.id, entry.title, entry.body);
    });
  }

  async updateEntry(entry: ContextEntry, revision: ContextRevision): Promise<void> {
    this.transaction('updateEntry', () => {
      this.db
        .prepare(
          `UPDATE context_entries SET category = ?, title = ?, body = ?, status = ?,
             verification = ?, revision = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          entry.category,
          entry.title,
          entry.body,
          entry.status,
          entry.verification,
          entry.revision,
          entry.updatedAt,
          entry.id,
        );
      this.insertRevision(revision);
      this.db.prepare('DELETE FROM context_search WHERE entry_id = ?').run(entry.id);
      this.db
        .prepare('INSERT INTO context_search (entry_id, title, body) VALUES (?, ?, ?)')
        .run(entry.id, entry.title, entry.body);
    });
  }

  private insertRevision(revision: ContextRevision): void {
    this.db
      .prepare(
        `INSERT INTO context_revisions (entry_id, revision, title, body, category, verification,
           status, changed_at, changed_by, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        revision.entryId,
        revision.revision,
        revision.title,
        revision.body,
        revision.category,
        revision.verification,
        revision.status,
        revision.changedAt,
        revision.changedBy,
        revision.reason,
      );
  }

  async deleteEntry(id: string): Promise<boolean> {
    return this.transaction('deleteEntry', () => {
      this.db.prepare('DELETE FROM context_search WHERE entry_id = ?').run(id);
      return this.db.prepare('DELETE FROM context_entries WHERE id = ?').run(id).changes > 0;
    });
  }

  async getEntry(id: string): Promise<ContextEntry | null> {
    return this.run('getEntry', () => {
      const row = this.db.prepare('SELECT * FROM context_entries WHERE id = ?').get(id) as
        Row | undefined;
      return row ? toEntry(row) : null;
    });
  }

  async listEntries(filter: EntryFilter): Promise<ContextEntry[]> {
    return this.run('listEntries', () => {
      const clauses = [OWNER_CLAUSE];
      const params: (string | number | null)[] = ownerParams(filter.owner);
      if (!filter.includeObsolete) clauses.push("status = 'active'");
      if (filter.taskId !== undefined) {
        clauses.push('task_id = ?');
        params.push(filter.taskId);
      }
      if (filter.sessionId !== undefined) {
        clauses.push('session_id = ?');
        params.push(filter.sessionId);
      }
      if (filter.category !== undefined) {
        clauses.push('category = ?');
        params.push(filter.category);
      }
      const query = filter.search === undefined ? null : ftsQuery(filter.search);
      if (query !== null) {
        clauses.push('id IN (SELECT entry_id FROM context_search WHERE context_search MATCH ?)');
        params.push(query);
      }
      params.push(filter.limit ?? 500);
      const rows = this.db
        .prepare(
          `SELECT * FROM context_entries WHERE ${clauses.join(' AND ')}
           ORDER BY updated_at DESC LIMIT ?`,
        )
        .all(...params) as Row[];
      return rows.map(toEntry);
    });
  }

  async listRevisions(entryId: string): Promise<ContextRevision[]> {
    return this.run('listRevisions', () =>
      (
        this.db
          .prepare('SELECT * FROM context_revisions WHERE entry_id = ? ORDER BY revision DESC')
          .all(entryId) as Row[]
      ).map((row) => ({
        entryId: str(row, 'entry_id'),
        revision: row.revision as number,
        title: str(row, 'title'),
        body: str(row, 'body'),
        category: str(row, 'category') as ContextRevision['category'],
        verification: str(row, 'verification') as ContextRevision['verification'],
        status: str(row, 'status') as ContextRevision['status'],
        changedAt: str(row, 'changed_at'),
        changedBy: str(row, 'changed_by'),
        reason: strOrNull(row, 'reason'),
      })),
    );
  }

  // Tasks -------------------------------------------------------------------

  async insertTask(task: ContextTask): Promise<void> {
    this.run('insertTask', () =>
      this.db
        .prepare(
          `INSERT INTO context_tasks (id, project_id, workspace_path, title, objective, status,
             base_commit, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          task.id,
          task.projectId,
          task.workspacePath,
          task.title,
          task.objective,
          task.status,
          task.baseCommit,
          task.createdAt,
          task.updatedAt,
        ),
    );
  }

  async updateTask(task: ContextTask): Promise<void> {
    this.run('updateTask', () =>
      this.db
        .prepare(
          'UPDATE context_tasks SET title = ?, objective = ?, status = ?, updated_at = ? WHERE id = ?',
        )
        .run(task.title, task.objective, task.status, task.updatedAt, task.id),
    );
  }

  async deleteTask(id: string): Promise<boolean> {
    return this.transaction('deleteTask', () => {
      this.db
        .prepare(
          'DELETE FROM context_search WHERE entry_id IN (SELECT id FROM context_entries WHERE task_id = ?)',
        )
        .run(id);
      return this.db.prepare('DELETE FROM context_tasks WHERE id = ?').run(id).changes > 0;
    });
  }

  async getTask(id: string): Promise<ContextTask | null> {
    return this.run('getTask', () => {
      const row = this.db.prepare('SELECT * FROM context_tasks WHERE id = ?').get(id) as
        Row | undefined;
      return row ? toTask(row) : null;
    });
  }

  async listTasks(owner: ContextOwner): Promise<ContextTask[]> {
    return this.run('listTasks', () =>
      (
        this.db
          .prepare(`SELECT * FROM context_tasks WHERE ${OWNER_CLAUSE} ORDER BY updated_at DESC`)
          .all(...ownerParams(owner)) as Row[]
      ).map(toTask),
    );
  }

  // Decisions ---------------------------------------------------------------

  async insertDecision(decision: DecisionRecord): Promise<void> {
    this.run('insertDecision', () =>
      this.db
        .prepare(
          `INSERT INTO context_decisions (id, project_id, workspace_path, task_id, question, decision,
             alternatives, reasoning, evidence, affected, status, superseded_by, author, created_at,
             updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          decision.id,
          decision.projectId,
          decision.workspacePath,
          decision.taskId,
          decision.question,
          decision.decision,
          JSON.stringify(decision.alternatives),
          decision.reasoning,
          JSON.stringify(decision.evidence),
          JSON.stringify(decision.affected),
          decision.status,
          decision.supersededBy,
          decision.author,
          decision.createdAt,
          decision.updatedAt,
        ),
    );
  }

  async updateDecision(decision: DecisionRecord): Promise<void> {
    this.run('updateDecision', () =>
      this.db
        .prepare(
          'UPDATE context_decisions SET status = ?, superseded_by = ?, updated_at = ? WHERE id = ?',
        )
        .run(decision.status, decision.supersededBy, decision.updatedAt, decision.id),
    );
  }

  async getDecision(id: string): Promise<DecisionRecord | null> {
    return this.run('getDecision', () => {
      const row = this.db.prepare('SELECT * FROM context_decisions WHERE id = ?').get(id) as
        Row | undefined;
      return row ? toDecision(row) : null;
    });
  }

  async listDecisions(owner: ContextOwner, taskId?: string): Promise<DecisionRecord[]> {
    return this.run('listDecisions', () => {
      const params: (string | null)[] = ownerParams(owner);
      let sql = `SELECT * FROM context_decisions WHERE ${OWNER_CLAUSE}`;
      if (taskId !== undefined) {
        sql += ' AND task_id = ?';
        params.push(taskId);
      }
      return (this.db.prepare(`${sql} ORDER BY created_at DESC`).all(...params) as Row[]).map(
        toDecision,
      );
    });
  }

  // Sessions ----------------------------------------------------------------

  async insertSession(session: AiSession): Promise<void> {
    this.run('insertSession', () =>
      this.db
        .prepare(
          `INSERT INTO ai_sessions (id, provider, capture_mode, project_id, workspace_path, task_id,
             terminal_id, handoff_id, start_commit, status, started_at, ended_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          session.id,
          session.provider,
          session.captureMode,
          session.projectId,
          session.workspacePath,
          session.taskId,
          session.terminalId,
          session.handoffId,
          session.startCommit,
          session.status,
          session.startedAt,
          session.endedAt,
        ),
    );
  }

  async updateSession(session: AiSession): Promise<void> {
    this.run('updateSession', () =>
      this.db
        .prepare('UPDATE ai_sessions SET status = ?, ended_at = ? WHERE id = ?')
        .run(session.status, session.endedAt, session.id),
    );
  }

  async getSession(id: string): Promise<AiSession | null> {
    return this.run('getSession', () => {
      const row = this.db.prepare('SELECT * FROM ai_sessions WHERE id = ?').get(id) as
        Row | undefined;
      return row ? toSession(row) : null;
    });
  }

  async listSessions(owner: ContextOwner): Promise<AiSession[]> {
    return this.run('listSessions', () =>
      (
        this.db
          .prepare(
            `SELECT * FROM ai_sessions WHERE ${OWNER_CLAUSE} ORDER BY started_at DESC LIMIT 200`,
          )
          .all(...ownerParams(owner)) as Row[]
      ).map(toSession),
    );
  }

  async activeSessionForTerminal(terminalId: string): Promise<AiSession | null> {
    return this.run('activeSessionForTerminal', () => {
      const row = this.db
        .prepare("SELECT * FROM ai_sessions WHERE terminal_id = ? AND status = 'active' LIMIT 1")
        .get(terminalId) as Row | undefined;
      return row ? toSession(row) : null;
    });
  }

  // Handoffs and snapshots --------------------------------------------------

  async insertHandoff(handoff: ContextHandoff): Promise<void> {
    const {
      id,
      projectId,
      workspacePath,
      taskId,
      sourceSessionId,
      targetProvider,
      sourceRevision,
      createdAt,
      ...payload
    } = handoff;
    this.run('insertHandoff', () =>
      this.db
        .prepare(
          `INSERT INTO context_handoffs (id, project_id, workspace_path, task_id, source_session_id,
             target_provider, payload, source_revision, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          projectId,
          workspacePath,
          taskId,
          sourceSessionId,
          targetProvider,
          JSON.stringify(payload),
          sourceRevision,
          createdAt,
        ),
    );
  }

  async getHandoff(id: string): Promise<ContextHandoff | null> {
    return this.run('getHandoff', () => {
      const row = this.db.prepare('SELECT * FROM context_handoffs WHERE id = ?').get(id) as
        Row | undefined;
      return row ? toHandoff(row) : null;
    });
  }

  async listHandoffs(owner: ContextOwner): Promise<ContextHandoff[]> {
    return this.run('listHandoffs', () =>
      (
        this.db
          .prepare(
            `SELECT * FROM context_handoffs WHERE ${OWNER_CLAUSE} ORDER BY created_at DESC LIMIT 200`,
          )
          .all(...ownerParams(owner)) as Row[]
      ).map(toHandoff),
    );
  }

  async insertSnapshot(snapshot: ContextSnapshot): Promise<void> {
    this.run('insertSnapshot', () =>
      this.db
        .prepare(
          `INSERT INTO context_snapshots (id, project_id, workspace_path, task_id, markdown, head, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          snapshot.id,
          snapshot.projectId,
          snapshot.workspacePath,
          snapshot.taskId,
          snapshot.markdown,
          snapshot.head,
          snapshot.createdAt,
        ),
    );
  }

  // Overview and project removal ---------------------------------------------

  async overview(owner: ContextOwner): Promise<ContextOverview> {
    return this.run('overview', () => {
      const count = (sql: string) =>
        (this.db.prepare(sql).get(...ownerParams(owner)) as { n: number }).n;
      return {
        entries: count(
          `SELECT COUNT(*) AS n FROM context_entries WHERE ${OWNER_CLAUSE} AND status = 'active'`,
        ),
        tasks: count(`SELECT COUNT(*) AS n FROM context_tasks WHERE ${OWNER_CLAUSE}`),
        openTasks: count(
          `SELECT COUNT(*) AS n FROM context_tasks WHERE ${OWNER_CLAUSE} AND status = 'open'`,
        ),
        decisions: count(
          `SELECT COUNT(*) AS n FROM context_decisions WHERE ${OWNER_CLAUSE} AND status = 'ACTIVE'`,
        ),
        sessions: count(`SELECT COUNT(*) AS n FROM ai_sessions WHERE ${OWNER_CLAUSE}`),
        activeSessions: count(
          `SELECT COUNT(*) AS n FROM ai_sessions WHERE ${OWNER_CLAUSE} AND status = 'active'`,
        ),
        handoffs: count(`SELECT COUNT(*) AS n FROM context_handoffs WHERE ${OWNER_CLAUSE}`),
        pending: count(
          `SELECT COUNT(*) AS n FROM context_entries WHERE ${OWNER_CLAUSE} AND status = 'active'
             AND category IN ('next-action', 'pending-decision', 'blocker')`,
        ),
      };
    });
  }

  async reassignProject(projectId: string, workspacePath: string): Promise<void> {
    this.transaction('reassignProject', () => {
      for (const table of [
        'context_tasks',
        'ai_sessions',
        'context_entries',
        'context_decisions',
        'context_handoffs',
        'context_snapshots',
      ]) {
        this.db
          .prepare(`UPDATE ${table} SET project_id = NULL, workspace_path = ? WHERE project_id = ?`)
          .run(workspacePath, projectId);
      }
    });
  }
}
