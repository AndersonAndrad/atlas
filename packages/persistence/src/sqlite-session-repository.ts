import type {
  ApprovalRequest,
  ApprovalStatus,
  AtlasSession,
  AtlasSessionStatus,
  ExecutionProfile,
  SessionEvent,
  SessionEventMetadata,
  SessionEventType,
  SessionTaskStatus,
} from '@atlas/contracts';
import type {
  NewSessionEvent,
  SessionChange,
  SessionRepository,
  StoredSession,
  StoredSessionTask,
} from '@atlas/sessions';
import { AtlasError } from '@atlas/shared';
import type { Database } from './database.js';

interface SessionRow {
  id: string;
  name: string;
  objective: string;
  project_id: string | null;
  workspace_path: string | null;
  status: AtlasSessionStatus;
  execution_profile: ExecutionProfile;
  constraints: string;
  revision: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  ended_at: string | null;
  archived_at: string | null;
}

interface TaskRow {
  id: string;
  session_id: string;
  title: string;
  description: string;
  status: SessionTaskStatus;
  assigned_agent_id: string | null;
  validation_criteria: string;
  position: number;
  created_at: string;
  updated_at: string;
}

interface EventRow {
  id: number;
  session_id: string;
  type: SessionEventType;
  occurred_at: string;
  metadata: string;
}

interface ApprovalRow {
  id: string;
  session_id: string;
  task_id: string | null;
  summary: string;
  status: ApprovalStatus;
  requested_at: string;
  resolved_at: string | null;
}

/**
 * ATLAS Sessions, their tasks, dependencies, events and approvals. Every change
 * is one transaction guarded by the session revision.
 */
export class SqliteSessionRepository implements SessionRepository {
  constructor(private readonly db: Database) {}

  async insert(session: AtlasSession, events: NewSessionEvent[]): Promise<void> {
    this.run('insert', () =>
      this.transaction(() => {
        this.db
          .prepare(
            `INSERT INTO atlas_sessions (id, name, objective, project_id, workspace_path, status,
               execution_profile, constraints, revision, created_at, updated_at, started_at,
               completed_at, ended_at, archived_at)
             VALUES (:id, :name, :objective, :projectId, :workspacePath, :status,
               :executionProfile, :constraints, 0, :createdAt, :updatedAt, :startedAt,
               :completedAt, :endedAt, :archivedAt)`,
          )
          .run(sessionParams(session));
        this.insertEvents(session.id, events);
      }),
    );
  }

  async findById(id: string): Promise<StoredSession | null> {
    return this.run('findById', () => {
      const row = this.db.prepare('SELECT * FROM atlas_sessions WHERE id = ?').get(id) as
        SessionRow | undefined;
      return row === undefined ? null : toStored(row);
    });
  }

  async findAll(filter: { includeArchived: boolean; projectId?: string }): Promise<AtlasSession[]> {
    return this.run('findAll', () => {
      const conditions: string[] = [];
      const params: string[] = [];
      if (!filter.includeArchived) conditions.push('archived_at IS NULL');
      if (filter.projectId !== undefined) {
        conditions.push('project_id = ?');
        params.push(filter.projectId);
      }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const rows = this.db
        .prepare(`SELECT * FROM atlas_sessions ${where} ORDER BY created_at DESC, id`)
        .all(...params) as unknown as SessionRow[];
      return rows.map((row) => toSession(row));
    });
  }

  async findByStatuses(statuses: readonly AtlasSessionStatus[]): Promise<StoredSession[]> {
    if (statuses.length === 0) return [];
    return this.run('findByStatuses', () => {
      const placeholders = statuses.map(() => '?').join(', ');
      const rows = this.db
        .prepare(`SELECT * FROM atlas_sessions WHERE status IN (${placeholders})`)
        .all(...statuses) as unknown as SessionRow[];
      return rows.map(toStored);
    });
  }

  async findByProject(projectId: string): Promise<StoredSession[]> {
    return this.run('findByProject', () => {
      const rows = this.db
        .prepare('SELECT * FROM atlas_sessions WHERE project_id = ?')
        .all(projectId) as unknown as SessionRow[];
      return rows.map(toStored);
    });
  }

