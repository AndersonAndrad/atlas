import type {
  AiSession,
  ContextCategory,
  ContextEntry,
  ContextHandoff,
  ContextOverview,
  ContextOwner,
  ContextReconciliation,
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

/** Record counts of an owner for the Context Health report. */
export interface ContextCounts {
  entries: number;
  activeEntries: number;
  obsoleteEntries: number;
  requiredEntries: number;
  decisions: number;
  activeDecisions: number;
  supersededDecisions: number;
  tasks: number;
  openTasks: number;
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
  /**
   * Active entries of an owner matching any of the terms in the full-text index,
   * best first (bm25). Terms are plain words; they are never parsed as FTS syntax.
   */
  rankEntries(owner: ContextOwner, terms: string[], limit: number): Promise<ContextEntry[]>;
  /**
   * Changes whenever an entry, task or decision of the owner (or a global entry)
   * is added, changed or removed, also by another process. Used as cache key.
   */
  revision(owner: ContextOwner): Promise<string>;
  counts(owner: ContextOwner): Promise<ContextCounts>;

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

  /** Records a reconciliation run; only the latest runs per owner are kept. */
  insertReconciliation(owner: ContextOwner, run: ContextReconciliation): Promise<void>;
  lastReconciliation(owner: ContextOwner): Promise<ContextReconciliation | null>;

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
