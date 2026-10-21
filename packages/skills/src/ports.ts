import type {
  AiProvider,
  Skill,
  SkillAssignment,
  SkillScope,
  SkillSource,
  SkillSyncBatch,
  SkillVersion,
} from '@atlas/contracts';
import type { SkillFolderSnapshot } from './analyze.js';

/** A version as stored: the SKILL.md text and where its copy lives. */
export interface StoredSkillVersion extends SkillVersion {
  skillMd: string;
  storagePath: string;
}

/** One change written to a provider folder by a synchronization, for rollback. */
export interface SkillSyncChange {
  skillId: string | null;
  dirName: string;
  action: 'create' | 'update' | 'remove';
  targetPath: string;
  /** Where the replaced or removed folder was moved; null for created folders. */
  backupPath: string | null;
}

/** Persistence of the Skills Hub (SQLite in `@atlas/persistence`). */
export interface SkillRepository {
  listSkills(): Promise<Skill[]>;
  getSkill(id: string): Promise<Skill | null>;
  /** Inserts a skill with its first version. */
  insertSkill(skill: Skill, version: StoredSkillVersion): Promise<void>;
  /** Adds a version and makes it current. */
  addVersion(skill: Skill, version: StoredSkillVersion): Promise<void>;
  /** Saves the enabled flag, validation and update time. */
  updateSkill(skill: Skill): Promise<void>;
  /** Removes the registry entry, its versions and assignments. */
  removeSkill(id: string): Promise<boolean>;
  listVersions(skillId: string): Promise<StoredSkillVersion[]>;
  getVersion(skillId: string, sequence: number): Promise<StoredSkillVersion | null>;

  setAssignment(assignment: SkillAssignment): Promise<void>;
  removeAssignment(skillId: string, scope: SkillScope, target: string): Promise<boolean>;
  /** Removes every assignment to a target, e.g. a removed project. */
  removeAssignmentsFor(scope: SkillScope, target: string): Promise<number>;

  listSources(): Promise<SkillSource[]>;
  insertSource(source: SkillSource): Promise<void>;
  setSourceEnabled(id: string, enabled: boolean): Promise<boolean>;
  removeSource(id: string): Promise<boolean>;

  insertSyncBatch(batch: SkillSyncBatch, changes: SkillSyncChange[]): Promise<void>;
  listSyncBatches(provider?: AiProvider): Promise<SkillSyncBatch[]>;
  syncChanges(batchId: string): Promise<SkillSyncChange[]>;
  markRolledBack(batchId: string, at: string): Promise<void>;
}

/** File access of the Skills Hub; the Node implementation is `NodeSkillFileSystem`. */
export interface SkillFileSystem {
  /** Reads a skill folder within the size limits; never follows links outside it. */
  snapshot(directory: string): Promise<SkillFolderSnapshot>;
  /** Direct sub-folders containing SKILL.md (hidden folders are skipped). */
  skillFolders(root: string): Promise<string[]>;
  /** Copies the listed files (relative paths) from one folder to a new one. */
  copyFiles(from: string, to: string, files: readonly string[]): Promise<void>;
  writeFile(file: string, content: string): Promise<void>;
  /** Text of a file, or null for binary content. */
  readText(file: string, maxBytes: number): Promise<{ content: string | null; truncated: boolean }>;
  kind(path: string): Promise<'directory' | 'file' | 'other' | null>;
  realpath(path: string): Promise<string>;
  /** Renames within one filesystem, creating the destination's parent. */
  move(from: string, to: string): Promise<void>;
  removeDirectory(directory: string): Promise<void>;
  /** Looks an executable up on PATH without running it; null when unknown. */
  hasExecutable(name: string): boolean | null;
}

/** Folders suggested for discovery; inspected only after the user adds them. */
export interface SuggestionEnvironment {
  home: string;
  /** `CLAUDE_CONFIG_DIR` when set. */
  claudeConfigDir: string | null;
}
