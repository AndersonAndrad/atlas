import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectAuditService, type AuditProviderRunner, type AuditStore } from '@atlas/audit';
import type { AuditFinding, BackgroundJob, ProjectAudit } from '@atlas/contracts';
import { JobService } from '@atlas/jobs';
import { SqliteJobRepository, openDatabase, type Database } from '@atlas/persistence';
import { noopLogger } from '@atlas/shared';
import { createTempDir } from '../../../tests/support/temp.js';
import {
  CliAuditRunner,
  claudeAuditArguments,
  parseClaudeResult,
} from '../src/adapters/audit-cli.js';
import { GitAuditWorkspace, parsePorcelain } from '../src/adapters/audit-workspace.js';
import { createGitExecutor } from '../src/git/git-runner.js';
import { AuditJobExecutor } from '../src/jobs/audit-executor.js';
import { FilePreflightLogStore } from '../src/adapters/preflight-storage.js';
import { createEngine } from '../src/index.js';

const posix = process.platform !== 'win32';
const gitAvailable = (() => {
  try {
    execFileSync('git', ['--version']);
    return true;
  } catch {
    return false;
  }
})();

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const REPORT = {
  summary: 'One issue.',
  findings: [
    {
      title: 'Unchecked input',
      category: 'security',
      severity: 'HIGH',
      confidence: 'HIGH',
      kind: 'observation',
      description: 'Input reaches the query.',
      evidence: 'See the call.',
      excerpt: 'query(input)',
      locations: [{ path: 'src/app.ts', startLine: 1, endLine: null, symbol: null }],
      impact: 'Data exposure.',
      recommendation: 'Validate the input.',
      suggestedTaskTitle: 'Validate input',
      acceptanceCriteria: ['Input is validated'],
      effort: 'small',
    },
  ],
};

describe('parsePorcelain and parseClaudeResult', () => {
  it('reads status entries, skipping the original path of renames', () => {
    expect(parsePorcelain(' M a.ts\0R  new.ts\0old.ts\0?? dir/b.ts\0')).toEqual([
      { status: ' M', path: 'a.ts' },
      { status: 'R ', path: 'new.ts' },
      { status: '??', path: 'dir/b.ts' },
    ]);
  });

  it('takes the structured output and the usage of a Claude Code result', () => {
    const parsed = parseClaudeResult(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'text',
        structured_output: REPORT,
        total_cost_usd: 0.5,
        duration_ms: 1200,
        usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 7 },
      }),
    );
    expect(parsed).toEqual({
      kind: 'answer',
      answer: REPORT,
      metrics: { inputTokens: 15, outputTokens: 7, costUsd: 0.5, durationMs: 1200 },
    });
    expect(parseClaudeResult('{"subtype":"error_max_turns","is_error":true}')).toMatchObject({
      kind: 'error',
      detail: 'error_max_turns',
    });
    expect(parseClaudeResult('not json')).toBeNull();
  });

  it('never gives Claude Code tools that run commands or edit files', () => {
    const args = claudeAuditArguments();
    const tools = args[args.indexOf('--tools') + 1];
    expect(tools).toBe('Read,Grep,Glob');
    expect(args).toContain('--restricted');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('dontAsk');
    expect(args.join(' ')).not.toMatch(/bypassPermissions|Bash|Edit|Write/);
  });
});

/** A fake provider CLI: a POSIX script that answers `--help` and records how it ran. */
function fakeCli(directory: string, name: 'claude' | 'codex', body: string, help: string) {
  const file = path.join(directory, name);
  writeFileSync(
    file,
    `#!/bin/sh
case "$*" in
  "--help"|"exec --help") printf '%s\\n' '${help}'; exit 0 ;;
esac
printf '%s\\n' "$@" > "$0.args"
cat > "$0.stdin"
env > "$0.env"
${body}
`,
  );
  chmodSync(file, 0o755);
  return file;
}

const CLAUDE_HELP =
  '--restricted --tools --allowedTools --permission-mode dontAsk --strict-mcp-config --no-session-persistence --output-format --json-schema';
const CODEX_HELP = '--sandbox read-only --ephemeral --json --output-schema --output-last-message';

