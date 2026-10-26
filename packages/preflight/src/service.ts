import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  EMPTY_PREFLIGHT_CONFIG,
  PreflightConfigSchema,
  PreflightOutputQuerySchema,
  PreflightRunsQuerySchema,
  PreflightSelectionSchema,
  PreflightStartSchema,
  parseInput,
  type PreflightAuthorizationReason,
  type PreflightCheck,
  type PreflightCheckResult,
  type PreflightCheckStatus,
  type PreflightConfig,
  type PreflightDiscovery,
  type PreflightEnvironmentStatus,
  type PreflightExecutionMethod,
  type PreflightOutputLine,
  type PreflightOutputPage,
  type PreflightPlan,
  type PreflightPlannedCheck,
  type PreflightProfile,
  type PreflightRun,
  type PreflightRunSummary,
  type PreflightSelection,
  type PreflightWorkspace,
  type PreflightWorkspaceDetails,
} from '@atlas/contracts';
import { AtlasError, describeError, type Logger } from '@atlas/shared';
import { commandDangers } from './danger.js';
import { discover, readScript } from './discovery.js';
import { LogBuffer } from './log-buffer.js';
import type {
  CheckInvocation,
  PreflightExecutor,
  PreflightLogStore,
  PreflightRepository,
  PreflightTools,
  SourceState,
  SourceStateReader,
  WorkspaceFileAccess,
} from './ports.js';
import { runReport } from './report.js';
import { runSchedule } from './scheduler.js';
import { requiredOutcome, runStatus, statusCounts } from './status.js';
import { MAX_WORKFLOW_BYTES, summarizeWorkflow } from './workflows.js';

/** Finished runs kept per workspace; older runs and their logs are deleted. */
export const PREFLIGHT_RUNS_KEPT = 100;
const DEFAULT_OUTPUT_PAGE = 2000;

const SHELL_WARNING =
  'Runs on this computer with your user account and your terminal environment. It is not sandboxed.';
const ACT_WARNING =
  'Runs in Docker containers through act. Docker does not fully isolate the host, and actions and images are downloaded from the internet.';

export interface PreflightProjectLookup {
  /** A registered project, or null when it does not exist. */
  find(projectId: string): Promise<{ id: string; name: string; workspacePath: string } | null>;
}

export interface PreflightServiceOptions {
  repository: PreflightRepository;
  files: WorkspaceFileAccess;
  /** Absent in clients that do not own processes (e.g. the CLI): runs are refused. */
  executor?: PreflightExecutor;
  tools: PreflightTools;
  source: SourceStateReader;
  logs: PreflightLogStore;
  projects: PreflightProjectLookup;
  /** Removes credentials from a line of output. */
  redact: (text: string) => string;
  clock: { now(): Date };
  generateId: () => string;
  logger: Logger;
  /** Called once a run finished and was saved; must not throw. */
  onRunFinished?: (run: PreflightRun, workspace: PreflightWorkspace) => void;
}

/** What one check of a run will execute, resolved from the configuration and the files. */
interface PreparedCheck {
  check: PreflightCheck;
  method: PreflightExecutionMethod;
  reference: string;
  digest: string;
  cwd: string;
  invocation: CheckInvocation | null;
  dangers: string[];
  warnings: string[];
  /** The check cannot run as configured (missing script, secrets needed…). */
  blocked: string | null;
  /** The check can never run locally (e.g. a macOS runner). */
  unsupported: string | null;
}

interface ActiveRun {
  run: PreflightRun;
  controller: AbortController;
  buffers: Map<number, LogBuffer>;
  done: Promise<void>;
  /** Serializes the run's writes. */
  saving: Promise<void>;
  /** Logs of skipped checks being written. */
  logging: Promise<void>;
}

const notFound = () => new AtlasError('PREFLIGHT_NOT_FOUND');

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/**
 * Preflight (SDD-007 Milestone A): local validation of a workspace without any AI
 * provider. A check runs only after the user authorized its exact definition; checks
 * that may change something outside the computer are authorized on every run. A check
 * passes only on a zero exit code; everything it could not verify is reported as such.
 */
export class PreflightService {
  private readonly active = new Map<string, ActiveRun>();
  private readonly activeByWorkspace = new Map<string, string>();

  constructor(private readonly options: PreflightServiceOptions) {}

