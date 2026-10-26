/** Folders the editor may access: registered projects only (SDD-011 §2.3). */
export interface EditorWorkspaces {
  /** The project's folder; throws PROJECT_NOT_FOUND for unknown projects. */
  projectRoot(projectId: string): Promise<string>;
}

/** The project's own ignore rules (Git), FR-1103. */
export interface ProjectIgnoreRules {
  /**
   * Which of `names` (entries of `directory`, an absolute path) the rules ignore; null when
   * the folder is not in a repository, so the default list applies.
   */
  ignored(directory: string, names: readonly string[]): Promise<ReadonlySet<string> | null>;
  /**
   * Files of the repository under `root` (tracked and untracked, not ignored), relative to
   * `root`; null when it is not a repository.
   */
  files(root: string): Promise<{ paths: string[]; truncated: boolean } | null>;
}

export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}
