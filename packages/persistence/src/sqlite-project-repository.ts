import { ProjectSchema, type Project } from '@atlas/contracts';
import type { ProjectRepository, StoredProject } from '@atlas/projects';
import { AtlasError } from '@atlas/shared';
import type { Database } from './database.js';

interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  workspace_path: string;
  tags: string;
  git_repository_root: string | null;
  is_git_repository: number;
  created_at: string;
  updated_at: string;
  last_opened_at: string | null;
}

const SELECT_COLUMNS = `id, name, description, workspace_path, tags, git_repository_root,
  is_git_repository, created_at, updated_at, last_opened_at`;

// SQLite extended result code for UNIQUE constraint violations.
const SQLITE_CONSTRAINT_UNIQUE = 2067;
const SQLITE_CONSTRAINT_PRIMARYKEY = 1555;

export class SqliteProjectRepository implements ProjectRepository {
  constructor(private readonly db: Database) {}

  async findAll(): Promise<Project[]> {
    return this.run('findAll', () => {
      const rows = this.db
        .prepare(`SELECT ${SELECT_COLUMNS} FROM projects ORDER BY name COLLATE NOCASE, created_at`)
        .all() as unknown as ProjectRow[];
      return rows.map(toProject);
    });
  }

  async findById(id: string): Promise<Project | null> {
    return this.run('findById', () => {
      const row = this.db.prepare(`SELECT ${SELECT_COLUMNS} FROM projects WHERE id = ?`).get(id) as
        ProjectRow | undefined;
      return row ? toProject(row) : null;
    });
  }

  async findByPathKey(pathKey: string): Promise<Project | null> {
    return this.run('findByPathKey', () => {
      const row = this.db
        .prepare(`SELECT ${SELECT_COLUMNS} FROM projects WHERE path_key = ?`)
        .get(pathKey) as ProjectRow | undefined;
      return row ? toProject(row) : null;
    });
  }

  async insert({ project, pathKey }: StoredProject): Promise<void> {
    this.run('insert', () => {
      this.db
        .prepare(
          `INSERT INTO projects (id, name, description, workspace_path, path_key, tags,
             git_repository_root, is_git_repository, created_at, updated_at, last_opened_at)
           VALUES (:id, :name, :description, :workspacePath, :pathKey, :tags,
             :gitRepositoryRoot, :isGitRepository, :createdAt, :updatedAt, :lastOpenedAt)`,
        )
        .run(toParams(project, pathKey));
    });
  }

  async update({ project, pathKey }: StoredProject): Promise<void> {
    const changes = this.run('update', () => {
      const result = this.db
        .prepare(
          `UPDATE projects SET name = :name, description = :description,
             workspace_path = :workspacePath, path_key = :pathKey, tags = :tags,
             git_repository_root = :gitRepositoryRoot, is_git_repository = :isGitRepository,
             updated_at = :updatedAt, last_opened_at = :lastOpenedAt
           WHERE id = :id`,
        )
        // created_at is immutable and therefore not part of the UPDATE statement.
        .run(updateParams(project, pathKey));
      return Number(result.changes);
    });
    if (changes === 0) {
      throw new AtlasError('PROJECT_NOT_FOUND', undefined, { details: { projectId: project.id } });
    }
  }

  async delete(id: string): Promise<boolean> {
    return this.run('delete', () => {
      const result = this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
      return Number(result.changes) > 0;
    });
  }

  private run<T>(operation: string, fn: () => T): T {
    try {
      return fn();
    } catch (error) {
      if (error instanceof AtlasError) throw error;
      const errcode = (error as { errcode?: unknown }).errcode;
      if (errcode === SQLITE_CONSTRAINT_UNIQUE || errcode === SQLITE_CONSTRAINT_PRIMARYKEY) {
        throw new AtlasError('PROJECT_ALREADY_EXISTS', undefined, {
          cause: error,
          details: { operation },
        });
      }
      throw new AtlasError('PROJECT_PERSISTENCE_ERROR', `Project repository ${operation} failed.`, {
        cause: error,
        details: { operation },
      });
    }
  }
}

function toParams(project: Project, pathKey: string) {
  return {
    id: project.id,
    name: project.name,
    description: project.description ?? null,
    workspacePath: project.workspacePath,
    pathKey,
    tags: JSON.stringify(project.tags),
    gitRepositoryRoot: project.git.isRepository ? (project.git.repositoryRoot ?? null) : null,
    isGitRepository: project.git.isRepository ? 1 : 0,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    lastOpenedAt: project.lastOpenedAt ?? null,
  };
}

function updateParams(project: Project, pathKey: string) {
  const { createdAt: _createdAt, ...params } = toParams(project, pathKey);
  return params;
}

function toProject(row: ProjectRow): Project {
  const candidate = {
    id: row.id,
    name: row.name,
    ...(row.description !== null ? { description: row.description } : {}),
    tags: JSON.parse(row.tags) as unknown,
    workspacePath: row.workspace_path,
    git:
      row.is_git_repository === 1 && row.git_repository_root !== null
        ? { isRepository: true, repositoryRoot: row.git_repository_root }
        : { isRepository: false },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.last_opened_at !== null ? { lastOpenedAt: row.last_opened_at } : {}),
  };
  const parsed = ProjectSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new AtlasError('PROJECT_PERSISTENCE_ERROR', 'Stored project record is corrupted.', {
      details: { projectId: row.id, issues: parsed.error.issues },
    });
  }
  return parsed.data;
}
