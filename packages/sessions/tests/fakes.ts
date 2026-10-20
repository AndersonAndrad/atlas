import type {
  ApprovalRequest,
  AtlasSession,
  AtlasSessionStatus,
  SessionEvent,
} from '@atlas/contracts';
import { AtlasError } from '@atlas/shared';
import type {
  NewSessionEvent,
  SessionChange,
  SessionProjectInfo,
  SessionRepository,
  SessionWorkspaces,
  StoredSession,
  StoredSessionTask,
} from '../src/index.js';

/** In-memory session repository with the same revision semantics as the SQLite one. */
export class InMemorySessionRepository implements SessionRepository {
  readonly sessions = new Map<string, StoredSession>();
  readonly tasks = new Map<string, StoredSessionTask>();
  readonly events: SessionEvent[] = [];
  approvals: ApprovalRequest[] = [];

  async insert(session: AtlasSession, events: NewSessionEvent[]): Promise<void> {
    this.sessions.set(session.id, { session: structuredClone(session), revision: 0 });
    this.addEvents(session.id, events);
  }

  async findById(id: string): Promise<StoredSession | null> {
    const stored = this.sessions.get(id);
    return stored ? structuredClone(stored) : null;
  }

  async findAll(filter: { includeArchived: boolean; projectId?: string }): Promise<AtlasSession[]> {
    return [...this.sessions.values()]
      .map((stored) => structuredClone(stored.session))
      .filter((session) => filter.includeArchived || session.archivedAt === null)
      .filter((session) => filter.projectId === undefined || session.projectId === filter.projectId)
      .reverse();
  }

  async findByStatuses(statuses: readonly AtlasSessionStatus[]): Promise<StoredSession[]> {
    return [...this.sessions.values()]
      .filter((stored) => statuses.includes(stored.session.status))
      .map((stored) => structuredClone(stored));
  }

  async findByProject(projectId: string): Promise<StoredSession[]> {
    return [...this.sessions.values()]
      .filter((stored) => stored.session.projectId === projectId)
      .map((stored) => structuredClone(stored));
  }

  async commit(change: SessionChange): Promise<boolean> {
    const stored = this.sessions.get(change.sessionId);
    if (stored === undefined || stored.revision !== change.expectedRevision) return false;
    this.sessions.set(change.sessionId, {
      session: structuredClone(change.session ?? stored.session),
      revision: stored.revision + 1,
    });
    for (const task of change.upsertTasks ?? []) this.tasks.set(task.id, structuredClone(task));
    for (const id of change.removeTaskIds ?? []) this.tasks.delete(id);
    this.addEvents(change.sessionId, change.events);
    return true;
  }

  async findTasks(sessionId: string): Promise<StoredSessionTask[]> {
    return [...this.tasks.values()]
      .filter((task) => task.sessionId === sessionId)
      .sort((a, b) => a.position - b.position)
      .map((task) => structuredClone(task));
  }

  async countTasks(sessionIds: readonly string[]) {
    const counts = new Map<string, { total: number; completed: number }>();
    for (const task of this.tasks.values()) {
      if (!sessionIds.includes(task.sessionId)) continue;
      const current = counts.get(task.sessionId) ?? { total: 0, completed: 0 };
      current.total += 1;
      if (task.status === 'COMPLETED') current.completed += 1;
      counts.set(task.sessionId, current);
    }
    return counts;
  }

  async findEvents(sessionId: string, limit: number): Promise<SessionEvent[]> {
    return this.events.filter((event) => event.sessionId === sessionId).slice(-limit);
  }

  async findPendingApprovals(sessionId: string): Promise<ApprovalRequest[]> {
    return this.approvals.filter(
      (approval) => approval.sessionId === sessionId && approval.status === 'PENDING',
    );
  }

  /** Puts a stored session into any status, as an execution adapter or old build would. */
  force(id: string, status: AtlasSessionStatus): void {
    const stored = this.sessions.get(id)!;
    stored.session.status = status;
    stored.revision += 1;
  }

  private addEvents(sessionId: string, events: readonly NewSessionEvent[]): void {
    for (const event of events) {
      this.events.push({ id: this.events.length + 1, sessionId, ...structuredClone(event) });
    }
  }
}

/** Workspace checks backed by a fixed set of projects and directories. */
export class FakeWorkspaces implements SessionWorkspaces {
  readonly projects = new Map<string, SessionProjectInfo>();
  readonly directories = new Set<string>();
  readonly readOnly = new Set<string>();

  async findProject(projectId: string): Promise<SessionProjectInfo | null> {
    return this.projects.get(projectId) ?? null;
  }

  async resolveDirectory(path: string): Promise<string> {
    if (!this.directories.has(path)) throw new AtlasError('PROJECT_PATH_UNAVAILABLE');
    return path;
  }

  async isAvailable(path: string): Promise<boolean> {
    return this.directories.has(path);
  }

  async assertUsable(path: string): Promise<void> {
    if (!this.directories.has(path)) throw new AtlasError('PROJECT_PATH_UNAVAILABLE');
    if (this.readOnly.has(path)) throw new AtlasError('PROJECT_PERMISSION_DENIED');
  }
}
