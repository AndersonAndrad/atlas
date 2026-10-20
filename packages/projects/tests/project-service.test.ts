import { beforeEach, describe, expect, it } from 'vitest';
import { AtlasError, type ErrorCode } from '@atlas/shared';
import { ProjectService, SELECTED_PROJECT_SETTING, type PathPlatform } from '../src/index.js';
import {
  FakePathInspector,
  InMemoryProjectRepository,
  InMemorySettingsRepository,
} from './fakes.js';

async function expectAtlasError(promise: Promise<unknown>, code: ErrorCode) {
  await expect(promise).rejects.toBeInstanceOf(AtlasError);
  await promise.catch((error: AtlasError) => expect(error.code).toBe(code));
}

function setup(platform: PathPlatform = 'darwin') {
  const projects = new InMemoryProjectRepository();
  const settings = new InMemorySettingsRepository();
  const inspector = new FakePathInspector();
  let tick = 0;
  let ids = 0;
  const service = new ProjectService({
    projects,
    settings,
    inspector,
    platform,
    clock: { now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)) },
    generateId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
  });
  return { service, projects, settings, inspector };
}

describe('ProjectService.create', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
    ctx.inspector
      .set('/work/atlas', { status: 'available', gitRoot: '/work/atlas', branch: 'main' })
      .set('/work/plain', { status: 'available' });
  });

  it('registers a Git project with stable metadata only', async () => {
    const project = await ctx.service.create({
      name: ' Atlas ',
      workspacePath: '/work/atlas',
      description: 'Main repo',
      tags: ['core'],
    });
    expect(project).toMatchObject({
      name: 'Atlas',
      description: 'Main repo',
      tags: ['core'],
      workspacePath: '/work/atlas',
      git: { isRepository: true, repositoryRoot: '/work/atlas' },
    });
    expect(project).not.toHaveProperty('lastOpenedAt');
    // The branch is dynamic and must not be persisted.
    expect(JSON.stringify(ctx.projects.records.get(project.id))).not.toContain('main');
  });

  it('registers directories without Git', async () => {
    const project = await ctx.service.create({ name: 'Plain', workspacePath: '/work/plain' });
    expect(project.git).toEqual({ isRepository: false });
  });

  it('omits an empty description', async () => {
    const project = await ctx.service.create({
      name: 'Plain',
      workspacePath: '/work/plain',
      description: '   ',
    });
    expect(project).not.toHaveProperty('description');
  });

  it('stores the symlink-resolved path', async () => {
    ctx.inspector.set('/links/atlas', { status: 'available', resolvedPath: '/work/atlas' });
    const project = await ctx.service.create({ name: 'Link', workspacePath: '/links/atlas' });
    expect(project.workspacePath).toBe('/work/atlas');
  });

  it.each([
    ['missing', 'PROJECT_PATH_UNAVAILABLE'],
    ['not-a-directory', 'PROJECT_PATH_INVALID'],
    ['permission-denied', 'PROJECT_PERMISSION_DENIED'],
  ] as const)('rejects a %s directory with %s', async (status, code) => {
    ctx.inspector.set('/work/bad', { status });
    await expectAtlasError(ctx.service.create({ name: 'Bad', workspacePath: '/work/bad' }), code);
    expect(ctx.projects.records.size).toBe(0);
  });

  it('rejects relative paths before touching the filesystem', async () => {
    await expectAtlasError(
      ctx.service.create({ name: 'Rel', workspacePath: 'work/atlas' }),
      'PROJECT_PATH_INVALID',
    );
    expect(ctx.inspector.calls).toEqual([]);
  });

  it('rejects invalid input with field issues', async () => {
    const promise = ctx.service.create({ name: '', workspacePath: '/work/atlas' });
    await expectAtlasError(promise, 'VALIDATION_FAILED');
    await promise.catch((error: AtlasError) =>
      expect(error.issues[0]).toMatchObject({ field: 'name' }),
    );
  });
});

