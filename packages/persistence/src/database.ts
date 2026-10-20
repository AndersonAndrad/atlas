import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AtlasError, noopLogger, type Logger } from '@atlas/shared';
import { MIGRATIONS, type Migration } from './migrations.js';

export type Database = DatabaseSync;

export interface OpenDatabaseOptions {
  /** Absolute path to the database file, or ':memory:'. */
  filePath: string;
  logger?: Logger;
  migrations?: readonly Migration[];
}

const BUSY_TIMEOUT_MS = 5000;

export function openDatabase(options: OpenDatabaseOptions): Database {
  const logger = options.logger ?? noopLogger;
  let db: DatabaseSync | undefined;
  try {
    if (options.filePath !== ':memory:') {
      mkdirSync(path.dirname(options.filePath), { recursive: true });
    }
    db = new DatabaseSync(options.filePath, { timeout: BUSY_TIMEOUT_MS });
    db.exec('PRAGMA foreign_keys = ON;');
    if (options.filePath !== ':memory:') {
      // WAL lets the CLI read while the desktop app writes (and vice versa).
      db.exec('PRAGMA journal_mode = WAL;');
    }
    runMigrations(db, options.migrations ?? MIGRATIONS, logger);
    return db;
  } catch (error) {
    db?.close();
    if (error instanceof AtlasError) throw error;
    throw new AtlasError('PROJECT_PERSISTENCE_ERROR', 'Failed to open the database.', {
      cause: error,
      details: { filePath: options.filePath },
    });
  }
}

export function getSchemaVersion(db: Database): number {
  const row = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as
    { version: number | null } | undefined;
  return row?.version ?? 0;
}

export function runMigrations(
  db: Database,
  migrations: readonly Migration[],
  logger: Logger,
): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);

  const current = getSchemaVersion(db);
  const latest = migrations.at(-1)?.version ?? 0;
  if (current > latest) {
    throw new AtlasError(
      'PROJECT_PERSISTENCE_ERROR',
      'The database was created by a newer version of ATLAS.',
      { details: { databaseVersion: current, supportedVersion: latest } },
    );
  }

  const insert = db.prepare(
    'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
  );
  for (const migration of migrations) {
    if (migration.version <= current) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(migration.sql);
      insert.run(migration.version, migration.name, new Date().toISOString());
      db.exec('COMMIT');
      logger.info('Applied database migration', {
        version: migration.version,
        name: migration.name,
      });
    } catch (error) {
      db.exec('ROLLBACK');
      throw new AtlasError('PROJECT_PERSISTENCE_ERROR', 'Database migration failed.', {
        cause: error,
        details: { version: migration.version, name: migration.name },
      });
    }
  }
}
