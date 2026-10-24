import {
  CheckNoteLinksSchema,
  CreateNoteSchema,
  NOTE_EXCERPT_MAX,
  NOTE_LIST_LIMIT_MAX,
  NoteIdSchema,
  NoteListQuerySchema,
  RevealNoteFileSchema,
  UpdateNoteSchema,
  parseInput,
  parseNoteLink,
  type CheckNoteLinksInput,
  type CreateNoteInput,
  type NoteLinkStatus,
  type NoteList,
  type NoteListQuery,
  type NoteScope,
  type ProjectNote,
  type RevealNoteFileInput,
  type UpdateNoteInput,
} from '@atlas/contracts';
import { AtlasError, describeError, type Logger } from '@atlas/shared';
import type { NoteLinkTargets, NoteOwnerFilter, NoteRepository } from './ports.js';

export interface NotesServiceOptions {
  repository: NoteRepository;
  links: NoteLinkTargets;
  clock: { now(): Date };
  generateId: () => string;
  logger: Logger;
  /** Called after every change, so every client can refresh. */
  onChange?: (noteId: string) => void;
}

/**
 * Turns user text into an FTS5 query of quoted prefix terms, so operators or quotes
 * typed by the user are never interpreted as query syntax.
 */
export function ftsQuery(search: string): string | null {
  const terms = search
    .split(/\s+/)
    .map((term) => term.replace(/"/g, ''))
    .filter((term) => term !== '');
  return terms.length === 0 ? null : terms.map((term) => `"${term}"*`).join(' ');
}

/** A single line of plain text from the start of a Markdown note, for lists. */
export function noteExcerpt(markdown: string): string {
  const text = markdown
    .slice(0, NOTE_EXCERPT_MAX * 4)
    .replace(/```[^\n]*/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]\s+\[[ xX]\]|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/[*_`~|]/g, '')
    // eslint-disable-next-line no-control-regex -- removing control characters is the point.
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length <= NOTE_EXCERPT_MAX
    ? text
    : `${text.slice(0, NOTE_EXCERPT_MAX - 1).trimEnd()}…`;
}

/**
 * Project Hub notes (SDD-010 Milestone A): local Markdown notes of a project, of a
 * workspace or global. Nothing here touches project files; links are only resolved.
 */
export class NotesService {
  constructor(private readonly options: NotesServiceOptions) {}

  async list(query: NoteListQuery): Promise<NoteList> {
    const parsed = parseInput(NoteListQuerySchema, query);
    const owner = await this.owner(parsed.scope);
    const match = parsed.search === undefined ? null : ftsQuery(parsed.search);
    const [notes, categories, counts] = await Promise.all([
      this.options.repository.list({
        owner,
        filter: parsed.filter ?? 'active',
        match,
        category: parsed.category ?? null,
        limit: parsed.limit ?? NOTE_LIST_LIMIT_MAX,
      }),
      this.options.repository.categories(owner),
      this.options.repository.counts(owner),
    ]);
    return { notes, categories, counts };
  }

  async get(id: string): Promise<ProjectNote> {
    const note = await this.options.repository.get(parseInput(NoteIdSchema, id));
    if (note === null) throw new AtlasError('NOTE_NOT_FOUND', undefined, { details: { id } });
    return note;
  }

  async create(input: CreateNoteInput): Promise<ProjectNote> {
    const parsed = parseInput(CreateNoteSchema, input);
    const workspacePath =
      parsed.projectId === null
        ? null
        : await this.options.links.projectWorkspace(parsed.projectId);
    const now = this.now();
    const note: ProjectNote = {
      id: this.options.generateId(),
      projectId: parsed.projectId,
      workspacePath,
      title: parsed.title,
      content: parsed.content,
      category: parsed.category ?? null,
      pinned: parsed.pinned ?? false,
      archived: false,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    await this.options.repository.insert(note);
    this.changed(note.id);
    return note;
  }

  /** Applies the change only to the revision the user edited (FR-1008). */
  async update(id: string, input: UpdateNoteInput): Promise<ProjectNote> {
    const changes = parseInput(UpdateNoteSchema, input);
    const stored = await this.get(id);
    if (stored.revision !== changes.expectedRevision) {
      throw new AtlasError('NOTE_CONFLICT', undefined, {
        details: { id, expected: changes.expectedRevision, stored: stored.revision },
      });
    }
    const note: ProjectNote = {
      ...stored,
      title: changes.title ?? stored.title,
      content: changes.content ?? stored.content,
      category: changes.category === undefined ? stored.category : changes.category,
      pinned: changes.pinned ?? stored.pinned,
      archived: changes.archived ?? stored.archived,
      revision: stored.revision + 1,
      updatedAt: this.now(),
    };
    if (!(await this.options.repository.update(note, stored.revision))) {
      // Another client wrote (or deleted the note) between the read and the write.
      const deleted = (await this.options.repository.get(id)) === null;
      throw new AtlasError(deleted ? 'NOTE_NOT_FOUND' : 'NOTE_CONFLICT', undefined, {
        details: { id },
      });
    }
    this.changed(note.id);
    return note;
  }

  async remove(id: string): Promise<void> {
    if (!(await this.options.repository.remove(parseInput(NoteIdSchema, id)))) {
      throw new AtlasError('NOTE_NOT_FOUND', undefined, { details: { id } });
    }
    this.changed(id);
  }

  /** Whether each `atlas:` link resolves; malformed links are reported as broken. */
  async checkLinks(input: CheckNoteLinksInput): Promise<NoteLinkStatus[]> {
    const { projectId, links } = parseInput(CheckNoteLinksSchema, input);
    if (projectId !== null) await this.options.links.projectWorkspace(projectId);
    // Branches are read once per check, however many branch links the note has.
    let branches: Promise<ReadonlySet<string>> | null = null;
    const branchNames = () => {
      branches ??=
        projectId === null
          ? Promise.resolve(new Set<string>())
          : this.options.links.branchNames(projectId);
      return branches;
    };
    return Promise.all(
      [...new Set(links)].map(async (href) => {
        try {
          return await this.checkLink(projectId, href, branchNames);
        } catch (error) {
          this.options.logger.info('Note link could not be checked', {
            error: describeError(error),
          });
          return { href, valid: false, label: null };
        }
      }),
    );
  }

  /** Absolute path of an `atlas:file/...` link inside the project's folder. */
  async filePath(input: RevealNoteFileInput): Promise<string> {
    const { projectId, href } = parseInput(RevealNoteFileSchema, input);
    const link = parseNoteLink(href);
    const resolved =
      link?.kind === 'file' ? await this.options.links.resolveFile(projectId, link.path) : null;
    if (resolved === null) {
      throw new AtlasError('VALIDATION_FAILED', 'The linked file is not available.', {
        issues: [{ field: 'href', message: 'The file does not exist in this project.' }],
      });
    }
    return resolved;
  }

  private async checkLink(
    projectId: string | null,
    href: string,
    branchNames: () => Promise<ReadonlySet<string>>,
  ): Promise<NoteLinkStatus> {
    const link = parseNoteLink(href);
    const broken = { href, valid: false, label: null };
    if (link === null) return broken;
    switch (link.kind) {
      case 'note': {
        const note = await this.options.repository.get(link.id);
        return note === null ? broken : { href, valid: true, label: note.title };
      }
      case 'session': {
        const title = await this.options.links.sessionTitle(link.id);
        return title === null ? broken : { href, valid: true, label: title };
      }
      case 'branch':
        // Branches and files belong to a project's folder; global notes have none.
        if (projectId === null) return broken;
        return (await branchNames()).has(link.name)
          ? { href, valid: true, label: link.name }
          : broken;
      case 'file':
        if (projectId === null) return broken;
        return (await this.options.links.resolveFile(projectId, link.path)) === null
          ? broken
          : { href, valid: true, label: link.path };
    }
  }

  private async owner(scope: NoteScope): Promise<NoteOwnerFilter> {
    if (scope.kind !== 'project') return scope;
    return {
      kind: 'project',
      projectId: scope.projectId,
      workspacePath: await this.options.links.projectWorkspace(scope.projectId),
    };
  }

  private changed(noteId: string): void {
    try {
      this.options.onChange?.(noteId);
    } catch (error) {
      this.options.logger.warn('Note listener failed', { error: describeError(error) });
    }
  }

  private now(): string {
    return this.options.clock.now().toISOString();
  }
}