describe('duplicate detection', () => {
  it('rejects the same directory registered twice', async () => {
    const ctx = setup();
    ctx.inspector.set('/work/atlas', { status: 'available' });
    await ctx.service.create({ name: 'A', workspacePath: '/work/atlas' });
    await expectAtlasError(
      ctx.service.create({ name: 'B', workspacePath: '/work/atlas' }),
      'PROJECT_ALREADY_EXISTS',
    );
    expect(ctx.projects.records.size).toBe(1);
  });

  it('rejects a different spelling of the same macOS directory', async () => {
    const ctx = setup('darwin');
    ctx.inspector
      .set('/Work/Atlas', { status: 'available' })
      .set('/work/atlas', { status: 'available' });
    await ctx.service.create({ name: 'A', workspacePath: '/Work/Atlas' });
    await expectAtlasError(
      ctx.service.create({ name: 'B', workspacePath: '/work/atlas/' }),
      'PROJECT_ALREADY_EXISTS',
    );
  });

  it('allows case-different directories on Linux', async () => {
    const ctx = setup('linux');
    ctx.inspector
      .set('/work/Atlas', { status: 'available' })
      .set('/work/atlas', { status: 'available' });
    await ctx.service.create({ name: 'A', workspacePath: '/work/Atlas' });
    await ctx.service.create({ name: 'B', workspacePath: '/work/atlas' });
    expect(ctx.projects.records.size).toBe(2);
  });

  it('rejects a symlink to an already registered directory', async () => {
    const ctx = setup();
    ctx.inspector
      .set('/work/atlas', { status: 'available' })
      .set('/links/atlas', { status: 'available', resolvedPath: '/work/atlas' });
    await ctx.service.create({ name: 'A', workspacePath: '/work/atlas' });
    await expectAtlasError(
      ctx.service.create({ name: 'B', workspacePath: '/links/atlas' }),
      'PROJECT_ALREADY_EXISTS',
    );
  });
});

describe('ProjectService.update', () => {
  let ctx: ReturnType<typeof setup>;
  let id: string;
  beforeEach(async () => {
    ctx = setup();
    ctx.inspector
      .set('/work/a', { status: 'available' })
      .set('/work/b', { status: 'available', gitRoot: '/work/b' })
      .set('/work/c', { status: 'available' });
    id = (
      await ctx.service.create({
        name: 'A',
        workspacePath: '/work/a',
        description: 'd',
        tags: ['x'],
      })
    ).id;
  });

  it('updates metadata and bumps updatedAt only', async () => {
    const before = await ctx.service.findById(id);
    const updated = await ctx.service.update(id, { name: 'Renamed', tags: ['y', 'z'] });
    expect(updated).toMatchObject({ name: 'Renamed', tags: ['y', 'z'], description: 'd' });
    expect(updated.createdAt).toBe(before!.createdAt);
    expect(updated.updatedAt > before!.updatedAt).toBe(true);
    expect(await ctx.service.findById(id)).toEqual(updated);
  });

  it('clears the description with null', async () => {
    const updated = await ctx.service.update(id, { description: null });
    expect(updated).not.toHaveProperty('description');
  });

  it('validates and re-inspects a changed directory', async () => {
    const updated = await ctx.service.update(id, { workspacePath: '/work/b' });
    expect(updated.workspacePath).toBe('/work/b');
    expect(updated.git).toEqual({ isRepository: true, repositoryRoot: '/work/b' });
  });

  it('rejects moving to an unavailable directory and keeps the record', async () => {
    await expectAtlasError(
      ctx.service.update(id, { workspacePath: '/work/missing' }),
      'PROJECT_PATH_UNAVAILABLE',
    );
    expect((await ctx.service.findById(id))?.workspacePath).toBe('/work/a');
  });

  it('rejects moving onto another registered directory', async () => {
    await ctx.service.create({ name: 'C', workspacePath: '/work/c' });
    await expectAtlasError(
      ctx.service.update(id, { workspacePath: '/work/c' }),
      'PROJECT_ALREADY_EXISTS',
    );
  });

  it('allows re-saving the same directory', async () => {
    await expect(ctx.service.update(id, { workspacePath: '/work/a' })).resolves.toMatchObject({
      workspacePath: '/work/a',
    });
  });

  it('reports unknown projects', async () => {
    await expectAtlasError(
      ctx.service.update('00000000-0000-4000-8000-999999999999', { name: 'x' }),
      'PROJECT_NOT_FOUND',
    );
    await expectAtlasError(ctx.service.update('not-a-uuid', { name: 'x' }), 'PROJECT_NOT_FOUND');
  });

  it('rejects an empty update', async () => {
    await expectAtlasError(ctx.service.update(id, {}), 'VALIDATION_FAILED');
  });
});

