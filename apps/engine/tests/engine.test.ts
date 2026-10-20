import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempDir } from '../../../tests/support/temp.js';
import { createEngine, type Engine } from '../src/index.js';

describe('Engine (headless, without Electron)', () => {
  let temp: ReturnType<typeof createTempDir>;
  let dataDir: string;
  let workspaces: string;
  let engine: Engine | undefined;

  const open = () => {
    engine?.close();
    engine = createEngine({ dataDir, component: 'test' });
    return engine;
  };

  beforeEach(() => {
    temp = createTempDir();
    dataDir = path.join(temp.dir, 'data');
    workspaces = path.join(temp.dir, 'workspaces');
    mkdirSync(workspaces);
  });
  afterEach(() => {
    engine?.close();
    engine = undefined;
    temp.cleanup();
  });

  const workspace = (name: string, git = false) => {
    const dir = path.join(workspaces, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'README.md'), name);
    if (git) {
      mkdirSync(path.join(dir, '.git'));
      writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    }
    return dir;
  };

  it('stores the database inside the data directory, not the workspace', async () => {
    const dir = workspace('alpha');
    await open().projects.create({ name: 'Alpha', workspacePath: dir });
    expect(existsSync(path.join(dataDir, 'atlas.db'))).toBe(true);
    expect(readdirSync(dir)).toEqual(['README.md']);
  });

  it('persists projects and the selection across restarts', async () => {
    const a = await open().projects.create({ name: 'A', workspacePath: workspace('a', true) });
    const b = await engine!.projects.create({ name: 'B', workspacePath: workspace('b') });
    await engine!.projects.selectProject(b.id);

    const restarted = open();
    const all = await restarted.projects.findAll();
    expect(all.map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
    expect((await restarted.projects.getSelectedProject())?.id).toBe(b.id);
    expect(all.find((p) => p.id === a.id)?.git).toEqual({
      isRepository: true,
      repositoryRoot: path.join(workspaces, 'a'),
    });
  });

  it('reports the live Git branch in details', async () => {
    const dir = workspace('git', true);
    const project = await open().projects.create({ name: 'Git', workspacePath: dir });
    writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/develop\n');
    expect((await engine!.projects.getDetails(project.id)).git.branch).toBe('develop');
  });

  it('rejects duplicates through symlinks', async () => {
    const dir = workspace('dup');
    const link = path.join(temp.dir, 'dup-link');
    symlinkSync(dir, link);
    await open().projects.create({ name: 'Dup', workspacePath: dir });
    await expect(
      engine!.projects.create({ name: 'Dup 2', workspacePath: link }),
    ).rejects.toMatchObject({ code: 'PROJECT_ALREADY_EXISTS' });
  });

  it.runIf(process.platform === 'darwin')(
    'rejects duplicates that differ only by case on macOS',
    async () => {
      const dir = workspace('CaseProject');
      await open().projects.create({ name: 'Case', workspacePath: dir });
      const variant = path.join(workspaces, 'caseproject');
      // Only meaningful on a case-insensitive volume (the macOS default).
      if (!existsSync(variant)) return;
      await expect(
        engine!.projects.create({ name: 'Case 2', workspacePath: variant }),
      ).rejects.toMatchObject({ code: 'PROJECT_ALREADY_EXISTS' });
    },
  );

  it('keeps a project whose directory disappeared and lets the user relocate it', async () => {
    const dir = workspace('movable');
    const project = await open().projects.create({ name: 'Movable', workspacePath: dir });
    const moved = path.join(workspaces, 'moved');
    renameSync(dir, moved);

    const restarted = open();
    const details = await restarted.projects.getDetails(project.id);
    expect(details.availability.status).toBe('missing');

    const updated = await restarted.projects.update(project.id, { workspacePath: moved });
    expect(updated.workspacePath).toBe(moved);
    expect((await restarted.projects.getDetails(project.id)).availability.status).toBe('available');
    // The project files were moved by the user, not by ATLAS, and remain intact.
    expect(readdirSync(moved)).toEqual(['README.md']);
  });

  it('never deletes project files when removing a registry entry', async () => {
    const dir = workspace('keep', true);
    const project = await open().projects.create({ name: 'Keep', workspacePath: dir });
    await engine!.projects.remove(project.id);
    expect(readdirSync(dir).sort()).toEqual(['.git', 'README.md']);
    expect(await engine!.projects.findAll()).toEqual([]);
  });

  it('writes structured logs to the data directory', async () => {
    await open().projects.create({ name: 'Log', workspacePath: workspace('log') });
    expect(existsSync(path.join(dataDir, 'logs', 'atlas.log'))).toBe(true);
  });
});
