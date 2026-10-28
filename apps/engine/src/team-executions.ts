import {
  ACTIVE_TEAM_EXECUTION_STATUSES,
  ApproveTeamPlanSchema,
  NOTIFICATION_MESSAGE_MAX,
  NOTIFICATION_TITLE_MAX,
  STAGE_STATUS_OF_EXECUTION,
  TeamContinueActionSchema,
  TEAM_ROLE_CONTEXT,
  TEAM_SUMMARY_FILES_MAX,
  parseInput,
  type AiProvider,
  type ApproveTeamPlanInput,
  type BackgroundJob,
  type ContextTarget,
  type ContextTask,
  type TaskAssessment,
  type CreateJobInput,
  type CreateNotificationInput,
  type ExecuteTaskInput,
  type LlmWrapperStatus,
  type PreflightPlan,
  type PreflightWorkspace,
  type PreflightWorkspaceDetails,
  type TaskExecution,
  type TeamContinueAction,
  type TeamExecution,
  type TeamPauseReason,
  type TeamPreflightOption,
  type TeamProfileOption,
  type TeamProposal,
  type TeamStage,
  type UsageOverview,
} from '@atlas/contracts';
import {
  assessTask,
  proposeStages,
  stageObjective,
  teamRisks,
  type ResolvedTarget,
  type SharedContextService,
  type TeamExecutionStore,
} from '@atlas/context';
import { AtlasError, describeError, type Logger } from '@atlas/shared';

const PROVIDER_NAMES: Record<AiProvider, string> = { claude: 'Claude Code', codex: 'Codex' };
export const TEAM_HISTORY_LIMIT = 10;

const PAUSE_MESSAGES: Record<TeamPauseReason, string> = {
  'manual-advance': 'is ready for its next member',
  'stage-failed': 'stopped: a member failed',
  'stage-untracked': 'cannot tell whether a member finished',
  'stage-interrupted': 'stopped: a member was interrupted',
  'launch-failed': 'could not start a member',
  'engine-restart': 'stopped when ATLAS quit',
};

const truncate = (value: string, max: number) =>
  value.length <= max ? value : `${value.slice(0, max - 1)}…`;

/** The parts of the Task Execution Hub a team uses (SDD-025 Task 02). */
export interface TeamTaskRuns {
  execute(input: ExecuteTaskInput): Promise<TaskExecution>;
  cancel(target: ContextTarget, id: string): Promise<TaskExecution>;
  review(target: ContextTarget, id: string): Promise<TaskExecution>;
  activeForTask(taskId: string): Promise<TaskExecution | null>;
}

export interface TeamPreflight {
  openProject(projectId: string): Promise<PreflightWorkspace>;
  workspace(id: string): Promise<PreflightWorkspaceDetails>;
  plan(input: unknown): Promise<PreflightPlan>;
}

export interface TeamExecutionServiceDependencies {
  store: TeamExecutionStore;
  context: SharedContextService;
  resolveContextTarget: (target: ContextTarget) => Promise<ResolvedTarget>;
  runs: TeamTaskRuns;
  wrapperStatus: (target: ResolvedTarget) => Promise<Record<AiProvider, LlmWrapperStatus>>;
  usage: () => Promise<UsageOverview>;
  preflight: TeamPreflight;
  jobs: {
    create(input: CreateJobInput): Promise<BackgroundJob>;
    cancel(id: string): Promise<unknown>;
  };
  publishNotification: (input: CreateNotificationInput) => Promise<void>;
  onChange: (execution: TeamExecution) => void;
  generateId: () => string;
  now: () => Date;
  logger: Logger;
}

const targetOf = (execution: TeamExecution): ContextTarget =>
  execution.projectId !== null
    ? { projectId: execution.projectId }
    : { workspacePath: execution.workspacePath! };

const isActive = (execution: TeamExecution) =>
  ACTIVE_TEAM_EXECUTION_STATUSES.includes(execution.status);