  async commit(change: SessionChange): Promise<boolean> {
    return this.run('commit', () =>
      this.transaction(() => {
        const updated = change.session
          ? this.db
              .prepare(
                `UPDATE atlas_sessions SET name = :name, objective = :objective,
                   project_id = :projectId, workspace_path = :workspacePath, status = :status,
                   execution_profile = :executionProfile, constraints = :constraints,
                   updated_at = :updatedAt, started_at = :startedAt,
                   completed_at = :completedAt, ended_at = :endedAt, archived_at = :archivedAt,
                   revision = revision + 1
                 WHERE id = :id AND revision = :expectedRevision`,
              )
              .run(updateParams(change.session, change.expectedRevision))
          : this.db
              .prepare(
                'UPDATE atlas_sessions SET revision = revision + 1 WHERE id = ? AND revision = ?',
              )
              .run(change.sessionId, change.expectedRevision);
        if (Number(updated.changes) === 0) return false;

        const tasks = change.upsertTasks ?? [];
        for (const task of tasks) this.upsertTask(change.sessionId, task);
        // Dependencies are written after every task exists.
        for (const task of tasks) this.replaceDependencies(change.sessionId, task);
        const remove = this.db.prepare('DELETE FROM session_tasks WHERE id = ? AND session_id = ?');
        for (const taskId of change.removeTaskIds ?? []) remove.run(taskId, change.sessionId);
        this.insertEvents(change.sessionId, change.events);
        return true;
      }),
    );
  }

  async findTasks(sessionId: string): Promise<StoredSessionTask[]> {
    return this.run('findTasks', () => {
      const rows = this.db
        .prepare('SELECT * FROM session_tasks WHERE session_id = ? ORDER BY position, created_at')
        .all(sessionId) as unknown as TaskRow[];
      const dependencies = this.db
        .prepare(
          `SELECT task_id, depends_on_task_id FROM session_task_dependencies
           WHERE session_id = ? ORDER BY rowid`,
        )
        .all(sessionId) as unknown as { task_id: string; depends_on_task_id: string }[];
      const byTask = new Map<string, string[]>();
      for (const dependency of dependencies) {
        const list = byTask.get(dependency.task_id) ?? [];
        list.push(dependency.depends_on_task_id);
        byTask.set(dependency.task_id, list);
      }
      return rows.map((row) => toTask(row, byTask.get(row.id) ?? []));
    });
  }

  async countTasks(
    sessionIds: readonly string[],
  ): Promise<Map<string, { total: number; completed: number }>> {
    const counts = new Map<string, { total: number; completed: number }>();
    if (sessionIds.length === 0) return counts;
    return this.run('countTasks', () => {
      // One aggregate over all tasks: no bound parameter per session, whatever the list size.
      const rows = this.db
        .prepare(
          `SELECT session_id, COUNT(*) AS total,
             SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END) AS completed
           FROM session_tasks GROUP BY session_id`,
        )
        .all() as unknown as { session_id: string; total: number; completed: number }[];
      const wanted = new Set(sessionIds);
      for (const row of rows) {
        if (wanted.has(row.session_id)) {
          counts.set(row.session_id, { total: row.total, completed: row.completed });
        }
      }
      return counts;
    });
  }

  async findEvents(sessionId: string, limit: number): Promise<SessionEvent[]> {
    return this.run('findEvents', () => {
      const rows = this.db
        .prepare(
          `SELECT * FROM (SELECT * FROM session_events WHERE session_id = ?
             ORDER BY id DESC LIMIT ?) ORDER BY id`,
        )
        .all(sessionId, limit) as unknown as EventRow[];
      return rows.map(toEvent);
    });
  }

  async findPendingApprovals(sessionId: string): Promise<ApprovalRequest[]> {
    return this.run('findPendingApprovals', () => {
      const rows = this.db
        .prepare(
          `SELECT * FROM session_approvals WHERE session_id = ? AND status = 'PENDING'
           ORDER BY requested_at`,
        )
        .all(sessionId) as unknown as ApprovalRow[];
      return rows.map(toApproval);
    });
  }

