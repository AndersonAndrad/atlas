import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SqliteSettingsRepository,
  SqliteSkillRepository,
  openDatabase,
  type Database,
} from '@atlas/persistence';
import { createTempDir } from '../../../tests/support/temp.js';
import { MANAGED_MARKER, NodeSkillFileSystem, SkillsHub } from '../src/index.js';

describe('Skills Hub with real folders (SDD-006 Milestone B)', () => {
  let temp: ReturnType<typeof createTempDir>;
  let db: Database;
  let hub: SkillsHub;
  let home: string;

  const skillFolder = (root: string, name: string, extra: Record<string, string> = {}) => {
    const dir = path.join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'SKILL.md'),
      extra['SKILL.md'] ?? `---\nname: ${name}\ndescription: Helps with ${name}.\n---\n# ${name}\n`,
    );
    for (const [file, content] of Object.entries(extra)) {
      if (file === 'SKILL.md') continue;
      mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      writeFileSync(path.join(dir, file), content);
    }
    return dir;
  };
  const tree = (dir: string) => readdirSync(dir, { recursive: true }).map(String).sort();

  const create = () =>
    new SkillsHub({
      repository: new SqliteSkillRepository(db),
      fs: new NodeSkillFileSystem({ PATH: '/usr/bin:/bin' }),
      storageRoot: path.join(temp.dir, 'data', 'skills'),
      suggestions: { home, claudeConfigDir: null },
      settings: new SqliteSettingsRepository(db),
      clock: { now: () => new Date() },
      generateId: randomUUID,
    });

  beforeEach(() => {
    temp = createTempDir();
    home = path.join(temp.dir, 'home');
    mkdirSync(home);
    db = openDatabase({ filePath: path.join(temp.dir, 'atlas.db') });
    hub = create();
  });
  afterEach(() => {
    db.close();
    temp.cleanup();
  });

  it('reads only authorized folders and imports a reviewed copy without touching the source', async () => {
    const claude = path.join(home, '.claude', 'skills');
    const source = skillFolder(claude, 'review-helper', { 'scripts/run.sh': 'echo hi\n' });
    chmodSync(path.join(source, 'scripts/run.sh'), 0o755);
    const before = tree(source);

    await expect(hub.inspect(source, false)).rejects.toMatchObject({
      code: 'SKILL_SOURCE_UNAUTHORIZED',
    });
    await expect(
      hub.addSource({ path: path.join(temp.dir, 'other'), kind: 'path' }, false),
    ).rejects.toMatchObject({
      code: 'SKILL_SOURCE_UNAUTHORIZED',
    });
    const suggestion = (await hub.suggestions()).find((item) => item.kind === 'claude')!;
    expect(suggestion).toMatchObject({ path: claude, exists: true });
    await hub.addSource({ path: claude, kind: 'claude' }, false);

    expect((await hub.discover()).map((item) => [item.name, item.status])).toEqual([
      ['review-helper', 'new'],
    ]);
    const preview = await hub.inspect(source, false);
    expect(preview.validation.scripts).toEqual(['scripts/run.sh']);
    await expect(
      hub.import({ path: source, confirm: true, contentHash: '0'.repeat(64) }, false),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    const skill = await hub.import(
      { path: source, confirm: true, contentHash: preview.contentHash },
      false,
    );
    expect(skill).toMatchObject({
      name: 'review-helper',
      enabled: false,
      currentSequence: 1,
      source: { kind: 'claude' },
    });
    expect(tree(skill.storagePath)).toEqual(['SKILL.md', 'scripts', 'scripts/run.sh']);
    expect(tree(source)).toEqual(before);
    expect((await hub.discover())[0]!.status).toBe('imported');

    // A change at the source is offered as an update; nothing changes by itself.
    writeFileSync(
      path.join(source, 'SKILL.md'),
      '---\nname: review-helper\ndescription: Better.\n---\n# v2\n',
    );
    expect((await hub.discover())[0]!.status).toBe('update-available');
    expect((await hub.details(skill.id)).updateAvailable).toBe(true);
    const update = await hub.inspect(source, false);
    const next = await hub.import(
      { path: source, confirm: true, contentHash: update.contentHash, note: 'v2' },
      false,
    );
    expect(next.currentSequence).toBe(2);
    const diff = await hub.diff(skill.id, 1, 2);
    expect(diff.lines).toContainEqual({ kind: 'added', text: '# v2' });
    expect(diff.files).toEqual([{ path: 'SKILL.md', change: 'changed' }]);
    expect((await hub.readFile(skill.id, 1, 'SKILL.md')).content).toContain('# review-helper');
    await expect(hub.readFile(skill.id, 1, '../../atlas.db')).rejects.toMatchObject({
      code: 'SKILL_NOT_FOUND',
    });

    // Removing the registry entry deletes ATLAS's copies only.
    await hub.remove(skill.id);
    expect(existsSync(next.storagePath)).toBe(false);
    expect(existsSync(path.join(source, 'SKILL.md'))).toBe(true);
    expect(await hub.listSkills()).toEqual([]);
  });

  it('refuses unsafe folders and invalid skills', async () => {
    const root = path.join(temp.dir, 'chosen');
    const outside = path.join(temp.dir, 'secret.txt');
    writeFileSync(outside, 'secret');
    const linked = skillFolder(root, 'linked');
    symlinkSync(outside, path.join(linked, 'leak.txt'));
    const preview = await hub.inspect(linked, true);
    expect(preview.validation.valid).toBe(false);
    await expect(
      hub.import({ path: linked, confirm: true, contentHash: preview.contentHash }, true),
    ).rejects.toMatchObject({ code: 'SKILL_REJECTED' });

    const leaky = skillFolder(root, 'leaky', {
      'SKILL.md': '---\nname: leaky\ndescription: key AKIAABCDEFGHIJKLMNOP\n---\n',
    });
    expect((await hub.inspect(leaky, true)).validation.issues.map((item) => item.code)).toContain(
      'credential-in-metadata',
    );
    await expect(hub.inspect(path.join(root, 'missing'), true)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('creates editable skills from templates, versions edits and resolves rules', async () => {
    const skill = await hub.createFromTemplate({ templateId: 'code-review', name: 'team-review' });
    expect(skill).toMatchObject({
      source: { kind: 'template', templateId: 'code-review' },
      version: '1.0.0',
    });
    await expect(
      hub.createFromTemplate({ templateId: 'code-review', name: 'team-review' }),
    ).rejects.toThrow();
    const text = (await hub.readFile(skill.id, 1, 'SKILL.md')).content!;
    const edited = await hub.edit({ skillId: skill.id, content: `${text}\n6. Check the docs.\n` });
    expect(edited.currentSequence).toBe(2);
    expect(edited.version).toMatch(/^1\.0\.0\+[0-9a-f]{8}$/);
    await expect(
      hub.edit({ skillId: skill.id, content: '---\nname: [broken\n---\n' }),
    ).rejects.toMatchObject({
      code: 'SKILL_REJECTED',
    });

    const project = randomUUID();
    expect((await hub.resolve({ projectId: project }))[0]).toMatchObject({
      active: false,
      layer: 'none',
    });
    await hub.assign({ skillId: skill.id, scope: 'project', target: project, effect: 'enable' });
    expect((await hub.resolve({ projectId: project }))[0]).toMatchObject({
      active: true,
      layer: 'project',
    });
    await hub.assign({ skillId: skill.id, scope: 'role', target: 'qa', effect: 'disable' });
    expect((await hub.resolve({ projectId: project, role: 'qa' }))[0]).toMatchObject({
      active: false,
      layer: 'role',
    });
    await hub.projectRemoved(project);
    expect((await hub.details(skill.id)).skill.assignments.map((item) => item.scope)).toEqual([
      'role',
    ]);
    expect((await hub.resolve({}))[0]!.skillFile).toBe(path.join(edited.storagePath, 'SKILL.md'));
  });

  it('synchronizes enabled skills to a provider folder, never touching other folders, and rolls back', async () => {
    const target = path.join(home, '.agents', 'skills');
    const theirs = skillFolder(target, 'their-skill');
    const first = await hub.createFromTemplate({
      templateId: 'unit-testing',
      name: 'unit-testing',
    });
    const second = await hub
      .createFromTemplate({ templateId: 'documentation', name: 'their-skill' })
      .catch(() => null);
    expect(second).not.toBeNull();
    await hub.setEnabled(first.id, true);
    await hub.setEnabled(second!.id, true);

    await expect(hub.syncPreview('codex')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(hub.setSyncTargets({ codex: 'relative/path' })).rejects.toThrow();
    await hub.setSyncTargets({ codex: target });

    const plan = await hub.syncPreview('codex');
    expect(plan.items.map((item) => [item.dirName, item.action])).toEqual([
      ['their-skill', 'conflict'],
      ['unit-testing', 'create'],
    ]);
    const applied = await hub.syncApply('codex');
    expect(applied.applied.map((item) => item.dirName)).toEqual(['unit-testing']);
    const written = path.join(target, 'unit-testing');
    expect(JSON.parse(readFileSync(path.join(written, MANAGED_MARKER), 'utf8'))).toMatchObject({
      managedBy: 'atlas',
      skillId: first.id,
    });
    expect(readFileSync(path.join(theirs, 'SKILL.md'), 'utf8')).toContain('their-skill');
    expect(readdirSync(target).filter((name) => name.startsWith('.atlas'))).toEqual([]);
    expect(
      (await hub.syncPreview('codex')).items.find((item) => item.dirName === 'unit-testing')
        ?.action,
    ).toBe('unchanged');
    await expect(hub.remove(first.id)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    // A new version is an update; disabling the skill removes ATLAS's copy.
    const text = (await hub.readFile(first.id, 1, 'SKILL.md')).content!;
    await hub.edit({ skillId: first.id, content: `${text}\nMore.\n` });
    expect(
      (await hub.syncPreview('codex')).items.find((item) => item.dirName === 'unit-testing')
        ?.action,
    ).toBe('update');
    const updated = await hub.syncApply('codex');
    expect(readFileSync(path.join(written, 'SKILL.md'), 'utf8')).toContain('More.');

    await hub.setEnabled(first.id, false);
    expect(
      (await hub.syncPreview('codex')).items.find((item) => item.dirName === 'unit-testing')
        ?.action,
    ).toBe('remove');
    const removed = await hub.syncApply('codex');
    expect(existsSync(written)).toBe(false);

    // Rollback only for the latest batch; it restores the folder as it was.
    await expect(hub.syncRollback(updated.batchId)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    expect(await hub.syncRollback(removed.batchId)).toEqual({
      restored: ['unit-testing'],
      skipped: [],
    });
    expect(readFileSync(path.join(written, 'SKILL.md'), 'utf8')).toContain('More.');
    await expect(hub.syncRollback(removed.batchId)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    expect(await hub.syncRollback(updated.batchId)).toEqual({
      restored: ['unit-testing'],
      skipped: [],
    });
    expect(readFileSync(path.join(written, 'SKILL.md'), 'utf8')).not.toContain('More.');
    expect((await hub.syncHistory('codex')).map((batch) => batch.rolledBackAt !== null)).toEqual([
      true,
      true,
      false,
    ]);
    expect(readFileSync(path.join(theirs, 'SKILL.md'), 'utf8')).toContain('their-skill');
  });
});
