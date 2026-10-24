import type {
  PreflightCheckResult,
  PreflightRequiredOutcome,
  PreflightRun,
  PreflightRunStatus,
  PreflightRunSummary,
  PreflightTrigger,
  PreflightWorkspace,
} from '@atlas/contracts';
import { requiredOutcome, statusCounts, type PreflightRepository } from '@atlas/preflight';
import { AtlasError } from '@atlas/shared';
import type { Database } from './database.js';

type Row = Record<string, string | number | null>;

const str = (row: Row, key: string) => row[key] as string;
const strOrNull = (row: Row, key: string) => (row[key] as string | null) ?? null;

function toWorkspace(row: Row): PreflightWorkspace {
  return {
    id: str(row, 'id'),
    path: str(row, 'path'),
    projectId: strOrNull(row, 'project_id'),
    name: str(row, 'name'),
    createdAt: str(row, 'created_at'),
    updatedAt: str(row, 'updated_at'),
  };
}

function toRun(row: Row): PreflightRun {
  return {
    id: str(row, 'id'),
    workspaceId: str(row, 'workspace_id'),
    projectId: strOrNull(row, 'project_id'),
    workspacePath: str(row, 'workspace_path'),
    profileId: strOrNull(row, 'profile_id'),
    profileName: str(row, 'profile_name'),
    trigger: str(row, 'trigger') as PreflightTrigger,
    status: str(row, 'status') as PreflightRunStatus,
    requiredOutcome: str(row, 'required_outcome') as PreflightRequiredOutcome,
    sourceRevision: strOrNull(row, 'source_revision'),
    branch: strOrNull(row, 'branch'),
    sourceStateFingerprint: strOrNull(row, 'source_fingerprint'),
    sourceChangedDuringRun: row.source_changed === 1,
    retryOf: strOrNull(row, 'retry_of'),
    startedAt: str(row, 'started_at'),
    finishedAt: strOrNull(row, 'finished_at'),
    results: JSON.parse(str(row, 'results')) as PreflightCheckResult[],
  };
}

function summary(run: PreflightRun): PreflightRunSummary {
  const { results, ...rest } = run;
  return { ...rest, counts: statusCounts(results) };
}

/** SQLite storage of Preflight workspaces, authorizations and runs (migration v10). */
export class SqlitePreflightRepository implements PreflightRepository {
  constructor(private readonly db: Database) {}

  private run<T>(operation: string, action: () => T): T {
    try {
      return action();
    } catch (error) {
      if (error instanceof AtlasError) throw error;
      throw new AtlasError('PROJECT_PERSISTENCE_ERROR', 'Preflight data could not be saved.', {
        cause: error,
        details: { operation },
      });
    }
  }

  async listWorkspaces(): Promise<PreflightWorkspace[]> {
    return this.run('listWorkspaces', () =>
      (
        this.db.prepare('SELECT * FROM preflight_workspaces ORDER BY name, path').all() as Row[]
      ).map(toWorkspace),
    );
  }

  async findWorkspace(id: string) {
    return this.run('findWorkspace', () => {
      const row = this.db.prepare('SELECT * FROM preflight_workspaces WHERE id = ?').get(id) as
        Row | undefined;
      return row ? { workspace: toWorkspace(row), config: str(row, 'config') } : null;
    });
  }

  async findWorkspaceByPath(path: string): Promise<PreflightWorkspace | null> {
    return this.run('findWorkspaceByPath', () => {
      const row = this.db.prepare('SELECT * FROM preflight_workspaces WHERE path = ?').get(path) as
        Row | undefined;
      return row ? toWorkspace(row) : null;
    });
  }

