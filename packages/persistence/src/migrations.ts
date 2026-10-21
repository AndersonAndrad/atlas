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
  {
    version: 5,
    name: 'create_shared_context',
    // Shared Context (SDD-005 Milestone A). Additive: no existing table changes.
    // Records belong to a project or to a repository root (never both); global
    // entries belong to neither. Removing a project converts its records to the
    // project's directory first (Engine), like ATLAS Sessions.
    sql: `
      CREATE TABLE context_tasks (
        id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
        project_id TEXT REFERENCES projects (id) ON DELETE SET NULL,
        workspace_path TEXT CHECK (workspace_path IS NULL OR length(workspace_path) > 0),
        title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
        objective TEXT NOT NULL CHECK (length(objective) BETWEEN 1 AND 4000),
        status TEXT NOT NULL CHECK (status IN ('open', 'done', 'abandoned')),
        base_commit TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (project_id IS NULL OR workspace_path IS NULL)
      ) STRICT;
      CREATE INDEX context_tasks_owner ON context_tasks (project_id, workspace_path, status);

      CREATE TABLE ai_sessions (
        id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
        provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex', 'external')),
        capture_mode TEXT NOT NULL CHECK (capture_mode IN ('managed', 'attached')),
        project_id TEXT REFERENCES projects (id) ON DELETE SET NULL,
        workspace_path TEXT CHECK (workspace_path IS NULL OR length(workspace_path) > 0),
        task_id TEXT REFERENCES context_tasks (id) ON DELETE SET NULL,
        terminal_id TEXT,
        handoff_id TEXT,
        start_commit TEXT,
        status TEXT NOT NULL CHECK (status IN ('active', 'ended')),
        started_at TEXT NOT NULL,
        ended_at TEXT,
        CHECK (project_id IS NULL OR workspace_path IS NULL),
        CHECK ((status = 'ended') = (ended_at IS NOT NULL))
      ) STRICT;
      CREATE INDEX ai_sessions_owner ON ai_sessions (project_id, workspace_path, started_at);
      CREATE INDEX ai_sessions_terminal ON ai_sessions (terminal_id, status);

      CREATE TABLE context_entries (
        id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
        scope TEXT NOT NULL
          CHECK (scope IN ('global', 'project', 'workspace', 'task', 'session', 'agent')),
        project_id TEXT REFERENCES projects (id) ON DELETE SET NULL,
        workspace_path TEXT CHECK (workspace_path IS NULL OR length(workspace_path) > 0),
        task_id TEXT REFERENCES context_tasks (id) ON DELETE CASCADE,
        session_id TEXT REFERENCES ai_sessions (id) ON DELETE SET NULL,
        category TEXT NOT NULL,
        title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
        body TEXT NOT NULL CHECK (length(body) <= 20000),
        status TEXT NOT NULL CHECK (status IN ('active', 'obsolete')),
        verification TEXT NOT NULL CHECK (verification IN ('verified', 'user', 'observed')),
        source_kind TEXT NOT NULL,
        source_ref TEXT,
        recorded_by TEXT NOT NULL,
        refs TEXT NOT NULL DEFAULT '{"files":[],"commit":null}' CHECK (json_valid(refs)),
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (project_id IS NULL OR workspace_path IS NULL),
        CHECK ((scope = 'global') = (project_id IS NULL AND workspace_path IS NULL))
      ) STRICT;
      CREATE INDEX context_entries_owner
        ON context_entries (project_id, workspace_path, status, updated_at);
      CREATE INDEX context_entries_task ON context_entries (task_id);
      CREATE INDEX context_entries_session ON context_entries (session_id);

      CREATE TABLE context_revisions (
        entry_id TEXT NOT NULL REFERENCES context_entries (id) ON DELETE CASCADE,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        category TEXT NOT NULL,
        verification TEXT NOT NULL,
        status TEXT NOT NULL,
        changed_at TEXT NOT NULL,
        changed_by TEXT NOT NULL,
        reason TEXT,
        PRIMARY KEY (entry_id, revision)
      ) STRICT;

      -- Full-text index of entry titles and bodies, kept in sync by the repository.
      CREATE VIRTUAL TABLE context_search USING fts5 (entry_id UNINDEXED, title, body);

      CREATE TABLE context_decisions (
        id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
        project_id TEXT REFERENCES projects (id) ON DELETE SET NULL,
        workspace_path TEXT CHECK (workspace_path IS NULL OR length(workspace_path) > 0),
        task_id TEXT REFERENCES context_tasks (id) ON DELETE SET NULL,
        question TEXT NOT NULL CHECK (length(question) BETWEEN 1 AND 500),
        decision TEXT NOT NULL CHECK (length(decision) BETWEEN 1 AND 2000),
        alternatives TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(alternatives)),
        reasoning TEXT NOT NULL DEFAULT '',
        evidence TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence)),
        affected TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(affected)),
        status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'SUPERSEDED', 'REJECTED')),
        superseded_by TEXT REFERENCES context_decisions (id) ON DELETE SET NULL,
        author TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (project_id IS NULL OR workspace_path IS NULL),
        CHECK (project_id IS NOT NULL OR workspace_path IS NOT NULL)
      ) STRICT;
      CREATE INDEX context_decisions_owner
        ON context_decisions (project_id, workspace_path, status);

      CREATE TABLE context_handoffs (
        id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
        project_id TEXT REFERENCES projects (id) ON DELETE SET NULL,
        workspace_path TEXT CHECK (workspace_path IS NULL OR length(workspace_path) > 0),
        task_id TEXT REFERENCES context_tasks (id) ON DELETE SET NULL,
        source_session_id TEXT REFERENCES ai_sessions (id) ON DELETE SET NULL,
        target_provider TEXT CHECK (target_provider IS NULL OR target_provider IN ('claude', 'codex')),
        payload TEXT NOT NULL CHECK (json_valid(payload)),
        source_revision TEXT,
        created_at TEXT NOT NULL,
        CHECK (project_id IS NULL OR workspace_path IS NULL)
      ) STRICT;
      CREATE INDEX context_handoffs_owner ON context_handoffs (project_id, workspace_path, created_at);

      CREATE TABLE context_snapshots (
        id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
        project_id TEXT REFERENCES projects (id) ON DELETE SET NULL,
        workspace_path TEXT CHECK (workspace_path IS NULL OR length(workspace_path) > 0),
        task_id TEXT REFERENCES context_tasks (id) ON DELETE SET NULL,
        markdown TEXT NOT NULL,
        head TEXT,
        created_at TEXT NOT NULL,
        CHECK (project_id IS NULL OR workspace_path IS NULL)
      ) STRICT;
    `,
  },
  {
    version: 6,
    name: 'context_retrieval',
    // Context retrieval (SDD-006 Milestone A). Additive: new columns with defaults and
    // a table of reconciliation runs. Existing rows keep their meaning.
    sql: `
      ALTER TABLE context_entries
        ADD COLUMN required INTEGER NOT NULL DEFAULT 0 CHECK (required IN (0, 1));
      ALTER TABLE context_tasks ADD COLUMN base_branch TEXT;
      ALTER TABLE context_tasks ADD COLUMN budget_tokens INTEGER
        CHECK (budget_tokens IS NULL OR budget_tokens BETWEEN 500 AND 32000);

      CREATE TABLE context_reconciliations (
        id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
        project_id TEXT REFERENCES projects (id) ON DELETE SET NULL,
        workspace_path TEXT CHECK (workspace_path IS NULL OR length(workspace_path) > 0),
        at TEXT NOT NULL,
        head TEXT,
        branch TEXT,
        stale INTEGER NOT NULL CHECK (stale >= 0),
        conflicts INTEGER NOT NULL CHECK (conflicts >= 0),
        duplicates INTEGER NOT NULL CHECK (duplicates >= 0),
        CHECK (project_id IS NULL OR workspace_path IS NULL)
      ) STRICT;
      CREATE INDEX context_reconciliations_owner
        ON context_reconciliations (project_id, workspace_path, at);
    `,
  },
  {
    version: 7,
    name: 'git_operation_log',
    // Persistent Git operation log (PLAN-016). Additive. Repository roots are stored
    // as text (not projects): the log outlives project registrations.
    sql: `
      CREATE TABLE git_operation_log (
        id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
        repository_root TEXT NOT NULL CHECK (length(repository_root) > 0),
        kind TEXT NOT NULL,
        status TEXT NOT NULL
          CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
        started_at TEXT NOT NULL,
        finished_at TEXT,
        summary TEXT,
        error TEXT CHECK (error IS NULL OR json_valid(error)),
        steps TEXT CHECK (steps IS NULL OR json_valid(steps))
      ) STRICT;
      CREATE INDEX git_operation_log_started ON git_operation_log (started_at);
      CREATE INDEX git_operation_log_repository
        ON git_operation_log (repository_root, started_at);

      CREATE TABLE git_command_log (
        operation_id TEXT NOT NULL REFERENCES git_operation_log (id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL CHECK (sequence >= 1),
        args TEXT NOT NULL CHECK (json_valid(args)),
        started_at TEXT NOT NULL,
        duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
        exit_code INTEGER,
        outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed', 'cancelled')),
        stdout TEXT,
        stderr TEXT,
        truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1)),
        PRIMARY KEY (operation_id, sequence)
      ) STRICT;
    `,
  },
  {
    version: 8,
    name: 'skills_hub',
    // Skills Hub (SDD-006 Milestone B). Additive. Skills are not tied to projects:
    // project ids appear only as assignment targets and are removed with the project.
    sql: `
      CREATE TABLE skills (
        id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
        name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
        description TEXT NOT NULL DEFAULT '',
        dir_name TEXT NOT NULL UNIQUE CHECK (length(dir_name) BETWEEN 1 AND 64),
        version TEXT NOT NULL,
        current_sequence INTEGER NOT NULL CHECK (current_sequence >= 1),
        source_kind TEXT NOT NULL
          CHECK (source_kind IN ('claude', 'codex', 'path', 'template', 'atlas')),
        source_path TEXT,
        template_id TEXT,
        enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
        validation TEXT NOT NULL CHECK (json_valid(validation)),
        storage_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE skill_versions (
        skill_id TEXT NOT NULL REFERENCES skills (id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL CHECK (sequence >= 1),
        version TEXT NOT NULL,
        content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        files TEXT NOT NULL CHECK (json_valid(files)),
        validation TEXT NOT NULL CHECK (json_valid(validation)),
        skill_md TEXT NOT NULL,
        storage_path TEXT NOT NULL,
        note TEXT,
        imported_at TEXT NOT NULL,
        PRIMARY KEY (skill_id, sequence)
      ) STRICT;

      CREATE TABLE skill_assignments (
        skill_id TEXT NOT NULL REFERENCES skills (id) ON DELETE CASCADE,
        scope TEXT NOT NULL CHECK (scope IN ('project', 'provider', 'role', 'session')),
        target TEXT NOT NULL CHECK (length(target) BETWEEN 1 AND 200),
        effect TEXT NOT NULL CHECK (effect IN ('enable', 'disable')),
        created_at TEXT NOT NULL,
        PRIMARY KEY (skill_id, scope, target)
      ) STRICT;
      CREATE INDEX skill_assignments_target ON skill_assignments (scope, target);

      CREATE TABLE skill_sources (
        id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
        path TEXT NOT NULL UNIQUE CHECK (length(path) > 0),
        kind TEXT NOT NULL CHECK (kind IN ('claude', 'codex', 'path')),
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        added_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE skill_sync_batches (
        id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
        provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex')),
        target_path TEXT NOT NULL,
        applied_at TEXT NOT NULL,
        rolled_back_at TEXT,
        changes INTEGER NOT NULL CHECK (changes >= 0)
      ) STRICT;
      CREATE INDEX skill_sync_batches_provider ON skill_sync_batches (provider, applied_at);

      CREATE TABLE skill_sync_changes (
        batch_id TEXT NOT NULL REFERENCES skill_sync_batches (id) ON DELETE CASCADE,
        position INTEGER NOT NULL CHECK (position >= 0),
        skill_id TEXT,
        dir_name TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('create', 'update', 'remove')),
        target_path TEXT NOT NULL,
        backup_path TEXT,
        PRIMARY KEY (batch_id, position)
      ) STRICT;
    `,
  },
];