/**
 * "Execute with ATLAS" (SDD-026 Task 02). ATLAS has no multi-agent orchestration engine
 * yet (SDD-005 Milestone B), so an approved team runs as a sequence of ordinary task
 * executions, one member per stage in its own terminal, through the Task Execution Hub.
 * Nothing runs before approval; nothing is retried, skipped or added without the user;
 * the task is never completed: a finished team asks for review.
 */
export class TeamExecutionService {
  /** One change at a time: approvals, run events and user actions never interleave. */
  private queue: Promise<unknown> = Promise.resolve();
  /** Task executions started as team stages: their own notifications are not sent. */
  private readonly stageRuns = new Set<string>();

  constructor(private readonly deps: TeamExecutionServiceDependencies) {}

  /** Whether a task execution is a stage of a team (its outcome is reported by the team). */
  isStage(executionId: string): boolean {
    return this.stageRuns.has(executionId);
  }

  // Proposal (Milestone A) ----------------------------------------------------

  async proposal(rawTarget: ContextTarget, taskId: string): Promise<TeamProposal> {
    const target = await this.deps.resolveContextTarget(rawTarget);
    const task = await this.deps.context.getTask(target, taskId);
    const [assessment, wrappers, profiles, preflight] = await Promise.all([
      this.assess(target, task),
      this.deps.wrapperStatus(target),
      this.profiles(),
      this.preflightOption(target),
    ]);
    const providers = (['claude', 'codex'] as const).map((provider) => ({
      provider,
      availability: wrappers[provider],
    }));
    const stages = proposeStages(assessment, providers, profiles);
    return {
      taskId: task.id,
      assessment,
      stages,
      risks: teamRisks(assessment, stages, providers),
      providers,
      profiles,
      preflight,
      estimate: null,
    };
  }

  list(rawTarget: ContextTarget, taskId: string): Promise<TeamExecution[]> {
    return this.deps.resolveContextTarget(rawTarget).then(async (target) => {
      await this.deps.context.getTask(target, taskId);
      return this.deps.store.listForTask(taskId, TEAM_HISTORY_LIMIT);
    });
  }

  // Approval (FR-005, FR-006) -------------------------------------------------

  approve(raw: ApproveTeamPlanInput): Promise<TeamExecution> {
    return this.exclusive(async () => {
      const request = parseInput(ApproveTeamPlanSchema, raw);
      const target = await this.deps.resolveContextTarget(request.target);
      const task = await this.deps.context.getTask(target, request.taskId);
      const repeated = await this.deps.store.findByRequestId(request.requestId);
      if (repeated !== null) {
        if (repeated.taskId !== task.id) {
          throw invalid('requestId', 'This request was already used for another task.');
        }
        return repeated;
      }
      if (task.status !== 'open') {
        throw invalid('taskId', 'Only open tasks can be executed. Reopen the task first.');
      }
      const active = (await this.deps.store.listActive()).some((item) => item.taskId === task.id);
      if (active || (await this.deps.runs.activeForTask(task.id)) !== null) {
        throw new AtlasError('TEAM_EXECUTION_ACTIVE');
      }
      const wrappers = await this.deps.wrapperStatus(target);
      const profiles = (await this.deps.usage()).profiles.map((report) => report.profile);
      const stages: TeamStage[] = request.stages.map((stage, index) => {
        if (wrappers[stage.provider] === 'missing') {
          throw invalid(
            `stages.${index}.provider`,
            `${PROVIDER_NAMES[stage.provider]} is not installed. Choose another provider.`,
          );
        }
        const profile =
          stage.profileId === undefined
            ? null
            : (profiles.find(
                (item) =>
                  item.id === stage.profileId && item.providerId === stage.provider && !item.hidden,
              ) ?? null);
        if (stage.profileId !== undefined && profile === null) {
          throw invalid(`stages.${index}.profileId`, 'Choose an account profile of this provider.');
        }
        return {
          role: stage.role,
          provider: stage.provider,
          profileId: profile?.id ?? null,
          profileName: profile?.displayName ?? null,
          status: 'PENDING',
          executionIds: [],
          sessionIds: [],
          terminalId: null,
          exitCode: null,
          startedAt: null,
          endedAt: null,
          changedFiles: [],
          commits: [],
        };
      });
      if (request.preflight !== null) await this.checkPreflight(target, request.preflight);
      const assessment = await this.assess(target, task);
      const execution: TeamExecution = {
        id: this.deps.generateId(),
        requestId: request.requestId,
        taskId: task.id,
        ...target.owner,
        status: 'RUNNING',
        pause: null,
        pauseDetail: null,
        advance: request.advance,
        stages,
        currentStage: 0,
        complexity: assessment.complexity,
        preflight:
          request.preflight === null
            ? null
            : { ...request.preflight, jobId: null, result: 'not-requested' },
        summary: null,
        approvedAt: this.timestamp(),
        finishedAt: null,
        reviewedAt: null,
      };
      await this.deps.store.insert(execution);
      this.deps.logger.info('Team execution approved', {
        teamExecutionId: execution.id,
        taskId: task.id,
        stages: stages.map((stage) => stage.role),
      });
      return this.launch(execution, 0);
    });
  }