  // -------------------------------------------------------------------------
  // Workspaces and configuration
  // -------------------------------------------------------------------------

  listWorkspaces(): Promise<PreflightWorkspace[]> {
    return this.options.repository.listWorkspaces();
  }

  /** The workspace of a registered project; created on first use. */
  async openProject(projectId: string): Promise<PreflightWorkspace> {
    const project = await this.options.projects.find(projectId);
    if (project === null) throw new AtlasError('PROJECT_NOT_FOUND');
    const directory = path.resolve(project.workspacePath);
    const existing = await this.options.repository.findWorkspaceByPath(directory);
    if (existing !== null) {
      if (existing.projectId === project.id && existing.name === project.name) return existing;
      const stored = await this.options.repository.findWorkspace(existing.id);
      const updated = {
        ...existing,
        projectId: project.id,
        name: project.name,
        updatedAt: this.now(),
      };
      await this.options.repository.updateWorkspace(updated, stored?.config ?? '{}');
      return updated;
    }
    return this.insertWorkspace(directory, project.id, project.name);
  }

  /** A folder outside registered projects; only one the user picked in the native dialog. */
  async addFolder(folder: string, explicit: boolean): Promise<PreflightWorkspace> {
    if (!explicit || !path.isAbsolute(folder)) throw new AtlasError('PREFLIGHT_UNAUTHORIZED');
    const directory = path.resolve(folder);
    if (!(await this.options.files.isDirectory(directory))) {
      throw new AtlasError('VALIDATION_FAILED', 'The folder does not exist.', {
        issues: [{ field: 'path', message: 'The folder does not exist.' }],
      });
    }
    const existing = await this.options.repository.findWorkspaceByPath(directory);
    return existing ?? this.insertWorkspace(directory, null, path.basename(directory) || directory);
  }

  /** A removed project's workspace stays as a folder workspace, with its history. */
  async projectRemoved(projectId: string): Promise<void> {
    for (const workspace of await this.options.repository.listWorkspaces()) {
      if (workspace.projectId !== projectId) continue;
      const stored = await this.options.repository.findWorkspace(workspace.id);
      await this.options.repository.updateWorkspace(
        { ...workspace, projectId: null, updatedAt: this.now() },
        stored?.config ?? '{}',
      );
    }
  }

  /** Removes the workspace with its configuration, authorizations, history and logs. */
  async removeWorkspace(id: string): Promise<void> {
    await this.requireWorkspace(id);
    const runId = this.activeByWorkspace.get(id);
    if (runId !== undefined) {
      const active = this.active.get(runId);
      active?.controller.abort();
      await active?.done;
    }
    const runs = await this.options.repository.listRuns(id, 100_000);
    await this.options.repository.removeWorkspace(id);
    for (const run of runs) await this.removeLogs(run.id);
  }

  async workspace(id: string): Promise<PreflightWorkspaceDetails> {
    const { workspace, config } = await this.requireWorkspace(id);
    const parsed = this.parseConfig(config);
    return { workspace, config: parsed ?? EMPTY_PREFLIGHT_CONFIG, configInvalid: parsed === null };
  }

  async saveConfig(id: string, input: unknown): Promise<PreflightWorkspaceDetails> {
    const config = parseInput(PreflightConfigSchema, input);
    const { workspace } = await this.requireWorkspace(id);
    const updated = { ...workspace, updatedAt: this.now() };
    await this.options.repository.updateWorkspace(updated, JSON.stringify(config));
    return { workspace: updated, config, configInvalid: false };
  }

  /** Reads what the workspace declares; executes nothing (FR-703, FR-706). */
  async discover(id: string): Promise<PreflightDiscovery> {
    const { workspace } = await this.requireWorkspace(id);
    return discover(this.options.files.files(workspace.path));
  }

  environment(refresh: boolean): Promise<PreflightEnvironmentStatus> {
    return this.options.tools.status(refresh);
  }

  // -------------------------------------------------------------------------
  // Runs
  // -------------------------------------------------------------------------

  /** What a run of the selection would execute, and what needs authorization. */
  async plan(input: unknown): Promise<PreflightPlan> {
    const selection = parseInput(PreflightSelectionSchema, input);
    const { workspace, checks, disabled } = await this.resolveSelection(selection);
    const planned = await Promise.all(
      checks.map(async (check) => this.planned(workspace, await this.prepare(workspace, check))),
    );
    return { checks: planned, disabled };
  }

