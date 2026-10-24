import type { NoteCounts, NoteFilter, NoteSummary, ProjectNote } from '@atlas/contracts';

/**
 * Notes a query covers. A project covers its own notes and the workspace notes left in
 * its folder by an earlier registration of the same folder.
 */
export type NoteOwnerFilter =
  | { kind: 'project'; projectId: string; workspacePath: string }
  | { kind: 'global' }
  | { kind: 'all' };

export interface NoteRepositoryQuery {
  owner: NoteOwnerFilter;
  filter: NoteFilter;
  /** An FTS5 query built by `ftsQuery`, never raw user text. */
  match: string | null;
  category: string | null;
  limit: number;
}

/** Storage of notes (SQLite in the Engine). */
export interface NoteRepository {
  insert(note: ProjectNote): Promise<void>;
  get(id: string): Promise<ProjectNote | null>;
  /**
   * Replaces the note only while its stored revision is still `expectedRevision`.
   * False when the note changed or no longer exists.
   */
  update(note: ProjectNote, expectedRevision: number): Promise<boolean>;
  /** False when the note does not exist. */
  remove(id: string): Promise<boolean>;
  /** Pinned first, then the most recently updated. */
  list(query: NoteRepositoryQuery): Promise<NoteSummary[]>;
  /** Distinct categories, sorted case-insensitively. */
  categories(owner: NoteOwnerFilter): Promise<string[]>;
  counts(owner: NoteOwnerFilter): Promise<NoteCounts>;
}

/** What `atlas:` links point to, resolved by the Engine (FR-1006). */
export interface NoteLinkTargets {
  /** The project's folder; throws PROJECT_NOT_FOUND for unknown projects. */
  projectWorkspace(projectId: string): Promise<string>;
  /** Title of an ATLAS Session, null when it does not exist. */
  sessionTitle(id: string): Promise<string | null>;
  /** Local branch names of the project's repository; empty when it is not a repository. */
  branchNames(projectId: string): Promise<ReadonlySet<string>>;
  /**
   * Absolute path of an existing file or folder inside the project's folder, after
   * resolving symbolic links; null when missing or outside the folder.
   */
  resolveFile(projectId: string, relativePath: string): Promise<string | null>;
}