  // User decisions (FR-011, FR-013) --------------------------------------------

  continue(rawTarget: ContextTarget, id: string, rawAction: unknown): Promise<TeamExecution> {
    return this.exclusive(async () => {
      const action: TeamContinueAction = parseInput(TeamContinueActionSchema, rawAction);
      const execution = await this.owned(rawTarget, id);
      if (execution.status !== 'PAUSED') throw new AtlasError('TEAM_EXECUTION_INVALID_STATE');
      const index = execution.currentStage;
      // Paused after the last member: only the Preflight step is left.
      if (index === null) {
        if (action === 'retry' && execution.preflight !== null) return this.runPreflight(execution);
        return this.complete({
          ...execution,
          preflight: execution.preflight && { ...execution.preflight, result: 'not-run' },
        });
      }
      const stage = execution.stages[index]!;
      switch (action) {
        case 'retry':
          if (stage.status === 'PENDING' || stage.status === 'SUCCEEDED') {
            throw new AtlasError('TEAM_EXECUTION_INVALID_STATE');
          }
          return this.launch(execution, index);
        case 'skip':
          return this.advance(this.withStage(execution, index, { status: 'SKIPPED' }), index);
        case 'next':
          // A pending member starts; an ended one (e.g. untracked) is taken as finished.
          if (stage.status === 'PENDING') return this.launch(execution, index);
          return this.advance(execution, index);
      }
    });
  }

  cancel(rawTarget: ContextTarget, id: string): Promise<TeamExecution> {
    return this.exclusive(async () => {
      const execution = await this.owned(rawTarget, id);
      if (!isActive(execution)) throw new AtlasError('TEAM_EXECUTION_INVALID_STATE');
      const index = execution.currentStage;
      const running = index === null ? null : execution.stages[index]!;
      if (running?.status === 'RUNNING') {
        const runId = running.executionIds.at(-1)!;
        await this.deps.runs
          .cancel(targetOf(execution), runId)
          .catch((error: unknown) =>
            this.deps.logger.debug('Team stage cancel skipped', { error: describeError(error) }),
          );
      }
      if (execution.status === 'CHECKING' && execution.preflight?.jobId) {
        await this.deps.jobs.cancel(execution.preflight.jobId).catch(() => undefined);
      }
      return this.save({
        ...execution,
        status: 'CANCELLED',
        pause: null,
        pauseDetail: null,
        stages: execution.stages.map((stage) =>
          stage.status === 'PENDING' ? { ...stage, status: 'CANCELLED' } : stage,
        ),
        preflight: execution.preflight && {
          ...execution.preflight,
          result: execution.preflight.result === 'running' ? 'not-run' : execution.preflight.result,
        },
        finishedAt: this.timestamp(),
      });
    });
  }

  /** Explicit review of the outcome (FR-012); the members' runs are reviewed with it. */
  review(rawTarget: ContextTarget, id: string): Promise<TeamExecution> {
    return this.exclusive(async () => {
      const execution = await this.owned(rawTarget, id);
      if (isActive(execution)) throw new AtlasError('TEAM_EXECUTION_INVALID_STATE');
      if (execution.reviewedAt !== null) return execution;
      for (const runId of execution.stages.flatMap((stage) => stage.executionIds)) {
        await this.deps.runs.review(targetOf(execution), runId).catch(() => undefined);
      }
      return this.save({ ...execution, reviewedAt: this.timestamp() });
    });
  }

