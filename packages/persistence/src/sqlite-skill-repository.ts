import type {
  AiProvider,
  Skill,
  SkillAssignment,
  SkillScope,
  SkillSource,
  SkillSyncBatch,
} from '@atlas/contracts';
import type { SkillRepository, SkillSyncChange, StoredSkillVersion } from '@atlas/skills';
import { AtlasError } from '@atlas/shared';
import type { Database } from './database.js';

type Row = Record<string, string | number | null>;

const str = (row: Row, key: string) => row[key] as string;
const strOrNull = (row: Row, key: string) => (row[key] as string | null) ?? null;
const json = <T>(value: unknown): T => JSON.parse(value as string) as T;

function toAssignment(row: Row): SkillAssignment {
  return {
    skillId: str(row, 'skill_id'),
    scope: str(row, 'scope') as SkillScope,
    target: str(row, 'target'),
    effect: str(row, 'effect') as SkillAssignment['effect'],
    createdAt: str(row, 'created_at'),
  };
}

function toSkill(row: Row, assignments: SkillAssignment[]): Skill {
  return {
    id: str(row, 'id'),
    name: str(row, 'name'),
    description: str(row, 'description'),
    dirName: str(row, 'dir_name'),
    version: str(row, 'version'),
    currentSequence: row.current_sequence as number,
    source: {
      kind: str(row, 'source_kind') as Skill['source']['kind'],
      path: strOrNull(row, 'source_path'),
      templateId: strOrNull(row, 'template_id'),
    },
    enabled: row.enabled === 1,
    assignments,
    validation: json(row.validation),
    storagePath: str(row, 'storage_path'),
    createdAt: str(row, 'created_at'),
    updatedAt: str(row, 'updated_at'),
  };
}

function toVersion(row: Row): StoredSkillVersion {
  return {
    skillId: str(row, 'skill_id'),
    sequence: row.sequence as number,
    version: str(row, 'version'),
    contentHash: str(row, 'content_hash'),
    name: str(row, 'name'),
    description: str(row, 'description'),
    files: json(row.files),
    validation: json(row.validation),
    note: strOrNull(row, 'note'),
    importedAt: str(row, 'imported_at'),
    skillMd: str(row, 'skill_md'),
    storagePath: str(row, 'storage_path'),
  };
}

function toBatch(row: Row): SkillSyncBatch {
  return {
    batchId: str(row, 'id'),
    provider: str(row, 'provider') as AiProvider,
    targetPath: str(row, 'target_path'),
    appliedAt: str(row, 'applied_at'),
    rolledBackAt: strOrNull(row, 'rolled_back_at'),
    changes: row.changes as number,
  };
}

/** SQLite storage of the Skills Hub (migration v8). */
export class SqliteSkillRepository implements SkillRepository {
  constructor(private readonly db: Database) {}

