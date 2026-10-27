import type { GitChangeCounts, GitUnavailableReason, ProjectGitSnapshot } from '@atlas/contracts';
import type { ProjectGitStore, StoredProjectGit } from '@atlas/git';
import { AtlasError } from '@atlas/shared';
import type { Database } from './database.js';

interface Row {
  project_id: string;
  git_monitoring_enabled: number;
  state: string | null;
  branch: string | null;
  detached_head: number | null;
  unborn_head: number | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  upstream_gone: number | null;
  changes: string | null;
  refreshed_at: string | null;
  error_reason: string | null;
  error_at: string | null;
}

const SELECT = `SELECT p.id AS project_id, p.git_monitoring_enabled, s.state, s.branch,
    s.detached_head, s.unborn_head, s.upstream, s.ahead, s.behind, s.upstream_gone, s.changes,
    s.refreshed_at, s.error_reason, s.error_at
  FROM projects p LEFT JOIN project_git_snapshots s ON s.project_id = p.id`;

const EMPTY_CHANGES: GitChangeCounts = {
  modified: 0,
  staged: 0,
  untracked: 0,
  deleted: 0,
  renamed: 0,
  conflicted: 0,
  total: 0,
};

function toSnapshot(row: Row): ProjectGitSnapshot | null {
  if (row.state === 'not-repository') return { state: 'not-repository' };
  if (row.state !== 'repository') return null;
  return {
    state: 'repository',
    branch: row.branch,
    detachedHead: row.detached_head === 1,
    unbornHead: row.unborn_head === 1,
    upstream: row.upstream,
    ahead: row.ahead,
    behind: row.behind,
    upstreamGone: row.upstream_gone === 1,
    changes: { ...EMPTY_CHANGES, ...(JSON.parse(row.changes ?? '{}') as Partial<GitChangeCounts>) },
  };
}

function toStored(row: Row): StoredProjectGit {
  return {
    projectId: row.project_id,
    monitoringEnabled: row.git_monitoring_enabled === 1,
    snapshot: toSnapshot(row),
    refreshedAt: row.refreshed_at,
    error:
      row.error_reason !== null && row.error_at !== null
        ? { reason: row.error_reason as GitUnavailableReason, at: row.error_at }
        : null,
  };
}

/** Per-project Git monitoring preference and last known status (migration v17). */
export class SqliteProjectGitRepository implements ProjectGitStore {
  constructor(private readonly db: Database) {}

  private run<T>(operation: string, action: () => T): T {
    try {
      return action();
    } catch (error) {
      if (error instanceof AtlasError) throw error;
      throw new AtlasError('PROJECT_PERSISTENCE_ERROR', 'Project Git status could not be saved.', {
        cause: error,
        details: { operation },
      });
    }
  }

  async list(): Promise<StoredProjectGit[]> {
    return this.run('list', () =>
      (this.db.prepare(SELECT).all() as unknown as Row[]).map(toStored),
    );
  }

  async get(projectId: string): Promise<StoredProjectGit | null> {
    return this.run('get', () => {
      const row = this.db.prepare(`${SELECT} WHERE p.id = ?`).get(projectId) as Row | undefined;
      return row === undefined ? null : toStored(row);
    });
  }

  async setMonitoring(projectId: string, enabled: boolean): Promise<boolean> {
    return this.run('setMonitoring', () => {
      const result = this.db
        .prepare('UPDATE projects SET git_monitoring_enabled = ? WHERE id = ?')
        .run(enabled ? 1 : 0, projectId);
      return Number(result.changes) > 0;
    });
  }

  async saveSnapshot(
    projectId: string,
    snapshot: ProjectGitSnapshot,
    refreshedAt: string,
  ): Promise<void> {
    const repository = snapshot.state === 'repository' ? snapshot : null;
    this.run('saveSnapshot', () => {
      // A project removed meanwhile matches no row in projects: nothing is written.
      this.db
        .prepare(
          `INSERT INTO project_git_snapshots (project_id, state, branch, detached_head,
             unborn_head, upstream, ahead, behind, upstream_gone, changes, refreshed_at,
             error_reason, error_at)
           SELECT id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL FROM projects WHERE id = ?
           ON CONFLICT (project_id) DO UPDATE SET state = excluded.state,
             branch = excluded.branch, detached_head = excluded.detached_head,
             unborn_head = excluded.unborn_head, upstream = excluded.upstream,
             ahead = excluded.ahead, behind = excluded.behind,
             upstream_gone = excluded.upstream_gone, changes = excluded.changes,
             refreshed_at = excluded.refreshed_at, error_reason = NULL, error_at = NULL`,
        )
        .run(
          snapshot.state,
          repository?.branch ?? null,
          repository?.detachedHead ? 1 : 0,
          repository?.unbornHead ? 1 : 0,
          repository?.upstream ?? null,
          repository?.ahead ?? null,
          repository?.behind ?? null,
          repository?.upstreamGone ? 1 : 0,
          repository === null ? null : JSON.stringify(repository.changes),
          refreshedAt,
          projectId,
        );
    });
  }

  async saveError(projectId: string, reason: GitUnavailableReason, at: string): Promise<void> {
    this.run('saveError', () => {
      // Keeps the last successful snapshot; only the error columns change.
      this.db
        .prepare(
          `INSERT INTO project_git_snapshots (project_id, error_reason, error_at)
           SELECT id, ?, ? FROM projects WHERE id = ?
           ON CONFLICT (project_id) DO UPDATE SET error_reason = excluded.error_reason,
             error_at = excluded.error_at`,
        )
        .run(reason, at, projectId);
    });
  }

  async clearSnapshot(projectId: string): Promise<void> {
    this.run('clearSnapshot', () => {
      this.db.prepare('DELETE FROM project_git_snapshots WHERE project_id = ?').run(projectId);
    });
  }
}