  // Run events ----------------------------------------------------------------

  /** A stage's task execution changed: untracked runs can never report their end. */
  stageChanged(run: TaskExecution): Promise<void> {
    if (run.status !== 'UNTRACKED' || !this.stageRuns.has(run.id)) return Promise.resolve();
    return this.exclusive(async () => {
      const found = await this.findStage(run);
      if (found === null || found.execution.stages[found.index]!.status !== 'RUNNING') return;
      const paused = this.withStage(found.execution, found.index, {
        status: 'UNTRACKED',
        exitCode: null,
      });
      await this.pause(paused, 'stage-untracked', null);
    });
  }

  /** A stage's task execution reached a final status (the tracker's settle hook). */
  stageSettled(run: TaskExecution): Promise<void> {
    return this.exclusive(async () => {
      const found = await this.findStage(run);
      if (found === null || found.execution.stages[found.index]!.status !== 'RUNNING') return;
      const { index } = found;
      const status = STAGE_STATUS_OF_EXECUTION[run.status] ?? 'FAILED';
      const evidence = await this.evidence(found.execution, run.aiSessionId);
      const execution = this.withStage(found.execution, index, {
        status,
        exitCode: run.exitCode,
        endedAt: run.endedAt,
        ...evidence,
      });
      if (execution.status === 'CANCELLED') {
        await this.save(execution);
        return;
      }
      switch (status) {
        case 'SUCCEEDED':
          await this.advance(execution, index);
          return;
        case 'FAILED':
          await this.pause(execution, 'stage-failed', `Exit code ${run.exitCode ?? 'unknown'}.`);
          return;
        default:
          await this.pause(execution, 'stage-interrupted', null);
      }
    });
  }

  /** The Preflight job of a team ended. */
  preflightFinished(job: BackgroundJob): Promise<void> {
    return this.exclusive(async () => {
      const execution = (await this.deps.store.listActive()).find(
        (item) => item.status === 'CHECKING' && item.preflight?.jobId === job.id,
      );
      if (execution === undefined || execution.preflight === null) return;
      await this.complete({
        ...execution,
        preflight: {
          ...execution.preflight,
          result:
            job.status === 'COMPLETED' ? 'passed' : job.status === 'FAILED' ? 'failed' : 'not-run',
        },
      });
    });
  }

  /**
   * After a restart nothing of a team can still run (its stages were interrupted with
   * their terminals): active teams wait for the user. Nothing is rerun automatically.
   */
  recover(): Promise<void> {
    return this.exclusive(async () => {
      for (const execution of await this.deps.store.listActive()) {
        for (const runId of execution.stages.flatMap((stage) => stage.executionIds)) {
          this.stageRuns.add(runId);
        }
        if (execution.status === 'PAUSED') continue;
        const index = execution.currentStage;
        const paused =
          index !== null && execution.stages[index]!.status === 'RUNNING'
            ? this.withStage(execution, index, { status: 'INTERRUPTED' })
            : {
                ...execution,
                preflight: execution.preflight && {
                  ...execution.preflight,
                  result:
                    execution.preflight.result === 'running'
                      ? ('not-run' as const)
                      : execution.preflight.result,
                },
              };
        await this.pause(paused, 'engine-restart', null, { notify: false });
      }
    });
  }

  // Internals -----------------------------------------------------------------

  /** Task text, the files its context refers to, and the decisions it must respect. */
  private async assess(target: ResolvedTarget, task: ContextTask): Promise<TaskAssessment> {
    const [entries, decisions] = await Promise.all([
      this.deps.context.list(target, { taskId: task.id }),
      this.deps.context.listDecisions(target),
    ]);
    return assessTask({
      task,
      contextFiles: [
        ...new Set(entries.flatMap((entry) => entry.refs.files.map((ref) => ref.path))),
      ],
      decisions: decisions.filter(
        (decision) => decision.taskId === null || decision.taskId === task.id,
      ),
    });
  }