  async start(input: unknown): Promise<PreflightRun> {
    const request = parseInput(PreflightStartSchema, input);
    const executor = this.options.executor;
    if (executor === undefined) {
      throw new AtlasError('ENGINE_UNAVAILABLE', 'Checks run only in the A.T.L.A.S Engine.');
    }
    const { workspace, checks, profile, concurrency } = await this.resolveSelection(request);
    if (this.activeByWorkspace.has(workspace.id)) throw new AtlasError('PREFLIGHT_BUSY');
    if (request.retryOf) {
      const previous = await this.options.repository.findRun(request.retryOf);
      if (previous === null || previous.workspaceId !== workspace.id) throw notFound();
    }

    const prepared = await Promise.all(checks.map((check) => this.prepare(workspace, check)));
    const granted = new Map(request.authorizations.map((item) => [item.checkId, item.digest]));
    const missing: string[] = [];
    for (const item of prepared) {
      const planned = await this.planned(workspace, item);
      if (planned.authorization !== null && granted.get(item.check.id) !== item.digest) {
        missing.push(item.check.id);
      }
    }
    if (missing.length > 0) {
      throw new AtlasError('PREFLIGHT_AUTHORIZATION_REQUIRED', undefined, {
        issues: missing.map((checkId) => ({
          field: `authorizations.${checkId}`,
          message: 'Review and authorize this check.',
        })),
      });
    }
    // Checked again after the awaits above: two starts may have raced. From here until
    // the run is registered below nothing is awaited.
    if (this.activeByWorkspace.has(workspace.id)) throw new AtlasError('PREFLIGHT_BUSY');
    const at = this.now();

    const run: PreflightRun = {
      id: this.options.generateId(),
      workspaceId: workspace.id,
      projectId: workspace.projectId,
      workspacePath: workspace.path,
      profileId: profile?.id ?? null,
      profileName:
        profile?.name ?? (request.retryOf ? 'Retry of failed checks' : 'Selected checks'),
      trigger: 'MANUAL',
      status: 'RUNNING',
      requiredOutcome: 'NONE',
      sourceRevision: null,
      branch: null,
      sourceStateFingerprint: null,
      sourceChangedDuringRun: false,
      retryOf: request.retryOf ?? null,
      startedAt: at,
      finishedAt: null,
      results: prepared.map((item, position) => ({
        position,
        checkId: item.check.id,
        name: item.check.name,
        type: item.check.type,
        category: item.check.category,
        required: item.check.required,
        method: item.method,
        reference: item.reference,
        status: 'PENDING',
        startedAt: null,
        finishedAt: null,
        durationMs: null,
        exitCode: null,
        detail: null,
        environment: item.method === 'LOCAL_ACT' ? 'Local act runner' : executor.shellLabel,
        digest: item.digest,
        outputLines: 0,
        outputTruncated: false,
      })),
    };
    const active: ActiveRun = {
      run,
      controller: new AbortController(),
      buffers: new Map(),
      done: Promise.resolve(),
      saving: Promise.resolve(),
      logging: Promise.resolve(),
    };
    this.active.set(run.id, active);
    this.activeByWorkspace.set(workspace.id, run.id);
    try {
      for (const item of prepared) {
        if (granted.get(item.check.id) === item.digest) {
          await this.options.repository.authorize(workspace.id, item.check.id, item.digest, at);
        }
      }
      const state = await this.sourceState(workspace.path);
      run.sourceRevision = state?.revision ?? null;
      run.branch = state?.branch ?? null;
      run.sourceStateFingerprint = state?.fingerprint ?? null;
      await this.options.repository.insertRun(run);
    } catch (error) {
      this.active.delete(run.id);
      this.activeByWorkspace.delete(workspace.id);
      throw error;
    }
    // Ids and counts only: commands and paths may hold private details.
    this.options.logger.info('Preflight run started', {
      runId: run.id,
      workspaceId: workspace.id,
      checks: prepared.length,
    });
    active.done = this.execute(workspace, active, prepared, concurrency, executor).catch(
      (error: unknown) =>
        this.options.logger.error('Preflight run failed', {
          runId: run.id,
          error: describeError(error),
        }),
    );
    return structuredClone(run);
  }

