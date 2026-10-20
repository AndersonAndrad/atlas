import type { Project, ProjectPathInspection } from '@atlas/contracts';

/** A project as persisted, including its platform-normalized path key used for uniqueness. */
export interface StoredProject {
  project: Project;
  pathKey: string;
}

export interface ProjectRepository {
  findAll(): Promise<Project[]>;
  findById(id: string): Promise<Project | null>;
  findByPathKey(pathKey: string): Promise<Project | null>;
  /** Throws PROJECT_ALREADY_EXISTS when the path key is already registered. */
  insert(record: StoredProject): Promise<void>;
  /** Throws PROJECT_ALREADY_EXISTS when the path key belongs to another project. */
  update(record: StoredProject): Promise<void>;
  /** Returns false when no project had the given id. */
  delete(id: string): Promise<boolean>;
}

export interface SettingsRepository {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface PathInspector {
  /** Inspects an absolute path. Must never throw for missing or inaccessible paths. */
  inspect(absolutePath: string): Promise<ProjectPathInspection>;
}

export interface Clock {
  now(): Date;
}

export type IdGenerator = () => string;
