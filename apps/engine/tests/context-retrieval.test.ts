import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ContextTarget } from '@atlas/contracts';
import { SqliteContextRepository, openDatabase } from '@atlas/persistence';
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

describe.skipIf(!gitAvailable)('Context retrieval (SDD-006 Milestone A)', () => {
  let temp: ReturnType<typeof createTempDir>;
  let dataDir: string;
  let engine: Engine;
  const env = () => ({
    ...process.env,
    HOME: path.join(temp.dir, 'home'),
    XDG_CONFIG_HOME: path.join(temp.dir, 'home'),
    GIT_CONFIG_NOSYSTEM: '1',
  });
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, env: env(), encoding: 'utf8' }).trim();

  const open = async () => {
    engine = createEngine({
      dataDir,
      component: 'test',
      env: env(),
      terminals: {
        spawner: new FakePtySpawner(),
        mirrors: new FakeMirrorFactory(),
        shells: new FakeShellProvider(),
      },
    });
    await engine.initialize();
  };

  const project = async (name: string) => {
    const dir = path.join(temp.dir, name);
    mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.name', 'Ana');
    git(dir, 'config', 'user.email', 'ana@example.com');
    writeFileSync(path.join(dir, 'auth.ts'), 'export const auth = 1;\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'chore: init');
    const created = await engine.projects.create({ name, workspacePath: dir });
    const target: ContextTarget = { projectId: created.id };
    return { dir, target, resolved: await engine.resolveContextTarget(target) };
  };

  const note = (
    p: Awaited<ReturnType<typeof project>>,
    category: 'note' | 'architecture' | 'progress' | 'summary' | 'constraint' | 'next-action',
    title: string,
    extra: { body?: string; files?: string[]; required?: boolean; taskId?: string } = {},
  ) =>
    engine.context.record(
      p.resolved,
      {
        target: p.target,
        scope: extra.taskId ? 'task' : 'project',
        category,
        title,
        body: extra.body ?? '',
        ...(extra.files ? { files: extra.files } : {}),
        ...(extra.required ? { required: true } : {}),
        ...(extra.taskId ? { taskId: extra.taskId } : {}),
      },
      'desktop',
    );

  beforeEach(async () => {
    temp = createTempDir();
    mkdirSync(path.join(temp.dir, 'home'));
    dataDir = path.join(temp.dir, 'data');
    await open();
  });
  afterEach(async () => {
    await engine.shutdown();
    temp.cleanup();
  });

  it('retrieves by objective with full-text ranking, without crossing projects', async () => {
    const api = await project('api');
    const web = await project('web');
    await note(api, 'note', 'Refresh tokens rotate on every login', { body: 'JWT rotation' });
    await note(api, 'summary', 'Styled the settings page');
    await note(web, 'note', 'Refresh tokens in the web client', { body: 'JWT' });

    const bundle = await engine.context.bundle(api.resolved, {
      provider: 'claude',
      objective: 'Rotate JWT refresh tokens',
    });
    expect(bundle.included.map((ref) => ref.title)).toEqual([
      'Refresh tokens rotate on every login',
    ]);
    const factors = bundle.included[0]!.factors.map((factor) => factor.name);
    expect(factors).toEqual(expect.arrayContaining(['text', 'search-rank']));
    expect(bundle.excluded.map((item) => [item.reference.title, item.reason])).toEqual([
      ['Styled the settings page', 'not-relevant'],
    ]);
    expect(bundle.markdown).not.toContain('web client');
    expect(bundle.budgetSource).toBe('default');
    expect(bundle.budgetTokens).toBe(6000);
  });

  it('caches stored records, invalidates on writes from any connection, and checks Git every time', async () => {
    const api = await project('api');
    await note(api, 'architecture', 'Auth module', { files: ['auth.ts'] });
    const request = { provider: 'generic' as const };

    expect((await engine.context.bundle(api.resolved, request)).cache).toBe('miss');
    expect((await engine.context.bundle(api.resolved, request)).cache).toBe('hit');

    // Repository changes are seen even when the stored records come from the cache.
    writeFileSync(path.join(api.dir, 'auth.ts'), 'export const auth = 2;\n');
    const changed = await engine.context.bundle(api.resolved, request);
    expect(changed.cache).toBe('hit');
    expect(changed.included[0]?.stale).toBe(true);

    // A write through the Engine invalidates…
    await note(api, 'note', 'New note');
    const afterWrite = await engine.context.bundle(api.resolved, request);
    expect(afterWrite.cache).toBe('miss');
    expect(afterWrite.included.map((ref) => ref.title)).toContain('New note');

    // …and so does a write by another process (e.g. the CLI) on the same database.
    const other = openDatabase({ filePath: path.join(dataDir, 'atlas.db') });
    try {
      const entry = (
        await new SqliteContextRepository(other).listEntries({
          owner: api.resolved.owner,
        })
      )[0]!;
      await new SqliteContextRepository(other).updateEntry(
        { ...entry, title: 'Renamed elsewhere', revision: entry.revision + 1 },
        {
          entryId: entry.id,
          revision: entry.revision + 1,
          title: 'Renamed elsewhere',
          body: entry.body,
          category: entry.category,
          verification: entry.verification,
          status: entry.status,
          changedAt: new Date().toISOString(),
          changedBy: 'cli',
          reason: null,
        },
      );
    } finally {
      other.close();
    }
    const external = await engine.context.bundle(api.resolved, request);
    expect(external.cache).toBe('miss');
    expect(external.included.map((ref) => ref.title)).toContain('Renamed elsewhere');

    // Another project never gets a cached bundle of this one.
    const web = await project('web');
    const isolated = await engine.context.bundle(web.resolved, request);
    expect(isolated.included).toEqual([]);
  });

  it('resolves budgets from settings and task overrides and keeps them across restarts', async () => {
    const api = await project('api');
    await engine.context.budgets.update({ providers: { claude: 2000 }, roles: { qa: 4000 } });
    expect(await engine.context.bundle(api.resolved, { provider: 'claude' })).toMatchObject({
      budgetTokens: 2000,
      budgetSource: 'provider',
    });
    expect(
      await engine.context.bundle(api.resolved, { provider: 'claude', agentRole: 'qa' }),
    ).toMatchObject({ budgetTokens: 4000, budgetSource: 'role' });

    const task = await engine.context.createTask(api.resolved, {
      title: 'JWT',
      objective: 'Implement JWT',
    });
    expect(task.baseBranch).toBe('main');
    const updated = await engine.context.updateTask(api.resolved, task.id, { budgetTokens: 1000 });
    expect(updated.budgetTokens).toBe(1000);
    expect(
      await engine.context.bundle(api.resolved, { provider: 'claude', taskId: task.id }),
    ).toMatchObject({ budgetTokens: 1000, budgetSource: 'task' });

    await engine.shutdown();
    await open();
    const resolved = await engine.resolveContextTarget(api.target);
    expect((await engine.context.listTasks(resolved))[0]?.budgetTokens).toBe(1000);
    expect((await engine.context.budgets.get()).providers).toEqual({ claude: 2000 });
  });

  it('keeps required entries in every bundle and records them as required', async () => {
    const api = await project('api');
    const rule = await note(api, 'constraint', 'Never edit generated files', { required: true });
    expect(rule.required).toBe(true);
    const bundle = await engine.context.bundle(api.resolved, {
      provider: 'generic',
      budgetTokens: 500,
      excludeIds: [rule.id],
      detail: 'essential',
    });
    expect(bundle.included.map((ref) => ref.id)).toEqual([rule.id]);
    const relaxed = await engine.context.update(
      api.resolved,
      rule.id,
      { required: false },
      'desktop',
    );
    expect(relaxed).toMatchObject({ required: false, revision: 2 });
    expect((await engine.context.history(api.resolved, rule.id))[0]?.reason).toBe(
      'No longer always included',
    );
  });

  it('reports context health and records reconciliations', async () => {
    const api = await project('api');
    await note(api, 'architecture', 'Auth module', { files: ['auth.ts'] });
    await note(api, 'note', 'Use pnpm workspaces');
    await note(api, 'note', 'use PNPM workspaces');
    await note(api, 'progress', 'Login works');
    const task = await engine.context.createTask(api.resolved, {
      title: 'JWT',
      objective: 'Implement JWT',
    });
    await note(api, 'next-action', 'Write tests', { taskId: task.id });
    await engine.context.updateTask(api.resolved, task.id, { status: 'done' });
    for (const answer of ['cookie', 'localStorage']) {
      await engine.context.createDecision(
        api.resolved,
        {
          question: 'Token storage',
          decision: answer,
          alternatives: [],
          reasoning: '',
          evidence: [],
          affected: [],
        },
        'desktop',
      );
    }
    git(api.dir, 'rm', '-q', 'auth.ts');

    const report = await engine.context.health(api.resolved);
    expect(report.totals).toMatchObject({ activeEntries: 5, activeDecisions: 2, tasks: 1 });
    expect(report.stale.map((item) => item.reason)).toEqual([
      '"Auth module" refers to auth.ts, which no longer exists',
    ]);
    expect(report.duplicates).toHaveLength(1);
    expect(report.conflicts.map((item) => item.reason)).toEqual([
      '2 active decisions answer "Token storage" differently',
    ]);
    expect(report.pendingOfClosedTasks.map((item) => item.title)).toEqual(['Write tests']);
    expect(report.missingSources.map((item) => item.title)).toEqual(['Login works']);
    expect(report.estimatedRelevantTokens).toBeGreaterThan(0);
    expect(report.lastReconciliation).toBeNull();

    const reconciled = await engine.context.reconcile(api.resolved);
    expect(reconciled.lastReconciliation).toMatchObject({ stale: 1, conflicts: 1, duplicates: 1 });
    await engine.shutdown();
    await open();
    const again = await engine.context.health(await engine.resolveContextTarget(api.target));
    expect(again.lastReconciliation?.id).toBe(reconciled.lastReconciliation?.id);
  });

  it('starts an AI session with exactly the previewed selection', async () => {
    const api = await project('api');
    const keep = await note(api, 'architecture', 'Hexagonal layers');
    const drop = await note(api, 'architecture', 'Private experiment');
    const selection = {
      objective: 'Add refresh tokens',
      agentRole: 'developer' as const,
      excludeIds: [drop.id],
    };
    const preview = await engine.context.bundle(api.resolved, {
      provider: 'claude',
      ...selection,
    });
    const started = await engine.startAiSession({
      provider: 'claude',
      target: api.target,
      includeContext: true,
      ...selection,
    });
    expect(started.prompt).toContain(preview.markdown);
    expect(started.prompt).toContain('Hexagonal layers');
    expect(started.prompt).not.toContain('Private experiment');
    expect(started.prompt).toContain('Add refresh tokens');
    expect(keep.id).not.toBe(drop.id);
  });
});
