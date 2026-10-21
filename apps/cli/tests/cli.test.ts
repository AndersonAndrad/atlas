import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  AtlasSession,
  AtlasSessionListItem,
  ProjectDetails,
  SessionChangedEvent,
  TerminalSession,
} from '@atlas/contracts';
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

  it('shows Git details, or a plain-folder state, for a project', async () => {
    const added = JSON.parse(
      (await run(['project', 'add', workspace, '--json'])).out,
    ) as ProjectDetails;
    const shown = await run(['project', 'show', added.project.id]);
    expect(shown.code).toBe(0);
    // The test workspace has a hand-made .git without objects: git refuses it or reports it.
    expect(shown.out).toMatch(/\nGit/);

    const plain = path.join(temp.dir, 'plain');
    mkdirSync(plain);
    const plainProject = JSON.parse(
      (await run(['project', 'add', plain, '--json'])).out,
    ) as ProjectDetails;
    const json = JSON.parse(
      (await run(['project', 'show', plainProject.project.id, '--json'])).out,
    ) as {
      gitStatus: { state: string };
    };
    expect(json.gitStatus.state).toBe('not-repository');
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
      expect(shown.out).toMatch(new RegExp(`Directory +${workspace}`));

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

    it('keeps terminals running when their project is removed', async () => {
      await startHost();
      const projectId = await addProject();
      await run(['terminal', 'open', '--project', projectId]);

      expect((await run(['project', 'remove', projectId, '--yes'])).code).toBe(0);
      expect(host!.engine.terminals!.list()).toEqual([
        expect.objectContaining({ projectId: null, status: 'RUNNING' }),
      ]);
    });

    it('opens standalone terminals and renames them', async () => {
      await startHost();
      const folder = path.join(temp.dir, 'tools');
      mkdirSync(folder);
      const opened = await run(['terminal', 'open', '--cwd', 'tools', '--json']);
      const session = JSON.parse(opened.out) as TerminalSession;
      expect(session).toMatchObject({ projectId: null, cwd: folder, title: 'tools' });

      expect((await run(['terminal', 'rename', session.id, 'Docker Services'])).out).toBe(
        'Terminal renamed to "Docker Services".\n',
      );
      expect((await run(['terminal', 'rename', session.id, '--auto'])).out).toBe(
        'Terminal renamed to "tools".\n',
      );
      expect((await run(['terminal', 'rename', session.id])).code).toBe(2);
      expect(
        (await run(['terminal', 'open', '--cwd', 'tools', '--project', session.id])).code,
      ).toBe(2);
    });
  });

  describe('session commands', () => {
    let host: EngineHost | undefined;
    afterEach(async () => {
      await host?.stop();
      host = undefined;
    });

    const create = async (...extra: string[]) => {
      const result = await run([
        'session',
        'create',
        '--name',
        'NOVA auth',
        '--objective',
        'Implement authentication',
        '--json',
        ...extra,
      ]);
      expect(result.err).toBe('');
      return JSON.parse(result.out) as AtlasSession;
    };

    it('manages sessions without a running Engine', async () => {
      const projectId = (
        JSON.parse((await run(['project', 'add', workspace, '--json'])).out) as ProjectDetails
      ).project.id;
      const session = await create(
        '--project',
        projectId,
        '--profile',
        'economy',
        '-c',
        'No network',
      );
      expect(session).toMatchObject({
        status: 'DRAFT',
        projectId,
        executionProfile: 'ECONOMY',
        constraints: ['No network'],
      });
      await create('--cwd', 'my-app');

      const list = await run(['session', 'list', '--json']);
      expect(
        (JSON.parse(list.out) as AtlasSessionListItem[]).map((item) => item.projectName),
      ).toEqual([null, 'my-app']);
      expect((await run(['session', 'list'])).out).toContain('NOVA auth');

      expect((await run(['session', 'ready', session.id])).out).toBe(
        'Session "NOVA auth" is ready.\n',
      );
      expect((await run(['session', 'start', session.id])).out).toBe(
        'Session "NOVA auth" is waiting for an executor. No execution adapter is installed yet.\n',
      );
      const shown = await run(['session', 'show', session.id]);
      expect(shown.out).toContain('waiting for executor');
      expect(shown.out).toContain('Executing          no');
      expect(shown.out).toContain('SESSION_WAITING_EXECUTOR ready → waiting for executor');
      expect((await run(['session', 'tasks', session.id])).out).toBe('No tasks.\n');

      const invalid = await run(['session', 'ready', session.id]);
      expect(invalid.code).toBe(1);
      expect(invalid.err).toContain('not available in the current session status');

      expect((await run(['session', 'cancel', session.id])).code).toBe(2);
      expect((await run(['session', 'cancel', session.id, '--yes'])).out).toBe(
        'Session "NOVA auth" is cancelled.\n',
      );
      expect((await run(['session', 'archive', session.id])).code).toBe(0);
      expect((await run(['session', 'list', '--json'])).out).not.toContain(session.id);
      expect((await run(['session', 'list', '--all', '--json'])).out).toContain(session.id);
    });

    it('validates arguments', async () => {
      expect((await run(['session', 'create', '--name', 'x'])).code).toBe(2);
      expect(
        (await run(['session', 'create', '-n', 'x', '-o', 'y', '--project', 'a', '--cwd', '.']))
          .code,
      ).toBe(2);
      const badProfile = await run([
        'session',
        'create',
        '-n',
        'x',
        '-o',
        'y',
        '--profile',
        'turbo',
      ]);
      expect(badProfile.code).toBe(1);
      expect((await run(['session', 'show', 'not-an-id'])).code).toBe(1);
      expect(
        (await run(['session', 'show', '00000000-0000-4000-8000-00000000abcd'])).err,
      ).toContain('The session could not be found.');
    });

    it('goes through the running Engine so ATLAS Control sees changes live', async () => {
      host = await startEngineHost({
        dataDir,
        component: 'test',
        terminals: {
          spawner: new FakePtySpawner(),
          mirrors: new FakeMirrorFactory(),
          shells: new FakeShellProvider(),
        },
      });
      const received: SessionChangedEvent[] = [];
      host.onSessionChanged((event) => received.push(event));
      const session = await create();
      expect((await run(['session', 'ready', session.id])).code).toBe(0);
      expect(received.map((event) => event.sessionId)).toEqual([session.id, session.id]);
      expect((await host.engine.sessions.get(session.id)).status).toBe('READY');
    });
  });

  describe('shared context', () => {
    const projectId = async () => {
      const added = await run(['project', 'add', workspace, '--json']);
      return (JSON.parse(added.out) as ProjectDetails).project.id;
    };

    it('shows context, prints a bundle and creates and shows handoffs', async () => {
      const id = await projectId();
      const empty = await run(['context', 'show', '--project', id]);
      expect(empty.code).toBe(0);
      expect(empty.out).toContain('0 entries');

      const bundle = await run(['context', 'bundle', '--project', id, '--provider', 'codex']);
      expect(bundle.code).toBe(0);
      expect(bundle.out).toContain('# ATLAS context — my-app');
      expect(bundle.out).toContain('Context for Codex CLI');

      const created = await run([
        'context',
        'handoff',
        'create',
        '--project',
        id,
        '--objective',
        'Implement JWT authentication',
        '--to',
        'claude',
        '--pending',
        'Refresh tokens',
        '--json',
      ]);
      expect(created.code).toBe(0);
      const handoff = JSON.parse(created.out) as { id: string; pendingWork: string[] };
      expect(handoff.pendingWork).toEqual(['Refresh tokens']);

      const shown = await run(['context', 'handoff', 'show', handoff.id, '--project', id]);
      expect(shown.out).toContain('Prepared for Claude Code');
      expect(shown.out).toContain('- Refresh tokens');
      expect((await run(['context', 'show', '--project', id])).out).toContain('1 handoffs');
    });

    it('imports, enables, resolves and removes skills from explicit paths', async () => {
      const dir = path.join(temp.dir, 'my-skill');
      mkdirSync(path.join(dir, 'scripts'), { recursive: true });
      writeFileSync(
        path.join(dir, 'SKILL.md'),
        '---\nname: my-skill\ndescription: Helps.\n---\n# Hi\n',
      );
      writeFileSync(path.join(dir, 'scripts', 'run.sh'), '#!/bin/sh\necho hi\n');
      expect((await run(['skills', 'list'])).out).toContain('No skills registered.');

      const refused = await run(['skills', 'import', dir]);
      expect(refused.out).toContain('scripts/run.sh');
      expect(refused.err).toContain('Re-run with --yes');
      const imported = await run(['skills', 'import', dir, '--yes', '--json']);
      expect(imported.code).toBe(0);
      const skill = JSON.parse(imported.out.slice(imported.out.indexOf('{'))) as { id: string };
      expect((await run(['skills', 'enable', skill.id])).out).toContain('enabled globally');
      expect((await run(['skills', 'resolve', '--provider', 'codex'])).out).toMatch(
        /active\s+my-skill/,
      );
      expect(
        (await run(['skills', 'assign', skill.id, '--scope', 'role', '--target', 'boss'])).code,
      ).not.toBe(0);
      expect((await run(['skills', 'show', skill.id])).out).toContain('Source: path');
      expect((await run(['skills', 'templates'])).out).toContain('conventional-commits');
      expect((await run(['skills', 'remove', skill.id, '--yes'])).out).toContain('Removed');
      expect(existsSync(path.join(dir, 'SKILL.md'))).toBe(true);
    });

    it('imports a folder of skills and enables them', async () => {
      const repo = path.join(temp.dir, 'skills-repo');
      for (const name of ['review', 'tests']) {
        mkdirSync(path.join(repo, name), { recursive: true });
        writeFileSync(
          path.join(repo, name, 'SKILL.md'),
          `---\nname: ${name}\ndescription: ${name} skill.\n---\n`,
        );
      }
      const result = await run(['skills', 'import', repo, '--yes', '--enable']);
      expect(result.code).toBe(0);
      expect(result.out).toContain('new       review');
      expect(result.out).toContain('Imported 2 skill(s) and enabled them; 0 failed.');
      expect((await run(['skills', 'list'])).out).toMatch(/on\s+review/);
    });

    it('lists the Git operation log and validates its options', async () => {
      const empty = await run(['git', 'log-operations']);
      expect(empty.code).toBe(0);
      expect(empty.out).toContain('No logged Git operations.');
      const json = await run(['git', 'log-operations', '--json']);
      expect(JSON.parse(json.out)).toEqual({ operations: [], nextBefore: null });
      expect((await run(['git', 'log-operations', '--limit', 'all'])).err).toContain(
        '--limit must be a number',
      );
      const missing = await run(['git', 'log-operation', '00000000-0000-4000-8000-000000000001']);
      expect(missing.code).not.toBe(0);
      expect((await run(['git', 'reflog', '--repo', temp.dir])).err).toContain(
        'is not inside a Git repository',
      );
    });

    it('retrieves ranked context and reports context health', async () => {
      const id = await projectId();
      const retrieved = await run([
        'context',
        'retrieve',
        '--project',
        id,
        '--objective',
        'Rotate JWT tokens',
        '--role',
        'qa',
        '--file',
        'src/auth.ts',
      ]);
      expect(retrieved.code).toBe(0);
      expect(retrieved.out).toContain('Objective: Rotate JWT tokens · role: qa');
      expect(retrieved.out).toContain('approximation: characters / 4');

      const json = await run(['context', 'bundle', '--project', id, '--budget', '1000', '--json']);
      expect(JSON.parse(json.out)).toMatchObject({ budgetTokens: 1000, budgetSource: 'request' });

      const health = await run(['context', 'health', '--project', id]);
      expect(health.code).toBe(0);
      expect(health.out).toContain('Last reconciliation: never');
      expect(health.out).toContain('not a quality score');

      expect((await run(['context', 'bundle', '--project', id, '--budget', 'lots'])).err).toContain(
        '--budget must be a number',
      );
      const badRole = await run(['context', 'retrieve', '--project', id, '--role', 'boss']);
      expect(badRole.code).not.toBe(0);
    });

    it('requires one target and a valid provider, and needs the running app to start AI', async () => {
      const id = await projectId();
      expect((await run(['context', 'show'])).err).toContain('--project <id> or --cwd');
      expect((await run(['context', 'handoff', 'create', '--project', id])).err).toContain(
        '--objective',
      );
      expect((await run(['ai', 'start', '--provider', 'gpt', '--project', id])).err).toContain(
        'claude or codex',
      );
      const offline = await run(['ai', 'start', '--provider', 'claude', '--project', id]);
      expect(offline.code).not.toBe(0);
      expect(offline.err).toContain('Engine is not running');
    });
  });
});