describe.skipIf(!posix)('CliAuditRunner (SDD-026 FR-004, FR-006)', () => {
  let temp: ReturnType<typeof createTempDir>;
  let bin: string;
  let wrappers: string;
  let project: string;

  beforeEach(() => {
    temp = createTempDir();
    bin = path.join(temp.dir, 'bin');
    wrappers = path.join(temp.dir, 'wrappers');
    project = path.join(temp.dir, 'project');
    for (const directory of [bin, wrappers, project]) mkdirSync(directory);
  });
  afterEach(() => temp.cleanup());

  const runner = (extra: Partial<ConstructorParameters<typeof CliAuditRunner>[0]> = {}) =>
    new CliAuditRunner({
      platform: process.platform,
      home: temp.dir,
      searchPath: async () => [wrappers, bin].join(path.delimiter),
      excludeDirectory: wrappers,
      env: () => ({ PATH: `${bin}:/usr/bin:/bin`, HOME: temp.dir }),
      tempDirectory: path.join(temp.dir, 'tmp'),
      killGraceMs: 200,
      ...extra,
    });
  const request = (overrides: Record<string, unknown> = {}) => {
    const output: string[] = [];
    const log: string[] = [];
    return {
      output,
      log,
      request: {
        auditId: id(1),
        provider: 'claude' as const,
        profileDirectory: null,
        cwd: project,
        prompt: 'Audit "this"; $(touch pwned) `id`',
        timeoutMs: 10_000,
        signal: new AbortController().signal,
        output: (chunk: string) => output.push(chunk),
        log: (line: string) => log.push(line),
        ...overrides,
      },
    };
  };

  it('reports a missing CLI and one without the read-only options, never the wrappers', async () => {
    // A wrapper with every option must not count: the real CLI is needed.
    fakeCli(wrappers, 'claude', 'exit 0', CLAUDE_HELP);
    expect(await runner().availability('claude')).toMatchObject({ available: false });
    fakeCli(bin, 'codex', 'exit 0', '--sandbox read-only');
    const codex = await runner().availability('codex');
    expect(codex.available).toBe(false);
    expect(codex.reason).toMatch(/cannot run a read-only audit.*--output-schema/);
  });

  it('runs Claude Code restricted, with the prompt on standard input and the profile', async () => {
    const claude = fakeCli(
      bin,
      'claude',
      `echo 'progress on stderr' >&2
printf '%s' '${JSON.stringify({ subtype: 'success', structured_output: REPORT, usage: { input_tokens: 3, output_tokens: 4 }, total_cost_usd: 0.01 })}'`,
      CLAUDE_HELP,
    );
    const { request: input, output } = request({
      profileDirectory: path.join(temp.dir, '.claude-work'),
    });
    const outcome = await runner().run(input);
    expect(outcome).toEqual({
      kind: 'completed',
      answer: REPORT,
      metrics: { inputTokens: 3, outputTokens: 4, costUsd: 0.01, durationMs: null },
    });
    const args = readFileSync(`${claude}.args`, 'utf8').trim().split('\n');
    expect(args.slice(0, 2)).toEqual(['-p', '--restricted']);
    expect(args).toContain('--json-schema');
    // The prompt is data on standard input, never an argument or shell text.
    expect(readFileSync(`${claude}.stdin`, 'utf8')).toBe('Audit "this"; $(touch pwned) `id`');
    expect(readFileSync(`${claude}.env`, 'utf8')).toContain(
      `CLAUDE_CONFIG_DIR=${path.join(temp.dir, '.claude-work')}`,
    );
    expect(output.join('')).toContain('progress on stderr');
  });

  it('reports a Claude Code error result and a non-JSON answer as failures', async () => {
    fakeCli(
      bin,
      'claude',
      `printf '{"subtype":"error_during_execution","is_error":true}'`,
      CLAUDE_HELP,
    );
    expect(await runner().run(request().request)).toMatchObject({
      kind: 'failed',
      summary: 'Claude Code could not finish the audit (error_during_execution).',
    });
    fakeCli(bin, 'claude', 'echo oops; exit 3', CLAUDE_HELP);
    expect(await runner().run(request().request)).toMatchObject({
      kind: 'failed',
      summary: 'Claude Code exited with code 3.',
    });
  });

  it('runs Codex in its read-only sandbox and reads its last message and events', async () => {
    const codex = fakeCli(
      bin,
      'codex',
      `answer=''
while [ $# -gt 0 ]; do
  if [ "$1" = --output-last-message ]; then answer="$2"; fi
  shift
done
printf '%s\\n' '{"type":"item.started","item":{"type":"command_execution","command":"ls -la"}}'
printf '%s\\n' '{"type":"error","message":"reconnecting"}'
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":11,"output_tokens":5}}'
printf '%s' '${JSON.stringify(REPORT)}' > "$answer"`,
      CODEX_HELP,
    );
    const { request: input, log } = request({ provider: 'codex' });
    const outcome = await runner().run(input);
    expect(outcome).toMatchObject({
      kind: 'completed',
      metrics: { inputTokens: 11, outputTokens: 5, costUsd: null },
    });
    expect(JSON.parse((outcome as { answer: string }).answer)).toEqual(REPORT);
    const args = readFileSync(`${codex}.args`, 'utf8').trim().split('\n');
    expect(args.slice(0, 3)).toEqual(['exec', '--sandbox', 'read-only']);
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(args.at(-1)).toBe('-');
    // A recovered error event is logged; the exit and the answer decide the outcome.
    expect(log).toEqual(['Codex ran: ls -la', 'Codex reported an error event.']);
  });

  it('stops a CLI that runs past the time limit, or when cancelled', async () => {
    fakeCli(bin, 'claude', 'sleep 30', CLAUDE_HELP);
    expect(await runner().run(request({ timeoutMs: 300 }).request)).toEqual({ kind: 'timed-out' });
    const controller = new AbortController();
    const running = runner().run(request({ signal: controller.signal }).request);
    setTimeout(() => controller.abort(), 300);
    expect(await running).toEqual({ kind: 'cancelled' });
  });
});

