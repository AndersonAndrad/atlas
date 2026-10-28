import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuditFinding, ProjectAudit } from '@atlas/contracts';
import {
  MIGRATIONS,
  SqliteAuditRepository,
  getSchemaVersion,
  openDatabase,
  type Database,
} from '@atlas/persistence';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = (minute: number) => new Date(Date.UTC(2026, 9, 27, 12, minute)).toISOString();
const PROJECT = id(500);
const OTHER = id(501);

const audit = (n: number, overrides: Partial<ProjectAudit> = {}): ProjectAudit => ({
  id: id(n),
  projectId: PROJECT,
  jobId: null,
  provider: 'claude',
  profileId: null,
  profileName: null,
  categories: ['security'],
  scope: { kind: 'project' },
  scopeFiles: [],
  scopeTruncated: false,
  readOnlyMode: 'tools-restricted',
  acknowledgedWarnings: [],
  timeoutMinutes: 30,
  status: 'QUEUED',
  createdAt: at(n),
  startedAt: null,
  finishedAt: null,
  summary: null,
  errorSummary: null,
  workspaceCheck: null,
  changedPaths: [],
  metrics: null,
  findingCount: 0,
  severityCounts: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFORMATIONAL: 0 },
  needsReviewCount: 0,
  invalidCount: 0,
  malformedCount: 0,
  ...overrides,
});

const finding = (n: number, auditId: string, ordinal: number): AuditFinding => ({
  id: id(n),
  auditId,
  projectId: PROJECT,
  fingerprint: 'a'.repeat(64),
  ordinal,
  title: `Finding ${ordinal}`,
  category: 'security',
  severity: 'HIGH',
  confidence: 'MEDIUM',
  kind: 'observation',
  description: 'Description',
  evidence: 'Evidence',
  excerpt: 'const x = 1;',
  locations: [{ path: 'src/a.ts', startLine: 1, endLine: null, symbol: null, status: 'located' }],
  impact: 'Impact',
  recommendation: 'Recommendation',
  suggestedTaskTitle: 'Fix it',
  acceptanceCriteria: ['It is fixed'],
  effort: 'small',
  validation: 'evidence-located',
  validationNotes: [],
  containsCommands: false,
});

