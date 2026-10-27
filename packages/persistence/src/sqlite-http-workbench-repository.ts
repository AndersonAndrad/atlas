import type {
  HttpBodyKind,
  HttpCollection,
  HttpFolder,
  HttpHistoryEntry,
  HttpHistoryPage,
  HttpRequestDefinition,
  HttpRequestSummary,
  HttpSavedRequest,
  HttpSnapshot,
  HttpSnapshotSummary,
  ListHttpCollectionsInput,
  MoveHttpItemInput,
} from '@atlas/contracts';
import type {
  HttpCollectionPatch,
  HttpWorkbenchRepository,
  NewHttpCollection,
  NewHttpSnapshot,
  StoredHttpRequest,
} from '@atlas/api-workbench';
import { AtlasError } from '@atlas/shared';
import type { Database } from './database.js';

type Row = Record<string, string | number | null>;
type Param = string | number | null;

const str = (row: Row, key: string) => row[key] as string;
const strOrNull = (row: Row, key: string) => (row[key] as string | null) ?? null;
const numOrNull = (row: Row, key: string) => (row[key] as number | null) ?? null;

function toFolder(row: Row): HttpFolder {
  return {
    id: str(row, 'id'),
    collectionId: str(row, 'collection_id'),
    parentId: strOrNull(row, 'parent_id'),
    name: str(row, 'name'),
    position: row.position as number,
  };
}

function toSummary(row: Row): HttpRequestSummary {
  return {
    id: str(row, 'id'),
    collectionId: str(row, 'collection_id'),
    folderId: strOrNull(row, 'folder_id'),
    name: str(row, 'name'),
    method: str(row, 'method'),
    url: str(row, 'url'),
    position: row.position as number,
  };
}

function toHistory(row: Row): HttpHistoryEntry {
  return {
    id: row.id as number,
    requestId: strOrNull(row, 'request_id'),
    collectionId: strOrNull(row, 'collection_id'),
    method: str(row, 'method'),
    url: str(row, 'url'),
    status: numOrNull(row, 'status'),
    durationMs: row.duration_ms as number,
    responseBytes: numOrNull(row, 'response_bytes'),
    errorCode: strOrNull(row, 'error_code'),
    errorSummary: strOrNull(row, 'error_summary'),
    executedAt: str(row, 'executed_at'),
  };
}

function toSnapshotSummary(row: Row): HttpSnapshotSummary {
  return {
    id: str(row, 'id'),
    requestId: strOrNull(row, 'request_id'),
    name: str(row, 'name'),
    method: str(row, 'method'),
    url: str(row, 'url'),
    status: row.status as number,
    createdAt: str(row, 'created_at'),
  };
}

const COLLECTION_FILTERS = {
  all: '1 = 1',
  global: "scope = 'global'",
  project: `scope = 'global'
    OR (scope = 'project' AND project_id = ?)
    OR (scope = 'shared' AND id IN
      (SELECT collection_id FROM http_collection_projects WHERE project_id = ?))`,
} as const;

/** SQLite storage of the API Workbench (migration v14). */
export class SqliteHttpWorkbenchRepository implements HttpWorkbenchRepository {
  constructor(private readonly db: Database) {}

