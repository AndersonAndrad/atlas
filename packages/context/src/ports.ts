import type {
  AiSession,
  ContextCategory,
  ContextEntry,
  ContextHandoff,
  ContextOverview,
  ContextOwner,
  ContextRevision,
  ContextSnapshot,
  ContextTask,
  DecisionRecord,
} from '@atlas/contracts';

export interface EntryFilter {
  owner: ContextOwner;
  taskId?: string;
  sessionId?: string;
  category?: ContextCategory;
  /** Full-text query over titles and bodies. */
  search?: string;
  includeObsolete?: boolean;
  limit?: number;
}

/** Persistence of shared context. Implemented with SQLite (`@atlas/persistence`). */
export interface ContextRepository {
  insertEntry(entry: ContextEntry, revision: ContextRevision): Promise<void>;
  updateEntry(entry: ContextEntry, revision: ContextRevision): Promise<void>;
  deleteEntry(id: string): Promise<boolean>;
  getEntry(id: string): Promise<ContextEntry | null>;
  /** Entries of an owner (global entries when the owner is empty), newest first. */
  listEntries(filter: EntryFilter): Promise<ContextEntry[]>;
  listRevisions(entryId: string): Promise<ContextRevision[]>;

  insertTask(task: ContextTask): Promise<void>;
  updateTask(task: ContextTask): Promise<void>;
  deleteTask(id: string): Promise<boolean>;
  getTask(id: string): Promise<ContextTask | null>;
  listTasks(owner: ContextOwner): Promise<ContextTask[]>;

  insertDecision(decision: DecisionRecord): Promise<void>;
  updateDecision(decision: DecisionRecord): Promise<void>;
  getDecision(id: string): Promise<DecisionRecord | null>;
  listDecisions(owner: ContextOwner, taskId?: string): Promise<DecisionRecord[]>;

  insertSession(session: AiSession): Promise<void>;
  updateSession(session: AiSession): Promise<void>;
  getSession(id: string): Promise<AiSession | null>;
  listSessions(owner: ContextOwner): Promise<AiSession[]>;
  activeSessionForTerminal(terminalId: string): Promise<AiSession | null>;

  insertHandoff(handoff: ContextHandoff): Promise<void>;
  getHandoff(id: string): Promise<ContextHandoff | null>;
  listHandoffs(owner: ContextOwner): Promise<ContextHandoff[]>;

  insertSnapshot(snapshot: ContextSnapshot): Promise<void>;

  overview(owner: ContextOwner): Promise<ContextOverview>;
  /** A removed project's records keep its directory as their workspace. */
  reassignProject(projectId: string, workspacePath: string): Promise<void>;
}

/** Read-only repository evidence (Git), used for verified facts and freshness. */
export interface RepositoryInspector {
  state(directory: string): Promise<{
    root: string | null;
    branch: string | null;
    head: string | null;
    uncommittedFiles: number;
  }>;
  /** Git blob hash of a file's current content; null when it does not exist. */
  fileHash(root: string, path: string): Promise<string | null>;
  isAncestor(root: string, commit: string, head: string): Promise<boolean>;
  /** Commits after `base` on the current branch (newest first), or the latest ones. */
  commitsSince(root: string, base: string | null): Promise<{ hash: string; subject: string }[]>;
  /** Files changed since `base` (committed, uncommitted and untracked). */
  changedFilesSince(root: string, base: string | null): Promise<string[]>;
}