describe('SqliteAuditRepository (SDD-026 Task 01)', () => {
  let db: Database;
  let repository: SqliteAuditRepository;

  beforeEach(() => {
    db = openDatabase({ filePath: ':memory:' });
    for (const project of [PROJECT, OTHER]) {
      db.prepare(
        `INSERT INTO projects (id, name, workspace_path, path_key, tags, is_git_repository,
           created_at, updated_at) VALUES (?, 'P', ?, ?, '[]', 0, 'x', 'x')`,
      ).run(project, `/work/${project}`, `/work/${project}`);
    }
    repository = new SqliteAuditRepository(db);
  });

  afterEach(() => db.close());

  it('is created by migration v21', () => {
    expect(getSchemaVersion(db)).toBe(MIGRATIONS.at(-1)!.version);
    expect(MIGRATIONS.find((migration) => migration.version === 21)!.name).toBe('project_audits');
  });

  it('round-trips an audit with its configuration and result', async () => {
    const stored = audit(1, {
      scope: { kind: 'files', paths: ['src/a.ts'] },
      scopeFiles: ['src/a.ts'],
      acknowledgedWarnings: ['warning'],
    });
    await repository.insert(stored);
    expect(await repository.get(stored.id)).toEqual(stored);
    expect(await repository.get(id(999))).toBeNull();
  });

  it('links the job only through setJob, so a lifecycle update never clears it', async () => {
    await repository.insert(audit(1));
    await repository.setJob(id(1), id(77));
    // A stale copy without the job, as an executor holding the queued audit would save.
    await repository.update(audit(1, { status: 'RUNNING', startedAt: at(2) }));
    const current = await repository.get(id(1));
    expect(current).toMatchObject({ jobId: id(77), status: 'RUNNING', startedAt: at(2) });
  });

  it('completes an audit and its findings in one transaction, in report order', async () => {
    await repository.insert(audit(1));
    const completed = audit(1, {
      status: 'COMPLETED',
      finishedAt: at(5),
      findingCount: 2,
      summary: 'Two issues',
      metrics: { inputTokens: 10, outputTokens: 5, costUsd: null, durationMs: 1000 },
    });
    await repository.complete(completed, [finding(11, id(1), 1), finding(10, id(1), 0)]);
    expect(await repository.get(id(1))).toEqual(completed);
    const findings = await repository.findings(id(1));
    expect(findings.map((item) => item.ordinal)).toEqual([0, 1]);
    expect(findings[0]).toEqual(finding(10, id(1), 0));
  });

  it('keeps the audit unchanged when a finding cannot be stored', async () => {
    await repository.insert(audit(1));
    const duplicate = [finding(10, id(1), 0), finding(11, id(1), 0)];
    await expect(
      repository.complete(audit(1, { status: 'COMPLETED' }), duplicate),
    ).rejects.toMatchObject({ code: 'PROJECT_PERSISTENCE_ERROR' });
    expect((await repository.get(id(1)))?.status).toBe('QUEUED');
    expect(await repository.findings(id(1))).toEqual([]);
  });

  it('lists audits per project newest first, and the active ones oldest first', async () => {
    await repository.insert(audit(1));
    await repository.insert(audit(2, { status: 'COMPLETED' }));
    await repository.insert(audit(3, { status: 'RUNNING' }));
    await repository.insert(audit(4, { projectId: OTHER }));
    expect((await repository.listForProject(PROJECT, 10)).map((item) => item.id)).toEqual([
      id(3),
      id(2),
      id(1),
    ]);
    expect((await repository.listForProject(PROJECT, 1)).map((item) => item.id)).toEqual([id(3)]);
    expect((await repository.listActive()).map((item) => item.id)).toEqual([id(1), id(3), id(4)]);
  });

  it('removes audits and findings with their project', async () => {
    await repository.insert(audit(1));
    await repository.complete(audit(1, { status: 'COMPLETED' }), [finding(10, id(1), 0)]);
    db.prepare('DELETE FROM projects WHERE id = ?').run(PROJECT);
    expect(await repository.get(id(1))).toBeNull();
    expect(await repository.findings(id(1))).toEqual([]);
  });

  it('remembers one decision per project and fingerprint, unlinking removed tasks', async () => {
    db.prepare(
      `INSERT INTO context_tasks (id, project_id, title, objective, status, created_at, updated_at)
       VALUES (?, ?, 'Task', 'Objective', 'open', 'x', 'x')`,
    ).run(id(700), PROJECT);
    const decision = {
      projectId: PROJECT,
      fingerprint: 'b'.repeat(64),
      decision: 'APPROVED' as const,
      note: null,
      taskId: id(700),
      auditId: id(1),
      findingId: id(10),
      decidedAt: at(1),
    };
    expect(getSchemaVersion(db)).toBe(MIGRATIONS.at(-1)!.version);
    await repository.saveDecision(decision);
    await repository.saveDecision({
      ...decision,
      decision: 'REJECTED',
      note: 'No',
      decidedAt: at(2),
    });
    expect(await repository.decisions(PROJECT, ['b'.repeat(64), 'c'.repeat(64)])).toEqual([
      { ...decision, decision: 'REJECTED', note: 'No', decidedAt: at(2) },
    ]);
    expect(await repository.decisions(OTHER, ['b'.repeat(64)])).toEqual([]);
    expect(await repository.decisions(PROJECT, [])).toEqual([]);
    db.prepare('DELETE FROM context_tasks WHERE id = ?').run(id(700));
    expect((await repository.decisions(PROJECT, ['b'.repeat(64)]))[0]?.taskId).toBeNull();
  });

  it('refuses invalid rows in the schema', () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO project_audits (id, project_id, provider, status, config, result, created_at)
           VALUES (?, ?, 'other', 'QUEUED', '{}', '{}', 'x')`,
        )
        .run(id(9), PROJECT),
    ).toThrow();
  });
});