  private upsertTask(sessionId: string, task: StoredSessionTask): void {
    const result = this.db
      .prepare(
        `INSERT INTO session_tasks (id, session_id, title, description, status,
           assigned_agent_id, validation_criteria, position, created_at, updated_at)
         VALUES (:id, :sessionId, :title, :description, :status, :assignedAgentId,
           :validationCriteria, :position, :createdAt, :updatedAt)
         ON CONFLICT (id) DO UPDATE SET title = excluded.title,
           description = excluded.description, status = excluded.status,
           assigned_agent_id = excluded.assigned_agent_id,
           validation_criteria = excluded.validation_criteria, position = excluded.position,
           updated_at = excluded.updated_at
         WHERE session_tasks.session_id = excluded.session_id`,
      )
      .run({
        id: task.id,
        sessionId,
        title: task.title,
        description: task.description,
        status: task.status,
        assignedAgentId: task.assignedAgentId,
        validationCriteria: JSON.stringify(task.validationCriteria),
        position: task.position,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      });
    if (Number(result.changes) === 0) {
      // The id belongs to a task of another session.
      throw new Error('Task belongs to another session.');
    }
  }

  private replaceDependencies(sessionId: string, task: StoredSessionTask): void {
    this.db
      .prepare('DELETE FROM session_task_dependencies WHERE session_id = ? AND task_id = ?')
      .run(sessionId, task.id);
    const insert = this.db.prepare(
      `INSERT INTO session_task_dependencies (session_id, task_id, depends_on_task_id)
       VALUES (?, ?, ?)`,
    );
    for (const dependency of task.dependencies) insert.run(sessionId, task.id, dependency);
  }

  private insertEvents(sessionId: string, events: readonly NewSessionEvent[]): void {
    const insert = this.db.prepare(
      'INSERT INTO session_events (session_id, type, occurred_at, metadata) VALUES (?, ?, ?, ?)',
    );
    for (const event of events) {
      insert.run(sessionId, event.type, event.occurredAt, JSON.stringify(event.metadata));
    }
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec(result === false ? 'ROLLBACK' : 'COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private run<T>(operation: string, fn: () => T): T {
    try {
      return fn();
    } catch (error) {
      throw new AtlasError('PROJECT_PERSISTENCE_ERROR', `Session repository ${operation} failed.`, {
        cause: error,
        details: { operation },
      });
    }
  }
}

function sessionParams(session: AtlasSession) {
  return {
    id: session.id,
    name: session.name,
    objective: session.objective,
    projectId: session.projectId,
    workspacePath: session.workspacePath,
    status: session.status,
    executionProfile: session.executionProfile,
    constraints: JSON.stringify(session.constraints),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    startedAt: session.startedAt,
    completedAt: session.completedAt,
    endedAt: session.endedAt,
    archivedAt: session.archivedAt,
  };
}

/** `created_at` never changes after insertion. */
function updateParams(session: AtlasSession, expectedRevision: number) {
  const { createdAt: _createdAt, ...params } = sessionParams(session);
  return { ...params, expectedRevision };
}

function toSession(row: SessionRow): AtlasSession {
  return {
    id: row.id,
    name: row.name,
    objective: row.objective,
    projectId: row.project_id,
    workspacePath: row.workspace_path,
    status: row.status,
    executionProfile: row.execution_profile,
    constraints: parseStringArray(row.constraints),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    endedAt: row.ended_at,
    archivedAt: row.archived_at,
  };
}

function toStored(row: SessionRow): StoredSession {
  return { session: toSession(row), revision: row.revision };
}

function toTask(row: TaskRow, dependencies: string[]): StoredSessionTask {
  return {
    id: row.id,
    sessionId: row.session_id,
    title: row.title,
    description: row.description,
    status: row.status,
    dependencies,
    assignedAgentId: row.assigned_agent_id,
    validationCriteria: parseStringArray(row.validation_criteria),
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toEvent(row: EventRow): SessionEvent {
  return {
    id: row.id,
    sessionId: row.session_id,
    type: row.type,
    occurredAt: row.occurred_at,
    metadata: JSON.parse(row.metadata) as SessionEventMetadata,
  };
}

function toApproval(row: ApprovalRow): ApprovalRequest {
  return {
    id: row.id,
    sessionId: row.session_id,
    taskId: row.task_id,
    summary: row.summary,
    status: row.status,
    requestedAt: row.requested_at,
    resolvedAt: row.resolved_at,
  };
}

function parseStringArray(raw: string): string[] {
  const value = JSON.parse(raw) as unknown;
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}