  /** Starts a member in a new terminal through the Task Execution Hub (FR-007, FR-008). */
  private async launch(execution: TeamExecution, index: number): Promise<TeamExecution> {
    const target = await this.deps.resolveContextTarget(targetOf(execution));
    const task = await this.deps.context.getTask(target, execution.taskId);
    const stage = execution.stages[index]!;
    try {
      const run = await this.deps.runs.execute({
        requestId: this.deps.generateId(),
        target: targetOf(execution),
        taskId: task.id,
        provider: stage.provider,
        ...(stage.profileId === null ? {} : { profileId: stage.profileId }),
        mode: 'new-terminal',
        objective: stageObjective({
          task,
          stages: execution.stages,
          index,
          previous: execution.stages.slice(0, index).filter((item) => item.status !== 'PENDING'),
        }),
        agentRole: TEAM_ROLE_CONTEXT[stage.role],
      });
      this.stageRuns.add(run.id);
      const started = this.withStage(
        { ...execution, status: 'RUNNING', pause: null, pauseDetail: null, currentStage: index },
        index,
        {
          status: run.status === 'UNTRACKED' ? 'UNTRACKED' : 'RUNNING',
          executionIds: [...stage.executionIds, run.id],
          sessionIds: [...stage.sessionIds, run.aiSessionId],
          terminalId: run.terminalId,
          exitCode: null,
          startedAt: run.createdAt,
          endedAt: null,
        },
      );
      this.deps.logger.info('Team stage started', {
        teamExecutionId: execution.id,
        stage: index,
        role: stage.role,
        executionId: run.id,
      });
      if (run.status === 'UNTRACKED') return this.pause(started, 'stage-untracked', null);
      return this.save(started);
    } catch (error) {
      this.deps.logger.warn('Team stage could not start', {
        teamExecutionId: execution.id,
        stage: index,
        error: describeError(error),
      });
      const detail =
        error instanceof AtlasError ? error.userMessage : 'The member could not start.';
      return this.pause(
        this.withStage({ ...execution, currentStage: index }, index, { status: 'FAILED' }),
        'launch-failed',
        detail,
      );
    }
  }

  /** The member at `index` ended (or was skipped): the next one, or the end of the team. */
  private async advance(execution: TeamExecution, index: number): Promise<TeamExecution> {
    const next = index + 1;
    if (next >= execution.stages.length) return this.finishStages(execution);
    if (execution.advance === 'manual') {
      return this.pause({ ...execution, currentStage: next }, 'manual-advance', null);
    }
    return this.launch(execution, next);
  }

  /** Every member ended: what Git shows changed, then Preflight when it was approved. */
  private async finishStages(execution: TeamExecution): Promise<TeamExecution> {
    const first = execution.stages.find((stage) => stage.executionIds.length > 0);
    const evidence = first
      ? await this.evidence(execution, first.sessionIds[0] ?? null)
      : { changedFiles: [], commits: [] };
    const used = new Map(
      execution.stages
        .filter((stage) => stage.profileId !== null && stage.executionIds.length > 0)
        .map((stage) => [stage.profileId!, stage]),
    );
    const usage = (await this.profiles().catch(() => [] as TeamProfileOption[]))
      .filter((profile) => used.has(profile.id))
      .map((profile) => ({
        profileId: profile.id,
        profileName: profile.displayName,
        provider: profile.provider,
        usedPercent: profile.usedPercent,
      }));
    const summarized: TeamExecution = {
      ...execution,
      currentStage: null,
      summary: { ...evidence, usage },
    };
    if (summarized.preflight !== null) return this.runPreflight(summarized);
    return this.complete(summarized);
  }

