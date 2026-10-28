import {
  ACTIVE_AUDIT_STATUSES,
  AI_PROVIDERS,
  AUDIT_CATEGORIES,
  AUDIT_CATEGORY_LABELS,
  AUDIT_CHANGED_PATHS_MAX,
  AUDIT_SCOPE_FILES_MAX,
  AUDIT_SEVERITIES,
  DEFAULT_AUDIT_CATEGORIES,
  JOB_ERROR_MAX,
  StartAuditSchema,
  auditPlainText,
  parseInput,
  type AiProvider,
  type AuditDetails,
  type AuditFinding,
  type AuditMetrics,
  type AuditOptions,
  type AuditProviderOption,
  type AuditReadOnlyMode,
  type AuditScope,
  type AuditSeverityCounts,
  type AuditStatus,
  type AuditWorkspaceCheck,
  type ProjectAudit,
  type StartAuditInput,
  type UsageProfile,
} from '@atlas/contracts';
import { AtlasError, describeError, type FieldIssue, type Logger } from '@atlas/shared';
import { auditFingerprint } from './fingerprint.js';
import type { AuditProject, AuditServiceDependencies, AuditWorkspaceSnapshot } from './ports.js';
import { buildAuditPrompt } from './prompt.js';
import { parseAuditReport } from './report.js';
import {
  validateFinding,
  type AuditFileInspector,
  type AuditPathInspection,
} from './validation.js';

export const AUDIT_PROVIDER_NAMES: Record<AiProvider, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
};

/** How each CLI is kept read-only, and what the user is told before starting (FR-006). */
const PROVIDER_POLICIES: Record<
  AiProvider,
  { readOnlyMode: AuditReadOnlyMode; dataNotice: string; warnings: string[] }
> = {
  claude: {
    readOnlyMode: 'tools-restricted',
    dataNotice:
      'Claude Code sends the files it reads to Anthropic, as when you use it in a terminal.',
    warnings: [],
  },
  codex: {
    readOnlyMode: 'sandboxed-commands',
    dataNotice:
      'Codex sends the files and command output it reads to OpenAI, as when you use it in a terminal.',
    warnings: [
      'Codex may run commands to inspect the project, and they can include project scripts. Its read-only sandbox blocks file changes and network access, but the commands still run on this computer.',
    ],
  },
};

const AUDITS_LISTED = 50;

/** The outcome reported to the background job. */
export interface AuditExecutionResult {
  status: 'COMPLETED' | 'FAILED' | 'CANCELLED';
  errorSummary: string | null;
}

/** What the job gives the audit while it runs. */
export interface AuditExecutionContext {
  signal: AbortSignal;
  /** A message from ATLAS for the job's log. */
  log(line: string): void;
  /** Diagnostic output of the provider CLI for the job's log. */
  output(chunk: string): void;
  progress(stage: string): void;
}

const emptyCounts = (): AuditSeverityCounts =>
  Object.fromEntries(AUDIT_SEVERITIES.map((severity) => [severity, 0])) as AuditSeverityCounts;

/** Same kind and same paths: the same audit for duplicate detection (FR-016). */
export function auditScopeKey(scope: AuditScope): string {
  const paths = 'paths' in scope ? [...scope.paths].sort() : [];
  return JSON.stringify([scope.kind, paths]);
}

/** Paths whose Git status differs, and whether HEAD moved. */
export function compareSnapshots(
  before: AuditWorkspaceSnapshot | null,
  after: AuditWorkspaceSnapshot | null,
): { check: AuditWorkspaceCheck; changedPaths: string[] } {
  if (before === null || after === null) return { check: 'unverifiable', changedPaths: [] };
  const changed = new Set<string>();
  for (const [file, status] of after.entries) {
    if (before.entries.get(file) !== status) changed.add(file);
  }
  for (const file of before.entries.keys()) if (!after.entries.has(file)) changed.add(file);
  const changedPaths = [...changed].sort().slice(0, AUDIT_CHANGED_PATHS_MAX);
  return {
    check: changed.size > 0 || before.head !== after.head ? 'changed' : 'unchanged',
    changedPaths,
  };
}