describe('ProjectService.remove', () => {
  it('removes only the registry entry and clears a matching selection', async () => {
    const ctx = setup();
    ctx.inspector.set('/work/a', { status: 'available' }).set('/work/b', { status: 'available' });
    const a = await ctx.service.create({ name: 'A', workspacePath: '/work/a' });
    const b = await ctx.service.create({ name: 'B', workspacePath: '/work/b' });
    await ctx.service.selectProject(a.id);

    await ctx.service.remove(a.id);

    expect(await ctx.service.findAll()).toEqual([expect.objectContaining({ id: b.id })]);
    expect(ctx.settings.values.has(SELECTED_PROJECT_SETTING)).toBe(false);
  });

  it('keeps the selection when another project is removed', async () => {
    const ctx = setup();
    ctx.inspector.set('/work/a', { status: 'available' }).set('/work/b', { status: 'available' });
    const a = await ctx.service.create({ name: 'A', workspacePath: '/work/a' });
    const b = await ctx.service.create({ name: 'B', workspacePath: '/work/b' });
    await ctx.service.selectProject(a.id);
    await ctx.service.remove(b.id);
    expect((await ctx.service.getSelectedProject())?.id).toBe(a.id);
  });

  it('reports unknown projects', async () => {
    const ctx = setup();
    await expectAtlasError(
      ctx.service.remove('00000000-0000-4000-8000-999999999999'),
      'PROJECT_NOT_FOUND',
    );
  });
});

describe('selection', () => {
  it('records lastOpenedAt without modifying other projects', async () => {
    const ctx = setup();
    ctx.inspector.set('/work/a', { status: 'available' }).set('/work/b', { status: 'available' });
    const a = await ctx.service.create({ name: 'A', workspacePath: '/work/a' });
    const b = await ctx.service.create({ name: 'B', workspacePath: '/work/b' });

    await ctx.service.selectProject(a.id);

    expect((await ctx.service.getSelectedProject())?.id).toBe(a.id);
    expect((await ctx.service.findById(a.id))?.lastOpenedAt).toBeDefined();
    expect(await ctx.service.findById(b.id)).toEqual(b);
  });

  it('returns null when nothing is selected', async () => {
    await expect(setup().service.getSelectedProject()).resolves.toBeNull();
  });

  it('clears a stale selection that points to a removed record', async () => {
    const ctx = setup();
    ctx.settings.values.set(SELECTED_PROJECT_SETTING, '00000000-0000-4000-8000-999999999999');
    await expect(ctx.service.getSelectedProject()).resolves.toBeNull();
    expect(ctx.settings.values.has(SELECTED_PROJECT_SETTING)).toBe(false);
  });

  it('still restores a selected project whose directory became unavailable', async () => {
    const ctx = setup();
    ctx.inspector.set('/work/a', { status: 'available' });
    const a = await ctx.service.create({ name: 'A', workspacePath: '/work/a' });
    await ctx.service.selectProject(a.id);
    ctx.inspector.set('/work/a', { status: 'missing' });

    expect((await ctx.service.getSelectedProject())?.id).toBe(a.id);
    const details = await ctx.service.getDetails(a.id);
    expect(details.availability.status).toBe('missing');
    expect(details.isSelected).toBe(true);
  });

  it('allows selecting an unavailable project without losing stored Git metadata', async () => {
    const ctx = setup();
    ctx.inspector.set('/work/a', { status: 'available', gitRoot: '/work/a' });
    const a = await ctx.service.create({ name: 'A', workspacePath: '/work/a' });
    ctx.inspector.set('/work/a', { status: 'missing' });
    await ctx.service.selectProject(a.id);
    expect((await ctx.service.findById(a.id))?.git).toEqual({
      isRepository: true,
      repositoryRoot: '/work/a',
    });
  });

  it('rejects selecting unknown projects', async () => {
    await expectAtlasError(
      setup().service.selectProject('00000000-0000-4000-8000-999999999999'),
      'PROJECT_NOT_FOUND',
    );
  });
});

describe('unavailable directories', () => {
  it('keeps unavailable projects registered and reports their status', async () => {
    const ctx = setup();
    ctx.inspector.set('/work/a', { status: 'available' });
    const a = await ctx.service.create({ name: 'A', workspacePath: '/work/a' });
    ctx.inspector.set('/work/a', { status: 'missing' });

    const list = await ctx.service.listDetails();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ project: { id: a.id }, availability: { status: 'missing' } });
  });

  it('lets the user fix the path of an unavailable project', async () => {
    const ctx = setup();
    ctx.inspector.set('/work/a', { status: 'available' });
    const a = await ctx.service.create({ name: 'A', workspacePath: '/work/a' });
    ctx.inspector.set('/work/a', { status: 'missing' }).set('/work/moved', { status: 'available' });
    const updated = await ctx.service.update(a.id, { workspacePath: '/work/moved' });
    expect(updated.workspacePath).toBe('/work/moved');
  });
});

describe('inspectPath', () => {
  it('reports unavailable directories without throwing', async () => {
    const inspection = await setup().service.inspectPath('/nowhere');
    expect(inspection.availability.status).toBe('missing');
  });
});