  /** Queues the approved Preflight profile with the digests the user authorized. */
  private async runPreflight(execution: TeamExecution): Promise<TeamExecution> {
    const preflight = execution.preflight!;
    try {
      const job = await this.deps.jobs.create({
        type: 'PREFLIGHT',
        selection: {
          workspaceId: preflight.workspaceId,
          profileId: preflight.profileId,
          checkIds: null,
          authorizations: preflight.authorizations,
        },
      });
      return this.save({
        ...execution,
        status: 'CHECKING',
        pause: null,
        pauseDetail: null,
        currentStage: null,
        preflight: { ...preflight, jobId: job.id, result: 'running' },
      });
    } catch (error) {
      // Checks that changed since the approval need a new authorization in Preflight.
      const result =
        error instanceof AtlasError && error.code === 'PREFLIGHT_AUTHORIZATION_REQUIRED'
          ? ('needs-authorization' as const)
          : ('not-run' as const);
      this.deps.logger.warn('Team Preflight could not start', {
        teamExecutionId: execution.id,
        error: describeError(error),
      });
      return this.complete({ ...execution, preflight: { ...preflight, result } });
    }
  }

  /** The result now awaits the user's review (FR-012); the task stays open. */
  private async complete(execution: TeamExecution): Promise<TeamExecution> {
    const completed = await this.save({
      ...execution,
      status: 'REVIEW_REQUIRED',
      pause: null,
      pauseDetail: null,
      currentStage: null,
      finishedAt: this.timestamp(),
    });
    await this.notify(
      completed,
      'ACTION_REQUIRED',
      'ATLAS team finished: review required',
      'finished. Review the result before marking the task done.',
    );
    return completed;
  }

  private async pause(
    execution: TeamExecution,
    reason: TeamPauseReason,
    detail: string | null,
    { notify = true }: { notify?: boolean } = {},
  ): Promise<TeamExecution> {
    const paused = await this.save({
      ...execution,
      status: 'PAUSED',
      pause: reason,
      pauseDetail: detail,
    });
    if (notify) {
      await this.notify(
        paused,
        reason === 'manual-advance' ? 'INFO' : 'ACTION_REQUIRED',
        'ATLAS team needs your decision',
        `${PAUSE_MESSAGES[reason]}. Open the task to continue, retry or cancel.`,
      );
    }
    return paused;
  }

  private async notify(
    execution: TeamExecution,
    type: CreateNotificationInput['type'],
    title: string,
    text: string,
  ): Promise<void> {
    try {
      const target = await this.deps.resolveContextTarget(targetOf(execution));
      const task = await this.deps.context.getTask(target, execution.taskId);
      const stage =
        execution.stages[execution.currentStage ?? -1] ??
        [...execution.stages].reverse().find((item) => item.executionIds.length > 0);
      const runId = stage?.executionIds.at(-1);
      await this.deps.publishNotification({
        type,
        category: 'AGENT',
        title: truncate(title, NOTIFICATION_TITLE_MAX),
        message: truncate(`The team for “${task.title}” ${text}`, NOTIFICATION_MESSAGE_MAX),
        projectId: execution.projectId,
        sourceName: target.label,
        taskId: execution.id,
        // Opens the task, where the team's progress and decisions are shown.
        action:
          runId === undefined || stage?.terminalId == null
            ? null
            : {
                type: 'task-execution',
                executionId: runId,
                taskId: execution.taskId,
                projectId: execution.projectId,
                workspacePath: execution.workspacePath,
                terminalId: stage.terminalId,
              },
      });
    } catch (error) {
      this.deps.logger.warn('Team notification failed', { error: describeError(error) });
    }
  }

  /** What Git shows changed since a member's AI session started (FR-012). */
  private async evidence(
    execution: TeamExecution,
    sessionId: string | null,
  ): Promise<Pick<TeamStage, 'changedFiles' | 'commits'>> {
    if (sessionId === null) return { changedFiles: [], commits: [] };
    try {
      const target = await this.deps.resolveContextTarget(targetOf(execution));
      const evidence = await this.deps.context.sessionEvidence(target, sessionId);
      return {
        changedFiles: evidence.changedFiles.slice(0, TEAM_SUMMARY_FILES_MAX),
        commits: evidence.commits.slice(0, 50),
      };
    } catch (error) {
      this.deps.logger.debug('Team stage evidence unavailable', { error: describeError(error) });
      return { changedFiles: [], commits: [] };
    }
  }

