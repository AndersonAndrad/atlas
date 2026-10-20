import type { Project, ProjectPathInspection } from '@atlas/contracts';
import { AtlasError } from '@atlas/shared';
import type {
  PathInspector,
  ProjectRepository,
  SettingsRepository,
  StoredProject,
} from '../src/index.js';

export class InMemoryProjectRepository implements ProjectRepository {
  readonly records = new Map<string, StoredProject>();

  async findAll(): Promise<Project[]> {
    return [...this.records.values()].map((record) => structuredClone(record.project));
  }
  async findById(id: string): Promise<Project | null> {
    const record = this.records.get(id);
    return record ? structuredClone(record.project) : null;
  }
  async findByPathKey(pathKey: string): Promise<Project | null> {
    const record = [...this.records.values()].find((r) => r.pathKey === pathKey);
    return record ? structuredClone(record.project) : null;
  }
  async insert(record: StoredProject): Promise<void> {
    this.assertUniqueKey(record);
    this.records.set(record.project.id, structuredClone(record));
  }
  async update(record: StoredProject): Promise<void> {
    if (!this.records.has(record.project.id)) throw new AtlasError('PROJECT_NOT_FOUND');
    this.assertUniqueKey(record);
    this.records.set(record.project.id, structuredClone(record));
  }
  async delete(id: string): Promise<boolean> {
    return this.records.delete(id);
  }
  private assertUniqueKey(record: StoredProject) {
    for (const existing of this.records.values()) {
      if (existing.pathKey === record.pathKey && existing.project.id !== record.project.id) {
        throw new AtlasError('PROJECT_ALREADY_EXISTS');
      }
    }
  }
}

export class InMemorySettingsRepository implements SettingsRepository {
  readonly values = new Map<string, string>();
  async get(key: string) {
    return this.values.get(key) ?? null;
  }
  async set(key: string, value: string) {
    this.values.set(key, value);
  }
  async delete(key: string) {
    this.values.delete(key);
  }
}

type FakeEntry =
  | { status: 'available'; resolvedPath?: string; gitRoot?: string; branch?: string }
  | { status: 'missing' | 'not-a-directory' | 'permission-denied' };

/** Path inspector backed by a static map; unknown paths are reported as missing. */
export class FakePathInspector implements PathInspector {
  readonly entries = new Map<string, FakeEntry>();
  calls: string[] = [];

  set(path: string, entry: FakeEntry) {
    this.entries.set(path, entry);
    return this;
  }

  async inspect(absolutePath: string): Promise<ProjectPathInspection> {
    this.calls.push(absolutePath);
    const checkedAt = '2026-01-01T00:00:00.000Z';
    const entry = this.entries.get(absolutePath) ?? { status: 'missing' as const };
    if (entry.status !== 'available') {
      return {
        inputPath: absolutePath,
        availability: { status: entry.status, checkedAt },
        git: { isRepository: false },
      };
    }
    const resolvedPath = entry.resolvedPath ?? absolutePath;
    return {
      inputPath: absolutePath,
      resolvedPath,
      availability: { status: 'available', checkedAt },
      git: entry.gitRoot
        ? {
            isRepository: true,
            repositoryRoot: entry.gitRoot,
            ...(entry.branch ? { branch: entry.branch } : {}),
          }
        : { isRepository: false },
      suggestedName: resolvedPath.split('/').filter(Boolean).at(-1) ?? resolvedPath,
    };
  }
}
