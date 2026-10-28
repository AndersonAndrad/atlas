import type { AuditFinding, AuditFindingDecision, ProjectAudit } from '@atlas/contracts';
import type { AuditStore } from '@atlas/audit';
import { AtlasError } from '@atlas/shared';
import type { Database } from './database.js';

interface AuditRow {
  id: string;
  project_id: string;
  job_id: string | null;
  provider: ProjectAudit['provider'];
  profile_id: string | null;
  profile_name: string | null;
  status: ProjectAudit['status'];
  config: string;
  result: string;
  error_summary: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

/** What the user chose; never changes after creation. */
type AuditConfig = Pick<
  ProjectAudit,
  | 'categories'
  | 'scope'
  | 'scopeFiles'
  | 'scopeTruncated'
  | 'readOnlyMode'
  | 'acknowledgedWarnings'
  | 'timeoutMinutes'
>;

/** What the audit produced. */
type AuditResult = Pick<
  ProjectAudit,
  | 'summary'
  | 'workspaceCheck'
  | 'changedPaths'
  | 'metrics'
  | 'findingCount'
  | 'severityCounts'
  | 'needsReviewCount'
  | 'invalidCount'
  | 'malformedCount'
>;

const configOf = (audit: ProjectAudit): AuditConfig => ({
  categories: audit.categories,
  scope: audit.scope,
  scopeFiles: audit.scopeFiles,
  scopeTruncated: audit.scopeTruncated,
  readOnlyMode: audit.readOnlyMode,
  acknowledgedWarnings: audit.acknowledgedWarnings,
  timeoutMinutes: audit.timeoutMinutes,
});

const resultOf = (audit: ProjectAudit): AuditResult => ({
  summary: audit.summary,
  workspaceCheck: audit.workspaceCheck,
  changedPaths: audit.changedPaths,
  metrics: audit.metrics,
  findingCount: audit.findingCount,
  severityCounts: audit.severityCounts,
  needsReviewCount: audit.needsReviewCount,
  invalidCount: audit.invalidCount,
  malformedCount: audit.malformedCount,
});

const toAudit = (row: AuditRow): ProjectAudit => ({
  id: row.id,
  projectId: row.project_id,
  jobId: row.job_id,
  provider: row.provider,
  profileId: row.profile_id,
  profileName: row.profile_name,
  status: row.status,
  errorSummary: row.error_summary,
  createdAt: row.created_at,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  ...(JSON.parse(row.config) as AuditConfig),
  ...(JSON.parse(row.result) as AuditResult),
});

/** Findings keep their indexed columns next to the full JSON document. */
type FindingData = Omit<
  AuditFinding,
  'id' | 'auditId' | 'projectId' | 'ordinal' | 'fingerprint' | 'severity' | 'validation'
>;

interface FindingRow {
  id: string;
  audit_id: string;
  project_id: string;
  ordinal: number;
  fingerprint: string;
  severity: AuditFinding['severity'];
  validation: AuditFinding['validation'];
  data: string;
}

const toFinding = (row: FindingRow): AuditFinding => ({
  ...(JSON.parse(row.data) as FindingData),
  id: row.id,
  auditId: row.audit_id,
  projectId: row.project_id,
  ordinal: row.ordinal,
  fingerprint: row.fingerprint,
  severity: row.severity,
  validation: row.validation,
});

interface DecisionRow {
  project_id: string;
  fingerprint: string;
  decision: AuditFindingDecision['decision'];
  note: string | null;
  task_id: string | null;
  audit_id: string;
  finding_id: string;
  decided_at: string;
}

const toDecision = (row: DecisionRow): AuditFindingDecision => ({
  projectId: row.project_id,
  fingerprint: row.fingerprint,
  decision: row.decision,
  note: row.note,
  taskId: row.task_id,
  auditId: row.audit_id,
  findingId: row.finding_id,
  decidedAt: row.decided_at,
});

const ACTIVE = `status IN ('QUEUED', 'RUNNING')`;

/** Project audits and their findings (migration v21). */
export class SqliteAuditRepository implements AuditStore {
  constructor(private readonly db: Database) {}

  private run<T>(operation: string, action: () => T): T {
    try {
      return action();
    } catch (error) {
      if (error instanceof AtlasError) throw error;
      throw new AtlasError('PROJECT_PERSISTENCE_ERROR', 'Project audit could not be saved.', {
        cause: error,
        details: { operation },
      });
    }
  }

