import { z } from 'zod';
import { ProjectIdSchema } from './project.js';

// ---------------------------------------------------------------------------
// Project Hub notes (SDD-010 Milestone A, PLAN-032)
// ---------------------------------------------------------------------------

export const NOTE_TITLE_MAX = 200;
/** Characters of Markdown in one note. */
export const NOTE_CONTENT_MAX = 200_000;
export const NOTE_CATEGORY_MAX = 60;
export const NOTE_SEARCH_MAX = 200;
export const NOTE_LIST_LIMIT_MAX = 500;
/** Characters of the plain-text excerpt returned by lists. */
export const NOTE_EXCERPT_MAX = 160;
/** Links checked in one request (FR-1006). */
export const NOTE_LINKS_MAX = 100;

export const NoteIdSchema = z.uuid({ message: 'Invalid note identifier.' });

/**
 * A Markdown note. Owners: a registered project (`projectId` and its `workspacePath`), a
 * workspace (only `workspacePath`: the note outlived its project's registration, PLAN-032
 * Q2) or global (neither).
 */
export interface ProjectNote {
  id: string;
  projectId: string | null;
  workspacePath: string | null;
  title: string;
  /** Untrusted Markdown: rendered without raw HTML. */
  content: string;
  category: string | null;
  pinned: boolean;
  archived: boolean;
  /** Increases on every change; updates must name the revision they edited (FR-1008). */
  revision: number;
  createdAt: string;
  updatedAt: string;
}

/** A note in lists: its content is replaced by a short plain-text excerpt. */
export interface NoteSummary extends Omit<ProjectNote, 'content'> {
  excerpt: string;
}

const Title = z
  .string()
  .trim()
  .min(1, 'Enter a title.')
  .max(NOTE_TITLE_MAX, `Use at most ${NOTE_TITLE_MAX} characters.`);
const Content = z
  .string()
  .max(
    NOTE_CONTENT_MAX,
    `Notes are limited to ${NOTE_CONTENT_MAX.toLocaleString('en')} characters.`,
  );
/** Free text (PLAN-032 Q3); empty means no category. */
const Category = z
  .string()
  .trim()
  .max(NOTE_CATEGORY_MAX, `Use at most ${NOTE_CATEGORY_MAX} characters.`)
  .transform((value) => (value === '' ? null : value))
  .nullable();

export const CreateNoteSchema = z.strictObject({
  /** Null creates a global note. */
  projectId: ProjectIdSchema.nullable(),
  title: Title,
  content: Content,
  category: Category.optional(),
  pinned: z.boolean().optional(),
});
export type CreateNoteInput = z.input<typeof CreateNoteSchema>;
export type ParsedCreateNote = z.output<typeof CreateNoteSchema>;

/** No defaults: absent fields stay unchanged. */
export const UpdateNoteSchema = z.strictObject({
  expectedRevision: z.int().min(1),
  title: Title.optional(),
  content: Content.optional(),
  category: Category.optional(),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
});
export type UpdateNoteInput = z.input<typeof UpdateNoteSchema>;
export type ParsedUpdateNote = z.output<typeof UpdateNoteSchema>;

/**
 * Which notes a list covers. `project` includes the workspace notes left in the project's
 * folder by an earlier registration; `all` covers every owner.
 */
export const NoteScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('project'), projectId: ProjectIdSchema }),
  z.strictObject({ kind: z.literal('global') }),
  z.strictObject({ kind: z.literal('all') }),
]);
export type NoteScope = z.infer<typeof NoteScopeSchema>;

export const NOTE_FILTERS = ['active', 'pinned', 'archived'] as const;
export type NoteFilter = (typeof NOTE_FILTERS)[number];

export const NoteListQuerySchema = z.strictObject({
  scope: NoteScopeSchema,
  /** `active` (not archived, the default), `pinned` (and not archived) or `archived`. */
  filter: z.enum(NOTE_FILTERS).optional(),
  /** Matches words of the title and content (prefix match). */
  search: z.string().trim().max(NOTE_SEARCH_MAX).optional(),
  category: z.string().trim().min(1).max(NOTE_CATEGORY_MAX).optional(),
  limit: z.int().min(1).max(NOTE_LIST_LIMIT_MAX).optional(),
});
export type NoteListQuery = z.infer<typeof NoteListQuerySchema>;