  private withStage(
    execution: TeamExecution,
    index: number,
    patch: Partial<TeamStage>,
  ): TeamExecution {
    return {
      ...execution,
      stages: execution.stages.map((stage, position) =>
        position === index ? { ...stage, ...patch } : stage,
      ),
    };
  }

  /** The team and stage a task execution belongs to (a cancelled team still records it). */
  private async findStage(
    run: Pick<TaskExecution, 'id' | 'taskId'>,
  ): Promise<{ execution: TeamExecution; index: number } | null> {
    for (const execution of await this.deps.store.listForTask(run.taskId, TEAM_HISTORY_LIMIT)) {
      const index = execution.stages.findIndex((stage) => stage.executionIds.includes(run.id));
      if (index !== -1) return { execution, index };
    }
    return null;
  }

  /** The profiles with their latest subscription use; never converted to money. */
  private async profiles(): Promise<TeamProfileOption[]> {
    const overview = await this.deps.usage();
    return overview.profiles
      .filter((report) => !report.profile.hidden)
      .map((report) => {
        const current = report.windows.filter((window) => window.state === 'current');
        return {
          id: report.profile.id,
          provider: report.profile.providerId,
          displayName: report.profile.displayName,
          status: report.profile.status,
          plan: report.profile.plan,
          usedPercent:
            current.length === 0 ? null : Math.max(...current.map((window) => window.usedPercent)),
          limited: report.profile.status === 'LIMITED',
        };
      });
  }

  /** The project's Preflight profiles and what each would need authorized (FR-007 step 7). */
  private async preflightOption(target: ResolvedTarget): Promise<TeamPreflightOption | null> {
    if (target.owner.projectId === null) return null;
    try {
      const workspace = await this.deps.preflight.openProject(target.owner.projectId);
      const details = await this.deps.preflight.workspace(workspace.id);
      if (details.config.profiles.length === 0) return null;
      const profiles = [];
      for (const profile of details.config.profiles) {
        const plan = await this.deps.preflight.plan({
          workspaceId: workspace.id,
          profileId: profile.id,
          checkIds: null,
        });
        profiles.push({
          id: profile.id,
          name: profile.name,
          checks: plan.checks.map((check) => ({
            checkId: check.checkId,
            name: check.name,
            digest: check.digest,
            authorization: check.authorization,
            warnings: check.warnings,
          })),
        });
      }
      return { workspaceId: workspace.id, profiles };
    } catch (error) {
      this.deps.logger.debug('Preflight is not available for the team', {
        error: describeError(error),
      });
      return null;
    }
  }

  /** The approved Preflight belongs to the task's project. */
  private async checkPreflight(
    target: ResolvedTarget,
    preflight: { workspaceId: string; profileId: string },
  ): Promise<void> {
    if (target.owner.projectId === null) {
      throw invalid('preflight', 'Preflight at the end is available for projects only.');
    }
    const workspace = await this.deps.preflight.openProject(target.owner.projectId);
    const details = await this.deps.preflight.workspace(workspace.id);
    if (
      workspace.id !== preflight.workspaceId ||
      !details.config.profiles.some((profile) => profile.id === preflight.profileId)
    ) {
      throw invalid('preflight', 'Choose a Preflight profile of this project.');
    }
  }

  private async owned(rawTarget: ContextTarget, id: string): Promise<TeamExecution> {
    const target = await this.deps.resolveContextTarget(rawTarget);
    const execution = await this.deps.store.get(id);
    if (
      execution === null ||
      execution.projectId !== target.owner.projectId ||
      execution.workspacePath !== target.owner.workspacePath
    ) {
      throw new AtlasError('TEAM_EXECUTION_NOT_FOUND');
    }
    return execution;
  }

  private async save(execution: TeamExecution): Promise<TeamExecution> {
    await this.deps.store.update(execution);
    this.deps.onChange(execution);
    return execution;
  }

  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private timestamp(): string {
    return this.deps.now().toISOString();
  }
}

const invalid = (field: string, message: string) =>
  new AtlasError('VALIDATION_FAILED', message, { issues: [{ field, message }] });