describe.skipIf(!gitAvailable || !posix)('GitAuditWorkspace (SDD-026 FR-003, FR-008)', () => {
  let temp: ReturnType<typeof createTempDir>;
  let repo: string;
  let project: string;
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: repo,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: temp.dir,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 'T',
        GIT_AUTHOR_EMAIL: 't@example.com',
        GIT_COMMITTER_NAME: 'T',
        GIT_COMMITTER_EMAIL: 't@example.com',
      },
      encoding: 'utf8',
    });
  const workspace = () =>
    new GitAuditWorkspace(
      createGitExecutor({ env: { PATH: process.env.PATH ?? '', HOME: temp.dir } }),
    );

  beforeEach(() => {
    temp = createTempDir();
    repo = path.join(temp.dir, 'repo');
    // The project is a folder inside the repository.
    project = path.join(repo, 'app');
    mkdirSync(path.join(project, 'src'), { recursive: true });
    git('init', '-q', '-b', 'main');
    writeFileSync(path.join(project, 'src', 'app.ts'), 'const a = 1;\nquery(input);\n');
    writeFileSync(path.join(project, 'src', 'old.ts'), 'old\n');
    writeFileSync(path.join(project, '.gitignore'), 'dist/\n');
    mkdirSync(path.join(project, 'dist'));
    writeFileSync(path.join(project, 'dist', 'out.js'), 'x');
    writeFileSync(path.join(temp.dir, 'secret.txt'), 'secret');
    symlinkSync(path.join(temp.dir, 'secret.txt'), path.join(project, 'link.txt'));
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
  });
  afterEach(() => temp.cleanup());

  it('checks scope paths inside the project, following symbolic links', async () => {
    const files = workspace();
    expect(await files.scopePath(project, 'src/app.ts')).toBe('file');
    expect(await files.scopePath(project, 'src')).toBe('directory');
    expect(await files.scopePath(project, 'src/none.ts')).toBe('missing');
    expect(await files.scopePath(project, 'dist/out.js')).toBe('ignored');
    expect(await files.scopePath(project, '../../secret.txt')).toBe('outside-project');
    expect(await files.scopePath(project, 'link.txt')).toBe('outside-project');
  });

  it('lists changed files relative to the project, without deleted ones', async () => {
    writeFileSync(path.join(project, 'src', 'app.ts'), 'changed\n');
    writeFileSync(path.join(project, 'src', 'new.ts'), 'new\n');
    git('rm', '-q', 'app/src/old.ts');
    writeFileSync(path.join(repo, 'outside.ts'), 'x');
    expect((await workspace().changedFiles(project))?.sort()).toEqual(['src/app.ts', 'src/new.ts']);
    expect(await workspace().changedFiles(temp.dir)).toBeNull();
  });

  it('notices further edits of a file that was already changed', async () => {
    const files = workspace();
    writeFileSync(path.join(project, 'src', 'app.ts'), 'first edit\n');
    const before = await files.snapshot(project);
    writeFileSync(path.join(project, 'src', 'app.ts'), 'a longer second edit\n');
    const after = await files.snapshot(project);
    expect(before?.entries.get('src/app.ts')).not.toBe(after?.entries.get('src/app.ts'));
    expect(before?.head).toMatch(/^[0-9a-f]{40}$/);
  });

  it('inspects reported paths without reading outside the project', async () => {
    const inspector = workspace().inspector(project);
    expect(await inspector.inspect('src/app.ts')).toMatchObject({
      status: 'file',
      path: 'src/app.ts',
      lineCount: 2,
    });
    expect(await inspector.inspect(path.join(project, 'src', 'app.ts'))).toMatchObject({
      status: 'file',
      path: 'src/app.ts',
    });
    expect(await inspector.inspect('./src\\app.ts')).toMatchObject({ status: 'file' });
    expect(await inspector.inspect(path.join(temp.dir, 'secret.txt'))).toEqual({
      status: 'outside-project',
      path: '(outside the project)',
    });
    expect(await inspector.inspect('link.txt')).toMatchObject({ status: 'outside-project' });
    expect(await inspector.inspect('dist/out.js')).toMatchObject({ status: 'ignored' });
    expect(await inspector.inspect('src')).toMatchObject({ status: 'not-a-file' });
    expect(await inspector.inspect('src/gone.ts')).toEqual({
      status: 'missing',
      path: 'src/gone.ts',
    });
    writeFileSync(path.join(project, 'src', 'bin.dat'), Buffer.from([1, 0, 2]));
    expect(await inspector.inspect('src/bin.dat')).toMatchObject({ status: 'file', content: null });
  });
});