  private run<T>(operation: string, action: () => T): T {
    try {
      return action();
    } catch (error) {
      if (error instanceof AtlasError) throw error;
      throw new AtlasError('PROJECT_PERSISTENCE_ERROR', 'The skill registry could not be saved.', {
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

  private assignments(skillId?: string): SkillAssignment[] {
    const rows = (
      skillId === undefined
        ? this.db.prepare('SELECT * FROM skill_assignments ORDER BY created_at').all()
        : this.db
            .prepare('SELECT * FROM skill_assignments WHERE skill_id = ? ORDER BY created_at')
            .all(skillId)
    ) as Row[];
    return rows.map(toAssignment);
  }

  async listSkills(): Promise<Skill[]> {
    return this.run('listSkills', () => {
      const assignments = this.assignments();
      return (this.db.prepare('SELECT * FROM skills ORDER BY name').all() as Row[]).map((row) =>
        toSkill(
          row,
          assignments.filter((item) => item.skillId === row.id),
        ),
      );
    });
  }

  async getSkill(id: string): Promise<Skill | null> {
    return this.run('getSkill', () => {
      const row = this.db.prepare('SELECT * FROM skills WHERE id = ?').get(id) as Row | undefined;
      return row ? toSkill(row, this.assignments(id)) : null;
    });
  }

  private insertVersion(version: StoredSkillVersion): void {
    this.db
      .prepare(
        `INSERT INTO skill_versions (skill_id, sequence, version, content_hash, name, description,
           files, validation, skill_md, storage_path, note, imported_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        version.skillId,
        version.sequence,
        version.version,
        version.contentHash,
        version.name,
        version.description,
        JSON.stringify(version.files),
        JSON.stringify(version.validation),
        version.skillMd,
        version.storagePath,
        version.note,
        version.importedAt,
      );
  }

  async insertSkill(skill: Skill, version: StoredSkillVersion): Promise<void> {
    this.transaction('insertSkill', () => {
      this.db
        .prepare(
          `INSERT INTO skills (id, name, description, dir_name, version, current_sequence,
             source_kind, source_path, template_id, enabled, validation, storage_path,
             created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          skill.id,
          skill.name,
          skill.description,
          skill.dirName,
          skill.version,
          skill.currentSequence,
          skill.source.kind,
          skill.source.path,
          skill.source.templateId,
          skill.enabled ? 1 : 0,
          JSON.stringify(skill.validation),
          skill.storagePath,
          skill.createdAt,
          skill.updatedAt,
        );
      this.insertVersion(version);
    });
  }

  async addVersion(skill: Skill, version: StoredSkillVersion): Promise<void> {
    this.transaction('addVersion', () => {
      this.insertVersion(version);
      this.db
        .prepare(
          `UPDATE skills SET name = ?, description = ?, version = ?, current_sequence = ?,
             validation = ?, storage_path = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          skill.name,
          skill.description,
          skill.version,
          skill.currentSequence,
          JSON.stringify(skill.validation),
          skill.storagePath,
          skill.updatedAt,
          skill.id,
        );
    });
  }

  async updateSkill(skill: Skill): Promise<void> {
    this.run('updateSkill', () =>
      this.db
        .prepare('UPDATE skills SET enabled = ?, validation = ?, updated_at = ? WHERE id = ?')
        .run(skill.enabled ? 1 : 0, JSON.stringify(skill.validation), skill.updatedAt, skill.id),
    );
  }

  async removeSkill(id: string): Promise<boolean> {
    return this.run(
      'removeSkill',
      () => this.db.prepare('DELETE FROM skills WHERE id = ?').run(id).changes > 0,
    );
  }

  async listVersions(skillId: string): Promise<StoredSkillVersion[]> {
    return this.run('listVersions', () =>
      (
        this.db
          .prepare('SELECT * FROM skill_versions WHERE skill_id = ? ORDER BY sequence DESC')
          .all(skillId) as Row[]
      ).map(toVersion),
    );
  }

  async getVersion(skillId: string, sequence: number): Promise<StoredSkillVersion | null> {
    return this.run('getVersion', () => {
      const row = this.db
        .prepare('SELECT * FROM skill_versions WHERE skill_id = ? AND sequence = ?')
        .get(skillId, sequence) as Row | undefined;
      return row ? toVersion(row) : null;
    });
  }

  async setAssignment(assignment: SkillAssignment): Promise<void> {
    this.run('setAssignment', () =>
      this.db
        .prepare(
          `INSERT INTO skill_assignments (skill_id, scope, target, effect, created_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (skill_id, scope, target) DO UPDATE SET effect = excluded.effect`,
        )
        .run(
          assignment.skillId,
          assignment.scope,
          assignment.target,
          assignment.effect,
          assignment.createdAt,
        ),
    );
  }

  async removeAssignment(skillId: string, scope: SkillScope, target: string): Promise<boolean> {
    return this.run(
      'removeAssignment',
      () =>
        this.db
          .prepare('DELETE FROM skill_assignments WHERE skill_id = ? AND scope = ? AND target = ?')
          .run(skillId, scope, target).changes > 0,
    );
  }

  async removeAssignmentsFor(scope: SkillScope, target: string): Promise<number> {
    return this.run('removeAssignmentsFor', () =>
      Number(
        this.db
          .prepare('DELETE FROM skill_assignments WHERE scope = ? AND target = ?')
          .run(scope, target).changes,
      ),
    );
  }

  async listSources(): Promise<SkillSource[]> {
    return this.run('listSources', () =>
      (this.db.prepare('SELECT * FROM skill_sources ORDER BY added_at').all() as Row[]).map(
        (row) => ({
          id: str(row, 'id'),
          path: str(row, 'path'),
          kind: str(row, 'kind') as SkillSource['kind'],
          enabled: row.enabled === 1,
          addedAt: str(row, 'added_at'),
        }),
      ),
    );
  }

  async insertSource(source: SkillSource): Promise<void> {
    this.run('insertSource', () =>
      this.db
        .prepare(
          'INSERT INTO skill_sources (id, path, kind, enabled, added_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(source.id, source.path, source.kind, source.enabled ? 1 : 0, source.addedAt),
    );
  }

  async setSourceEnabled(id: string, enabled: boolean): Promise<boolean> {
    return this.run(
      'setSourceEnabled',
      () =>
        this.db
          .prepare('UPDATE skill_sources SET enabled = ? WHERE id = ?')
          .run(enabled ? 1 : 0, id).changes > 0,
    );
  }

  async removeSource(id: string): Promise<boolean> {
    return this.run(
      'removeSource',
      () => this.db.prepare('DELETE FROM skill_sources WHERE id = ?').run(id).changes > 0,
    );
  }

  async insertSyncBatch(batch: SkillSyncBatch, changes: SkillSyncChange[]): Promise<void> {
    this.transaction('insertSyncBatch', () => {
      this.db
        .prepare(
          `INSERT INTO skill_sync_batches (id, provider, target_path, applied_at, rolled_back_at,
             changes) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          batch.batchId,
          batch.provider,
          batch.targetPath,
          batch.appliedAt,
          batch.rolledBackAt,
          batch.changes,
        );
      const insert = this.db.prepare(
        `INSERT INTO skill_sync_changes (batch_id, position, skill_id, dir_name, action,
           target_path, backup_path) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      changes.forEach((change, position) =>
        insert.run(
          batch.batchId,
          position,
          change.skillId,
          change.dirName,
          change.action,
          change.targetPath,
          change.backupPath,
        ),
      );
    });
  }

  async listSyncBatches(provider?: AiProvider): Promise<SkillSyncBatch[]> {
    return this.run('listSyncBatches', () =>
      (
        (provider === undefined
          ? this.db.prepare('SELECT * FROM skill_sync_batches ORDER BY applied_at DESC').all()
          : this.db
              .prepare(
                'SELECT * FROM skill_sync_batches WHERE provider = ? ORDER BY applied_at DESC',
              )
              .all(provider)) as Row[]
      ).map(toBatch),
    );
  }

  async syncChanges(batchId: string): Promise<SkillSyncChange[]> {
    return this.run('syncChanges', () =>
      (
        this.db
          .prepare('SELECT * FROM skill_sync_changes WHERE batch_id = ? ORDER BY position')
          .all(batchId) as Row[]
      ).map((row) => ({
        skillId: strOrNull(row, 'skill_id'),
        dirName: str(row, 'dir_name'),
        action: str(row, 'action') as SkillSyncChange['action'],
        targetPath: str(row, 'target_path'),
        backupPath: strOrNull(row, 'backup_path'),
      })),
    );
  }

  async markRolledBack(batchId: string, at: string): Promise<void> {
    this.run('markRolledBack', () =>
      this.db
        .prepare('UPDATE skill_sync_batches SET rolled_back_at = ? WHERE id = ?')
        .run(at, batchId),
    );
  }
}