  async cancel(runId: string): Promise<void> {
    const active = this.active.get(runId);
    if (active === undefined) {
      if ((await this.options.repository.findRun(runId)) === null) throw notFound();
      return;
    }
    active.controller.abort();
  }

  async runs(input: unknown): Promise<PreflightRunSummary[]> {
    const query = parseInput(PreflightRunsQuerySchema, input);
    await this.requireWorkspace(query.workspaceId);
    return this.options.repository.listRuns(query.workspaceId, query.limit ?? 30, query.before);
  }

  async run(runId: string): Promise<PreflightRun> {
    const active = this.active.get(runId);
    if (active !== undefined) return structuredClone(active.run);
    const run = await this.options.repository.findRun(runId);
    if (run === null) throw notFound();
    return run;
  }

  async output(input: unknown): Promise<PreflightOutputPage> {
    const query = parseInput(PreflightOutputQuerySchema, input);
    const limit = query.limit ?? DEFAULT_OUTPUT_PAGE;
    const run = await this.run(query.runId);
    const result = run.results[query.position];
    if (result === undefined) throw notFound();
    const buffer = this.active.get(query.runId)?.buffers.get(query.position);
    if (buffer !== undefined) {
      const lines = buffer.read(query.after, limit);
      const next = lines.at(-1)?.seq ?? Math.max(query.after, buffer.firstSeq - 1);
      return {
        lines,
        next,
        complete: buffer.complete && next >= buffer.count - 1,
        truncatedBefore: query.after + 1 < buffer.firstSeq,
      };
    }
    const settled = !['PENDING', 'RUNNING'].includes(result.status);
    const log = settled ? await this.readLog(query.runId, query.position) : null;
    if (log === null) {
      return { lines: [], next: query.after, complete: settled, truncatedBefore: false };
    }
    const start = Math.max(0, query.after + 1 - log.firstSeq);
    const lines = log.lines.slice(start, start + limit);
    const next = lines.at(-1)?.seq ?? Math.max(query.after, log.firstSeq - 1);
    return {
      lines,
      next,
      complete: start + lines.length >= log.lines.length,
      truncatedBefore: query.after + 1 < log.firstSeq,
    };
  }

  /** A Markdown report of the run, with the end of each failed check's output. */
  async report(runId: string): Promise<string> {
    const run = await this.run(runId);
    const logs = new Map<number, PreflightOutputLine[]>();
    for (const result of run.results) {
      if (result.status === 'PASSED') continue;
      const buffer = this.active.get(runId)?.buffers.get(result.position);
      const lines = buffer?.snapshot().lines ?? (await this.readLog(runId, result.position))?.lines;
      if (lines) logs.set(result.position, lines);
    }
    return runReport(run, logs);
  }

  /** Runs left running by an Engine that stopped are reported as cancelled. */
  /** Runs in progress; they stop when the Engine stops. */
  activeRunCount(): number {
    return this.active.size;
  }

  /** Whether a run of the workspace is in progress (one runs at a time). */
  isRunning(workspaceId: string): boolean {
    return this.activeByWorkspace.has(workspaceId);
  }

  /** The run once it finished and was saved; at once for a finished run. */
  async settled(runId: string): Promise<PreflightRun> {
    await this.active.get(runId)?.done;
    return this.run(runId);
  }

  async recover(): Promise<void> {
    const interrupted = await this.options.repository.interruptRunning(this.now());
    if (interrupted.length > 0) {
      this.options.logger.warn('Preflight runs were interrupted by an Engine stop', {
        count: interrupted.length,
      });
    }
  }

