import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

describe.skipIf(!gitAvailable)('Automatic LLM sessions (PLAN-021)', () => {
  let temp: ReturnType<typeof createTempDir>;
  let dataDir: string;
  let dir: string;
  let engine: Engine;
  let projectId: string;
  const env = () => ({
    ...process.env,
    HOME: path.join(temp.dir, 'home'),
    XDG_CONFIG_HOME: path.join(temp.dir, 'home'),
    GIT_CONFIG_NOSYSTEM: '1',
  });
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, env: env(), encoding: 'utf8' }).trim();
  let runs = 0;
  /** Writes an event as the wrapper does. */
  const event = (kind: 'start' | 'end', run: string, terminalId: string, project = projectId) => {
    const events = path.join(dataDir, 'context', 'events');
    writeFileSync(
      path.join(events, `${run}.${kind}.json`),
      JSON.stringify({
        event: kind,
        provider: 'claude',
        run,
        terminalId,
        projectId: project,
        exitCode: kind === 'end' ? 0 : null,
      }),
    );
  };
  const newRun = () => `20261021T1200${String((runs += 1)).padStart(2, '0')}-${1000 + runs}`;
  const checkpoint = (run: string, text: string) => {
    const file = path.join(dataDir, 'projects', projectId, 'checkpoints', `${run}.md`);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  };

  beforeEach(async () => {
    temp = createTempDir();
    mkdirSync(path.join(temp.dir, 'home'));
    dataDir = path.join(temp.dir, 'data');
    dir = path.join(temp.dir, 'backoffice');
    mkdirSync(dir);
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Ana');
    git('config', 'user.email', 'ana@example.com');
    writeFileSync(path.join(dir, 'a.ts'), 'export {};\n');
    git('add', '.');
    git('commit', '-qm', 'chore: init');
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
    projectId = (await engine.projects.create({ name: 'Backoffice', workspacePath: dir })).id;
    await engine.setProjectConfig(projectId, { keepContext: true });
  });
  afterEach(async () => {
    await engine.shutdown();
    temp.cleanup();
  });

  const target = () => engine.resolveContextTarget({ projectId });
  const processEvents = async () => {
    engine.llmSessions.schedule();
    await engine.llmSessions.idle();
  };

  it('records a session, its checkpoints and what Git shows changed, without the user', async () => {
    const terminal = await engine.terminals!.create({ projectId });
    const run = newRun();
    event('start', run, terminal.id);
    await processEvents();
    const [session] = await engine.context.listSessions(await target());
    expect(session).toMatchObject({
      provider: 'claude',
      status: 'active',
      terminalId: terminal.id,
    });

    // The LLM keeps its checkpoint; ATLAS imports each version.
    checkpoint(run, '## Objective\nAdd login\n\n## Done\n- form\n\n## Next steps\n- tests\n');
    await vi.waitFor(
      async () =>
        expect(
          (await engine.context.list(await target(), { category: 'checkpoint' }))[0]?.title,
        ).toBe('Work in progress (claude): Add login'),
      { timeout: 8000 },
    );
    writeFileSync(path.join(dir, 'login.ts'), 'export const login = 1;\n');
    git('add', 'login.ts');
    git('commit', '-qm', 'feat: login form');
    checkpoint(
      run,
      '## Objective\nAdd login\n\n## Done\n- form\n- tests\n\n## Next steps\n- docs\n',
    );

    event('end', run, terminal.id);
    await processEvents();
    const after = await engine.context.listSessions(await target());
    expect(after[0]?.status).toBe('ended');
    const entries = await engine.context.list(await target(), {});
    const checkpointEntry = entries.find((entry) => entry.category === 'checkpoint')!;
    expect(checkpointEntry).toMatchObject({ verification: 'observed', revision: 2 });
    expect(checkpointEntry.body).toContain('- docs');
    expect(entries.find((entry) => entry.category === 'commit')).toMatchObject({
      verification: 'verified',
    });
    expect(entries.find((entry) => entry.category === 'commit')?.body).toContain(
      'feat: login form',
    );
    expect(entries.find((entry) => entry.category === 'summary')?.title).toContain(
      'Automatic record of claude session',
    );

    // The next LLM gets the work in progress at the top of the context file.
    await vi.waitFor(() => {
      const context = readFileSync(path.join(dataDir, 'projects', projectId, 'context.md'), 'utf8');
      expect(context).toContain('Work in progress (claude): Add login');
      expect(context).toContain('## Next steps');
      expect(context.indexOf('Work in progress')).toBeLessThan(context.indexOf('Automatic record'));
    });
  });

  it('ends without a record when nothing changed, and when the terminal closes', async () => {
    const quiet = await engine.terminals!.create({ projectId });
    const run = newRun();
    event('start', run, quiet.id);
    await processEvents();
    event('end', run, quiet.id);
    await processEvents();
    expect((await engine.context.listSessions(await target()))[0]?.status).toBe('ended');
    expect(await engine.context.list(await target(), {})).toEqual([]);

    // Tokens ran out or the window was closed: no end event; the terminal exits.
    const closed = await engine.terminals!.create({ projectId });
    const second = newRun();
    event('start', second, closed.id);
    await processEvents();
    checkpoint(second, '## Objective\nRefactor auth\n\n## In progress\n- session store\n');
    writeFileSync(path.join(dir, 'auth.ts'), 'export {};\n');
    await engine.terminals!.terminate(closed.id);
    await vi.waitFor(async () => {
      await engine.llmSessions.idle();
      const sessions = await engine.context.listSessions(await target());
      expect(sessions.every((session) => session.status === 'ended')).toBe(true);
    });
    const entries = await engine.context.list(await target(), {});
    expect(entries.map((entry) => entry.category).sort()).toEqual([
      'checkpoint',
      'files-changed',
      'summary',
    ]);
  });

  it('tracks nothing for projects that do not keep context, or for invalid events', async () => {
    await engine.setProjectConfig(projectId, { keepContext: false });
    const terminal = await engine.terminals!.create({ projectId });
    event('start', newRun(), terminal.id);
    writeFileSync(path.join(dataDir, 'context', 'events', 'bad.start.json'), '{"event":"start"}');
    await processEvents();
    expect(await engine.context.listSessions(await target())).toEqual([]);
  });
});
