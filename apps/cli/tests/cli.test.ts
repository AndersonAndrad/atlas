import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectDetails, TerminalSession } from '@atlas/contracts';
import { startEngineHost, type EngineHost } from '@atlas/engine';
import {
  FakeMirrorFactory,
  FakePtySpawner,
  FakeShellProvider,
} from '../../../tests/support/fake-terminal.js';
import { createTempDir } from '../../../tests/support/temp.js';
import { runCli, type CliIo } from '../src/program.js';

interface Captured {
  io: CliIo;
  out: () => string;
  err: () => string;
}

function capture(cwd: string, confirmAnswer = false, isInteractive = false): Captured {
  let out = '';
  let err = '';
  return {
    io: {
      stdout: (text) => (out += text),
      stderr: (text) => (err += text),
      cwd,
      isInteractive,
      confirm: async () => confirmAnswer,
    },
    out: () => out,
    err: () => err,
  };
}

describe('atlas CLI', () => {
  let temp: ReturnType<typeof createTempDir>;
  let dataDir: string;
  let workspace: string;

  const run = async (args: string[], c = capture(temp.dir)) => {
    const code = await runCli(args, c.io, { dataDir });
    return { code, out: c.out(), err: c.err() };
  };

  beforeEach(() => {
    temp = createTempDir();
    dataDir = path.join(temp.dir, 'data');
    workspace = path.join(temp.dir, 'my-app');
    mkdirSync(path.join(workspace, '.git'), { recursive: true });
    writeFileSync(path.join(workspace, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  });
  afterEach(() => temp.cleanup());

  it('lists an empty registry', async () => {
    const result = await run(['project', 'list']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('No projects registered');
  });

  it('adds a project from a relative path using the directory name', async () => {
    const result = await run(['project', 'add', 'my-app', '--json', '-t', 'web']);
    expect(result.code).toBe(0);
    const details = JSON.parse(result.out) as ProjectDetails;
    expect(details.project).toMatchObject({
      name: 'my-app',
      workspacePath: workspace,
      tags: ['web'],
      git: { isRepository: true, repositoryRoot: workspace },
    });
    expect(details.git.branch).toBe('main');
  });

  it('lists and shows registered projects', async () => {
    const added = JSON.parse(
      (await run(['project', 'add', workspace, '--name', 'App', '--json'])).out,
    ) as ProjectDetails;
    const list = await run(['project', 'list']);
    expect(list.out).toContain(added.project.id);
    expect(list.out).toContain('App');
    expect(list.out).toContain('yes (main)');

    const show = await run(['project', 'show', added.project.id]);
    expect(show.code).toBe(0);
    expect(show.out).toContain(`Path         ${workspace}`);
  });

  it('rejects duplicates with a user-friendly message', async () => {
    await run(['project', 'add', workspace]);
    const result = await run(['project', 'add', `${workspace}/`]);
    expect(result.code).toBe(1);
    expect(result.err).toContain('already registered');
  });

  it('rejects unavailable directories without leaking internals', async () => {
    const result = await run(['project', 'add', 'missing-dir']);
    expect(result.code).toBe(1);
    expect(result.err).toBe('Error: The selected directory does not exist or is not reachable.\n');
  });

  it('reports unknown ids', async () => {
    const result = await run(['project', 'show', 'does-not-exist']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('could not be found');
  });

  it('requires --yes for non-interactive removal and never deletes files', async () => {
    const added = JSON.parse(
      (await run(['project', 'add', workspace, '--json'])).out,
    ) as ProjectDetails;

    const refused = await run(['project', 'remove', added.project.id]);
    expect(refused.code).toBe(2);
    expect(JSON.parse((await run(['project', 'list', '--json'])).out)).toHaveLength(1);

    const removed = await run(['project', 'remove', added.project.id, '--yes']);
    expect(removed.code).toBe(0);
    expect(JSON.parse((await run(['project', 'list', '--json'])).out)).toEqual([]);
    expect(readdirSync(workspace)).toEqual(['.git']);
  });

  it('asks for confirmation interactively and honors a "no" answer', async () => {
    const added = JSON.parse(
      (await run(['project', 'add', workspace, '--json'])).out,
    ) as ProjectDetails;
    const declined = await run(
      ['project', 'remove', added.project.id],
      capture(temp.dir, false, true),
    );
    expect(declined.out).toContain('Aborted');
    expect(JSON.parse((await run(['project', 'list', '--json'])).out)).toHaveLength(1);

    const accepted = await run(
      ['project', 'remove', added.project.id],
      capture(temp.dir, true, true),
    );
    expect(accepted.code).toBe(0);
    expect(JSON.parse((await run(['project', 'list', '--json'])).out)).toEqual([]);
  });

  it('logs technical details when the database cannot be opened', async () => {
    mkdirSync(dataDir, { recursive: true });
    const db = new DatabaseSync(path.join(dataDir, 'atlas.db'));
    db.exec(
      "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT); INSERT INTO schema_migrations VALUES (999, 'future', 'x');",
    );
    db.close();

    const result = await run(['project', 'list']);
    expect(result.code).toBe(1);
    expect(result.err).toBe('Error: The project registry could not be saved. Please try again.\n');
    const log = readFileSync(path.join(dataDir, 'logs', 'atlas.log'), 'utf8');
    expect(log).toContain('CLI command failed');
    expect(log).toContain('newer version of ATLAS');
  });

  it('returns a usage error for unknown commands', async () => {
    expect((await run(['project', 'explode'])).code).toBe(2);
  });

  const builtCli = fileURLToPath(new URL('../dist/index.js', import.meta.url));
  it.runIf(existsSync(builtCli))('runs as a standalone process without Electron', () => {
    const env = { ...process.env, ATLAS_DATA_DIR: dataDir };
    execFileSync(process.execPath, [builtCli, 'project', 'add', workspace], { env });
    const output = execFileSync(process.execPath, [builtCli, 'project', 'list', '--json'], {
      env,
    }).toString();
    expect((JSON.parse(output) as ProjectDetails[])[0]?.project.workspacePath).toBe(workspace);
  });

  describe('terminal commands', () => {
    let host: EngineHost | undefined;
    let spawner: FakePtySpawner;

    const startHost = async () => {
      spawner = new FakePtySpawner();
      // The running Engine owns the terminals; fake PTYs keep these tests process-free.
      host = await startEngineHost({
        dataDir,
        component: 'test',
        terminals: { spawner, mirrors: new FakeMirrorFactory(), shells: new FakeShellProvider() },
      });
    };
    const addProject = async () => {
      const added = await run(['project', 'add', workspace, '--json']);
      return (JSON.parse(added.out) as ProjectDetails).project.id;
    };

    afterEach(async () => {
      await host?.stop();
      host = undefined;
    });

    it('reports that the Engine is not running', async () => {
      const result = await run(['terminal', 'list']);
      expect(result.code).toBe(1);
      expect(result.err).toBe(
        'Error: The ATLAS Engine is not running. Start (or restart) ATLAS Control and try again.\n',
      );
    });

    it('opens, lists, shows and closes terminals through the running Engine', async () => {
      await startHost();
      const projectId = await addProject();

      const opened = await run([
        'terminal',
        'open',
        '--project',
        projectId,
        '--title',
        'Dev',
        '--json',
      ]);
      expect(opened.code).toBe(0);
      const session = JSON.parse(opened.out) as TerminalSession;
      expect(session).toMatchObject({ title: 'Dev', status: 'RUNNING', cwd: workspace });
      // The process belongs to the shared Engine, not to the CLI invocation.
      expect(host!.engine.terminals!.getById(session.id).status).toBe('RUNNING');

      const list = await run(['terminal', 'list', '--project', projectId]);
      expect(list.out).toContain(session.id);
      expect(list.out).toMatch(/Dev\s+running\s+zsh/);

      const shown = await run(['terminal', 'show', session.id]);
      expect(shown.out).toContain(`Directory  ${workspace}`);

      const refused = await run(['terminal', 'close', session.id]);
      expect(refused.code).toBe(2);
      expect(host!.engine.terminals!.getById(session.id).status).toBe('RUNNING');

      const closed = await run(['terminal', 'close', session.id, '--yes']);
      expect(closed).toMatchObject({ code: 0, out: 'Terminal "Dev" is terminated.\n' });
      expect(spawner.last().kills).toEqual(['SIGHUP']);
    });

    it('validates projects and terminal ids', async () => {
      await startHost();
      const unknown = await run([
        'terminal',
        'open',
        '--project',
        '00000000-0000-4000-8000-000000000000',
      ]);
      expect(unknown).toMatchObject({ code: 1 });
      expect(unknown.err).toContain('The project could not be found');
      const missing = await run(['terminal', 'show', '00000000-0000-4000-8000-000000000000']);
      expect(missing.err).toContain('The terminal could not be found');
    });

    it('refuses to remove a project with running terminals', async () => {
      await startHost();
      const projectId = await addProject();
      await run(['terminal', 'open', '--project', projectId]);

      const refused = await run(['project', 'remove', projectId, '--yes']);
      expect(refused.code).toBe(1);
      expect(refused.err).toContain('has running terminals');

      const [session] = host!.engine.terminals!.list(projectId);
      await host!.engine.terminals!.terminate(session!.id);
      expect((await run(['project', 'remove', projectId, '--yes'])).code).toBe(0);
    });
  });
});
