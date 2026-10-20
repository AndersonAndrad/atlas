import type {
  ApprovalRequest,
  AtlasSession,
  AtlasSessionStatus,
  SessionEvent,
  SessionEventMetadata,
  SessionEventType,
  SessionTaskStatus,
} from '@atlas/contracts';

/** A task as stored; `blockedBy` is derived when tasks are read. */
export interface StoredSessionTask {
  id: string;
  sessionId: string;
  title: string;
  description: string;
  status: SessionTaskStatus;
  dependencies: string[];
  assignedAgentId: string | null;
  validationCriteria: string[];
  /** Creation order inside the session. */
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface StoredSession {
  session: AtlasSession;
  /** Incremented by every committed change; used for optimistic concurrency. */
  revision: number;
}

export interface NewSessionEvent {
  type: SessionEventType;
  occurredAt: string;
  metadata: SessionEventMetadata;
}

/**
 * One atomic change of a session and its tasks. It is applied only when the
 * stored revision still equals `expectedRevision`, so concurrent writers (the
 * Engine host and a CLI process) never overwrite each other's changes.
 */
export interface SessionChange {
  sessionId: string;
  expectedRevision: number;
  session?: AtlasSession;
  upsertTasks?: StoredSessionTask[];
  removeTaskIds?: string[];
  events: NewSessionEvent[];
}

export interface SessionRepository {
  insert(session: AtlasSession, events: NewSessionEvent[]): Promise<void>;
  findById(id: string): Promise<StoredSession | null>;
  findAll(filter: { includeArchived: boolean; projectId?: string }): Promise<AtlasSession[]>;
  findByStatuses(statuses: readonly AtlasSessionStatus[]): Promise<StoredSession[]>;
  findByProject(projectId: string): Promise<StoredSession[]>;
  /** Returns false (and changes nothing) when the revision no longer matches. */
  commit(change: SessionChange): Promise<boolean>;
  findTasks(sessionId: string): Promise<StoredSessionTask[]>;
  /** Total and completed task counts per session. */
  countTasks(
    sessionIds: readonly string[],
  ): Promise<Map<string, { total: number; completed: number }>>;
  /** The most recent events, in chronological order. */
  findEvents(sessionId: string, limit: number): Promise<SessionEvent[]>;
  findPendingApprovals(sessionId: string): Promise<ApprovalRequest[]>;
}

export interface SessionProjectInfo {
  id: string;
  name: string;
  workspacePath: string;
}

/** Resolves and checks workspace references; implemented by the Engine. */
export interface SessionWorkspaces {
  /** Registry lookup only (no filesystem access); `null` when the project is not registered. */
  findProject(projectId: string): Promise<SessionProjectInfo | null>;
  /** Validates an absolute, existing directory and returns its canonical path. */
  resolveDirectory(path: string): Promise<string>;
  /** Whether a directory currently exists and is readable. Never throws. */
  isAvailable(path: string): Promise<boolean>;
  /**
   * Throws a user-safe AtlasError unless the directory exists and can be read and
   * written. Checked before a session is prepared for execution.
   */
  assertUsable(path: string): Promise<void>;
}

export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}
