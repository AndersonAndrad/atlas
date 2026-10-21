import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ContextTarget } from '@atlas/contracts';
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

describe.skipIf(!gitAvailable)('Skills in the Engine (SDD-006 Milestone B)', () => {
  let temp: ReturnType<typeof createTempDir>;
  let engine: Engine;
  const env = () => ({
    ...process.env,
    HOME: path.join(temp.dir, 'home'),
    XDG_CONFIG_HOME: path.join(temp.dir, 'home'),
    GIT_CONFIG_NOSYSTEM: '1',
  });

  beforeEach(async () => {
    temp = createTempDir();
    mkdirSync(path.join(temp.dir, 'home'));
    engine = createEngine({
      dataDir: path.join(temp.dir, 'data'),
      component: 'test',
      env: env(),
      terminals: {
        spawner: new FakePtySpawner(),
        mirrors: new FakeMirrorFactory(),
        shells: new FakeShellProvider(),
      },
    });
    await engine.initialize();
  });
  afterEach(async () => {
    await engine.shutdown();
    temp.cleanup();
  });

  const project = async (name: string) => {
    const dir = path.join(temp.dir, name);
    mkdirSync(dir);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, env: env() });
    writeFileSync(path.join(dir, 'a.ts'), 'export {};\n');
    const created = await engine.projects.create({ name, workspacePath: dir });
    const target: ContextTarget = { projectId: created.id };
    return { id: created.id, target, resolved: await engine.resolveContextTarget(target) };
  };

  it('lists active skills in context bundles by project, provider and session', async () => {
    const api = await project('api');
    const web = await project('web');
    const review = await engine.skills.createFromTemplate({
      templateId: 'code-review',
      name: 'review',
    });
    const testing = await engine.skills.createFromTemplate({
      templateId: 'unit-testing',
      name: 'testing',
    });
    await engine.skills.assign({
      skillId: review.id,
      scope: 'project',
      target: api.id,
      effect: 'enable',
    });

    const bundle = await engine.context.bundle(api.resolved, { provider: 'claude' });
    expect(bundle.skills.map((skill) => skill.name)).toEqual(['review']);
    expect(bundle.markdown).toContain('## Skills enabled by the user');
    expect(bundle.markdown).toContain(path.join(review.storagePath, 'SKILL.md'));
    // The skill's own instructions are not copied into the context.
    expect(bundle.markdown).not.toContain('Read the complete diff and the code around it');
    expect((await engine.context.bundle(web.resolved, { provider: 'claude' })).skills).toEqual([]);

    const started = await engine.startAiSession({
      provider: 'codex',
      target: api.target,
      includeContext: true,
      skillIds: [testing.id],
    });
    expect(started.prompt).toContain(path.join(testing.storagePath, 'SKILL.md'));
    const details = await engine.skills.details(testing.id);
    expect(details.skill.assignments).toEqual([
      expect.objectContaining({ scope: 'session', target: started.session.id, effect: 'enable' }),
    ]);

    await engine.removeProject(api.id);
    expect((await engine.skills.details(review.id)).skill.assignments).toEqual([]);
  });
});
