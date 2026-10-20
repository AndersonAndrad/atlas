export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/**
 * Ordered, append-only list of schema migrations.
 * Never edit a released migration; add a new one instead.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'create_projects_and_settings',
    sql: `
      CREATE TABLE projects (
        id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
        name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
        description TEXT CHECK (description IS NULL OR length(description) <= 1000),
        workspace_path TEXT NOT NULL CHECK (length(workspace_path) > 0),
        path_key TEXT NOT NULL UNIQUE CHECK (length(path_key) > 0),
        tags TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags) AND json_type(tags) = 'array'),
        git_repository_root TEXT,
        is_git_repository INTEGER NOT NULL DEFAULT 0 CHECK (is_git_repository IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_opened_at TEXT,
        CHECK (is_git_repository = 1 OR git_repository_root IS NULL)
      ) STRICT;

      CREATE TABLE application_settings (
        key TEXT PRIMARY KEY NOT NULL CHECK (length(key) > 0),
        value TEXT NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 2,
    name: 'create_terminal_sessions',
    sql: `
      CREATE TABLE terminal_sessions (
        id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
        project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
        title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 60),
        shell_id TEXT NOT NULL,
        shell_name TEXT NOT NULL,
        shell_path TEXT NOT NULL,
        cwd TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN
          ('CREATED', 'STARTING', 'RUNNING', 'EXITED', 'FAILED', 'TERMINATING', 'TERMINATED')),
        pid INTEGER,
        exit_code INTEGER,
        signal INTEGER,
        end_reason TEXT CHECK (end_reason IS NULL OR end_reason IN
          ('exited', 'user', 'engine-shutdown', 'startup-failed', 'engine-lost')),
        failure_message TEXT,
        columns INTEGER NOT NULL CHECK (columns > 0),
        rows INTEGER NOT NULL CHECK (rows > 0),
        created_at TEXT NOT NULL,
        started_at TEXT,
        ended_at TEXT
      ) STRICT;

      CREATE INDEX terminal_sessions_project ON terminal_sessions (project_id, created_at);
    `,
  },
];