  async insertWorkspace(workspace: PreflightWorkspace, config: string): Promise<void> {
    this.run('insertWorkspace', () => {
      this.db
        .prepare(
          `INSERT INTO preflight_workspaces (id, path, project_id, name, config, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          workspace.id,
          workspace.path,
          workspace.projectId,
          workspace.name,
          config,
          workspace.createdAt,
          workspace.updatedAt,
        );
    });
  }

  async updateWorkspace(workspace: PreflightWorkspace, config: string): Promise<void> {
    this.run('updateWorkspace', () => {
      this.db
        .prepare(
          `UPDATE preflight_workspaces SET project_id = ?, name = ?, config = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(workspace.projectId, workspace.name, config, workspace.updatedAt, workspace.id);
    });
  }

  async removeWorkspace(id: string): Promise<void> {
    this.run('removeWorkspace', () => {
      this.db.prepare('DELETE FROM preflight_workspaces WHERE id = ?').run(id);
    });
  }

  async authorizationState(workspaceId: string, checkId: string, digest: string) {
    return this.run('authorizationState', () => {
      const rows = this.db
        .prepare(
          'SELECT digest FROM preflight_authorizations WHERE workspace_id = ? AND check_id = ?',
        )
        .all(workspaceId, checkId) as Row[];
      if (rows.some((row) => row.digest === digest)) return 'current' as const;
      return rows.length > 0 ? ('other' as const) : ('none' as const);
    });
  }

  async authorize(workspaceId: string, checkId: string, digest: string, at: string) {
    this.run('authorize', () => {
      this.db
        .prepare(
          `INSERT INTO preflight_authorizations (workspace_id, check_id, digest, authorized_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (workspace_id, check_id, digest) DO UPDATE SET authorized_at = excluded.authorized_at`,
        )
        .run(workspaceId, checkId, digest, at);
    });
  }

  private runValues(run: PreflightRun) {
    return [
      run.workspaceId,
      run.projectId,
      run.workspacePath,
      run.profileId,
      run.profileName,
      run.trigger,
      run.status,
      run.requiredOutcome,
      run.sourceRevision,
      run.branch,
      run.sourceStateFingerprint,
      run.sourceChangedDuringRun ? 1 : 0,
      run.retryOf,
      run.startedAt,
      run.finishedAt,
      JSON.stringify(run.results),
    ];
  }

  async insertRun(run: PreflightRun): Promise<void> {
    this.run('insertRun', () => {
      this.db
        .prepare(
          `INSERT INTO preflight_runs (workspace_id, project_id, workspace_path, profile_id,
             profile_name, trigger, status, required_outcome, source_revision, branch,
             source_fingerprint, source_changed, retry_of, started_at, finished_at, results, id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(...this.runValues(run), run.id);
    });
  }

  async updateRun(run: PreflightRun): Promise<void> {
    this.run('updateRun', () => {
      this.db
        .prepare(
          `UPDATE preflight_runs SET workspace_id = ?, project_id = ?, workspace_path = ?,
             profile_id = ?, profile_name = ?, trigger = ?, status = ?, required_outcome = ?,
             source_revision = ?, branch = ?, source_fingerprint = ?, source_changed = ?,
             retry_of = ?, started_at = ?, finished_at = ?, results = ?
           WHERE id = ?`,
        )
        .run(...this.runValues(run), run.id);
    });
  }

  async findRun(id: string): Promise<PreflightRun | null> {
    return this.run('findRun', () => {
      const row = this.db.prepare('SELECT * FROM preflight_runs WHERE id = ?').get(id) as
        Row | undefined;
      return row ? toRun(row) : null;
    });
  }

  async listRuns(workspaceId: string, limit: number, before?: string) {
    return this.run('listRuns', () => {
      const anchor =
        before === undefined
          ? undefined
          : (this.db
              .prepare('SELECT started_at, id FROM preflight_runs WHERE id = ?')
              .get(before) as Row | undefined);
      const rows = (
        anchor === undefined
          ? this.db
              .prepare(
                `SELECT * FROM preflight_runs WHERE workspace_id = ?
                 ORDER BY started_at DESC, id DESC LIMIT ?`,
              )
              .all(workspaceId, limit)
          : this.db
              .prepare(
                `SELECT * FROM preflight_runs WHERE workspace_id = ?
                   AND (started_at < ? OR (started_at = ? AND id < ?))
                 ORDER BY started_at DESC, id DESC LIMIT ?`,
              )
              .all(
                workspaceId,
                str(anchor, 'started_at'),
                str(anchor, 'started_at'),
                str(anchor, 'id'),
                limit,
              )
      ) as Row[];
      return rows.map((row) => summary(toRun(row)));
    });
  }

  async interruptRunning(at: string): Promise<string[]> {
    return this.run('interruptRunning', () => {
      const rows = this.db
        .prepare("SELECT * FROM preflight_runs WHERE status = 'RUNNING'")
        .all() as Row[];
      const update = this.db.prepare(
        "UPDATE preflight_runs SET status = 'CANCELLED', required_outcome = ?, finished_at = ?, results = ? WHERE id = ?",
      );
      for (const row of rows) {
        const run = toRun(row);
        const results = run.results.map((result) =>
          result.status === 'PENDING' || result.status === 'RUNNING'
            ? {
                ...result,
                status: 'CANCELLED' as const,
                detail: 'The Engine stopped during the run.',
                finishedAt: at,
              }
            : result,
        );
        update.run(requiredOutcome(results), at, JSON.stringify(results), run.id);
      }
      return rows.map((row) => str(row, 'id'));
    });
  }

  async pruneRuns(workspaceId: string, keep: number): Promise<string[]> {
    return this.run('pruneRuns', () => {
      const rows = this.db
        .prepare(
          `SELECT id FROM preflight_runs WHERE workspace_id = ? AND status <> 'RUNNING'
           ORDER BY started_at DESC, id DESC LIMIT -1 OFFSET ?`,
        )
        .all(workspaceId, keep) as Row[];
      const remove = this.db.prepare('DELETE FROM preflight_runs WHERE id = ?');
      for (const row of rows) remove.run(str(row, 'id'));
      return rows.map((row) => str(row, 'id'));
    });
  }
}
