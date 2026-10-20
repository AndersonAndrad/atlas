import type { TerminalEvent, TerminalGroup, TerminalSession } from '@atlas/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  FakeMirrorFactory,
  FakePtySpawner,
  FakeShellProvider,
} from '../../../tests/support/fake-terminal.js';
import {
  TerminalGroups,
  TerminalService,
  TerminalSettings,
  type KeyValueStore,
  type TerminalGroupRepository,
  type TerminalSessionRepository,
} from '../src/index.js';

class MemoryGroups implements TerminalGroupRepository {
  rows = new Map<string, TerminalGroup>();
  async findAll() {
    return [...this.rows.values()]
      .map((group) => ({ ...group }))
      .sort((a, b) => a.position - b.position);
  }
  async save(group: TerminalGroup) {
    this.rows.set(group.id, { ...group });
  }
  async saveAll(groups: TerminalGroup[]) {
    for (const group of groups) this.rows.set(group.id, { ...group });
  }
  async delete(id: string) {
    this.rows.delete(id);
  }
}

const sessionRepository: TerminalSessionRepository = {
  findAll: async () => [],
  save: async () => undefined,
  delete: async () => undefined,
  markInterrupted: async () => 0,
};

function memoryStore(): KeyValueStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => void values.set(key, value),
    delete: async (key) => void values.delete(key),
  };
}

describe('TerminalGroups', () => {
  let groups: TerminalGroups;
  let terminals: TerminalService;
  let spawner: FakePtySpawner;
  let store: ReturnType<typeof memoryStore>;
  let events: TerminalEvent[];
  let counter: number;

  beforeEach(() => {
    counter = 1;
    const generateId = () => `00000000-0000-4000-8000-${String(counter++).padStart(12, '0')}`;
    const repository = new MemoryGroups();
    store = memoryStore();
    const settings = new TerminalSettings(store);
    spawner = new FakePtySpawner();
    terminals = new TerminalService({
      sessions: sessionRepository,
      spawner,
      mirrors: new FakeMirrorFactory(),
      shells: new FakeShellProvider(),
      workspaces: {
        resolveProjectDirectory: async () => '/work',
        resolveDirectory: async (directory) => directory,
        assertProjectExists: async () => undefined,
        homeDirectory: () => '/home/me',
      },
      settings,
      environment: { shellEnvironment: () => ({}) },
      cwdResolver: { currentDirectory: async () => null },
      groupExists: (id) => groups.exists(id),
      clock: { now: () => new Date('2026-10-20T00:00:00.000Z') },
      generateId,
      timing: { killTimeoutMs: 50 },
    });
    events = [];
    terminals.onEvent((event) => events.push(event));
    groups = new TerminalGroups({
      groups: repository,
      terminals,
      settings,
      clock: { now: () => new Date('2026-10-20T00:00:00.000Z') },
      generateId,
    });
  });

  const membersOf = (groupId: string | null): TerminalSession[] =>
    terminals.list().filter((session) => session.groupId === groupId);

  it('creates, renames, collapses and reorders groups, publishing each change', async () => {
    const dev = await groups.create('  Desenvolvimento ');
    const personal = await groups.create('Pessoal');
    expect(dev).toMatchObject({ name: 'Desenvolvimento', position: 0, collapsed: false });
    expect(personal.position).toBe(1);

    await groups.rename(dev.id, 'Development');
    await groups.setCollapsed(personal.id, true);
    const reordered = await groups.move(personal.id, 0);
    expect(reordered.map((group) => [group.name, group.position, group.collapsed])).toEqual([
      ['Pessoal', 0, true],
      ['Development', 1, false],
    ]);
    const last = events.at(-1);
    expect(last).toMatchObject({ type: 'groups' });
  });

  it('validates names and identifiers', async () => {
    await expect(groups.create('')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(groups.create('x'.repeat(61))).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(groups.rename('00000000-0000-4000-8000-999999999999', 'x')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('groups terminals from different projects and standalone ones', async () => {
    const group = await groups.create('Mixed');
    await terminals.create({
      projectId: '11111111-1111-4111-8111-111111111111',
      groupId: group.id,
    });
    await terminals.create({
      projectId: '22222222-2222-4222-8222-222222222222',
      groupId: group.id,
    });
    await terminals.create({ cwd: '/srv', groupId: group.id });
    expect(new Set(membersOf(group.id).map((session) => session.projectId))).toEqual(
      new Set([
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
        null,
      ]),
    );
  });

  it('deleting a group keeps its terminals running as ungrouped', async () => {
    const group = await groups.create('Temporary');
    const session = await terminals.create({ cwd: '/srv', groupId: group.id });
    await store.set(`terminal.layout.${group.id}`, '{}');

    await groups.delete(group.id, { terminateTerminals: false });
    expect(terminals.getById(session.id)).toMatchObject({ groupId: null, status: 'RUNNING' });
    expect(spawner.last().kills).toEqual([]);
    expect(await groups.list()).toEqual([]);
    expect(store.values.has(`terminal.layout.${group.id}`)).toBe(false);
  });

  it('terminates the terminals of a deleted group only when asked to', async () => {
    const group = await groups.create('Temporary');
    const session = await terminals.create({ cwd: '/srv', groupId: group.id });
    await groups.delete(group.id, { terminateTerminals: true });
    expect(spawner.last().kills).toEqual(['SIGHUP']);
    expect(terminals.list().some((item) => item.id === session.id)).toBe(false);
  });
});
