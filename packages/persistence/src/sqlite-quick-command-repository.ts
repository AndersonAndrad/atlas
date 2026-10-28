import type { QuickCommand, QuickCommandScope } from '@atlas/contracts';
import { AtlasError } from '@atlas/shared';
import type { Database } from './database.js';

interface CommandRow {
  id: string;
  name: string;
  command: string;
  scope: string;
}

interface AssignmentRow {
  command_id: string;
  project_id: string;
}

/** What a command stores; the project list matters only for `PROJECTS`. */
export interface StoredQuickCommand {
  id: string;
  name: string;
  command: string;
  scope: QuickCommandScope;
  projectIds: string[];
}

/**
 * Quick commands and the projects they are limited to (migration v25, SDD-025 Task 03).
 * Removing a project removes it from every command; a command left without projects stays
 * limited to projects, so it is offered nowhere rather than everywhere.
 */
export class SqliteQuickCommandRepository {
  constructor(private readonly db: Database) {}

  private run<T>(operation: string, action: () => T): T {
    try {
      return action();
    } catch (error) {
      if (error instanceof AtlasError) throw error;
      throw new AtlasError('PROJECT_PERSISTENCE_ERROR', 'Quick commands could not be saved.', {
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

  /** Every command in the user's order, with its projects in selection order. */
  async list(): Promise<QuickCommand[]> {
    return this.run('list', () => {
      const commands = this.db
        .prepare('SELECT id, name, command, scope FROM quick_commands ORDER BY position, id')
        .all() as unknown as CommandRow[];
      const assignments = this.db
        .prepare(
          `SELECT a.command_id, a.project_id FROM quick_command_projects a
           JOIN projects p ON p.id = a.project_id
           ORDER BY a.position, p.name COLLATE NOCASE, p.id`,
        )
        .all() as unknown as AssignmentRow[];
      const projects = new Map<string, string[]>();
      for (const row of assignments) {
        projects.set(row.command_id, [...(projects.get(row.command_id) ?? []), row.project_id]);
      }
      return commands.map((row) => ({
        id: row.id,
        name: row.name,
        command: row.command,
        scope: row.scope as QuickCommandScope,
        projectIds: row.scope === 'ALL' ? [] : (projects.get(row.id) ?? []),
      }));
    });
  }

  async count(): Promise<number> {
    return this.run('count', () => {
      const row = this.db.prepare('SELECT COUNT(*) AS n FROM quick_commands').get() as {
        n: number;
      };
      return Number(row.n);
    });
  }

  /** Appends a command at the end of the list. */
  async insert(command: StoredQuickCommand, now: string): Promise<void> {
    this.transaction('insert', () => {
      this.db
        .prepare(
          `INSERT INTO quick_commands (id, name, command, scope, position, created_at, updated_at)
           VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM quick_commands), ?, ?)`,
        )
        .run(command.id, command.name, command.command, command.scope, now, now);
      this.writeProjects(command);
    });
  }

  /** Replaces a command's text and availability; false when it does not exist. */
  async update(command: StoredQuickCommand, now: string): Promise<boolean> {
    return this.transaction('update', () => {
      const result = this.db
        .prepare(
          `UPDATE quick_commands SET name = ?, command = ?, scope = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(command.name, command.command, command.scope, now, command.id);
      if (Number(result.changes) === 0) return false;
      this.db.prepare('DELETE FROM quick_command_projects WHERE command_id = ?').run(command.id);
      this.writeProjects(command);
      return true;
    });
  }

  async remove(id: string): Promise<boolean> {
    return this.run('remove', () => {
      const result = this.db.prepare('DELETE FROM quick_commands WHERE id = ?').run(id);
      return Number(result.changes) > 0;
    });
  }

  /** Swaps the places of two commands. */
  async swap(first: string, second: string): Promise<void> {
    this.transaction('swap', () => {
      const position = (id: string) =>
        (
          this.db.prepare('SELECT position FROM quick_commands WHERE id = ?').get(id) as {
            position: number;
          }
        ).position;
      const [a, b] = [position(first), position(second)];
      const set = this.db.prepare('UPDATE quick_commands SET position = ? WHERE id = ?');
      set.run(b, first);
      set.run(a, second);
    });
  }

  /** Adds a project at the end of a command's projects, or removes it. */
  async setAssignment(
    commandId: string,
    projectId: string,
    assigned: boolean,
    now: string,
  ): Promise<void> {
    this.transaction('setAssignment', () => {
      if (assigned) {
        this.db
          .prepare(
            `INSERT OR IGNORE INTO quick_command_projects (command_id, project_id, position)
             VALUES (?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM quick_command_projects
                            WHERE command_id = ?))`,
          )
          .run(commandId, projectId, commandId);
      } else {
        this.db
          .prepare('DELETE FROM quick_command_projects WHERE command_id = ? AND project_id = ?')
          .run(commandId, projectId);
      }
      this.db.prepare('UPDATE quick_commands SET updated_at = ? WHERE id = ?').run(now, commandId);
    });
  }

  private writeProjects(command: StoredQuickCommand): void {
    if (command.scope !== 'PROJECTS') return;
    const insert = this.db.prepare(
      'INSERT INTO quick_command_projects (command_id, project_id, position) VALUES (?, ?, ?)',
    );
    command.projectIds.forEach((projectId, index) => insert.run(command.id, projectId, index));
  }
}