export interface NoteCounts {
  /** Not archived. */
  active: number;
  pinned: number;
  archived: number;
}

export interface NoteList {
  /** Pinned first, then the most recently updated. */
  notes: NoteSummary[];
  /** Categories used in the scope, for filtering and autocomplete. */
  categories: string[];
  counts: NoteCounts;
}

// ---------------------------------------------------------------------------
// Internal links (FR-1006)
// ---------------------------------------------------------------------------

/** Scheme of links between notes and other ATLAS records, e.g. `atlas:note/<id>`. */
export const NOTE_LINK_SCHEME = 'atlas:';

export type NoteLink =
  | { kind: 'note'; id: string }
  | { kind: 'session'; id: string }
  | { kind: 'branch'; name: string }
  /** Relative to the note's workspace, `/`-separated. */
  | { kind: 'file'; path: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Characters accepted in a branch name; Git itself rejects the rest of `..`, `@{`, etc. */
const BRANCH = /^[A-Za-z0-9._/-]{1,255}$/;
const LINK_TEXT_MAX = 1024;

function decode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/**
 * Parses an `atlas:` link. Returns null for anything else or anything unsafe: a file
 * outside the workspace (absolute, `..`, backslashes, NUL) or an invalid branch name.
 */
export function parseNoteLink(href: string): NoteLink | null {
  if (!href.startsWith(NOTE_LINK_SCHEME) || href.length > LINK_TEXT_MAX) return null;
  const rest = href.slice(NOTE_LINK_SCHEME.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return null;
  const kind = rest.slice(0, slash);
  const value = decode(rest.slice(slash + 1));
  if (value === null || value === '') return null;
  switch (kind) {
    case 'note':
    case 'session':
      return UUID.test(value) ? { kind, id: value.toLowerCase() } : null;
    case 'branch':
      if (!BRANCH.test(value) || value.includes('..') || value.startsWith('-')) return null;
      if (value.startsWith('/') || value.endsWith('/') || value.endsWith('.lock')) return null;
      return { kind, name: value };
    case 'file': {
      if (value.startsWith('/') || value.includes('\\') || value.includes('\0')) return null;
      const segments = value.split('/');
      if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
        return null;
      }
      return { kind, path: value };
    }
    default:
      return null;
  }
}

/** The `atlas:` link of a record, e.g. for inserting a link to another note. */
export function noteLinkHref(link: NoteLink): string {
  switch (link.kind) {
    case 'note':
    case 'session':
      return `${NOTE_LINK_SCHEME}${link.kind}/${link.id}`;
    case 'branch':
      return `${NOTE_LINK_SCHEME}branch/${link.name}`;
    case 'file':
      return `${NOTE_LINK_SCHEME}file/${link.path.split('/').map(encodeURIComponent).join('/')}`;
  }
}

export const CheckNoteLinksSchema = z.strictObject({
  /** The project whose workspace files and branches resolve; null for global notes. */
  projectId: ProjectIdSchema.nullable(),
  links: z.array(z.string().max(LINK_TEXT_MAX)).max(NOTE_LINKS_MAX),
});
export type CheckNoteLinksInput = z.infer<typeof CheckNoteLinksSchema>;

export interface NoteLinkStatus {
  href: string;
  /** False when the link is malformed or its target does not exist (shown as broken). */
  valid: boolean;
  /** Title of the note or session, branch name or file path. */
  label: string | null;
}

export const RevealNoteFileSchema = z.strictObject({
  projectId: ProjectIdSchema,
  /** A `atlas:file/...` link. */
  href: z.string().max(LINK_TEXT_MAX),
});
export type RevealNoteFileInput = z.infer<typeof RevealNoteFileSchema>;
