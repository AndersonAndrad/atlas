import type { NoteCounts, NoteSummary, ProjectNote } from '@atlas/contracts';
import {
  noteExcerpt,
  type NoteOwnerFilter,
  type NoteRepository,
  type NoteRepositoryQuery,
} from '@atlas/notes';
import { AtlasError } from '@atlas/shared';
import type { Database } from './database.js';

type Row = Record<string, string | number | null>;
type Param = string | number | null;

const strOrNull = (row: Row, key: string) => (row[key] as string | null) ?? null;

/** Characters read for list excerpts: enough for Markdown markup around the first line. */
const EXCERPT_SOURCE_CHARS = 640;

const SUMMARY_COLUMNS = `id, project_id, workspace_path, title, category, pinned, archived,
  revision, created_at, updated_at, substr(content, 1, ${EXCERPT_SOURCE_CHARS}) AS head`;

function toSummaryFields(row: Row): Omit<ProjectNote, 'content'> {
  return {
    id: row.id as string,
    projectId: strOrNull(row, 'project_id'),
    workspacePath: strOrNull(row, 'workspace_path'),
    title: row.title as string,
    category: strOrNull(row, 'category'),
    pinned: row.pinned === 1,
    archived: row.archived === 1,
    revision: row.revision as number,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

/** SQL condition and parameters selecting the notes of an owner. */
function ownerClause(owner: NoteOwnerFilter): { sql: string; params: Param[] } {
  switch (owner.kind) {
    case 'project':
      return {
        sql: '(project_id = ? OR (project_id IS NULL AND workspace_path = ?))',
        params: [owner.projectId, owner.workspacePath],
      };
    case 'global':
      return { sql: '(project_id IS NULL AND workspace_path IS NULL)', params: [] };
    case 'all':
      return { sql: '1 = 1', params: [] };
  }
}

const FILTER_CLAUSES = {
  active: 'archived = 0',
  pinned: 'archived = 0 AND pinned = 1',
  archived: 'archived = 1',
} as const;

/** SQLite storage of Project Hub notes (migration v12), searched through FTS5. */
export class SqliteNoteRepository implements NoteRepository {
  constructor(private readonly db: Database) {}

  private run<T>(operation: string, action: () => T): T {
    try {
      return action();
    } catch (error) {
      if (error instanceof AtlasError) throw error;
      throw new AtlasError('PROJECT_PERSISTENCE_ERROR', 'Notes could not be saved.', {
        cause: error,
        details: { operation },
      });
    }
  }

  private transaction<T>(operation: string, action: () => T): T {
    return this.run(operation, () => {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const result = action();
        this.db.exec('COMMIT');
        return result;
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    });
  }

  private index(note: ProjectNote): void {
    this.db.prepare('DELETE FROM notes_search WHERE note_id = ?').run(note.id);
    this.db
      .prepare('INSERT INTO notes_search (note_id, title, content) VALUES (?, ?, ?)')
      .run(note.id, note.title, note.content);
  }

  async insert(note: ProjectNote): Promise<void> {
    this.transaction('insert', () => {
      this.db
        .prepare(
          `INSERT INTO notes (id, project_id, workspace_path, title, content, category, pinned,
             archived, revision, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          note.id,
          note.projectId,
          note.workspacePath,
          note.title,
          note.content,
          note.category,
          note.pinned ? 1 : 0,
          note.archived ? 1 : 0,
          note.revision,
          note.createdAt,
          note.updatedAt,
        );
      this.index(note);
    });
  }

  async get(id: string): Promise<ProjectNote | null> {
    return this.run('get', () => {
      const row = this.db.prepare('SELECT * FROM notes WHERE id = ?').get(id) as Row | undefined;
      return row === undefined ? null : { ...toSummaryFields(row), content: row.content as string };
    });
  }

  async update(note: ProjectNote, expectedRevision: number): Promise<boolean> {
    return this.transaction('update', () => {
      const result = this.db
        .prepare(
          `UPDATE notes SET title = ?, content = ?, category = ?, pinned = ?, archived = ?,
             revision = ?, updated_at = ?
           WHERE id = ? AND revision = ?`,
        )
        .run(
          note.title,
          note.content,
          note.category,
          note.pinned ? 1 : 0,
          note.archived ? 1 : 0,
          note.revision,
          note.updatedAt,
          note.id,
          expectedRevision,
        );
      if (Number(result.changes) === 0) return false;
      this.index(note);
      return true;
    });
  }

  async remove(id: string): Promise<boolean> {
    return this.transaction('remove', () => {
      const result = this.db.prepare('DELETE FROM notes WHERE id = ?').run(id);
      this.db.prepare('DELETE FROM notes_search WHERE note_id = ?').run(id);
      return Number(result.changes) > 0;
    });
  }

  async list(query: NoteRepositoryQuery): Promise<NoteSummary[]> {
    return this.run('list', () => {
      const owner = ownerClause(query.owner);
      const clauses = [owner.sql, FILTER_CLAUSES[query.filter]];
      const params: Param[] = [...owner.params];
      if (query.match !== null) {
        clauses.push('id IN (SELECT note_id FROM notes_search WHERE notes_search MATCH ?)');
        params.push(query.match);
      }
      if (query.category !== null) {
        clauses.push('category = ? COLLATE NOCASE');
        params.push(query.category);
      }
      params.push(query.limit);
      const rows = this.db
        .prepare(
          `SELECT ${SUMMARY_COLUMNS} FROM notes WHERE ${clauses.join(' AND ')}
           ORDER BY pinned DESC, updated_at DESC, id LIMIT ?`,
        )
        .all(...params) as Row[];
      return rows.map((row) => ({
        ...toSummaryFields(row),
        excerpt: noteExcerpt(row.head as string),
      }));
    });
  }

  async categories(owner: NoteOwnerFilter): Promise<string[]> {
    return this.run('categories', () => {
      const clause = ownerClause(owner);
      const rows = this.db
        .prepare(
          `SELECT DISTINCT category FROM notes WHERE ${clause.sql} AND category IS NOT NULL
           ORDER BY category COLLATE NOCASE`,
        )
        .all(...clause.params) as Row[];
      return rows.map((row) => row.category as string);
    });
  }

  async counts(owner: NoteOwnerFilter): Promise<NoteCounts> {
    return this.run('counts', () => {
      const clause = ownerClause(owner);
      const row = this.db
        .prepare(
          `SELECT
             COALESCE(SUM(archived = 0), 0) AS active,
             COALESCE(SUM(archived = 0 AND pinned = 1), 0) AS pinned,
             COALESCE(SUM(archived = 1), 0) AS archived
           FROM notes WHERE ${clause.sql}`,
        )
        .get(...clause.params) as Row;
      return {
        active: Number(row.active),
        pinned: Number(row.pinned),
        archived: Number(row.archived),
      };
    });
  }
}
