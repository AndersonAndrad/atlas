import { describe, expect, it } from 'vitest';
import type {
  BackgroundJob,
  ContextTask,
  CreateNotificationInput,
  ExecuteTaskInput,
  TaskExecution,
  TeamExecution,
  UsageOverview,
} from '@atlas/contracts';
import type { ResolvedTarget, SharedContextService, TeamExecutionStore } from '@atlas/context';
import { AtlasError, noopLogger } from '@atlas/shared';
import { TeamExecutionService } from '../src/team-executions.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const PROJECT = id(900);
const TASK = id(800);
const TARGET = { projectId: PROJECT };

class MemoryStore implements TeamExecutionStore {
  readonly rows = new Map<string, TeamExecution>();
  async insert(execution: TeamExecution) {
    this.rows.set(execution.id, structuredClone(execution));
  }
  async update(execution: TeamExecution) {
    this.rows.set(execution.id, structuredClone(execution));
  }
  async get(executionId: string) {
    return structuredClone(this.rows.get(executionId) ?? null);
  }
  async findByRequestId(requestId: string) {
    return [...this.rows.values()].find((row) => row.requestId === requestId) ?? null;
  }
  async listForTask(taskId: string) {
    return [...this.rows.values()].filter((row) => row.taskId === taskId).reverse();
  }
  async listForProject(projectId: string) {
    return [...this.rows.values()].filter((row) => row.projectId === projectId).reverse();
  }
  async listActive() {
    return [...this.rows.values()].filter((row) =>
      ['RUNNING', 'PAUSED', 'CHECKING'].includes(row.status),
    );
  }
}

interface Options {
  objective?: string;
  untracked?: boolean;
  launchFails?: boolean;
  claude?: 'wrapped' | 'missing';
  preflightProfiles?: boolean;
  preflightFails?: 'authorization' | null;
  activeRun?: boolean;
}