/**
 * AI project audits (SDD-026 Task 01, Milestone A). An audit is confirmed by the user,
 * queued as a background job, and runs a provider CLI restricted to reading the project.
 * Its answer is validated against the schema and the project's files before anything is
 * stored; nothing in it is executed, and no project file is changed by ATLAS.
 */
export class ProjectAuditService {
  /** One start at a time: duplicate checks and job submissions never interleave. */
  private starting: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: AuditServiceDependencies & { logger: Logger }) {}

  async options(projectId: string): Promise<AuditOptions> {
    const project = await this.requireProject(projectId);
    const [providers, profiles, changed] = await Promise.all([
      Promise.all(AI_PROVIDERS.map((provider) => this.providerOption(provider))),
      this.deps.profiles(),
      project.available
        ? this.deps.workspace.changedFiles(project.workspacePath).catch(() => null)
        : Promise.resolve(null),
    ]);
    return {
      projectId: project.id,
      projectName: project.name,
      projectAvailable: project.available,
      providers,
      profiles: profiles
        .filter((profile) => !profile.hidden)
        .map((profile) => ({
          id: profile.id,
          provider: profile.providerId,
          displayName: profile.displayName,
          status: profile.status,
          plan: profile.plan,
        })),
      categories: AUDIT_CATEGORIES.map((id) => ({ id, label: AUDIT_CATEGORY_LABELS[id] })),
      defaultCategories: [...DEFAULT_AUDIT_CATEGORIES],
      git: { repository: changed !== null, changedFiles: changed?.length ?? null },
      estimate: null,
    };
  }

  start(raw: StartAuditInput): Promise<ProjectAudit> {
    const result = this.starting.then(() => this.queue(raw));
    this.starting = result.catch(() => undefined);
    return result;
  }

  async list(projectId: string): Promise<ProjectAudit[]> {
    await this.requireProject(projectId);
    return this.deps.store.listForProject(projectId, AUDITS_LISTED);
  }

  async get(auditId: string): Promise<AuditDetails> {
    const audit = await this.requireAudit(auditId);
    return { audit, findings: await this.deps.store.findings(audit.id) };
  }

  /** Cancels a queued audit at once; asks a running one to stop through its job. */
  async cancel(auditId: string): Promise<ProjectAudit> {
    const audit = await this.requireAudit(auditId);
    if (!ACTIVE_AUDIT_STATUSES.includes(audit.status)) {
      throw new AtlasError('JOB_TRANSITION_INVALID', 'The audit already finished.');
    }
    if (audit.jobId === null) return this.finish(audit, 'CANCELLED', 'The audit was cancelled.');
    await this.deps.jobs.cancel(audit.jobId);
    return this.requireAudit(audit.id);
  }

  /**
   * Called when the audit's job reached a final status. A job that ended without running
   * the audit (cancelled while queued, interrupted, failed to start) ends the audit too.
   */
  async jobFinished(
    auditId: string,
    jobStatus: 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'INTERRUPTED',
    errorSummary: string | null,
  ): Promise<void> {
    const audit = await this.deps.store.get(auditId);
    if (audit === null) return;
    // The run saw only an aborted signal; the job knows that ATLAS was quitting.
    if (jobStatus === 'INTERRUPTED' && audit.status === 'CANCELLED') {
      await this.finish(audit, 'INTERRUPTED', 'ATLAS stopped before the audit finished.');
      return;
    }
    if (!ACTIVE_AUDIT_STATUSES.includes(audit.status)) return;
    switch (jobStatus) {
      case 'CANCELLED':
        await this.finish(audit, 'CANCELLED', 'The audit was cancelled.');
        return;
      case 'INTERRUPTED':
        await this.finish(audit, 'INTERRUPTED', 'ATLAS stopped before the audit finished.');
        return;
      default:
        await this.finish(audit, 'FAILED', errorSummary ?? 'The audit ended without a result.');
    }
  }

  /** After a restart: nothing can still be running an audit (FR-005). */
  async recover(): Promise<ProjectAudit[]> {
    const recovered: ProjectAudit[] = [];
    for (const audit of await this.deps.store.listActive()) {
      recovered.push(
        await this.finish(audit, 'INTERRUPTED', 'ATLAS stopped before the audit finished.'),
      );
    }
    return recovered;
  }

  /**
   * Checks that a job may run this audit: it is queued and has no job yet. Returns what
   * the job shows in lists and notifications.
   */
  async jobPreparation(
    auditId: string,
  ): Promise<{ title: string; projectId: string; workspacePath: string }> {
    const audit = await this.requireAudit(auditId);
    if (audit.status !== 'QUEUED' || audit.jobId !== null) {
      throw new AtlasError('JOB_TRANSITION_INVALID', 'This audit was already submitted.');
    }
    const project = await this.requireProject(audit.projectId);
    return {
      title: `Audit ${project.name} with ${AUDIT_PROVIDER_NAMES[audit.provider]}`,
      projectId: project.id,
      workspacePath: project.workspacePath,
    };
  }

  /** Runs a queued audit; called by its background job. */
  async execute(auditId: string, context: AuditExecutionContext): Promise<AuditExecutionResult> {
    const audit = await this.requireAudit(auditId);
    if (audit.status !== 'QUEUED') {
      return { status: 'FAILED', errorSummary: 'This audit was already run.' };
    }
    try {
      return await this.run(audit, context);
    } catch (error) {
      this.deps.logger.warn('Project audit failed', {
        auditId: audit.id,
        error: describeError(error),
      });
      const current = (await this.deps.store.get(audit.id)) ?? audit;
      const summary = context.signal.aborted
        ? 'The audit was cancelled.'
        : 'The audit could not run.';
      await this.finish(current, context.signal.aborted ? 'CANCELLED' : 'FAILED', summary);
      return {
        status: context.signal.aborted ? 'CANCELLED' : 'FAILED',
        errorSummary: summary,
      };
    }
  }

  // -------------------------------------------------------------------------

  private async queue(raw: StartAuditInput): Promise<ProjectAudit> {
    const input = parseInput(StartAuditSchema, raw);
    const project = await this.requireProject(input.projectId);
    if (!project.available) throw new AtlasError('PROJECT_PATH_UNAVAILABLE');
    const option = await this.providerOption(input.provider);
    if (!option.available) {
      throw new AtlasError('AUDIT_PROVIDER_UNAVAILABLE', undefined, {
        issues: [{ field: 'provider', message: option.reason ?? 'Unavailable.' }],
      });
    }
    if (option.warnings.length > 0 && !input.acknowledgeWarnings) {
      throw new AtlasError('AUDIT_CONFIRMATION_REQUIRED', undefined, {
        issues: option.warnings.map((message) => ({ field: 'acknowledgeWarnings', message })),
      });
    }
    const profile = await this.profile(input.provider, input.profileId);
    const resolved = await this.resolveScope(project, input.scope);
    const key = auditScopeKey(input.scope);
    const duplicate = (await this.deps.store.listActive()).some(
      (audit) => audit.projectId === project.id && auditScopeKey(audit.scope) === key,
    );
    if (duplicate) throw new AtlasError('AUDIT_ACTIVE');

    const audit: ProjectAudit = {
      id: this.deps.generateId(),
      projectId: project.id,
      jobId: null,
      provider: input.provider,
      profileId: profile?.id ?? null,
      profileName: profile?.displayName ?? null,
      categories: input.categories,
      scope: input.scope,
      scopeFiles: resolved.files,
      scopeTruncated: resolved.truncated,
      readOnlyMode: option.readOnlyMode,
      acknowledgedWarnings: input.acknowledgeWarnings ? option.warnings : [],
      timeoutMinutes: input.timeoutMinutes,
      status: 'QUEUED',
      createdAt: this.now(),
      startedAt: null,
      finishedAt: null,
      summary: null,
      errorSummary: null,
      workspaceCheck: null,
      changedPaths: [],
      metrics: null,
      findingCount: 0,
      severityCounts: emptyCounts(),
      needsReviewCount: 0,
      invalidCount: 0,
      malformedCount: 0,
    };
    await this.deps.store.insert(audit);
    this.changed(audit);
    // Ids only: scopes and project names stay out of the logs.
    this.deps.logger.info('Project audit queued', {
      auditId: audit.id,
      projectId: project.id,
      provider: audit.provider,
    });
    try {
      const job = await this.deps.jobs.submit(audit.id);
      await this.deps.store.setJob(audit.id, job.id);
      // The job may already have started (and changed the audit): read it again.
      const queued = await this.requireAudit(audit.id);
      this.changed(queued);
      return queued;
    } catch (error) {
      await this.finish(audit, 'FAILED', 'The audit could not be queued.');
      throw error;
    }
  }

  private async run(audit: ProjectAudit, context: AuditExecutionContext) {
    const name = AUDIT_PROVIDER_NAMES[audit.provider];
    const project = await this.deps.project(audit.projectId);
    if (project === null) {
      return this.failed(audit, 'The project is no longer registered in ATLAS.');
    }
    if (!project.available) return this.failed(audit, 'The project folder is not available.');
    let profileDirectory: string | null = null;
    if (audit.profileId !== null) {
      const profile = (await this.deps.profiles()).find(
        (item) => item.id === audit.profileId && item.providerId === audit.provider,
      );
      if (profile === undefined) {
        return this.failed(audit, 'The account profile chosen for the audit no longer exists.');
      }
      profileDirectory = profile.profileDirectory;
    }

    let current: ProjectAudit = { ...audit, status: 'RUNNING', startedAt: this.now() };
    await this.deps.store.update(current);
    this.changed(current);
    context.progress('Recording the Git status');
    const before = await this.snapshot(project.workspacePath);
    context.log(
      current.readOnlyMode === 'tools-restricted'
        ? `ATLAS: starting ${name} with file reading and search tools only.`
        : `ATLAS: starting ${name} in its read-only sandbox.`,
    );
    context.progress(`Auditing with ${name}`);
    const outcome = await this.deps.runner.run({
      auditId: audit.id,
      provider: audit.provider,
      profileDirectory,
      cwd: project.workspacePath,
      prompt: buildAuditPrompt({
        projectName: project.name,
        categories: audit.categories,
        scope: audit.scope,
        scopeFiles: audit.scopeFiles,
        scopeTruncated: audit.scopeTruncated,
        readOnlyMode: audit.readOnlyMode,
      }),
      timeoutMs: audit.timeoutMinutes * 60_000,
      signal: context.signal,
      output: (chunk) => context.output(chunk),
      log: (line) => context.log(line),
    });
    const workspace = compareSnapshots(before, await this.snapshot(project.workspacePath));
    if (workspace.check === 'changed') {
      context.log('ATLAS: files of the project changed while the audit ran. Review them.');
    }
    current = {
      ...current,
      workspaceCheck: workspace.check,
      changedPaths: workspace.changedPaths,
    };

    switch (outcome.kind) {
      case 'cancelled':
        await this.finish(current, 'CANCELLED', 'The audit was cancelled.');
        return { status: 'CANCELLED', errorSummary: 'The audit was cancelled.' } as const;
      case 'timed-out':
        return this.failed(
          current,
          `The audit did not finish within ${audit.timeoutMinutes} minutes.`,
        );
      case 'failed':
        return this.failed({ ...current, metrics: outcome.metrics }, outcome.summary);
      case 'completed':
        break;
    }

    current = { ...current, metrics: outcome.metrics };
    const report = parseAuditReport(outcome.answer);
    if (report === null) {
      return this.failed(current, `${name} did not answer with a valid audit report.`);
    }
    context.progress('Checking the evidence');
    const inspector = cachedInspector(this.deps.workspace.inspector(project.workspacePath));
    const findings: AuditFinding[] = [];
    for (const [ordinal, finding] of report.findings.entries()) {
      const checked = await validateFinding(finding, inspector);
      findings.push({
        id: this.deps.generateId(),
        auditId: audit.id,
        projectId: audit.projectId,
        fingerprint: auditFingerprint({
          projectId: audit.projectId,
          category: finding.category,
          description: finding.description,
          excerpt: finding.excerpt,
          locations: checked.locations,
        }),
        ordinal,
        title: finding.title,
        category: finding.category,
        severity: finding.severity,
        confidence: finding.confidence,
        kind: finding.kind,
        description: finding.description,
        evidence: finding.evidence,
        excerpt: finding.excerpt,
        locations: checked.locations,
        impact: finding.impact,
        recommendation: finding.recommendation,
        suggestedTaskTitle: finding.suggestedTaskTitle,
        acceptanceCriteria: finding.acceptanceCriteria,
        effort: finding.effort ?? null,
        validation: checked.validation,
        validationNotes: checked.validationNotes,
        containsCommands: checked.containsCommands,
      });
    }
    const severityCounts = emptyCounts();
    for (const finding of findings) severityCounts[finding.severity] += 1;
    const completed: ProjectAudit = {
      ...current,
      status: 'COMPLETED',
      finishedAt: this.now(),
      summary: report.summary,
      findingCount: findings.length,
      severityCounts,
      needsReviewCount: findings.filter((finding) => finding.validation === 'needs-review').length,
      invalidCount: findings.filter((finding) => finding.validation === 'invalid').length,
      malformedCount: report.malformed,
    };
    await this.deps.store.complete(completed, findings);
    this.changed(completed);
    context.log(
      `ATLAS: ${findings.length} finding(s) stored` +
        (report.malformed > 0 ? `; ${report.malformed} malformed entr(ies) skipped.` : '.'),
    );
    this.deps.logger.info('Project audit completed', {
      auditId: audit.id,
      findings: findings.length,
      malformed: report.malformed,
    });
    return { status: 'COMPLETED', errorSummary: null } as const;
  }

  private async failed(audit: ProjectAudit, summary: string): Promise<AuditExecutionResult> {
    await this.finish(audit, 'FAILED', summary);
    return { status: 'FAILED', errorSummary: summary };
  }

  private async finish(
    audit: ProjectAudit,
    status: Exclude<AuditStatus, 'QUEUED' | 'RUNNING' | 'COMPLETED'>,
    errorSummary: string,
  ): Promise<ProjectAudit> {
    const finished: ProjectAudit = {
      ...audit,
      status,
      errorSummary: auditPlainText(errorSummary, JOB_ERROR_MAX),
      finishedAt: this.now(),
    };
    await this.deps.store.update(finished);
    this.changed(finished);
    return finished;
  }

  /** The stored audit, with its job: updates never carry `jobId`. */
  private changed(audit: ProjectAudit): void {
    if (this.deps.onChanged === undefined) return;
    void this.deps.store.get(audit.id).then(
      (stored) => stored !== null && this.deps.onChanged?.(stored),
      (error: unknown) =>
        this.deps.logger.debug('Changed audit could not be read', { error: describeError(error) }),
    );
  }

  private async snapshot(root: string): Promise<AuditWorkspaceSnapshot | null> {
    try {
      return await this.deps.workspace.snapshot(root);
    } catch (error) {
      this.deps.logger.debug('Git status for the audit could not be read', {
        error: describeError(error),
      });
      return null;
    }
  }

  private async providerOption(provider: AiProvider): Promise<AuditProviderOption> {
    const availability = await this.deps.runner.availability(provider);
    return { provider, ...availability, ...PROVIDER_POLICIES[provider] };
  }

  private async profile(
    provider: AiProvider,
    profileId: string | undefined,
  ): Promise<UsageProfile | null> {
    if (profileId === undefined) return null;
    const profile = (await this.deps.profiles()).find(
      (item) => item.id === profileId && item.providerId === provider && !item.hidden,
    );
    if (profile === undefined) {
      throw new AtlasError('VALIDATION_FAILED', undefined, {
        issues: [{ field: 'profileId', message: 'Choose an account profile of this provider.' }],
      });
    }
    return profile;
  }

  /** Checks every chosen path inside the project (FR-003); the changed files are listed. */
  private async resolveScope(
    project: AuditProject,
    scope: AuditScope,
  ): Promise<{ files: string[]; truncated: boolean }> {
    const invalid = (issues: FieldIssue[]) =>
      new AtlasError('AUDIT_SCOPE_INVALID', undefined, { issues });
    switch (scope.kind) {
      case 'project':
        return { files: [], truncated: false };
      case 'changed': {
        const changed = await this.deps.workspace.changedFiles(project.workspacePath);
        if (changed === null) {
          throw invalid([{ field: 'scope', message: 'The project is not a Git repository.' }]);
        }
        if (changed.length === 0) {
          throw invalid([{ field: 'scope', message: 'There are no uncommitted changes.' }]);
        }
        const files = [...changed].sort();
        return {
          files: files.slice(0, AUDIT_SCOPE_FILES_MAX),
          truncated: files.length > AUDIT_SCOPE_FILES_MAX,
        };
      }
      case 'directories':
      case 'files': {
        const expected = scope.kind === 'files' ? 'file' : 'directory';
        const issues: FieldIssue[] = [];
        for (const file of scope.paths) {
          const kind = await this.deps.workspace.scopePath(project.workspacePath, file);
          if (kind === expected) continue;
          issues.push({
            field: 'scope.paths',
            message:
              kind === 'missing'
                ? `"${file}" was not found in the project.`
                : kind === 'outside-project'
                  ? `"${file}" is outside the project folder.`
                  : kind === 'ignored'
                    ? `"${file}" is excluded by the project's ignore rules.`
                    : `"${file}" is not a ${expected === 'file' ? 'file' : 'folder'}.`,
          });
        }
        if (issues.length > 0) throw invalid(issues);
        return { files: [...scope.paths], truncated: false };
      }
    }
  }

  private async requireProject(projectId: string): Promise<AuditProject> {
    const project = await this.deps.project(projectId);
    if (project === null) throw new AtlasError('PROJECT_NOT_FOUND');
    return project;
  }

  private async requireAudit(auditId: string): Promise<ProjectAudit> {
    const audit = await this.deps.store.get(auditId);
    if (audit === null) throw new AtlasError('AUDIT_NOT_FOUND');
    return audit;
  }

  private now(): string {
    return this.deps.clock.now().toISOString();
  }
}

/** Files read while validating one report, so findings citing the same file read it once. */
const INSPECTION_CACHE_SIZE = 50;

function cachedInspector(inspector: AuditFileInspector): AuditFileInspector {
  const cache = new Map<string, Promise<AuditPathInspection>>();
  return {
    inspect: (reported) => {
      const cached = cache.get(reported);
      if (cached !== undefined) return cached;
      const inspection = inspector.inspect(reported);
      cache.set(reported, inspection);
      // Oldest first: bounded memory for reports that cite many large files.
      if (cache.size > INSPECTION_CACHE_SIZE) cache.delete(cache.keys().next().value!);
      return inspection;
    },
  };
}

/** Metrics a provider did not report stay null; they are never estimated. */
export function emptyAuditMetrics(): AuditMetrics {
  return { inputTokens: null, outputTokens: null, costUsd: null, durationMs: null };
}