  /** Cancels every run and waits for their processes to stop. */
  async close(): Promise<void> {
    const runs = [...this.active.values()];
    for (const active of runs) active.controller.abort();
    await Promise.all(runs.map((active) => active.done));
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private now(): string {
    return this.options.clock.now().toISOString();
  }

  private async insertWorkspace(
    directory: string,
    projectId: string | null,
    name: string,
  ): Promise<PreflightWorkspace> {
    const at = this.now();
    const workspace: PreflightWorkspace = {
      id: this.options.generateId(),
      path: directory,
      projectId,
      name: name.slice(0, 120),
      createdAt: at,
      updatedAt: at,
    };
    await this.options.repository.insertWorkspace(
      workspace,
      JSON.stringify(EMPTY_PREFLIGHT_CONFIG),
    );
    return workspace;
  }

  private async requireWorkspace(id: string) {
    const found = await this.options.repository.findWorkspace(id);
    if (found === null) throw notFound();
    return found;
  }

  private parseConfig(raw: string): PreflightConfig | null {
    try {
      const result = PreflightConfigSchema.safeParse(JSON.parse(raw));
      return result.success ? result.data : null;
    } catch {
      return null;
    }
  }

  private async resolveSelection(selection: PreflightSelection): Promise<{
    workspace: PreflightWorkspace;
    checks: PreflightCheck[];
    disabled: string[];
    profile: PreflightProfile | null;
    concurrency: number;
  }> {
    const { workspace, config: raw } = await this.requireWorkspace(selection.workspaceId);
    const config = this.parseConfig(raw);
    if (config === null) {
      throw new AtlasError('VALIDATION_FAILED', 'The Preflight configuration cannot be read.', {
        issues: [{ field: 'config', message: 'Save the configuration again before running.' }],
      });
    }
    if ((selection.profileId === null) === (selection.checkIds === null)) {
      throw new AtlasError('VALIDATION_FAILED', 'Choose a profile or checks.', {
        issues: [{ field: 'profileId', message: 'Choose a profile or checks, not both.' }],
      });
    }
    const byId = new Map(config.checks.map((check) => [check.id, check]));
    let profile: PreflightProfile | null = null;
    let ids: string[];
    if (selection.profileId !== null) {
      profile = config.profiles.find((item) => item.id === selection.profileId) ?? null;
      if (profile === null) throw notFound();
      ids = profile.checkIds;
    } else {
      ids = [...new Set(selection.checkIds!)];
      if (ids.some((id) => !byId.has(id))) throw notFound();
    }
    const selected = ids.map((id) => byId.get(id)!);
    const checks = selected.filter((check) => check.enabled);
    if (checks.length === 0) {
      throw new AtlasError('VALIDATION_FAILED', 'Nothing to run.', {
        issues: [{ field: 'checkIds', message: 'The selection has no enabled checks.' }],
      });
    }
    return {
      workspace,
      checks,
      disabled: selected.filter((check) => !check.enabled).map((check) => check.id),
      profile,
      concurrency: profile?.concurrency ?? selection.concurrency ?? 1,
    };
  }

  /** Resolves a check against the current files. Never throws for a broken check. */
  private async prepare(
    workspace: PreflightWorkspace,
    check: PreflightCheck,
  ): Promise<PreparedCheck> {
    const { redact } = this.options;
    // The schema refuses `..`; links are resolved here, so a check never runs outside.
    const folder = await this.options.files
      .folderInside(workspace.path, check.workingDirectory)
      .catch(() => null);
    const base = {
      check,
      cwd: folder ?? path.resolve(workspace.path, check.workingDirectory),
      dangers: [] as string[],
      warnings: [] as string[],
      blocked:
        folder === null && check.type !== 'GITHUB_ACTIONS'
          ? `The working folder "${check.workingDirectory || '.'}" does not exist or is outside the workspace.`
          : null,
      unsupported: null as string | null,
    };
    const env = Object.keys(check.env).sort();
    if (check.type === 'COMMAND') {
      const command = check.command ?? '';
      return {
        ...base,
        method: 'LOCAL_SHELL',
        reference: redact(command),
        digest: sha256({ type: check.type, command, cwd: check.workingDirectory, env: check.env }),
        invocation: { kind: 'shell', command },
        dangers: commandDangers(command),
        warnings: [SHELL_WARNING, ...this.envWarning(env)],
      };
    }
    if (check.type === 'PACKAGE_SCRIPT') {
      const manager = check.packageManager ?? 'npm';
      const script = check.script ?? '';
      const found = base.blocked
        ? null
        : await readScript(this.options.files.files(base.cwd), script).catch(() => null);
      const body = found?.body ?? null;
      const hooks = found?.hooks ?? [];
      return {
        ...base,
        method: 'LOCAL_SHELL',
        reference: redact(`${manager} run ${script}`),
        digest: sha256({
          type: check.type,
          manager,
          script,
          body,
          hooks,
          cwd: check.workingDirectory,
          env: check.env,
        }),
        invocation: { kind: 'package-script', manager, script },
        dangers: [
          ...new Set([body ?? '', ...hooks.map((hook) => hook.body)].flatMap(commandDangers)),
        ],
        warnings: [
          SHELL_WARNING,
          ...(body === null ? [] : [`The script runs: ${redact(body)}`]),
          // npm runs these hooks around the script; they are part of what is authorized.
          ...hooks.map((hook) => `npm may also run "${hook.name}": ${redact(hook.body)}`),
          ...this.envWarning(env),
        ],
        blocked:
          base.blocked ?? (body === null ? `The script "${script}" is not in package.json.` : null),
      };
    }
    return this.prepareWorkflow(workspace, check, base);
  }

  private async prepareWorkflow(
    workspace: PreflightWorkspace,
    check: PreflightCheck,
    base: Omit<PreparedCheck, 'method' | 'reference' | 'digest' | 'invocation'>,
  ): Promise<PreparedCheck> {
    const workflowPath = check.workflowPath ?? '';
    const settings = check.act!;
    const job = check.workflowJob;
    const text = await this.options.files
      .files(workspace.path)
      .readText(workflowPath, MAX_WORKFLOW_BYTES)
      .catch(() => null);
    const reference = `act ${settings.event} -W ${workflowPath}${job ? ` -j ${job}` : ''}`;
    const prepared: PreparedCheck = {
      ...base,
      cwd: workspace.path,
      method: 'LOCAL_ACT',
      reference,
      digest: sha256({ type: check.type, workflowPath, job, settings, text, env: check.env }),
      invocation: { kind: 'act', workflowPath, job, settings },
      warnings: [ACT_WARNING],
    };
    if (text === null) {
      prepared.blocked = 'The workflow file could not be read.';
      return prepared;
    }
    const summary = summarizeWorkflow(workflowPath, text);
    if (summary.parseError !== null) {
      prepared.blocked = summary.parseError;
      return prepared;
    }
    const jobs = job === null ? summary.jobs : summary.jobs.filter((item) => item.id === job);
    if (jobs.length === 0) {
      prepared.blocked = `The workflow has no job "${job}".`;
      return prepared;
    }
    if (!summary.triggers.includes(settings.event)) {
      prepared.blocked = `The workflow is not triggered by "${settings.event}".`;
    }
    const secrets = [...new Set(jobs.flatMap((item) => item.secrets))];
    if (secrets.length > 0) {
      prepared.blocked = `Needs secrets (${secrets.join(', ')}); ATLAS does not pass secrets to act yet.`;
    }
    const unsupported = jobs.filter((item) => item.compatibility === 'UNSUPPORTED');
    if (unsupported.length > 0) {
      prepared.unsupported = unsupported
        .map((item) => `${item.id}: ${item.compatibilityReasons[0] ?? 'not supported by act'}`)
        .join(' ');
    }
    prepared.dangers = [...new Set(jobs.flatMap((item) => item.dangerReasons))];
    const actions = [...new Set(jobs.flatMap((item) => item.actions))];
    const images = [
      ...new Set(jobs.flatMap((item) => [item.container, ...item.services].filter(Boolean))),
    ];
    if (actions.length > 0)
      prepared.warnings.push(`Downloads and runs these actions: ${actions.join(', ')}.`);
    if (images.length > 0)
      prepared.warnings.push(`Starts these containers or services: ${images.join(', ')}.`);
    for (const item of jobs) {
      if (item.compatibility !== 'COMPATIBLE') {
        prepared.warnings.push(`${item.id}: ${item.compatibilityReasons.join(' ')}`);
      }
    }
    const configFiles = await this.options.tools.actConfigFiles(workspace.path).catch(() => []);
    if (configFiles.length > 0) {
      prepared.warnings.push(
        `act also reads ${configFiles.join(', ')}, which may add options or secrets ATLAS does not control.`,
      );
    }
    prepared.warnings.push(...this.envWarning(Object.keys(check.env)));
    return prepared;
  }

  private envWarning(names: string[]): string[] {
    return names.length === 0 ? [] : [`Sets the variables ${names.join(', ')}.`];
  }

  private async planned(
    workspace: PreflightWorkspace,
    item: PreparedCheck,
  ): Promise<PreflightPlannedCheck> {
    let authorization: PreflightAuthorizationReason | null = null;
    // Nothing runs for a blocked or unsupported check, so there is nothing to authorize.
    if (item.blocked === null && item.unsupported === null) {
      if (item.dangers.length > 0) {
        authorization = 'SIDE_EFFECTS';
      } else {
        const state = await this.options.repository.authorizationState(
          workspace.id,
          item.check.id,
          item.digest,
        );
        authorization = state === 'current' ? null : state === 'other' ? 'CHANGED' : 'FIRST_RUN';
      }
    }
    return {
      checkId: item.check.id,
      name: item.check.name,
      method: item.method,
      reference: item.reference,
      digest: item.digest,
      authorization,
      warnings: [
        ...(item.dangers.length > 0
          ? [
              `May change something outside this computer: ${item.dangers.join('; ')}. It asks every time.`,
            ]
          : []),
        ...(item.blocked ? [`Blocked: ${item.blocked}`] : []),
        ...(item.unsupported ? [`Unsupported: ${item.unsupported}`] : []),
        ...item.warnings,
      ],
    };
  }

  private async sourceState(workspacePath: string): Promise<SourceState | null> {
    try {
      return await this.options.source.read(workspacePath);
    } catch (error) {
      this.options.logger.warn('The code state of a Preflight workspace could not be read', {
        error: describeError(error),
      });
      return null;
    }
  }

  private save(active: ActiveRun): Promise<void> {
    const snapshot = structuredClone(active.run);
    active.saving = active.saving
      .then(() => this.options.repository.updateRun(snapshot))
      .catch((error: unknown) =>
        this.options.logger.warn('A Preflight run could not be saved', {
          runId: snapshot.id,
          error: describeError(error),
        }),
      );
    return active.saving;
  }

  private async execute(
    workspace: PreflightWorkspace,
    active: ActiveRun,
    prepared: PreparedCheck[],
    concurrency: number,
    executor: PreflightExecutor,
  ): Promise<void> {
    const { run, controller } = active;
    try {
      await runSchedule(
        prepared.map((item, position) => ({
          position,
          id: item.check.id,
          dependsOn: item.check.dependsOn,
          // act runs its own containers; two at once compete for the same Docker host.
          exclusive: item.check.exclusive || item.method === 'LOCAL_ACT',
        })),
        concurrency,
        controller.signal,
        {
          execute: (position) =>
            this.executeCheck(workspace, active, prepared[position]!, position, executor),
          skip: (position, status, reason) => {
            const buffer = new LogBuffer(this.options.redact);
            buffer.note(reason);
            buffer.finish();
            active.buffers.set(position, buffer);
            this.settle(active, position, status, reason, null);
            active.logging = Promise.all([
              active.logging,
              this.persistLog(run.id, position, buffer),
            ]).then(() => undefined);
          },
        },
      );
    } finally {
      const end = await this.sourceState(workspace.path);
      run.sourceChangedDuringRun =
        run.sourceStateFingerprint !== null &&
        end !== null &&
        end.fingerprint !== run.sourceStateFingerprint;
      run.status = runStatus(run.results, controller.signal.aborted);
      run.requiredOutcome = requiredOutcome(run.results);
      run.finishedAt = this.now();
      await this.save(active);
      this.options.logger.info('Preflight run finished', {
        runId: run.id,
        status: run.status,
        requiredOutcome: run.requiredOutcome,
        counts: statusCounts(run.results),
      });
      await active.logging;
      this.active.delete(run.id);
      this.activeByWorkspace.delete(workspace.id);
      await this.prune(workspace.id);
      try {
        this.options.onRunFinished?.(structuredClone(run), workspace);
      } catch (error) {
        this.options.logger.warn('Preflight run listener failed', { error: describeError(error) });
      }
    }
  }

  private async executeCheck(
    workspace: PreflightWorkspace,
    active: ActiveRun,
    planned: PreparedCheck,
    position: number,
    executor: PreflightExecutor,
  ): Promise<PreflightCheckStatus> {
    const { run, controller } = active;
    const buffer = new LogBuffer(this.options.redact);
    active.buffers.set(position, buffer);
    const result = run.results[position]!;
    result.status = 'RUNNING';
    result.startedAt = this.now();
    await this.save(active);
    const started = Date.now();

    const finish = async (
      status: PreflightCheckStatus,
      detail: string,
      exitCode: number | null,
    ): Promise<PreflightCheckStatus> => {
      if (status !== 'PASSED' && status !== 'FAILED') buffer.note(detail);
      buffer.finish();
      result.durationMs = Date.now() - started;
      this.settle(active, position, status, detail, exitCode);
      await this.save(active);
      await this.persistLog(run.id, position, buffer);
      return status;
    };

    // The files may have changed since the user authorized the run.
    const current = await this.prepare(workspace, planned.check);
    if (current.digest !== planned.digest) {
      return finish(
        'BLOCKED',
        'The check changed after it was authorized. Run it again to review it.',
        null,
      );
    }
    if (current.unsupported !== null) return finish('UNSUPPORTED', current.unsupported, null);
    if (current.blocked !== null) return finish('BLOCKED', current.blocked, null);
    if (!(await this.options.files.isDirectory(current.cwd))) {
      return finish(
        'BLOCKED',
        `The working folder "${planned.check.workingDirectory}" does not exist.`,
        null,
      );
    }
    if (current.method === 'LOCAL_ACT') {
      const tools = await this.options.tools.status(false);
      if (!tools.act.available)
        return finish('BLOCKED', `act is not available: ${tools.act.detail}`, null);
      if (!tools.docker.available) {
        return finish('BLOCKED', `Docker is not available: ${tools.docker.detail}`, null);
      }
      result.environment = `Local act runner (act ${tools.act.detail}, Docker ${tools.docker.detail})`;
    }
    const tools = [
      ...planned.check.requiredTools,
      ...(current.invocation?.kind === 'package-script' ? [current.invocation.manager] : []),
    ];
    for (const tool of tools) {
      if (!(await executor.hasTool(tool)))
        return finish('BLOCKED', `"${tool}" was not found on PATH.`, null);
    }
    if (controller.signal.aborted) return finish('CANCELLED', 'The run was cancelled.', null);

    buffer.note(`$ ${current.reference}`);
    const outcome = await executor.run({
      invocation: current.invocation!,
      cwd: current.cwd,
      env: planned.check.env,
      timeoutMs: planned.check.timeoutSeconds * 1000,
      signal: controller.signal,
      onOutput: (stream, chunk) => buffer.append(stream, chunk),
    });
    switch (outcome.kind) {
      case 'exited':
        return finish(
          outcome.exitCode === 0 ? 'PASSED' : 'FAILED',
          outcome.detail,
          outcome.exitCode,
        );
      case 'timed-out':
        return finish('TIMED_OUT', outcome.detail, null);
      case 'cancelled':
        return finish('CANCELLED', outcome.detail, null);
      case 'start-failed':
        return finish('BLOCKED', outcome.detail, null);
    }
  }

  private settle(
    active: ActiveRun,
    position: number,
    status: PreflightCheckStatus,
    detail: string,
    exitCode: number | null,
  ): void {
    const result: PreflightCheckResult = active.run.results[position]!;
    const buffer = active.buffers.get(position);
    result.status = status;
    result.detail = this.options.redact(detail);
    result.exitCode = exitCode;
    result.finishedAt = this.now();
    result.outputLines = buffer?.count ?? 0;
    result.outputTruncated = buffer?.truncated ?? false;
    if (status === 'SKIPPED' || status === 'CANCELLED') void this.save(active);
  }

  private async persistLog(runId: string, position: number, buffer: LogBuffer): Promise<void> {
    try {
      await this.options.logs.write(runId, position, buffer.snapshot());
    } catch (error) {
      this.options.logger.warn('Preflight output could not be saved', {
        runId,
        error: describeError(error),
      });
    }
  }

  private async readLog(runId: string, position: number) {
    try {
      return await this.options.logs.read(runId, position);
    } catch (error) {
      this.options.logger.warn('Preflight output could not be read', {
        runId,
        error: describeError(error),
      });
      return null;
    }
  }

  private async removeLogs(runId: string): Promise<void> {
    try {
      await this.options.logs.remove(runId);
    } catch (error) {
      this.options.logger.warn('Preflight output could not be deleted', {
        runId,
        error: describeError(error),
      });
    }
  }

  private async prune(workspaceId: string): Promise<void> {
    try {
      const removed = await this.options.repository.pruneRuns(workspaceId, PREFLIGHT_RUNS_KEPT);
      for (const runId of removed) await this.removeLogs(runId);
    } catch (error) {
      this.options.logger.warn('Old Preflight runs could not be deleted', {
        error: describeError(error),
      });
    }
  }
}