function harness(options: Options = {}) {
  let next = 0;
  const store = new MemoryStore();
  const runs: (ExecuteTaskInput & { id: string })[] = [];
  const cancelled: string[] = [];
  const reviewed: string[] = [];
  const notifications: CreateNotificationInput[] = [];
  const jobs: { input: unknown }[] = [];
  const groups: string[] = [];
  const runOptions: { groupId?: string }[] = [];
  const task: ContextTask = {
    id: TASK,
    projectId: PROJECT,
    workspacePath: null,
    title: 'Login',
    objective: options.objective ?? 'Fix the wrong label.',
    status: 'open',
    baseCommit: null,
    baseBranch: null,
    budgetTokens: null,
    createdAt: 'x',
    updatedAt: 'x',
  };
  const target = {
    owner: { projectId: PROJECT, workspacePath: null },
    directory: '/work/app',
    label: 'App',
  } as unknown as ResolvedTarget;
  const context = {
    getTask: async (_target: ResolvedTarget, taskId: string) => {
      if (taskId !== TASK) throw new AtlasError('SESSION_TASK_NOT_FOUND');
      return task;
    },
    list: async () => [],
    listDecisions: async () => [],
    sessionEvidence: async (_target: ResolvedTarget, sessionId: string) => ({
      commits: [{ hash: `c-${sessionId}`, subject: 'work' }],
      changedFiles: [`src/${sessionId}.ts`],
      head: 'h',
    }),
  } as unknown as SharedContextService;
  const run = (input: ExecuteTaskInput): TaskExecution => {
    const runId = id(100 + ++next);
    return {
      id: runId,
      requestId: input.requestId,
      taskId: TASK,
      projectId: PROJECT,
      workspacePath: null,
      mode: 'new-terminal',
      provider: input.provider,
      profileId: input.profileId ?? null,
      profileName: null,
      terminalId: id(300 + next),
      terminalTitle: 't',
      aiSessionId: `s${next}`,
      runRef: null,
      status: options.untracked ? 'UNTRACKED' : 'LAUNCHING',
      exitCode: null,
      endReason: null,
      createdAt: 'x',
      startedAt: null,
      endedAt: null,
      cancelRequestedAt: null,
      reviewedAt: null,
    };
  };
  const overview: UsageOverview = {
    generatedAt: 'x',
    settings: { refreshMinutes: 10, retentionDays: 90 },
    profiles: [
      {
        profile: {
          id: id(50),
          providerId: 'claude',
          displayName: 'work',
          hidden: false,
          status: 'CONNECTED',
          plan: 'max',
        },
        windows: [{ state: 'current', usedPercent: 42 }],
      },
    ],
  } as unknown as UsageOverview;
  const service = new TeamExecutionService({
    store,
    context,
    resolveContextTarget: async () => target,
    runs: {
      execute: async (input, runOption) => {
        runOptions.push(runOption);
        if (options.launchFails) throw new AtlasError('TASK_EXECUTION_PROVIDER_UNAVAILABLE');
        const created = run(input);
        runs.push({ ...input, id: created.id });
        return created;
      },
      cancel: async (_target, runId) => {
        cancelled.push(runId);
        return {} as TaskExecution;
      },
      review: async (_target, runId) => {
        reviewed.push(runId);
        return {} as TaskExecution;
      },
      activeForTask: async () => (options.activeRun ? ({} as TaskExecution) : null),
    },
    wrapperStatus: async () => ({ claude: options.claude ?? 'wrapped', codex: 'wrapped' }),
    usage: async () => overview,
    preflight: {
      openProject: async () => ({ id: 'ws1' }) as never,
      workspace: async () =>
        ({
          config: {
            checks: [],
            profiles: options.preflightProfiles ? [{ id: 'quick', name: 'Quick' }] : [],
          },
        }) as never,
      plan: async () =>
        ({
          checks: [
            {
              checkId: 'lint',
              name: 'Lint',
              method: 'command',
              reference: 'x',
              digest: 'a'.repeat(64),
              authorization: 'FIRST_RUN',
              warnings: [],
            },
          ],
          disabled: [],
        }) as never,
    },
    jobs: {
      create: async (input) => {
        if (options.preflightFails === 'authorization') {
          throw new AtlasError('PREFLIGHT_AUTHORIZATION_REQUIRED');
        }
        jobs.push({ input });
        return { id: id(700) } as BackgroundJob;
      },
      cancel: async () => undefined,
    },
    terminalGroups: {
      create: async (name) => {
        groups.push(name);
        return id(400);
      },
      exists: async () => true,
    },
    publishNotification: async (input) => {
      notifications.push(input);
    },
    onChange: () => undefined,
    generateId: () => id(++next),
    now: () => new Date(Date.UTC(2026, 9, 27, 12, 0, 0)),
    logger: noopLogger,
  });
  const latest = async () => (await store.listForTask(TASK))[0]!;
  /** The tracker's settle hook for the last run started. */
  const settle = async (status: TaskExecution['status'], exitCode: number | null = 0) => {
    const last = runs.at(-1)!;
    const created = run(last);
    await service.stageSettled({
      ...created,
      id: last.id,
      aiSessionId: `s-${last.id.slice(-3)}`,
      status,
      exitCode,
      endedAt: 'y',
    });
  };
  return {
    service,
    store,
    runs,
    cancelled,
    reviewed,
    notifications,
    jobs,
    groups,
    runOptions,
    latest,
    settle,
  };
}

const approve = (
  service: TeamExecutionService,
  stages: { role: string; provider: 'claude' | 'codex'; profileId?: string }[],
  extra: Record<string, unknown> = {},
) =>
  service.approve({
    requestId: id(1),
    target: TARGET,
    taskId: TASK,
    stages: stages as never,
    ...extra,
  });

