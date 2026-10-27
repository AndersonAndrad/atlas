import type { ExtensionCompatibility, ExtensionDiagnostic } from '@atlas/contracts';
import type {
  ExtensionManifest,
  ExtensionRepository,
  NewExtensionDiagnostic,
  ProjectExtensionState,
  StoredExtension,
} from '@atlas/extensions';
import { AtlasError } from '@atlas/shared';
import type { Database } from './database.js';

type Row = Record<string, string | number | null>;

const str = (row: Row, key: string) => row[key] as string;
const strOrNull = (row: Row, key: string) => (row[key] as string | null) ?? null;

function toExtension(row: Row): StoredExtension {
  return {
    key: str(row, 'id'),
    namespace: str(row, 'namespace'),
    name: str(row, 'name'),
    displayName: str(row, 'display_name'),
    description: str(row, 'description'),
    version: str(row, 'version'),
    platform: str(row, 'platform'),
    license: strOrNull(row, 'license'),
    manifest: JSON.parse(str(row, 'manifest')) as ExtensionManifest,
    compatibility: JSON.parse(str(row, 'compatibility')) as ExtensionCompatibility,
    enabled: row.enabled === 1,
    sha256: strOrNull(row, 'sha256'),
    installedAt: str(row, 'installed_at'),
    updatedAt: str(row, 'updated_at'),
  };
}

function toDiagnostic(row: Row): ExtensionDiagnostic {
  return {
    id: row.id as number,
    extensionId: str(row, 'extension_id'),
    level: str(row, 'level') as ExtensionDiagnostic['level'],
    code: str(row, 'code'),
    message: str(row, 'message'),
    createdAt: str(row, 'created_at'),
  };
}

/** SQLite storage of installed extensions (migration v15). */
export class SqliteExtensionRepository implements ExtensionRepository {
  constructor(private readonly db: Database) {}

  private run<T>(operation: string, action: () => T): T {
    try {
      return action();
    } catch (error) {
      if (error instanceof AtlasError) throw error;
      throw new AtlasError('PROJECT_PERSISTENCE_ERROR', 'Extension data could not be saved.', {
        cause: error,
        details: { operation },
      });
    }
  }

  list(): StoredExtension[] {
    return this.run('list extensions', () =>
      (this.db.prepare('SELECT * FROM extensions ORDER BY id').all() as Row[]).map(toExtension),
    );
  }

  find(key: string): StoredExtension | null {
    return this.run('find extension', () => {
      const row = this.db.prepare('SELECT * FROM extensions WHERE id = ?').get(key) as
        Row | undefined;
      return row === undefined ? null : toExtension(row);
    });
  }

  save(extension: StoredExtension): void {
    this.run('save extension', () => {
      this.db
        .prepare(
          `INSERT INTO extensions (id, namespace, name, display_name, description, version,
             platform, license, manifest, compatibility, enabled, sha256, installed_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET namespace = excluded.namespace, name = excluded.name,
             display_name = excluded.display_name, description = excluded.description,
             version = excluded.version, platform = excluded.platform, license = excluded.license,
             manifest = excluded.manifest, compatibility = excluded.compatibility,
             enabled = excluded.enabled, sha256 = excluded.sha256,
             installed_at = excluded.installed_at, updated_at = excluded.updated_at`,
        )
        .run(
          extension.key,
          extension.namespace,
          extension.name,
          extension.displayName,
          extension.description,
          extension.version,
          extension.platform,
          extension.license,
          JSON.stringify(extension.manifest),
          JSON.stringify(extension.compatibility),
          extension.enabled ? 1 : 0,
          extension.sha256,
          extension.installedAt,
          extension.updatedAt,
        );
    });
  }

  remove(key: string): void {
    this.run('remove extension', () => {
      this.db.prepare('DELETE FROM extensions WHERE id = ?').run(key);
    });
  }

  setEnabled(key: string, enabled: boolean, at: string): void {
    this.run('enable extension', () => {
      this.db
        .prepare('UPDATE extensions SET enabled = ?, updated_at = ? WHERE id = ?')
        .run(enabled ? 1 : 0, at, key);
    });
  }

  projectStates(): ProjectExtensionState[] {
    return this.run('list extension project states', () =>
      (
        this.db
          .prepare(
            'SELECT extension_id, project_id, enabled FROM extension_project_states ORDER BY project_id',
          )
          .all() as Row[]
      ).map((row) => ({
        key: str(row, 'extension_id'),
        projectId: str(row, 'project_id'),
        enabled: row.enabled === 1,
      })),
    );
  }

  setProjectState(key: string, projectId: string, enabled: boolean | null): void {
    this.run('set extension project state', () => {
      if (enabled === null) {
        this.db
          .prepare('DELETE FROM extension_project_states WHERE extension_id = ? AND project_id = ?')
          .run(key, projectId);
        return;
      }
      this.db
        .prepare(
          `INSERT INTO extension_project_states (extension_id, project_id, enabled) VALUES (?, ?, ?)
           ON CONFLICT (extension_id, project_id) DO UPDATE SET enabled = excluded.enabled`,
        )
        .run(key, projectId, enabled ? 1 : 0);
    });
  }

  addDiagnostic(diagnostic: NewExtensionDiagnostic, keep: number): void {
    this.run('add extension diagnostic', () => {
      this.db
        .prepare(
          `INSERT INTO extension_diagnostics (extension_id, level, code, message, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          diagnostic.extensionId,
          diagnostic.level,
          diagnostic.code.slice(0, 64),
          diagnostic.message.slice(0, 1000),
          diagnostic.createdAt,
        );
      this.db
        .prepare(
          `DELETE FROM extension_diagnostics WHERE extension_id = ? AND id NOT IN
             (SELECT id FROM extension_diagnostics WHERE extension_id = ? ORDER BY id DESC LIMIT ?)`,
        )
        .run(diagnostic.extensionId, diagnostic.extensionId, keep);
    });
  }

  diagnostics(key: string, limit: number): ExtensionDiagnostic[] {
    return this.run('list extension diagnostics', () =>
      (
        this.db
          .prepare(
            'SELECT * FROM extension_diagnostics WHERE extension_id = ? ORDER BY id DESC LIMIT ?',
          )
          .all(key, limit) as Row[]
      ).map(toDiagnostic),
    );
  }

  diagnosticCounts(): Map<string, number> {
    return this.run('count extension diagnostics', () => {
      const rows = this.db
        .prepare(
          `SELECT extension_id, COUNT(*) AS count FROM extension_diagnostics
           WHERE level IN ('error', 'warning') GROUP BY extension_id`,
        )
        .all() as Row[];
      return new Map(rows.map((row) => [str(row, 'extension_id'), row.count as number]));
    });
  }

  clearDiagnostics(key: string): void {
    this.run('clear extension diagnostics', () => {
      this.db.prepare('DELETE FROM extension_diagnostics WHERE extension_id = ?').run(key);
    });
  }
}