class MemoryAuditStore implements AuditStore {
  readonly audits = new Map<string, ProjectAudit>();
  readonly saved = new Map<string, AuditFinding[]>();
  async insert(audit: ProjectAudit) {
    this.audits.set(audit.id, { ...audit });
  }
  async update(audit: ProjectAudit) {
    this.audits.set(audit.id, { ...audit, jobId: this.audits.get(audit.id)?.jobId ?? null });
  }
  async setJob(auditId: string, jobId: string) {
    this.audits.set(auditId, { ...this.audits.get(auditId)!, jobId });
  }
  async complete(audit: ProjectAudit, findings: readonly AuditFinding[]) {
    await this.update(audit);
    this.saved.set(audit.id, [...findings]);
  }
  async get(auditId: string) {
    return this.audits.get(auditId) ?? null;
  }
  async listForProject() {
    return [...this.audits.values()];
  }
  async listActive() {
    return [...this.audits.values()].filter((audit) =>
      ['QUEUED', 'RUNNING'].includes(audit.status),
    );
  }
  async findings(auditId: string) {
    return this.saved.get(auditId) ?? [];
  }
}

/** The audit service behind a real job queue (SDD-012), as the Engine wires it. */
describe('AuditJobExecutor (SDD-026 FR-005)', () => {
  let temp: ReturnType<typeof createTempDir>;
  let db: Database;
  beforeEach(() => {
    temp = createTempDir();
    db = openDatabase({ filePath: ':memory:' });
    db.prepare(
      `INSERT INTO projects (id, name, workspace_path, path_key, tags, is_git_repository,
         created_at, updated_at) VALUES (?, 'Shop', ?, ?, '[]', 0, 'x', 'x')`,
    ).run(id(900), temp.dir, temp.dir);
  });
  afterEach(() => {
    db.close();
    temp.cleanup();
  });

  function setup(run: AuditProviderRunner['run']) {
    let next = 0;
    const store = new MemoryAuditStore();
    const values = new Map<string, string>();
    const executor = new AuditJobExecutor({
      audits: () => audits,
      logs: new FilePreflightLogStore(path.join(temp.dir, 'logs')),
      redact: (text) => text.replace(/sk-[a-z0-9]+/g, '[redacted]'),
      logger: noopLogger,
    });
    const jobs = new JobService({
      repository: new SqliteJobRepository(db),
      executors: [executor],
      settings: {
        get: async (key) => values.get(key) ?? null,
        set: async (key, value) => {
          values.set(key, value);
        },
      },
      clock: { now: () => new Date() },
      generateId: () => id(500 + ++next),
      logger: noopLogger,
    });
    const audits: ProjectAuditService = new ProjectAuditService({
      store,
      project: async () => ({
        id: id(900),
        name: 'Shop',
        workspacePath: temp.dir,
        available: true,
      }),
      workspace: {
        scopePath: async () => 'file',
        changedFiles: async () => null,
        snapshot: async () => null,
        inspector: () => ({ inspect: async (file) => ({ status: 'missing', path: file }) }),
      },
      runner: { availability: async () => ({ available: true, reason: null }), run },
      jobs: {
        submit: (auditId) =>
          jobs.create({ type: 'AGENT', kind: 'project-audit', auditId }, 'desktop'),
        cancel: async (jobId) => {
          await jobs.cancel(jobId);
        },
      },
      profiles: async () => [],
      clock: { now: () => new Date() },
      generateId: () => id(++next),
      logger: noopLogger,
    });
    const finished: BackgroundJob[] = [];
    jobs.subscribe((job) => {
      if (job.payload.type !== 'AGENT') return;
      if (['COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED'].includes(job.status)) {
        finished.push(job);
        void audits.jobFinished(job.payload.auditId, job.status as 'CANCELLED', job.errorSummary);
      }
    });
    const settled = async (count: number) => {
      for (let attempt = 0; attempt < 200 && finished.length < count; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    };
    return { audits, jobs, store, finished, settled };
  }

  const start = (
    scope: { kind: 'project' } | { kind: 'files'; paths: string[] } = { kind: 'project' },
  ) => ({
    projectId: id(900),
    provider: 'claude' as const,
    categories: ['security' as const],
    scope,
  });

  it('runs an accepted audit in the background with a redacted log', async () => {
    const { audits, jobs, finished, settled } = setup(async (request) => {
      request.output('token sk-abc123 used\n');
      return {
        kind: 'completed',
        answer: REPORT,
        metrics: { inputTokens: 1, outputTokens: 1, costUsd: null, durationMs: null },
      };
    });
    const audit = await audits.start(start());
    await settled(1);
    expect(finished[0]).toMatchObject({ status: 'COMPLETED', type: 'AGENT' });
    const details = await jobs.get(audit.jobId!);
    expect(details.job.executionReference).toEqual({ type: 'project-audit', auditId: audit.id });
    expect(details.job.capabilities).toMatchObject({ cancel: false, retry: false, logs: true });
    const output = await jobs.output({ jobId: audit.jobId!, after: -1 });
    const text = output.lines.map((line) => line.text).join('\n');
    expect(text).toContain('[redacted]');
    expect(text).not.toContain('sk-abc123');
    const stored = await audits.get(audit.id);
    expect(stored.audit.status).toBe('COMPLETED');
    // The evidence file does not exist: the finding is kept but invalid.
    expect(stored.findings[0]?.validation).toBe('invalid');
    // A job cannot be created twice for the same audit.
    await expect(
      jobs.create({ type: 'AGENT', kind: 'project-audit', auditId: audit.id }, 'desktop'),
    ).rejects.toMatchObject({ code: 'JOB_TRANSITION_INVALID' });
  });

  it('cancels a running audit and a queued one', async () => {
    const { audits, settled } = setup(
      (request) =>
        new Promise((resolve) =>
          request.signal.addEventListener('abort', () => resolve({ kind: 'cancelled' })),
        ),
    );
    const running = await audits.start(start());
    // One job per project at a time: the second audit waits in the queue.
    const queued = await audits.start(start({ kind: 'files', paths: ['a.ts'] }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await audits.get(running.id)).audit.status).toBe('RUNNING');
    expect((await audits.get(queued.id)).audit.status).toBe('QUEUED');
    await audits.cancel(queued.id);
    await audits.cancel(running.id);
    await settled(2);
    expect((await audits.get(queued.id)).audit.status).toBe('CANCELLED');
    expect((await audits.get(running.id)).audit.status).toBe('CANCELLED');
  });
});

describe('Engine without process ownership (terminal-only, no AI)', () => {
  let temp: ReturnType<typeof createTempDir>;
  afterEach(() => temp.cleanup());

  it('offers audits as unavailable instead of failing', async () => {
    temp = createTempDir();
    const project = path.join(temp.dir, 'project');
    mkdirSync(project);
    const engine = createEngine({
      dataDir: path.join(temp.dir, 'data'),
      env: { PATH: '', HOME: temp.dir },
      component: 'test',
    });
    try {
      const created = await engine.createProject({ name: 'P', workspacePath: project });
      const options = await engine.audits.options(created.id);
      expect(options.providers.every((item) => !item.available)).toBe(true);
      expect(options.git.repository).toBe(false);
      await expect(
        engine.audits.start({
          projectId: created.id,
          provider: 'claude',
          categories: ['security'],
          scope: { kind: 'project' },
        }),
      ).rejects.toMatchObject({ code: 'AUDIT_PROVIDER_UNAVAILABLE' });
      expect(await engine.audits.list(created.id)).toEqual([]);
    } finally {
      await engine.shutdown();
    }
  });
});