  private run<T>(operation: string, action: () => T): T {
    try {
      return action();
    } catch (error) {
      if (error instanceof AtlasError) throw error;
      throw new AtlasError('PROJECT_PERSISTENCE_ERROR', 'API Workbench data could not be saved.', {
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

  private all(sql: string, ...params: Param[]): Row[] {
    return this.db.prepare(sql).all(...params) as Row[];
  }

  private one(sql: string, ...params: Param[]): Row | undefined {
    return this.db.prepare(sql).get(...params) as Row | undefined;
  }

  // --- Collections ---------------------------------------------------------

  private collections(where: string, params: Param[]): HttpCollection[] {
    const rows = this.all(
      `SELECT * FROM http_collections WHERE ${where} ORDER BY name COLLATE NOCASE, created_at`,
      ...params,
    );
    if (rows.length === 0) return [];
    const ids = JSON.stringify(rows.map((row) => row.id));
    const inIds = 'collection_id IN (SELECT value FROM json_each(?))';
    const folders = this.all(
      `SELECT * FROM http_folders WHERE ${inIds} ORDER BY position, name`,
      ids,
    ).map(toFolder);
    const requests = this.all(
      `SELECT id, collection_id, folder_id, name, method, url, position FROM http_requests
       WHERE ${inIds} ORDER BY position, name`,
      ids,
    ).map(toSummary);
    const shared = this.all(
      `SELECT collection_id, project_id FROM http_collection_projects WHERE ${inIds}
       ORDER BY project_id`,
      ids,
    );
    return rows.map((row) => {
      const id = str(row, 'id');
      const scope = str(row, 'scope');
      return {
        id,
        name: str(row, 'name'),
        description: str(row, 'description'),
        scope:
          scope === 'global'
            ? { kind: 'global' }
            : scope === 'project'
              ? { kind: 'project', projectId: strOrNull(row, 'project_id') }
              : {
                  kind: 'shared',
                  projectIds: shared
                    .filter((link) => link.collection_id === id)
                    .map((link) => str(link, 'project_id')),
                },
        cookieJar: row.cookie_jar === 1,
        folders: folders.filter((folder) => folder.collectionId === id),
        requests: requests.filter((request) => request.collectionId === id),
        createdAt: str(row, 'created_at'),
        updatedAt: str(row, 'updated_at'),
      };
    });
  }

  listCollections(filter: ListHttpCollectionsInput): HttpCollection[] {
    return this.run('list collections', () => {
      if (filter.kind === 'all') return this.collections(COLLECTION_FILTERS.all, []);
      if (filter.projectId === null) return this.collections(COLLECTION_FILTERS.global, []);
      return this.collections(COLLECTION_FILTERS.project, [filter.projectId, filter.projectId]);
    });
  }

  getCollection(id: string): HttpCollection | null {
    return this.run('get collection', () => this.collections('id = ?', [id])[0] ?? null);
  }

  private insertCollection(collection: NewHttpCollection): void {
    const { scope } = collection;
    this.db
      .prepare(
        `INSERT INTO http_collections (id, name, description, scope, project_id, cookie_jar,
           created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        collection.id,
        collection.name,
        collection.description,
        scope.kind,
        scope.kind === 'project' ? scope.projectId : null,
        collection.cookieJar ? 1 : 0,
        collection.createdAt,
        collection.createdAt,
      );
    if (scope.kind === 'shared') this.shareWith(collection.id, scope.projectIds);
  }

  private shareWith(collectionId: string, projectIds: readonly string[]): void {
    this.db
      .prepare('DELETE FROM http_collection_projects WHERE collection_id = ?')
      .run(collectionId);
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO http_collection_projects (collection_id, project_id) VALUES (?, ?)',
    );
    for (const projectId of projectIds) insert.run(collectionId, projectId);
  }

  createCollection(collection: NewHttpCollection): void {
    this.transaction('create collection', () => this.insertCollection(collection));
  }

  updateCollection(id: string, patch: HttpCollectionPatch, updatedAt: string): boolean {
    return this.transaction('update collection', () => {
      const row = this.one('SELECT id FROM http_collections WHERE id = ?', id);
      if (row === undefined) return false;
      const sets: string[] = ['updated_at = ?'];
      const params: Param[] = [updatedAt];
      if (patch.name !== undefined) {
        sets.push('name = ?');
        params.push(patch.name);
      }
      if (patch.description !== undefined) {
        sets.push('description = ?');
        params.push(patch.description);
      }
      if (patch.cookieJar !== undefined) {
        sets.push('cookie_jar = ?');
        params.push(patch.cookieJar ? 1 : 0);
      }
      if (patch.scope !== undefined) {
        sets.push('scope = ?', 'project_id = ?');
        params.push(
          patch.scope.kind,
          patch.scope.kind === 'project' ? patch.scope.projectId : null,
        );
      }
      this.db
        .prepare(`UPDATE http_collections SET ${sets.join(', ')} WHERE id = ?`)
        .run(...params, id);
      if (patch.scope !== undefined) {
        this.shareWith(id, patch.scope.kind === 'shared' ? patch.scope.projectIds : []);
      }
      return true;
    });
  }

  deleteCollection(id: string): boolean {
    return this.run(
      'delete collection',
      () => this.db.prepare('DELETE FROM http_collections WHERE id = ?').run(id).changes > 0,
    );
  }

  insertCollectionTree(
    collection: NewHttpCollection,
    folders: HttpFolder[],
    requests: StoredHttpRequest[],
  ): void {
    this.transaction('duplicate collection', () => {
      this.insertCollection(collection);
      const insertFolder = this.db.prepare(
        `INSERT INTO http_folders (id, collection_id, parent_id, name, position, created_at,
           updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      // Parents before their children.
      const inserted = new Set<string>();
      let pending = folders;
      while (pending.length > 0) {
        const ready = pending.filter((f) => f.parentId === null || inserted.has(f.parentId));
        if (ready.length === 0) throw new Error('Folder tree has no root.');
        for (const folder of ready) {
          insertFolder.run(
            folder.id,
            collection.id,
            folder.parentId,
            folder.name,
            folder.position,
            collection.createdAt,
            collection.createdAt,
          );
          inserted.add(folder.id);
        }
        pending = pending.filter((folder) => !inserted.has(folder.id));
      }
      for (const request of requests) this.insertRequest(request, collection.createdAt);
    });
  }

  // --- Folders -------------------------------------------------------------

  getFolder(id: string): HttpFolder | null {
    return this.run('get folder', () => {
      const row = this.one('SELECT * FROM http_folders WHERE id = ?', id);
      return row === undefined ? null : toFolder(row);
    });
  }

  private nextPosition(
    table: 'http_folders' | 'http_requests',
    collectionId: string,
    parent: string | null,
  ): number {
    const column = table === 'http_folders' ? 'parent_id' : 'folder_id';
    const row = this.one(
      `SELECT COALESCE(MAX(position) + 1, 0) AS next FROM ${table}
       WHERE collection_id = ? AND ${column} IS ?`,
      collectionId,
      parent,
    );
    return (row?.next as number | undefined) ?? 0;
  }

  createFolder(folder: Omit<HttpFolder, 'position'>, createdAt: string): HttpFolder {
    return this.transaction('create folder', () => {
      const position = this.nextPosition('http_folders', folder.collectionId, folder.parentId);
      this.db
        .prepare(
          `INSERT INTO http_folders (id, collection_id, parent_id, name, position, created_at,
             updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          folder.id,
          folder.collectionId,
          folder.parentId,
          folder.name,
          position,
          createdAt,
          createdAt,
        );
      this.touch(folder.collectionId, createdAt);
      return { ...folder, position };
    });
  }

  renameFolder(id: string, name: string, updatedAt: string): boolean {
    return this.run(
      'rename folder',
      () =>
        this.db
          .prepare('UPDATE http_folders SET name = ?, updated_at = ? WHERE id = ?')
          .run(name, updatedAt, id).changes > 0,
    );
  }

  deleteFolder(id: string): boolean {
    // Subfolders and their requests go with it (foreign keys).
    return this.run(
      'delete folder',
      () => this.db.prepare('DELETE FROM http_folders WHERE id = ?').run(id).changes > 0,
    );
  }

  // --- Requests ------------------------------------------------------------

  getRequest(id: string): HttpSavedRequest | null {
    return this.run('get request', () => {
      const row = this.one('SELECT * FROM http_requests WHERE id = ?', id);
      if (row === undefined) return null;
      return {
        ...toSummary(row),
        definition: JSON.parse(str(row, 'definition')) as HttpRequestDefinition,
        createdAt: str(row, 'created_at'),
        updatedAt: str(row, 'updated_at'),
      };
    });
  }

  private insertRequest(request: StoredHttpRequest, now: string): void {
    const position = this.nextPosition('http_requests', request.collectionId, request.folderId);
    this.db
      .prepare(
        `INSERT INTO http_requests (id, collection_id, folder_id, name, position, method, url,
           definition, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        request.id,
        request.collectionId,
        request.folderId,
        request.name,
        position,
        request.definition.method,
        request.definition.url,
        JSON.stringify(request.definition),
        now,
        now,
      );
  }

  saveRequest(request: StoredHttpRequest, now: string): HttpSavedRequest {
    this.transaction('save request', () => {
      const existing = this.one(
        'SELECT collection_id, folder_id FROM http_requests WHERE id = ?',
        request.id,
      );
      if (existing === undefined) {
        this.insertRequest(request, now);
      } else {
        const moved =
          existing.collection_id !== request.collectionId ||
          existing.folder_id !== request.folderId;
        this.db
          .prepare(
            `UPDATE http_requests SET collection_id = ?, folder_id = ?, name = ?, method = ?,
               url = ?, definition = ?, updated_at = ?,
               position = CASE WHEN ? THEN ? ELSE position END
             WHERE id = ?`,
          )
          .run(
            request.collectionId,
            request.folderId,
            request.name,
            request.definition.method,
            request.definition.url,
            JSON.stringify(request.definition),
            now,
            moved ? 1 : 0,
            moved ? this.nextPosition('http_requests', request.collectionId, request.folderId) : 0,
            request.id,
          );
      }
      this.touch(request.collectionId, now);
    });
    return this.getRequest(request.id)!;
  }

  deleteRequest(id: string): boolean {
    return this.run(
      'delete request',
      () => this.db.prepare('DELETE FROM http_requests WHERE id = ?').run(id).changes > 0,
    );
  }

  move(input: MoveHttpItemInput, updatedAt: string): void {
    this.transaction('move', () => {
      if (input.kind === 'request') {
        this.db
          .prepare(
            'UPDATE http_requests SET collection_id = ?, folder_id = ?, updated_at = ? WHERE id = ?',
          )
          .run(input.collectionId, input.folderId, updatedAt, input.id);
        this.reorder('http_requests', input.collectionId, input.folderId, input.id, input.position);
      } else {
        const subtree = this.all(
          `WITH RECURSIVE tree(id) AS (
             SELECT ? UNION ALL SELECT f.id FROM http_folders f JOIN tree ON f.parent_id = tree.id)
           SELECT id FROM tree`,
          input.id,
        ).map((row) => str(row, 'id'));
        if (input.folderId !== null && subtree.includes(input.folderId)) {
          throw new AtlasError('VALIDATION_FAILED', 'A folder cannot be moved into itself.', {
            issues: [{ field: 'folderId', message: 'A folder cannot be moved into itself.' }],
          });
        }
        const ids = JSON.stringify(subtree);
        this.db
          .prepare('UPDATE http_folders SET parent_id = ?, updated_at = ? WHERE id = ?')
          .run(input.folderId, updatedAt, input.id);
        // The whole subtree follows the folder into the target collection.
        this.db
          .prepare(
            'UPDATE http_folders SET collection_id = ? WHERE id IN (SELECT value FROM json_each(?))',
          )
          .run(input.collectionId, ids);
        this.db
          .prepare(
            'UPDATE http_requests SET collection_id = ? WHERE folder_id IN (SELECT value FROM json_each(?))',
          )
          .run(input.collectionId, ids);
        this.reorder('http_folders', input.collectionId, input.folderId, input.id, input.position);
      }
      this.touch(input.collectionId, updatedAt);
    });
  }

  /** Puts `id` at `position` among its siblings and numbers them again from 0. */
  private reorder(
    table: 'http_folders' | 'http_requests',
    collectionId: string,
    parent: string | null,
    id: string,
    position: number,
  ): void {
    const column = table === 'http_folders' ? 'parent_id' : 'folder_id';
    const siblings = this.all(
      `SELECT id FROM ${table} WHERE collection_id = ? AND ${column} IS ? AND id != ?
       ORDER BY position, name`,
      collectionId,
      parent,
      id,
    ).map((row) => str(row, 'id'));
    siblings.splice(Math.min(position, siblings.length), 0, id);
    const update = this.db.prepare(`UPDATE ${table} SET position = ? WHERE id = ?`);
    siblings.forEach((sibling, index) => update.run(index, sibling));
  }

  private touch(collectionId: string, updatedAt: string): void {
    this.db
      .prepare('UPDATE http_collections SET updated_at = ? WHERE id = ?')
      .run(updatedAt, collectionId);
  }

  isStoredFile(path: string): boolean {
    return this.run(
      'find file',
      () =>
        this.one(
          `SELECT 1 AS found FROM http_requests, json_tree(http_requests.definition) AS node
           WHERE node.key = 'path' AND node.type = 'text' AND node.value = ? LIMIT 1`,
          path,
        ) !== undefined,
    );
  }

  // --- History -------------------------------------------------------------

  addHistory(entry: Omit<HttpHistoryEntry, 'id'>, keep: number): void {
    this.transaction('add history', () => {
      this.db
        .prepare(
          `INSERT INTO http_history (request_id, collection_id, method, url, status, duration_ms,
             response_bytes, error_code, error_summary, executed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          entry.requestId,
          entry.collectionId,
          entry.method,
          entry.url,
          entry.status,
          entry.durationMs,
          entry.responseBytes,
          entry.errorCode,
          entry.errorSummary,
          entry.executedAt,
        );
      this.db
        .prepare(
          'DELETE FROM http_history WHERE id NOT IN (SELECT id FROM http_history ORDER BY id DESC LIMIT ?)',
        )
        .run(keep);
    });
  }

  history(query: { requestId?: string; before?: number; limit: number }): HttpHistoryPage {
    return this.run('history', () => {
      const where: string[] = [];
      const params: Param[] = [];
      if (query.requestId !== undefined) {
        where.push('request_id = ?');
        params.push(query.requestId);
      }
      if (query.before !== undefined) {
        where.push('id < ?');
        params.push(query.before);
      }
      const rows = this.all(
        `SELECT * FROM http_history ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY id DESC LIMIT ?`,
        ...params,
        query.limit + 1,
      );
      return {
        entries: rows.slice(0, query.limit).map(toHistory),
        hasMore: rows.length > query.limit,
      };
    });
  }

  clearHistory(): void {
    this.run('clear history', () => this.db.exec('DELETE FROM http_history'));
  }

  recentUrls(limit: number): string[] {
    return this.run('recent URLs', () =>
      // URLs with hidden secret values are not suggested: they would send the marker.
      this.all(
        `SELECT url FROM http_history WHERE instr(url, '[secret]') = 0
         GROUP BY url ORDER BY MAX(id) DESC LIMIT ?`,
        limit,
      ).map((row) => str(row, 'url')),
    );
  }

  // --- Snapshots -----------------------------------------------------------

  saveSnapshot(snapshot: NewHttpSnapshot): void {
    this.run('save snapshot', () =>
      this.db
        .prepare(
          `INSERT INTO http_snapshots (id, request_id, name, method, url, status, status_text,
             headers, content_type, body_kind, body, body_truncated, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          snapshot.id,
          snapshot.requestId,
          snapshot.name,
          snapshot.method,
          snapshot.url,
          snapshot.status,
          snapshot.statusText,
          JSON.stringify(snapshot.headers),
          snapshot.contentType,
          snapshot.bodyKind,
          snapshot.body,
          snapshot.bodyTruncated ? 1 : 0,
          snapshot.createdAt,
        ),
    );
  }

  listSnapshots(requestId: string | null): HttpSnapshotSummary[] {
    return this.run('list snapshots', () =>
      (requestId === null
        ? this.all('SELECT * FROM http_snapshots ORDER BY created_at DESC')
        : this.all(
            'SELECT * FROM http_snapshots WHERE request_id = ? ORDER BY created_at DESC',
            requestId,
          )
      ).map(toSnapshotSummary),
    );
  }

  getSnapshot(id: string): HttpSnapshot | null {
    return this.run('get snapshot', () => {
      const row = this.one('SELECT * FROM http_snapshots WHERE id = ?', id);
      if (row === undefined) return null;
      return {
        ...toSnapshotSummary(row),
        statusText: str(row, 'status_text'),
        headers: JSON.parse(str(row, 'headers')) as [string, string][],
        contentType: strOrNull(row, 'content_type'),
        bodyKind: str(row, 'body_kind') as HttpBodyKind,
        body: strOrNull(row, 'body'),
        bodyTruncated: row.body_truncated === 1,
      };
    });
  }

  deleteSnapshot(id: string): boolean {
    return this.run(
      'delete snapshot',
      () => this.db.prepare('DELETE FROM http_snapshots WHERE id = ?').run(id).changes > 0,
    );
  }

  countSnapshots(): number {
    return this.run(
      'count snapshots',
      () => (this.one('SELECT COUNT(*) AS n FROM http_snapshots')?.n as number | undefined) ?? 0,
    );
  }
}
