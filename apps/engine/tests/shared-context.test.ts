import { execFileSync } from 'node:child_process';
import { readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ContextTarget } from '@atlas/contracts';
import { AtlasError } from '@atlas/shared';
import {
  FakeMirrorFactory,
  FakePtySpawner,
  FakeShellProvider,
} from '../../../tests/support/fake-terminal.js';
import { createTempDir } from '../../../tests/support/temp.js';
import { createEngine, type Engine } from '../src/index.js';

const gitAvailable = (() => {
  try {
    execFileSync('git', ['--version']);
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!gitAvailable)('Shared context (SDD-005 Milestone A)', () => {
  let temp: ReturnType<typeof createTempDir>;
  let dataDir: string;
  let engine: Engine;
  let spawner: FakePtySpawner;
  const env = () => ({
    ...process.env,
    HOME: path.join(temp.dir, 'home'),
    XDG_CONFIG_HOME: path.join(temp.dir, 'home'),
    GIT_CONFIG_NOSYSTEM: '1',
  });
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, env: env(), encoding: 'utf8' }).trim();

  const repository = (name: string) => {
    const dir = path.join(temp.dir, name);
    mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.name', 'Ana');
    git(dir, 'config', 'user.email', 'ana@example.com');
    writeFileSync(path.join(dir, 'auth.ts'), 'export const auth = 1;\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'chore: init');
    return dir;
  };

  const open = async () => {
    spawner = new FakePtySpawner();
    engine = createEngine({
      dataDir,
      component: 'test',
      env: env(),
      terminals: { spawner, mirrors: new FakeMirrorFactory(), shells: new FakeShellProvider() },
    });
    await engine.initialize();
    return engine;
  };

  const project = async (name: string) => {
    const dir = repository(name);
    const created = await engine.projects.create({ name, workspacePath: dir });
    return { dir, target: { projectId: created.id } as ContextTarget, id: created.id };
  };

  beforeEach(async () => {
    temp = createTempDir();
    mkdirSync(path.join(temp.dir, 'home'));
    // An apostrophe in the data directory exercises the shell quoting of the prompt path.
    dataDir = path.join(temp.dir, "data o'neil");
    await open();
  });
  afterEach(async () => {
    await engine.shutdown();
    temp.cleanup();
  });

  it('keeps projects isolated and shares global entries only explicitly', async () => {
    const a = await project('api');
    const b = await project('web');
    const ctx = engine.context;
    const ta = await engine.resolveContextTarget(a.target);
    const tb = await engine.resolveContextTarget(b.target);
    const note = await ctx.record(
      ta,
      {
        target: a.target,
        scope: 'project',
        category: 'architecture',
        title: 'Hexagonal',
        body: 'Ports in core',
      },
      'desktop',
    );
    await ctx.record(
      null,
      { target: null, scope: 'global', category: 'convention', title: 'Use pnpm', body: '' },
      'desktop',
    );

    expect((await ctx.list(ta, {})).map((entry) => entry.title)).toEqual(['Hexagonal']);
    expect(await ctx.list(tb, {})).toEqual([]);
    expect((await ctx.list(tb, { includeGlobal: true })).map((entry) => entry.title)).toEqual([
      'Use pnpm',
    ]);
    // Records of another project cannot be read or changed through it.
    await expect(ctx.update(tb, note.id, { title: 'x' }, 'desktop')).rejects.toThrow(AtlasError);
    await expect(ctx.history(tb, note.id)).rejects.toThrow(AtlasError);
    await expect(
      ctx.record(
        ta,
        { target: a.target, scope: 'global', category: 'note', title: 'x', body: '' },
        'desktop',
      ),
    ).rejects.toThrow(AtlasError);
  });

  it('searches, revises, marks obsolete and removes entries, redacting secrets', async () => {
    const { target } = await project('search');
    const ctx = engine.context;
    const resolved = await engine.resolveContextTarget(target);
    const entry = await ctx.record(
      resolved,
      {
        target,
        scope: 'project',
        category: 'command',
        title: 'Deploy',
        body: 'Run deploy with GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123',
      },
      'desktop',
    );
    expect(entry.body).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123');
    expect(entry.verification).toBe('user');
    expect((await ctx.list(resolved, { search: 'depl' })).map((item) => item.id)).toEqual([
      entry.id,
    ]);
    expect(await ctx.list(resolved, { search: '"OR*' })).toEqual([]);

    const updated = await ctx.update(
      resolved,
      entry.id,
      { body: 'pnpm deploy', reason: 'outdated' },
      'cli',
    );
    expect(updated.revision).toBe(2);
    const history = await ctx.history(resolved, entry.id);
    expect(
      history.map((revision) => [revision.revision, revision.changedBy, revision.reason]),
    ).toEqual([
      [2, 'cli', 'outdated'],
      [1, 'desktop', null],
    ]);

    await ctx.update(resolved, entry.id, { status: 'obsolete' }, 'desktop');
    expect(await ctx.list(resolved, {})).toEqual([]);
    expect(await ctx.list(resolved, { includeObsolete: true })).toHaveLength(1);
    await ctx.remove(resolved, entry.id);
    expect(await ctx.list(resolved, { includeObsolete: true })).toEqual([]);
  });

  it('flags stale references and produces a fresh bundle within the budget', async () => {
    const { dir, target } = await project('fresh');
    const ctx = engine.context;
    const resolved = await engine.resolveContextTarget(target);
    const task = await ctx.createTask(resolved, {
      title: 'JWT',
      objective: 'Implement JWT authentication',
    });
    await ctx.record(
      resolved,
      {
        target,
        scope: 'task',
        taskId: task.id,
        category: 'progress',
        title: 'Login done',
        body: '',
        files: ['auth.ts'],
      },
      'desktop',
    );
    await ctx.createDecision(
      resolved,
      {
        question: 'Token storage',
        decision: 'httpOnly cookie',
        alternatives: [],
        reasoning: '',
        evidence: [],
        affected: [],
      },
      'desktop',
    );

    let bundle = await ctx.bundle(resolved, {
      taskId: task.id,
      provider: 'codex',
      budgetTokens: 4000,
    });
    expect(bundle.freshness.stale).toEqual([]);
    expect(bundle.markdown).toContain('Implement JWT authentication');
    expect(bundle.markdown).toContain('Token storage → httpOnly cookie');
    expect(bundle.freshness.branch).toBe('main');

    writeFileSync(path.join(dir, 'auth.ts'), 'export const auth = 2;\n');
    bundle = await ctx.bundle(resolved, { taskId: task.id, provider: 'codex', budgetTokens: 4000 });
    expect(bundle.freshness.stale[0]?.reason).toContain('auth.ts, which changed');
    expect(bundle.markdown).toContain('[by user, STALE] Login done');

    // A rewritten history leaves the task's base commit off the current branch.
    git(dir, 'checkout', '-q', '--orphan', 'other');
    git(dir, 'commit', '-qam', 'chore: rewrite');
    bundle = await ctx.bundle(resolved, { taskId: task.id, provider: 'codex', budgetTokens: 4000 });
    expect(
      bundle.freshness.stale.some((item) => item.reason.includes('not on the current branch')),
    ).toBe(true);
  });

  it('builds handoffs with Git evidence and supersedes decisions without erasing them', async () => {
    const { dir, target } = await project('handoff');
    const ctx = engine.context;
    const resolved = await engine.resolveContextTarget(target);
    const task = await ctx.createTask(resolved, {
      title: 'JWT',
      objective: 'Implement JWT authentication',
    });
    const first = await ctx.createDecision(
      resolved,
      {
        taskId: task.id,
        question: 'Storage',
        decision: 'localStorage',
        alternatives: [],
        reasoning: '',
        evidence: [],
        affected: [],
      },
      'desktop',
    );
    const second = await ctx.createDecision(
      resolved,
      {
        taskId: task.id,
        question: 'Storage',
        decision: 'httpOnly cookie',
        alternatives: ['localStorage'],
        reasoning: 'XSS',
        evidence: [],
        affected: [],
        supersedes: first.id,
      },
      'desktop',
    );
    const decisions = await ctx.listDecisions(resolved);
    expect(decisions.find((item) => item.id === first.id)).toMatchObject({
      status: 'SUPERSEDED',
      supersededBy: second.id,
    });

    writeFileSync(path.join(dir, 'login.ts'), 'export {};\n');
    git(dir, 'add', 'login.ts');
    git(dir, 'commit', '-qm', 'feat(auth): login');
    writeFileSync(path.join(dir, 'refresh.ts'), 'export {};\n');

    const draft = await ctx.prepareHandoff(resolved, { taskId: task.id });
    expect(draft.objective).toBe('Implement JWT authentication');
    expect(draft.commits.map((commit) => commit.slice(13))).toEqual(['feat(auth): login']);
    expect(draft.changedFiles).toEqual(['login.ts', 'refresh.ts']);
    expect(draft.decisions).toEqual(['Storage → httpOnly cookie']);

    const handoff = await ctx.createHandoff(resolved, {
      taskId: task.id,
      targetProvider: 'codex',
      objective: draft.objective,
      completedWork: ['Login endpoint'],
      pendingWork: ['Refresh tokens'],
      blockers: [],
      nextActions: ['Integration tests'],
    });
    expect(handoff.validations).toEqual([]);
    expect(handoff.sourceRevision).toBe(git(dir, 'rev-parse', 'HEAD'));
    expect(await ctx.getHandoff(resolved, handoff.id)).toEqual(handoff);
    const markdown = ctx.renderHandoff(resolved, handoff);
    expect(markdown).toContain('Prepared for Codex CLI');
    expect(markdown).toContain('feat(auth): login');
  });

  it('starts a managed AI session in a terminal and records a summary with verified evidence', async () => {
    const { dir, target, id } = await project("o'reilly");
    const resolved = await engine.resolveContextTarget(target);
    const task = await engine.context.createTask(resolved, {
      title: 'JWT',
      objective: 'Implement JWT',
    });
    const handoff = await engine.context.createHandoff(resolved, {
      taskId: task.id,
      targetProvider: 'claude',
      objective: 'Implement JWT',
      completedWork: [],
      pendingWork: ['Refresh tokens'],
      blockers: [],
      nextActions: [],
    });

    const started = await engine.startAiSession({
      provider: 'claude',
      target,
      taskId: task.id,
      handoffId: handoff.id,
      includeContext: true,
    });
    expect(started.session).toMatchObject({
      provider: 'claude',
      captureMode: 'managed',
      status: 'active',
      projectId: id,
    });
    expect(started.prompt).toContain('ATLAS handoff');
    const terminal = engine.terminals!.getById(started.terminalId);
    expect(terminal.projectId).toBe(id);
    // Only the private prompt file's path reaches the shell, quoted.
    const command = spawner.last().written.join('');
    const file = path.join(dataDir, 'context', 'prompts', `${started.session.id}.md`);
    expect(command).toBe(`claude "$(cat '${file.replace(/'/g, "'\\''")}')"\r`);
    // The quoted path is read back literally by a POSIX shell.
    const quoted = command.slice('claude "$(cat '.length, -')"\r'.length);
    expect(execFileSync('/bin/sh', ['-c', `printf %s ${quoted}`], { encoding: 'utf8' })).toBe(file);
    expect(readFileSync(file, 'utf8')).toBe(started.prompt);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(await engine.context.sessionForTerminal(started.terminalId)).toMatchObject({
      id: started.session.id,
    });

    // Work happens in the terminal…
    writeFileSync(path.join(dir, 'refresh.ts'), 'export {};\n');
    git(dir, 'add', 'refresh.ts');
    git(dir, 'commit', '-qm', 'feat(auth): refresh tokens');

    const evidence = await engine.context.sessionEvidence(resolved, started.session.id);
    expect(evidence.commits.map((commit) => commit.subject)).toEqual([
      'feat(auth): refresh tokens',
    ]);
    const { session, entries } = await engine.context.endSession(
      resolved,
      started.session.id,
      {
        summary: 'Added refresh tokens',
        completed: ['Refresh tokens'],
        pending: ['Rotate keys'],
        decisions: [],
        nextActions: [],
      },
      'desktop',
    );
    expect(session.status).toBe('ended');
    const byCategory = Object.fromEntries(entries.map((entry) => [entry.category, entry]));
    expect(byCategory.summary).toMatchObject({ verification: 'user', taskId: task.id });
    expect(byCategory.commit).toMatchObject({ verification: 'verified' });
    expect(byCategory.commit?.body).toContain('feat(auth): refresh tokens');
    expect(byCategory['files-changed']).toMatchObject({ verification: 'verified' });
    expect(byCategory['next-action']?.title).toBe('Rotate keys');
    await expect(
      engine.context.endSession(
        resolved,
        started.session.id,
        { summary: '', completed: [], pending: [], decisions: [], nextActions: [] },
        'desktop',
      ),
    ).rejects.toThrow(AtlasError);
  });

  it('keeps context across restarts and after the project is removed', async () => {
    const { dir, target, id } = await project('persist');
    const resolved = await engine.resolveContextTarget(target);
    await engine.context.record(
      resolved,
      { target, scope: 'project', category: 'overview', title: 'Payments API', body: '' },
      'desktop',
    );
    await engine.shutdown();
    await open();
    const reopened = await engine.resolveContextTarget(target);
    expect((await engine.context.list(reopened, {})).map((entry) => entry.title)).toEqual([
      'Payments API',
    ]);

    await engine.removeProject(id);
    await expect(engine.resolveContextTarget(target)).rejects.toThrow(AtlasError);
    // A terminal in the directory makes the repository reachable; the context moved there.
    await engine.terminals!.create({ cwd: dir });
    const workspace = await engine.resolveContextTarget({ workspacePath: dir });
    expect((await engine.context.list(workspace, {})).map((entry) => entry.title)).toEqual([
      'Payments API',
    ]);
  });
});