describe('TeamExecutionService proposal (SDD-026 Task 02 Milestone A)', () => {
  it('proposes one engineer for a simple task, with providers and subscription use', async () => {
    const { service } = harness();
    const proposal = await service.proposal(TARGET, TASK);
    expect(proposal.assessment.complexity).toBe('simple');
    expect(proposal.stages.map((stage) => [stage.role, stage.provider, stage.profileId])).toEqual([
      ['executor', 'claude', id(50)],
    ]);
    expect(proposal.profiles[0]).toMatchObject({ usedPercent: 42, limited: false });
    expect(proposal.preflight).toBeNull();
    expect(proposal.estimate).toBeNull();
  });

  it('proposes several roles for a complex task and offers Preflight with its checks', async () => {
    const { service } = harness({
      objective:
        'Add JWT authentication to the API and a React login form.\n- a\n- b\n- c\n- tests d',
      preflightProfiles: true,
    });
    const proposal = await service.proposal(TARGET, TASK);
    expect(proposal.stages.map((stage) => stage.role)).toEqual([
      'architect',
      'backend',
      'frontend',
      'security',
      'qa',
    ]);
    expect(proposal.preflight?.profiles[0]?.checks[0]).toMatchObject({
      checkId: 'lint',
      authorization: 'FIRST_RUN',
    });
  });

  it('proposes an alternative when the preferred provider is not installed', async () => {
    const { service } = harness({ claude: 'missing' });
    const [stage] = (await service.proposal(TARGET, TASK)).stages;
    expect(stage).toMatchObject({ provider: 'codex' });
    expect(stage?.substitution).toMatch(/not available/);
  });
});

