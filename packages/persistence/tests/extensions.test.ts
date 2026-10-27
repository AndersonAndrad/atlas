import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StoredExtension } from '@atlas/extensions';
import {
  MIGRATIONS,
  SqliteExtensionRepository,
  getSchemaVersion,
  openDatabase,
  type Database,
} from '@atlas/persistence';
import { createTempDir } from '../../../tests/support/temp.js';

const PROJECT = '00000000-0000-4000-8000-000000000900';
const OTHER = '00000000-0000-4000-8000-000000000901';

function insertProject(db: Database, projectId: string, folder: string) {
  db.prepare(
    `INSERT INTO projects (id, name, workspace_path, path_key, tags, is_git_repository,
       created_at, updated_at) VALUES (?, 'P', ?, ?, '[]', 0, 'x', 'x')`,
  ).run(projectId, folder, folder);
}

function extension(key: string, extra: Partial<StoredExtension> = {}): StoredExtension {
  const [namespace = '', name = ''] = key.split('.');
  return {
    key,
    namespace,
    name,
    displayName: name,
    description: '',
    version: '1.0.0',
    platform: 'universal',
    license: 'MIT',
    manifest: {
      publisher: namespace,
      name,
      version: '1.0.0',
      displayName: name,
      description: '',
      main: null,
      browser: null,
      categories: [],
      extensionDependencies: [],
      extensionPack: [],
      license: 'MIT',
      contributionKeys: ['themes'],
      contributes: { themes: [] },
    },
    compatibility: {
      level: 'UNTESTED',
      executable: false,
      working: ['Color theme: X'],
      unsupported: [],
      notes: [],
      tested: null,
    },
    enabled: true,
    sha256: 'a'.repeat(64),
    installedAt: '2026-10-27T10:00:00.000Z',
    updatedAt: '2026-10-27T10:00:00.000Z',
    ...extra,
  };
}

describe('SqliteExtensionRepository', () => {
  let db: Database;
  let repository: SqliteExtensionRepository;

  beforeEach(() => {
    db = openDatabase({ filePath: ':memory:' });
    insertProject(db, PROJECT, '/work/a');
    insertProject(db, OTHER, '/work/b');
    repository = new SqliteExtensionRepository(db);
  });

  afterEach(() => db.close());

  it('saves, replaces and lists extensions with their manifest and compatibility', () => {
    repository.save(extension('acme.theme'));
    repository.save(extension('acme.theme', { version: '1.1.0', enabled: false }));
    repository.save(extension('beta.icons'));
    expect(repository.list().map((item) => [item.key, item.version, item.enabled])).toEqual([
      ['acme.theme', '1.1.0', false],
      ['beta.icons', '1.0.0', true],
    ]);
    expect(repository.find('acme.theme')?.manifest.contributionKeys).toEqual(['themes']);
    expect(repository.find('acme.theme')?.compatibility.level).toBe('UNTESTED');
    expect(repository.find('missing.one')).toBeNull();
  });

  it('refuses identifiers that are not lower case', () => {
    expect(() => repository.save(extension('Acme.Theme'))).toThrow(
      expect.objectContaining({ code: 'PROJECT_PERSISTENCE_ERROR' }),
    );
  });

  it('keeps project overrides across updates and removes them with the extension', () => {
    repository.save(extension('acme.theme'));
    repository.setProjectState('acme.theme', PROJECT, false);
    repository.setProjectState('acme.theme', OTHER, true);
    repository.save(extension('acme.theme', { version: '2.0.0' }));
    expect(repository.projectStates()).toEqual([
      { key: 'acme.theme', projectId: PROJECT, enabled: false },
      { key: 'acme.theme', projectId: OTHER, enabled: true },
    ]);
    repository.setProjectState('acme.theme', OTHER, null);
    expect(repository.projectStates()).toHaveLength(1);
    repository.setEnabled('acme.theme', false, '2026-10-27T11:00:00.000Z');
    expect(repository.find('acme.theme')).toMatchObject({
      enabled: false,
      updatedAt: '2026-10-27T11:00:00.000Z',
    });
    repository.remove('acme.theme');
    expect(repository.projectStates()).toEqual([]);
  });

  it('drops a project override when the project is removed', () => {
    repository.save(extension('acme.theme'));
    repository.setProjectState('acme.theme', PROJECT, false);
    db.prepare('DELETE FROM projects WHERE id = ?').run(PROJECT);
    expect(repository.projectStates()).toEqual([]);
  });

  it('keeps only the newest diagnostics of each extension and counts problems', () => {
    for (let index = 0; index < 5; index += 1) {
      repository.addDiagnostic(
        {
          extensionId: 'acme.theme',
          level: index === 4 ? 'info' : 'error',
          code: `E${index}`,
          message: 'x'.repeat(2000),
          createdAt: `2026-10-27T10:0${index}:00.000Z`,
        },
        3,
      );
    }
    const diagnostics = repository.diagnostics('acme.theme', 10);
    expect(diagnostics.map((item) => item.code)).toEqual(['E4', 'E3', 'E2']);
    expect(diagnostics[0]?.message).toHaveLength(1000);
    expect(repository.diagnosticCounts().get('acme.theme')).toBe(2);
    repository.clearDiagnostics('acme.theme');
    expect(repository.diagnostics('acme.theme', 10)).toEqual([]);
  });
});

describe('migration v15 from a v14 database', () => {
  it('adds the extension tables without touching existing data', () => {
    const temp = createTempDir();
    try {
      const file = path.join(temp.dir, 'v14.db');
      let db = openDatabase({ filePath: file, migrations: MIGRATIONS.slice(0, 14) });
      insertProject(db, PROJECT, '/work/app');
      db.close();
      db = openDatabase({ filePath: file });
      expect(getSchemaVersion(db)).toBe(15);
      expect(db.prepare('SELECT COUNT(*) AS n FROM projects').get()).toEqual({ n: 1 });
      expect(db.prepare('SELECT COUNT(*) AS n FROM extensions').get()).toEqual({ n: 0 });
      db.close();
    } finally {
      temp.cleanup();
    }
  });
});