  private select(where: string, ...params: (string | number)[]): ProjectAudit[] {
    return (
      this.db
        .prepare(`SELECT * FROM project_audits WHERE ${where}`)
        .all(...params) as unknown as AuditRow[]
    ).map(toAudit);
  }

  private writeUpdate(audit: ProjectAudit): void {
    this.db
      .prepare(
        `UPDATE project_audits SET status = ?, result = ?, error_summary = ?, started_at = ?,
           finished_at = ?
         WHERE id = ?`,
      )
      .run(
        audit.status,
        JSON.stringify(resultOf(audit)),
        audit.errorSummary,
        audit.startedAt,
        audit.finishedAt,
        audit.id,
      );
  }

  async insert(audit: ProjectAudit): Promise<void> {
    this.run('insert', () => {
      this.db
        .prepare(
          `INSERT INTO project_audits (id, project_id, job_id, provider, profile_id,
             profile_name, status, config, result, error_summary, created_at, started_at,
             finished_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          audit.id,
          audit.projectId,
          audit.jobId,
          audit.provider,
          audit.profileId,
          audit.profileName,
          audit.status,
          JSON.stringify(configOf(audit)),
          JSON.stringify(resultOf(audit)),
          audit.errorSummary,
          audit.createdAt,
          audit.startedAt,
          audit.finishedAt,
        );
    });
  }

  async update(audit: ProjectAudit): Promise<void> {
    this.run('update', () => this.writeUpdate(audit));
  }

  async setJob(auditId: string, jobId: string): Promise<void> {
    this.run('setJob', () => {
      this.db.prepare('UPDATE project_audits SET job_id = ? WHERE id = ?').run(jobId, auditId);
    });
  }

  async complete(audit: ProjectAudit, findings: readonly AuditFinding[]): Promise<void> {
    this.run('complete', () => {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.writeUpdate(audit);
        const insert = this.db.prepare(
          `INSERT INTO project_audit_findings (id, audit_id, project_id, ordinal, fingerprint,
             category, severity, validation, data)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const finding of findings) {
          const { id, auditId, projectId, ordinal, fingerprint, severity, validation, ...data } =
            finding;
          insert.run(
            id,
            auditId,
            projectId,
            ordinal,
            fingerprint,
            data.category,
            severity,
            validation,
            JSON.stringify(data satisfies FindingData),
          );
        }
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    });
  }

  async get(id: string): Promise<ProjectAudit | null> {
    return this.run('get', () => this.select('id = ?', id)[0] ?? null);
  }

  async listForProject(projectId: string, limit: number): Promise<ProjectAudit[]> {
    return this.run('listForProject', () =>
      this.select('project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?', projectId, limit),
    );
  }

  async listActive(): Promise<ProjectAudit[]> {
    return this.run('listActive', () => this.select(`${ACTIVE} ORDER BY created_at, rowid`));
  }

  async decisions(
    projectId: string,
    fingerprints: readonly string[],
  ): Promise<AuditFindingDecision[]> {
    if (fingerprints.length === 0) return [];
    return this.run('decisions', () => {
      const wanted = new Set(fingerprints);
      return (
        this.db
          .prepare('SELECT * FROM audit_finding_decisions WHERE project_id = ?')
          .all(projectId) as unknown as DecisionRow[]
      )
        .filter((row) => wanted.has(row.fingerprint))
        .map(toDecision);
    });
  }

  async saveDecision(decision: AuditFindingDecision): Promise<void> {
    this.run('saveDecision', () => {
      this.db
        .prepare(
          `INSERT INTO audit_finding_decisions (project_id, fingerprint, decision, note, task_id,
             audit_id, finding_id, decided_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (project_id, fingerprint) DO UPDATE SET decision = excluded.decision,
             note = excluded.note, task_id = excluded.task_id, audit_id = excluded.audit_id,
             finding_id = excluded.finding_id, decided_at = excluded.decided_at`,
        )
        .run(
          decision.projectId,
          decision.fingerprint,
          decision.decision,
          decision.note,
          decision.taskId,
          decision.auditId,
          decision.findingId,
          decision.decidedAt,
        );
    });
  }

  async findings(auditId: string): Promise<AuditFinding[]> {
    return this.run('findings', () =>
      (
        this.db
          .prepare('SELECT * FROM project_audit_findings WHERE audit_id = ? ORDER BY ordinal')
          .all(auditId) as unknown as FindingRow[]
      ).map(toFinding),
    );
  }
}
