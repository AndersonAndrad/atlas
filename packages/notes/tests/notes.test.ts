import {
  noteLinkHref,
  parseNoteLink,
  type NoteCounts,
  type NoteSummary,
  type ProjectNote,
} from '@atlas/contracts';
import {
  NotesService,
  ftsQuery,
  noteExcerpt,
  type NoteLinkTargets,
  type NoteRepository,
  type NoteRepositoryQuery,
} from '@atlas/notes';
import { AtlasError, noopLogger } from '@atlas/shared';
import { describe, expect, it } from 'vitest';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const PROJECT = id(900);
let branchReads = 0;
const SESSION = id(901);

/** In-memory repository with the revision guard of the SQLite one (no search). */
class MemoryRepository implements NoteRepository {
  notes = new Map<string, ProjectNote>();
  /** Simulates another client writing between the service's read and write. */
  raceOnUpdate = false;
  async insert(note: ProjectNote) {
    this.notes.set(note.id, structuredClone(note));
  }
  async get(noteId: string) {
    const note = this.notes.get(noteId);
    return note === undefined ? null : structuredClone(note);
  }
  async update(note: ProjectNote, expectedRevision: number) {
    const stored = this.notes.get(note.id);
    if (this.raceOnUpdate && stored) stored.revision += 1;
    if (stored?.revision !== expectedRevision) return false;
    this.notes.set(note.id, structuredClone(note));
    return true;
  }
  async remove(noteId: string) {
    return this.notes.delete(noteId);
  }
  lastQuery: NoteRepositoryQuery | null = null;
  async list(query: NoteRepositoryQuery): Promise<NoteSummary[]> {
    this.lastQuery = query;
    return [...this.notes.values()].map(({ content, ...rest }) => ({
      ...rest,
      excerpt: noteExcerpt(content),
    }));
  }
  async categories() {
    return [];
  }
  async counts(): Promise<NoteCounts> {
    return { active: this.notes.size, pinned: 0, archived: 0 };
  }
}

const targets: NoteLinkTargets = {
  projectWorkspace: async (projectId) => {
    if (projectId !== PROJECT) throw new AtlasError('PROJECT_NOT_FOUND');
    return '/work/app';
  },
  sessionTitle: async (sessionId) => (sessionId === SESSION ? 'Refactor' : null),
  branchNames: async () => {
    branchReads += 1;
    return new Set(['feature/notes']);
  },
  resolveFile: async (_projectId, relativePath) =>
    relativePath === 'src/index.ts' ? '/work/app/src/index.ts' : null,
};

function setup() {
  const repository = new MemoryRepository();
  const changes: string[] = [];
  let next = 0;
  let minute = 0;
  const service = new NotesService({
    repository,
    links: targets,
    clock: { now: () => new Date(Date.UTC(2026, 9, 24, 12, minute++)) },
    generateId: () => id(++next),
    logger: noopLogger,
    onChange: (noteId) => changes.push(noteId),
  });
  return { service, repository, changes };
}

const code = async (promise: Promise<unknown>) =>
  promise.then(
    () => 'ok',
    (error: unknown) => (error instanceof AtlasError ? error.code : 'unexpected'),
  );