describe('TeamExecutionService approval and execution (Milestones B and C)', () => {
  it('runs nothing before approval, then starts the first member with its role', async () => {
    const { service, runs } = harness();
    await service.proposal(TARGET, TASK);
    expect(runs).toHaveLength(0);
    const team = await approve(service, [{ role: 'executor', provider: 'claude' }]);
    expect(team).toMatchObject({ status: 'RUNNING', currentStage: 0 });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ mode: 'new-terminal', agentRole: 'developer' });
    expect(runs[0]?.objective).toContain('You are the Engineer of an ATLAS team');
    expect(service.isStage(runs[0]!.id)).toBe(true);
  });

  it('opens every member in one terminal group named after the task', async () => {
    const { service, groups, runOptions, settle, latest } = harness();
    await approve(service, [
      { role: 'backend', provider: 'claude' },
      { role: 'frontend', provider: 'claude' },
    ]);
    await settle('REVIEW_REQUIRED');
    expect(groups).toEqual(['ATLAS · Login']);
    expect(runOptions).toEqual([{ groupId: id(400) }, { groupId: id(400) }]);
    expect((await latest()).terminalGroupId).toBe(id(400));
  });

  it('returns the same team for a repeated approval and blocks a second one', async () => {
    const { service, runs } = harness();
    const first = await approve(service, [{ role: 'executor', provider: 'claude' }]);
    expect((await approve(service, [{ role: 'qa', provider: 'codex' }])).id).toBe(first.id);
    expect(runs).toHaveLength(1);
    await expect(
      service.approve({
        requestId: id(2),
        target: TARGET,
        taskId: TASK,
        stages: [{ role: 'executor', provider: 'claude' }],
      }),
    ).rejects.toMatchObject({ code: 'TEAM_EXECUTION_ACTIVE' });
    const busy = harness({ activeRun: true });
    await expect(
      approve(busy.service, [{ role: 'executor', provider: 'claude' }]),
    ).rejects.toMatchObject({
      code: 'TEAM_EXECUTION_ACTIVE',
    });
  });

  it('refuses uninstalled providers, unknown accounts and duplicate roles', async () => {
    const { service } = harness({ claude: 'missing' });
    await expect(
      approve(service, [{ role: 'executor', provider: 'claude' }]),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(
      approve(service, [{ role: 'executor', provider: 'codex', profileId: id(50) }]),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      approve(service, [
        { role: 'qa', provider: 'codex' },
        { role: 'qa', provider: 'codex' },
      ]),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('advances automatically, hands off Git evidence and asks for review at the end', async () => {
    const { service, runs, latest, settle, notifications } = harness();
    await approve(service, [
      { role: 'backend', provider: 'claude', profileId: id(50) },
      { role: 'frontend', provider: 'codex' },
    ]);
    await settle('REVIEW_REQUIRED');
    expect(runs).toHaveLength(2);
    expect(runs[1]?.objective).toContain('Handoff from the earlier members (from Git):');
    expect(runs[1]?.objective).toContain(`src/s-${runs[0]!.id.slice(-3)}.ts`);
    await settle('REVIEW_REQUIRED');
    const done = await latest();
    expect(done.status).toBe('REVIEW_REQUIRED');
    expect(done.stages.map((stage) => stage.status)).toEqual(['SUCCEEDED', 'SUCCEEDED']);
    expect(done.summary?.changedFiles.length).toBeGreaterThan(0);
    expect(done.summary?.usage).toEqual([
      { profileId: id(50), profileName: 'work', provider: 'claude', usedPercent: 42 },
    ]);
    expect(notifications.map((item) => item.title)).toEqual([
      'ATLAS team finished: review required',
    ]);
  });

  it('pauses between members in manual mode, and skips on request', async () => {
    const { service, runs, latest, settle } = harness();
    await approve(
      service,
      [
        { role: 'executor', provider: 'claude' },
        { role: 'qa', provider: 'claude' },
        { role: 'docs', provider: 'claude' },
      ],
      { advance: 'manual' },
    );
    await settle('REVIEW_REQUIRED');
    expect(await latest()).toMatchObject({
      status: 'PAUSED',
      pause: 'manual-advance',
      currentStage: 1,
    });
    expect(runs).toHaveLength(1);
    await service.continue(TARGET, (await latest()).id, 'next');
    expect(runs).toHaveLength(2);
    await settle('REVIEW_REQUIRED');
    await service.continue(TARGET, (await latest()).id, 'skip');
    const done = await latest();
    expect(done.status).toBe('REVIEW_REQUIRED');
    expect(done.stages.map((stage) => stage.status)).toEqual(['SUCCEEDED', 'SUCCEEDED', 'SKIPPED']);
  });

  it('pauses on a failed member and reruns it only when asked', async () => {
    const { service, runs, latest, settle, notifications } = harness();
    await approve(service, [
      { role: 'executor', provider: 'claude' },
      { role: 'qa', provider: 'claude' },
    ]);
    await settle('FAILED', 3);
    const paused = await latest();
    expect(paused).toMatchObject({
      status: 'PAUSED',
      pause: 'stage-failed',
      pauseDetail: 'Exit code 3.',
    });
    expect(runs).toHaveLength(1);
    expect(notifications.at(-1)?.title).toBe('ATLAS team needs your decision');
    await expect(service.continue(TARGET, paused.id, 'next')).resolves.toBeTruthy();
    // "next" on a failed member takes it as ended; retry is the explicit rerun.
    expect(runs).toHaveLength(2);
  });

  it('retries a failed member as a new run of the same stage', async () => {
    const { service, runs, latest, settle } = harness();
    await approve(service, [{ role: 'executor', provider: 'claude' }]);
    await settle('INTERRUPTED', null);
    expect((await latest()).pause).toBe('stage-interrupted');
    await service.continue(TARGET, (await latest()).id, 'retry');
    expect(runs).toHaveLength(2);
    expect((await latest()).stages[0]?.executionIds).toHaveLength(2);
  });

  it('pauses when a member cannot be tracked, and continues when the user confirms', async () => {
    const { service, latest } = harness({ untracked: true });
    await approve(service, [{ role: 'executor', provider: 'claude' }]);
    expect(await latest()).toMatchObject({ status: 'PAUSED', pause: 'stage-untracked' });
    await service.continue(TARGET, (await latest()).id, 'next');
    expect((await latest()).status).toBe('REVIEW_REQUIRED');
  });

  it('pauses when a member cannot start', async () => {
    const { service, latest } = harness({ launchFails: true });
    await approve(service, [{ role: 'executor', provider: 'claude' }]);
    const paused = await latest();
    expect(paused).toMatchObject({ status: 'PAUSED', pause: 'launch-failed' });
    expect(paused.pauseDetail).toMatch(/not installed/);
  });

  it('cancels the running member and the remaining ones', async () => {
    const { service, runs, cancelled, latest, settle } = harness();
    await approve(service, [
      { role: 'executor', provider: 'claude' },
      { role: 'qa', provider: 'claude' },
    ]);
    const cancelledTeam = await service.cancel(TARGET, (await latest()).id);
    expect(cancelled).toEqual([runs[0]!.id]);
    expect(cancelledTeam.stages.map((stage) => stage.status)).toEqual(['RUNNING', 'CANCELLED']);
    await settle('CANCELLED', null);
    expect((await latest()).stages[0]?.status).toBe('CANCELLED');
    expect(runs).toHaveLength(1);
    await expect(service.cancel(TARGET, cancelledTeam.id)).rejects.toMatchObject({
      code: 'TEAM_EXECUTION_INVALID_STATE',
    });
  });

  it('runs the approved Preflight with the authorized digests, then asks for review', async () => {
    const { service, jobs, latest, settle } = harness({ preflightProfiles: true });
    const authorizations = [{ checkId: 'lint', digest: 'a'.repeat(64) }];
    await approve(service, [{ role: 'executor', provider: 'claude' }], {
      preflight: { workspaceId: 'ws1', profileId: 'quick', authorizations },
    });
    await settle('REVIEW_REQUIRED');
    expect(await latest()).toMatchObject({ status: 'CHECKING', preflight: { result: 'running' } });
    expect(jobs[0]?.input).toMatchObject({
      type: 'PREFLIGHT',
      selection: { workspaceId: 'ws1', profileId: 'quick', authorizations },
    });
    await service.preflightFinished({ id: id(700), status: 'FAILED' } as BackgroundJob);
    expect(await latest()).toMatchObject({
      status: 'REVIEW_REQUIRED',
      preflight: { result: 'failed' },
    });
  });

  it('reports a Preflight that needs a new authorization and refuses another project', async () => {
    const { service, latest, settle } = harness({
      preflightProfiles: true,
      preflightFails: 'authorization',
    });
    await expect(
      approve(service, [{ role: 'executor', provider: 'claude' }], {
        preflight: { workspaceId: 'other', profileId: 'quick', authorizations: [] },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await approve(service, [{ role: 'executor', provider: 'claude' }], {
      preflight: { workspaceId: 'ws1', profileId: 'quick', authorizations: [] },
    });
    await settle('REVIEW_REQUIRED');
    expect((await latest()).preflight?.result).toBe('needs-authorization');
  });

  it('pauses active teams after a restart without rerunning anything', async () => {
    const { service, runs, latest } = harness();
    await approve(service, [{ role: 'executor', provider: 'claude' }]);
    await service.recover();
    expect(await latest()).toMatchObject({ status: 'PAUSED', pause: 'engine-restart' });
    expect((await latest()).stages[0]?.status).toBe('INTERRUPTED');
    expect(runs).toHaveLength(1);
  });

  it('records the review of a finished team and of its members, never completing the task', async () => {
    const { service, reviewed, latest, settle, runs } = harness();
    await approve(service, [{ role: 'executor', provider: 'claude' }]);
    await expect(service.review(TARGET, (await latest()).id)).rejects.toMatchObject({
      code: 'TEAM_EXECUTION_INVALID_STATE',
    });
    await settle('REVIEW_REQUIRED');
    const done = await service.review(TARGET, (await latest()).id);
    expect(done.reviewedAt).not.toBeNull();
    expect(reviewed).toEqual([runs[0]!.id]);
  });
});
