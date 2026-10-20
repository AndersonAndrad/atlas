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
  {
    version: 3,
    name: 'standalone_terminals_and_groups',
    // Rebuilds terminal_sessions: project association becomes optional (and is
    // cleared, not cascaded, when a project is removed), names are split into
    // automatic and custom ones, and terminals can belong to groups.
    // SDD-002 titles other than the generated "<shell>" / "<shell> N" were set by the
    // user, so they become custom names.
    // Per-project layouts are replaced by per-group layouts.
    sql: `
      CREATE TABLE terminal_groups (
        id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
        name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
        position INTEGER NOT NULL CHECK (position >= 0),
        collapsed INTEGER NOT NULL DEFAULT 0 CHECK (collapsed IN (0, 1)),
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE terminal_sessions_v3 (
        id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
        project_id TEXT REFERENCES projects (id) ON DELETE SET NULL,
        auto_title TEXT NOT NULL CHECK (length(auto_title) BETWEEN 1 AND 60),
        custom_title TEXT CHECK (custom_title IS NULL OR length(custom_title) BETWEEN 1 AND 60),
        group_id TEXT REFERENCES terminal_groups (id) ON DELETE SET NULL,
        group_position INTEGER NOT NULL DEFAULT 0 CHECK (group_position >= 0),
        shell_id TEXT NOT NULL,
        shell_name TEXT NOT NULL,
        shell_path TEXT NOT NULL,
        cwd TEXT NOT NULL,
        current_cwd TEXT NOT NULL,
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

      INSERT INTO terminal_sessions_v3 (id, project_id, auto_title, custom_title, group_id,
        group_position, shell_id, shell_name, shell_path, cwd, current_cwd, status, pid,
        exit_code, signal, end_reason, failure_message, columns, rows, created_at, started_at,
        ended_at)
      SELECT id, project_id, substr(shell_name, 1, 60),
        CASE WHEN title = shell_name OR title GLOB shell_name || ' [0-9]*' THEN NULL
          ELSE title END,
        NULL,
        ROW_NUMBER() OVER (ORDER BY created_at) - 1, shell_id, shell_name, shell_path, cwd, cwd,
        status, pid, exit_code, signal, end_reason, failure_message, columns, rows, created_at,
        started_at, ended_at
      FROM terminal_sessions;

      DROP TABLE terminal_sessions;
      ALTER TABLE terminal_sessions_v3 RENAME TO terminal_sessions;
      CREATE INDEX terminal_sessions_project ON terminal_sessions (project_id);
      CREATE INDEX terminal_sessions_group ON terminal_sessions (group_id, group_position);

      DELETE FROM application_settings WHERE key LIKE 'terminal.layout.%';
    `,
  },
  {
    version: 4,
    name: 'create_atlas_sessions',
    // ATLAS Sessions (SDD-003 Milestone B). Additive: no existing table changes.
    // Removing a project clears the association (the Engine first converts its
    // sessions to standalone ones in the same directory). Dependencies reference
    // tasks of the same session through composite foreign keys.
    sql: `
      CREATE TABLE atlas_sessions (
        id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
        name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
        objective TEXT NOT NULL CHECK (length(objective) BETWEEN 1 AND 4000),
        project_id TEXT REFERENCES projects (id) ON DELETE SET NULL,
        workspace_path TEXT CHECK (workspace_path IS NULL OR length(workspace_path) > 0),
        status TEXT NOT NULL CHECK (status IN ('DRAFT', 'READY', 'WAITING_EXECUTOR', 'RUNNING',
          'PAUSED', 'WAITING_APPROVAL', 'COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED')),
        execution_profile TEXT NOT NULL
          CHECK (execution_profile IN ('ECONOMY', 'BALANCED', 'MAXIMUM')),
        constraints TEXT NOT NULL DEFAULT '[]'
          CHECK (json_valid(constraints) AND json_type(constraints) = 'array'),
        revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        ended_at TEXT,
        archived_at TEXT,
        CHECK (project_id IS NULL OR workspace_path IS NULL),
        CHECK (completed_at IS NULL OR status = 'COMPLETED'),
        CHECK (archived_at IS NULL OR status IN ('COMPLETED', 'FAILED', 'CANCELLED'))
      ) STRICT;

      CREATE INDEX atlas_sessions_status ON atlas_sessions (status);
      CREATE INDEX atlas_sessions_project ON atlas_sessions (project_id);

      CREATE TABLE session_tasks (
        id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
        session_id TEXT NOT NULL REFERENCES atlas_sessions (id) ON DELETE CASCADE,
        title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
        description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 4000),
        status TEXT NOT NULL CHECK (status IN
          ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED')),
        assigned_agent_id TEXT,
        validation_criteria TEXT NOT NULL DEFAULT '[]'
          CHECK (json_valid(validation_criteria) AND json_type(validation_criteria) = 'array'),
        position INTEGER NOT NULL CHECK (position >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (session_id, id)
      ) STRICT;

      CREATE INDEX session_tasks_session ON session_tasks (session_id, position);

      CREATE TABLE session_task_dependencies (
        session_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        depends_on_task_id TEXT NOT NULL,
        PRIMARY KEY (task_id, depends_on_task_id),
        FOREIGN KEY (session_id, task_id)
          REFERENCES session_tasks (session_id, id) ON DELETE CASCADE,
        FOREIGN KEY (session_id, depends_on_task_id)
          REFERENCES session_tasks (session_id, id) ON DELETE RESTRICT,
        CHECK (task_id <> depends_on_task_id)
      ) STRICT;

      CREATE INDEX session_task_dependencies_target
        ON session_task_dependencies (session_id, depends_on_task_id);

      CREATE TABLE session_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES atlas_sessions (id) ON DELETE CASCADE,
        type TEXT NOT NULL CHECK (length(type) BETWEEN 1 AND 64),
        occurred_at TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}'
          CHECK (json_valid(metadata) AND json_type(metadata) = 'object')
      ) STRICT;

      CREATE INDEX session_events_session ON session_events (session_id, id);

      CREATE TABLE session_approvals (
        id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
        session_id TEXT NOT NULL REFERENCES atlas_sessions (id) ON DELETE CASCADE,
        task_id TEXT REFERENCES session_tasks (id) ON DELETE SET NULL,
        summary TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 500),
        status TEXT NOT NULL CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED')),
        requested_at TEXT NOT NULL,
        resolved_at TEXT
      ) STRICT;

      CREATE INDEX session_approvals_session ON session_approvals (session_id, status);
    `,
  },
];