describe('NotesService', () => {
  it('creates project notes with the project folder and global notes without one', async () => {
    const { service, changes } = setup();
    const project = await service.create({
      projectId: PROJECT,
      title: '  Decisions  ',
      content: '# ADR',
      category: '  Architecture ',
    });
    expect(project).toMatchObject({
      projectId: PROJECT,
      workspacePath: '/work/app',
      title: 'Decisions',
      category: 'Architecture',
      pinned: false,
      archived: false,
      revision: 1,
    });
    const global = await service.create({ projectId: null, title: 'Shortcuts', content: '' });
    expect(global).toMatchObject({ projectId: null, workspacePath: null, category: null });
    expect(changes).toEqual([project.id, global.id]);
    expect(await code(service.create({ projectId: id(77), title: 'X', content: '' }))).toBe(
      'PROJECT_NOT_FOUND',
    );
  });

  it('validates titles, content size and categories', async () => {
    const { service } = setup();
    for (const input of [
      { projectId: null, title: '   ', content: '' },
      { projectId: null, title: 'x'.repeat(201), content: '' },
      { projectId: null, title: 'T', content: 'x'.repeat(200_001) },
      { projectId: null, title: 'T', content: '', category: 'c'.repeat(61) },
      { projectId: null, title: 'T', content: '', extra: true },
    ]) {
      expect(await code(service.create(input as never))).toBe('VALIDATION_FAILED');
    }
  });

  it('updates only the revision that was edited and reports conflicts', async () => {
    const { service, repository } = setup();
    const note = await service.create({ projectId: null, title: 'A', content: 'one' });
    const saved = await service.update(note.id, { expectedRevision: 1, content: 'two' });
    expect(saved).toMatchObject({ content: 'two', title: 'A', revision: 2 });
    expect(saved.updatedAt > note.updatedAt).toBe(true);
    // A second editor still holding revision 1 must not overwrite revision 2.
    expect(await code(service.update(note.id, { expectedRevision: 1, content: 'stale' }))).toBe(
      'NOTE_CONFLICT',
    );
    repository.raceOnUpdate = true;
    expect(await code(service.update(note.id, { expectedRevision: 2, pinned: true }))).toBe(
      'NOTE_CONFLICT',
    );
    repository.raceOnUpdate = false;
    expect((await service.get(note.id)).content).toBe('two');
    // Deleted between the read and the write: reported as missing.
    const original = repository.update.bind(repository);
    repository.update = async (changed, expected) => {
      await repository.remove(changed.id);
      return original(changed, expected);
    };
    const before = await service.get(note.id);
    expect(
      await code(service.update(note.id, { expectedRevision: before.revision, title: 'X' })),
    ).toBe('NOTE_NOT_FOUND');
    repository.update = original;
    await repository.insert(before);
    const cleared = await service.update(note.id, {
      expectedRevision: (await service.get(note.id)).revision,
      category: '',
      archived: true,
    });
    expect(cleared).toMatchObject({ category: null, archived: true, content: 'two' });
    expect(await code(service.update(id(99), { expectedRevision: 1 }))).toBe('NOTE_NOT_FOUND');
  });

  it('removes notes and reports missing ones', async () => {
    const { service } = setup();
    const note = await service.create({ projectId: null, title: 'A', content: '' });
    await service.remove(note.id);
    expect(await code(service.get(note.id))).toBe('NOTE_NOT_FOUND');
    expect(await code(service.remove(note.id))).toBe('NOTE_NOT_FOUND');
  });

  it('lists a project with its folder and turns search text into a safe FTS query', async () => {
    const { service, repository } = setup();
    await service.list({
      scope: { kind: 'project', projectId: PROJECT },
      search: 'tar"ifa OR NEAR(x',
    });
    expect(repository.lastQuery).toEqual({
      owner: { kind: 'project', projectId: PROJECT, workspacePath: '/work/app' },
      filter: 'active',
      match: '"tarifa"* "OR"* "NEAR(x"*',
      category: null,
      limit: 500,
    });
    expect(await code(service.list({ scope: { kind: 'project', projectId: id(5) } }))).toBe(
      'PROJECT_NOT_FOUND',
    );
  });

  it('checks atlas links against notes, sessions, branches and files', async () => {
    const { service } = setup();
    const target = await service.create({ projectId: null, title: 'Target', content: '' });
    const links = [
      `atlas:note/${target.id}`,
      `atlas:note/${id(55)}`,
      `atlas:session/${SESSION}`,
      'atlas:branch/feature/notes',
      'atlas:branch/missing',
      'atlas:file/src/index.ts',
      'atlas:file/../secret',
      'javascript:alert(1)',
    ];
    branchReads = 0;
    const statuses = await service.checkLinks({ projectId: PROJECT, links });
    expect(branchReads).toBe(1);
    expect(statuses.map((status) => [status.valid, status.label])).toEqual([
      [true, 'Target'],
      [false, null],
      [true, 'Refactor'],
      [true, 'feature/notes'],
      [false, null],
      [true, 'src/index.ts'],
      [false, null],
      [false, null],
    ]);
    // Global notes have no folder: branch and file links cannot resolve.
    const global = await service.checkLinks({
      projectId: null,
      links: ['atlas:branch/feature/notes', 'atlas:file/src/index.ts'],
    });
    expect(global.every((status) => !status.valid)).toBe(true);
  });

  it('resolves file links for revealing only inside the project', async () => {
    const { service } = setup();
    expect(await service.filePath({ projectId: PROJECT, href: 'atlas:file/src/index.ts' })).toBe(
      '/work/app/src/index.ts',
    );
    for (const href of ['atlas:file/missing', `atlas:note/${id(1)}`, 'atlas:file//etc/passwd']) {
      expect(await code(service.filePath({ projectId: PROJECT, href }))).toBe('VALIDATION_FAILED');
    }
  });
});

describe('note links', () => {
  it('parses only safe atlas links', () => {
    expect(parseNoteLink(`atlas:note/${id(1).toUpperCase()}`)).toEqual({ kind: 'note', id: id(1) });
    expect(parseNoteLink('atlas:branch/feat/x-1.2')).toEqual({
      kind: 'branch',
      name: 'feat/x-1.2',
    });
    expect(parseNoteLink('atlas:file/docs/My%20Notes.md')).toEqual({
      kind: 'file',
      path: 'docs/My Notes.md',
    });
    for (const href of [
      'atlas:note/123',
      'atlas:branch/a..b',
      'atlas:branch/-x',
      'atlas:branch/a b',
      'atlas:file/../x',
      'atlas:file/a/./b',
      'atlas:file//etc',
      'atlas:file/a%5Cb',
      'atlas:file/%00',
      'atlas:file/%E0%A4%A',
      'atlas:other/x',
      'atlas:note/',
      'https://example.com',
    ]) {
      expect(parseNoteLink(href)).toBeNull();
    }
  });

  it('builds links that parse back to the same target', () => {
    for (const link of [
      { kind: 'note', id: id(3) },
      { kind: 'branch', name: 'release/1.0' },
      { kind: 'file', path: 'docs/a b#c.md' },
    ] as const) {
      expect(parseNoteLink(noteLinkHref(link))).toEqual(link);
    }
  });
});

describe('helpers', () => {
  it('quotes every search term', () => {
    expect(ftsQuery('  ')).toBeNull();
    expect(ftsQuery('motor "tarifa')).toBe('"motor"* "tarifa"*');
  });

  it('builds a short plain-text excerpt from Markdown', () => {
    expect(noteExcerpt('# Title\n\n- [x] **done** item\n> quote with [link](atlas:note/x)')).toBe(
      'Title done item quote with link',
    );
    expect(noteExcerpt('word '.repeat(100))).toHaveLength(160);
  });
});
