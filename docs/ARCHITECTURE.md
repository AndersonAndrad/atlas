# ATLAS Architecture

Status: reflects SDD-001 (Project Registry), SDD-002 (Terminal Manager), SDD-003
(Workspace & Git, ATLAS Sessions), SDD-004 Milestone A (Git workflow) and SDD-005
Milestone A stage A1 (Shared Context).

## Overview

ATLAS is a local-first desktop application backed by a headless Engine. The Engine owns
all business logic, persistence and terminal processes. Since SDD-002 the desktop app
runs the Engine in an Electron **utility process** (the "Engine host"); the Electron main
process is a thin, security-focused broker between the renderer and the Engine.

```text
 ┌───────────────────────────┐                         ┌──────────────────────────┐
 │ Renderer (React + shadcn) │                         │ CLI (atlas)              │
 │ sandboxed, no Node        │                         │ project: direct SQLite   │
 │ xterm.js views            │                         │ terminal: Engine socket  │
 └────────────┬──────────────┘                         └─────┬───────────┬────────┘
  window.atlas│ contextBridge                                │ in-process│ NDJSON over
 ┌────────────▼──────────────┐                               │ (projects)│ Unix socket /
 │ Preload (CJS)             │                               │           │ named pipe,
 └────────────┬──────────────┘                               │           │ token auth
  invoke/send │ IPC (validated, trusted sender only)         │           │
 ┌────────────▼──────────────┐                               │           │
 │ Electron main             │ window security, native       │           │
 │ IPC → Engine requests     │ dialogs, app menu/shortcuts,  │           │
 │ routes output per view    │ quit confirmation             │           │
 └────────────┬──────────────┘                               │           │
  postMessage │ request/response + events                    │           │
 ┌────────────▼──────────────────────────────────────────┐   │           │
 │ Engine host (utilityProcess) — startEngineHost()       │◄──┼───────────┘
 │  ProjectService · TerminalService · TerminalSettings   │   │
 │  EngineDispatcher (validates every request)            │   │
 │  adapters: node-pty, @xterm/headless mirror, shells,   │   │
 │            path/Git inspection, file logger            │   │
 │  socket server for the CLI                             │   │
 └────────────┬──────────────────────────────────────────┘   │
              │ node:sqlite (WAL)                             │
              └──────────────── <data dir>/atlas.db ◄─────────┘
```

## Workspace layout

| Path                            | Responsibility                                                                                                                                                                              | Depends on                              |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `packages/shared`               | `AtlasError`, error codes and user-safe messages, `Logger` port                                                                                                                             | —                                       |
| `packages/contracts`            | Zod schemas/types: projects, terminals, layouts, Engine method contract (`engine-api`), IPC contract (`./ipc`, Zod-free)                                                                    | shared, zod                             |
| `packages/projects`             | Project domain: `ProjectService`, ports, path normalization                                                                                                                                 | shared, contracts                       |
| `packages/terminal`             | Terminal domain/application: `TerminalService`, lifecycle state machine, `TerminalSettings`, ports (PTY, mirror, shells, …)                                                                 | shared, contracts                       |
| `packages/conventional-commits` | Conventional Commits 1.0.0 validator, stricter project rules, deterministic commit suggestions (no dependencies; also used by the renderer)                                                 | —                                       |
| `packages/git`                  | Git inspection and workflow: porcelain parsers, `GitInspectionService`, `GitWorkspaceService`, `GitOperationCoordinator`, credential redaction, preferences                                 | shared, contracts, conventional-commits |
| `packages/skills`               | Skills Hub: SKILL.md parsing, provider adapters, safety checks, activation rules, versions, sync; `SkillRepository` / `SkillFileSystem` ports                                               | shared, contracts, git, yaml            |
| `packages/context`              | Shared Context: `SharedContextService`, ranked bundles (`retrieval/`: terms, scoring, budgets, consistency, cache) and handoff rendering, `ContextRepository` / `RepositoryInspector` ports | shared, contracts                       |
| `packages/persistence`          | SQLite, migrations, project/settings/terminal-session repositories                                                                                                                          | shared, contracts, ports                |
| `apps/engine`                   | Composition root `createEngine()`, `startEngineHost()`, adapters (node-pty, headless mirror, shells), RPC dispatcher + socket                                                               | all packages, node-pty, xterm           |
| `apps/cli`                      | `atlas` command line client                                                                                                                                                                 | engine                                  |
| `apps/desktop`                  | Electron main (broker), Engine host entry, preload bridge, React renderer (shadcn/ui, xterm.js)                                                                                             | engine (main/host), contracts           |

Dependency direction is inward: `projects` and `terminal` define ports; `persistence` and
`engine` implement them. Domain packages never import node-pty, SQLite or Electron.

## Engine

- `createEngine(options)` wires repositories, inspectors, clock and logger. With
  `options.terminals` it also builds the `TerminalService` (node-pty spawner, headless
  screen mirror, system shell provider, shell environment). Without it (CLI, standalone
  `atlas-engine status`) no native PTY module is loaded.
- `startEngineHost(options)` creates an Engine with terminals, initializes it (marks
  sessions left by a previous run as lost), creates the `EngineDispatcher` and starts the
  CLI socket server. `stop()` closes the socket, terminates every terminal and closes the
  database.
- `EngineDispatcher` maps method names (`packages/contracts/src/engine-api.ts`) to
  services. Every request is validated with Zod tuples, regardless of transport.
  Callers have a scope: `desktop` (everything) or `cli` (allow-list: `engine.status`,
  `terminals.list|get|create|terminate|closeInfo|rename|detachProject`).

### Engine host process (desktop)

`apps/desktop/src/engine-host/index.ts` runs inside `utilityProcess.fork`. Main sends
`start`, `request` and `shutdown` messages; the host answers with `ready`/`start-failed`,
`response`, `event` and `stopped`. `EngineHostClient` (main) correlates requests by id,
restarts the host after an unexpected exit (at most 3 times per minute, then reports a
fatal error) and notifies the renderer (`engine:restarted`) so it reloads its state.
On stop it kills the host only after `ENGINE_SHUTDOWN_TIMEOUT_MS` (exported by
`@atlas/engine`: the Git operation wait plus terminal shutdown) and a further margin, so
a finishing commit is not cut off.

## Terminal subsystem (SDD-002)

### Session model and lifecycle

`TerminalSession` metadata: id, projectId, title, shell (id, name, path), cwd, status,
pid, exitCode, signal, endReason, failureMessage, columns, rows, createdAt, startedAt,
endedAt. Runtime handles (PTY, mirror, subscribers) stay in memory.

```text
CREATED ─► STARTING ─► RUNNING ─► EXITED        (process exited on its own: any code/signal)
   │           │          └─────► TERMINATING ─► TERMINATED   (user, engine-shutdown)
   └───────────┴─► FAILED                        (startup-failed)
```

Transitions are enforced by `assertTransition`; a session can never return to RUNNING.
Sessions found non-final when an Engine starts are rewritten to `TERMINATED` with
`endReason: engine-lost`. Graceful shutdown records `engine-shutdown`.

Termination sends SIGHUP and, after 3 s, SIGKILL; `terminate()` resolves when the process
has exited. Closing a tab = `dismiss` (terminate if needed, then forget the session).

### PTY and screen mirror

- `NodePtySpawner` wraps node-pty 1.1.0 (forkpty on macOS/Linux, ConPTY on Windows). The
  native module is loaded lazily. `scripts/ensure-pty-helper.mjs` (postinstall) restores
  the executable bit of node-pty's macOS `spawn-helper`, which the published package lacks.
- Each session has a `HeadlessScreenMirror` (`@xterm/headless` + `@xterm/addon-serialize`,
  1,000 lines of scrollback). It parses all output so that a new view can be rebuilt,
  including the alternate screen of full-screen programs.
- Project terminals always start in `ProjectService.resolveAvailableWorkspace` (registered
  project, directory currently available, realpath). Standalone terminals (SDD-003) start in
  a directory validated by `ProjectService.resolveAvailableDirectory`: the one requested,
  the configured default working directory, or the home directory. Desktop clients may only
  request directories returned by the native picker.
- Shell environment: the Engine's environment minus `ELECTRON_*`, `CHROME_*`, `VSCODE_*`,
  `NODE_OPTIONS`; plus `TERM=xterm-256color`, `COLORTERM=truecolor`, `TERM_PROGRAM=ATLAS`;
  `LANG=en_US.UTF-8` on macOS when no locale is set.

### Output delivery, ordering and back-pressure

1. PTY data is appended to a per-session buffer and flushed every 8 ms or at 32 KiB.
2. Each flush gets a sequence number, is written to the mirror and emitted once per
   attached subscriber (`<renderer document>:<view id>`). Hidden sessions only feed the
   mirror.
3. Views acknowledge rendered characters. Above 1 MiB unacknowledged for any view the
   PTY is paused; it resumes below 256 KiB. Detaching releases back-pressure.
4. `attach(view, cols, rows)` resizes, flushes, registers the view, waits until the mirror
   parsed everything, and returns `{ snapshot, seq }`. The view writes the snapshot and
   drops buffered events with `seq <= snapshot seq` — no gaps or duplicates.

Main forwards output only to the current renderer document (the subscriber prefix changes
on every navigation/reload and the old prefix is detached), and lifecycle events to the
window. Output never passes through React state.

### Shells

| Platform | Detected                                                                         | Args           | Default                               |
| -------- | -------------------------------------------------------------------------------- | -------------- | ------------------------------------- |
| macOS    | `$SHELL`, zsh, bash in `/bin`, `/usr/bin`, `/usr/local/bin`, `/opt/homebrew/bin` | `-l` (login)   | `$SHELL`                              |
| Linux    | `$SHELL`, bash, zsh in the same directories                                      | none           | `$SHELL`                              |
| Windows  | PowerShell 7 (`pwsh.exe`), Windows PowerShell, `%ComSpec%` (cmd)                 | `-NoLogo` (PS) | PowerShell 7, else Windows PowerShell |

Only existing, executable regular files are offered (symlink duplicates removed). Extra
shells (e.g. an explicit WSL launcher such as `wsl.exe -d Ubuntu`) are configured in
`<data dir>/shells.json`:

```json
{
  "shells": [
    {
      "id": "wsl-ubuntu",
      "name": "WSL: Ubuntu",
      "path": "C:\\Windows\\System32\\wsl.exe",
      "args": ["-d", "Ubuntu"]
    }
  ]
}
```

Entries must have an absolute path to an executable (`.exe` on Windows) and a unique id;
invalid entries are skipped and reported in the terminal settings menu. The user's
default shell preference overrides the platform default. Renderers and the CLI only ever
select a shell **id**.

### Terminal persistence

- `terminal_sessions` (migrations v2, v3): metadata only — no output, no input, no command
  history. `project_id` is optional and cleared (`ON DELETE SET NULL`) when the project is
  removed; `auto_title`/`custom_title`, `group_id`/`group_position`, `current_cwd`.
- `terminal_groups` (v3): id, name, position, collapsed.
- `application_settings`: `terminal.preferences` (font size 8–32, font family preset,
  scrollback 500–50,000, default shell id, default working directory) and
  `terminal.layout.<group id | ungrouped>` (validated split tree, at most 6 panes).
- After a restart, previous sessions appear as ended tabs ("ended when ATLAS stopped")
  with **Restart** (new process, same title/shell) and **Close**.

### Desktop presentation

- **Terminals** view (SDD-003): a sidebar with collapsible terminal groups, an Ungrouped
  section and the registered projects; the selected group (or Ungrouped) is a workspace
  with a tab bar (one tab per session: status dot, name, rename by double-click/F2,
  close), toolbar (new terminal in the default directory, a chosen folder, a project or
  with another shell; split right/down; single pane; settings), and a split tree rendered
  with shadcn `Resizable` (react-resizable-panels).
- Layout model (`terminal/state/layout.ts`, pure and unit-tested): a pane references one
  session; a session is shown in at most one pane. Selecting a hidden tab shows it in the
  active pane. Hiding a pane never stops its process. Closing a tab terminates it after
  confirmation when a program other than the idle shell runs in the foreground.
- `TerminalView` (outside React) owns one xterm.js instance per visible pane: FitAddon,
  SearchAddon, ResizeObserver with 60 ms debounce, resize only on dimension changes.
  Views of hidden sessions and other projects are disposed (detached) and rebuilt from the
  mirror when shown again.
- Shortcuts live in the application menu (see SDD-002 doc); Windows/Linux use Ctrl+Shift
  combinations so Ctrl+C/Ctrl+D/etc. reach the shell.

### Application quit

Quitting (Cmd+Q, or closing the window on Windows/Linux) asks for confirmation when
terminals are running, then stops the Engine host, which terminates every process. On
macOS closing the window keeps the app and its terminals alive; reopening reattaches.
Terminal processes never outlive the Engine.

## Workspace and Git (SDD-003 Milestone A)

### Terminal names and working directory

- `customTitle` (user-defined, never overwritten) is stored apart from `autoTitle` (the
  current directory's name, `~` for home). `title` is the effective one; renaming to
  `null` restores the automatic name.
- After a command is entered (input containing a newline) and output has been quiet for
  700 ms, the Engine reads the shell's working directory: `/proc/<pid>/cwd` on Linux,
  `/usr/sbin/lsof -a -p <pid> -d cwd -Fn` on macOS (about 20 ms, no shell). Windows has
  no reliable source, so `currentCwd` stays the initial directory with
  `cwdSource: 'initial'`. A program that changes directory without the shell (or a shell
  cwd changed by a background job) is only seen after the next command.

### Groups

`TerminalGroups` (`packages/terminal`) creates, renames, collapses, reorders and deletes
groups (at most 50). Membership and order live on the terminal sessions
(`TerminalService.move`, which only updates metadata). Deleting a group moves its
terminals to Ungrouped unless the user explicitly asks to terminate them; its layout is
deleted. Changes are broadcast as `groups` events.

### Git inspection

`GitInspectionService` (`packages/git`; the `execFile` runner lives in `apps/engine/src/git`) runs the system `git` through `execFile`
(argument arrays, no shell) with `-c core.fsmonitor=false --no-optional-locks`, inherited
`GIT_*` variables removed, `GIT_TERMINAL_PROMPT=0`, a 5 s timeout, at most 4 concurrent
processes and a 1.5 s cache per directory. Commands:

| Data                                                              | Command                                                      |
| ----------------------------------------------------------------- | ------------------------------------------------------------ |
| Repository root (any subdirectory works)                          | `rev-parse --show-toplevel`                                  |
| Branch, detached/unborn HEAD, upstream, ahead/behind, file counts | `status --porcelain=v2 --branch -z --untracked-files=normal` |
| Local branches, recency (latest commit date)                      | `for-each-ref --sort=-committerdate refs/heads`              |
| Effective identity (git precedence)                               | `config --get user.name` / `user.email`                      |

Counting policy: each changed path is one entry of `total`; `modified` = unstaged
tracked changes, `staged` = index changes, `deleted` = staged or unstaged deletions,
`renamed` = staged renames, plus `untracked` and `conflicted`. A path can be in several
counters but is counted once in `total`. Ahead/behind come from local remote-tracking refs
(never fetched); no upstream → `null`, a missing tracking ref → `upstreamGone`. Missing
git, timeouts and "dubious ownership" become an explicit `unavailable` state.

Refresh: on request (project details, terminal header), when a terminal's directory
changes, when `RepositoryWatcher` sees HEAD/index/refs change in the git directory
(debounced 500 ms, best effort), and every 30 s for watched repositories (at most 32).
Changes are broadcast as `git` events; clients re-request the snapshot. Git never runs
on output chunks and never blocks terminal I/O (separate processes in the Engine host).

## Git workflow (SDD-004 Milestone A)

Full description: `docs/sdd/SDD-004-git-and-ai-execution.md`, Part I.

```text
 Renderer Git view ── IPC (Zod) ──► main ── Engine request ──► dispatcher
   commit dialog, diff, branches                                   │ requireGitRepository(root)
   validateCommitMessage (as you type)                             ▼
                                              GitWorkspaceService ──► GitOperationCoordinator
                                              (status, diff, stage,     per repository: lanes
                                               commit, push, pull,       "index" and "remote";
                                               fetch, branches)          queued/running/... events
                                                     │ GitExecutor (spawn, argv, no shell)
                                                     ▼
                                                   git ──► hooks, credential helpers
```

- **Authorization**: requests name a `repositoryRoot`, accepted only when the Engine itself
  resolved it from a registered project or a live terminal (re-checked per request). Paths
  must be listed by `git status`; branch names exist or pass `check-ref-format`.
- **Execution**: `createGitExecutor` (spawn) adds stdin (commit messages), exit-code
  allow-lists, bounded stdout, and `--progress` lines. Workflow commands use
  `--literal-pathspecs`; diffs use `--no-ext-diff --no-textconv`. Hooks always run.
- **Index semantics**: commits commit the index after the user's explicit selection
  (`stage`/`unstage` lists); an index fingerprint (HEAD + branch + staged entries) detects
  concurrent changes (`GIT_INDEX_CHANGED`). Selected files are protected by a separate
  content and mode identity check before and after the pre-commit steps and against what
  `git add` staged; a refusal after staging restores the selection's paths to their
  state before the commit attempt (including intent-to-add entries); if that restore
  fails, the user is told the selection remains staged.
- **Operations**: expected failures are reported on the `GitOperation` with a code and
  credential-free Git output; validation problems are request errors. `git-operation`
  events update every view; mutations invalidate the inspection cache and emit `git`.
- **Operation log (PLAN-016)**: the coordinator's journal (`GitOperationLog`) persists
  every status change; `recordingExecutor` records each command run inside an operation
  (attributed through an `AsyncLocalStorage` scope) with sanitized, size-limited output.
  `git.reflog` reads HEAD's reflog and marks entries matching a logged operation by time
  and kind. Retention by age and count; unfinished operations are closed at start.
- **Conventional Commits**: enforced by default in the renderer and Engine, with stricter
  rules from `git.preferences`. Project settings can disable enforcement and configure
  ordered pre-commit commands through the Engine's `PreCommitStepRunner` adapter
  (ADR-037). Running checks are cancellable; a failing check returns `check-failed` and
  nothing is committed. Queued operations are cancelled immediately. Engine shutdown
  cancels queued and cancellable running operations, stops accepting new operations, and
  waits a bounded time (derived from the pre-commit step kill grace period) for operations
  that cannot be cancelled (commit, push) to finish.
- **Invalid stored settings**: unreadable global preferences (`git.preferences`) or
  project commit checks refuse commits instead of dropping rules. `git.getPreferences`
  returns the defaults with `invalid: true` and `git.getProjectSettings` with
  `settingsInvalid: true` (both optional, absent when readable); Settings → Git warns
  "Stored Git preferences are invalid; save to replace them." and the commit dialog shows
  the same message with Commit disabled.

## Shared Context (SDD-005 Milestone A, stage A1)

Full description: `docs/sdd/SDD-005-multi-agent-and-shared-context.md`, Part I.

```text
 Context view / terminal menu / CLI ──► context.* / ai.* (Engine; targets authorized)
                                              │
                         SharedContextService (packages/context)
                          │                        │
          SqliteContextRepository          RepositoryEvidence (packages/git)
          (migration v5, FTS5 search)      state, file hashes, ancestry, commits/files
                                              │
   ai.start ─► AiSession + terminal ─► `claude|codex "$(cat <0600 prompt file>)"`
```

- Records belong to a project or a repository root (or are global by explicit choice);
  every request is resolved by the Engine and scoped to that owner.
- Entries are versioned (`context_revisions`); verification distinguishes Git evidence,
  the user's statements and (later) agent observations.
- Bundles check freshness against Git before every use and wrap stored content as
  untrusted reference data within a token budget.
- Managed AI sessions run the provider CLIs in ATLAS terminals; ATLAS never reads their
  conversations. Session summaries combine Git evidence with the user's summary.

### Project configuration for LLMs (PLAN-014)

```text
 Project details "AI & context" ─► context.projectConfig / setProjectConfig
                                          │
 ProjectConfigStore (apps/engine) ─► <data>/projects/<id>/project-config.json, context.md
                                          ▲ refreshed after context changes (dispatcher)
 ATLAS terminal env: ATLAS_PROJECT_* + PATH=<data>/bin:… ─► claude / codex wrappers
                                          └─► real CLI + "read the ATLAS configuration first"
```

Details and limitations: SDD-005 Part I, "Project configuration for LLMs"; ADR-042.

Automatic sessions and checkpoints (PLAN-021):

```text
 wrapper ─► <data>/context/events/<run>.start|end.json ─► LlmSessionTracker (apps/engine)
    │                                                         ├─ start/end attached AI session
    └─► ATLAS_CHECKPOINT_FILE (written by the LLM) ──────────►├─ checkpoint entry (observed)
 terminal exit / Engine start ───────────────────────────────►└─ automatic end with Git evidence
```

Details: SDD-005 Part I, "Automatic LLM sessions and checkpoints"; ADR-051–ADR-053.

### Context retrieval (SDD-006 Milestone A)

Full description: `docs/sdd/SDD-006-context-intelligence-and-skills.md`, Part I.

```text
 context.bundle(objective, role, files, keywords, exclusions, detail)
      │
 SharedContextService.bundle ─► LRU cache of stored records (key: owner, task, terms,
      │                          PRAGMA data_version + local writes)
      ├─ candidates: newest entries + FTS5 bm25 matches, active decisions, global entries
      ├─ freshness against Git (always, also on a cache hit)
      ├─ budget: request → task → profile → role → provider → default (application_settings)
      └─ buildBundle (pure): explainable scores, duplicates, compaction, relevance,
         priority sections, required records, included / excluded with reasons, warnings
 context.health / reconcile ─► stale, conflicts, duplicates, closed-task pending, sources
```

Tokens are always an estimate (characters / 4). The retrieval code is pure and has no
Node.js dependencies because the renderer bundles `@atlas/context`.

### Quick commands and project actions (PLAN-023)

```text
 Quick commands view ─► quickCommands.* ─► QuickCommandStore (apps/engine) ─► application_settings
 ProjectActionsMenu ─► projects.actions(projectId) ─► [open-terminal, run-command…]
        └─ run-command ─► quickCommands.run(ids) ─► terminals.create(project) + write(command⏎)
```

Details: SDD-003 Part I-C; ADR-055.

### Skills Hub (SDD-006 Milestone B)

Full description: `docs/sdd/SDD-006-context-intelligence-and-skills.md`, Part I-B.

```text
 Skills view / CLI ─► skills.* (Engine) ─► SkillsHub (packages/skills)
                                            ├─ NodeSkillFileSystem: read authorized folders, copy
                                            ├─ analyzeSkill: frontmatter (yaml), Claude/Codex adapters,
                                            │   scripts, permissions, credentials, dependencies
                                            ├─ SqliteSkillRepository (migration v8)
                                            ├─ resolveSkill: security > restrictions > session > role > enable
                                            └─ sync: preview / apply / rollback, .atlas-managed.json
 SharedContextService.bundle ─► skills resolver ─► "Skills enabled by the user" (paths only)
```

Picked paths are tracked by the desktop main process, which passes `explicit` to the
Engine; sync folders must be picked or suggested.

### Project context of a terminal

`Engine.terminalProjectContext` reports the associated project and the deepest registered
project containing the terminal's current directory. `Engine.registerProjectFromTerminal`
registers that directory (taken from the Engine's record, not from the client) and
associates the terminal.

### Application version

The desktop version comes from `app.getVersion()` (desktop `package.json`); the Engine
version is injected at build time from `apps/engine/package.json`
(`__ATLAS_ENGINE_VERSION__`; from its own package.json when run outside Electron); the
build id is `git rev-parse --short HEAD` (`-dirty` with local changes) at build time.
`app:info` combines them with channel (`development` unless packaged), platform,
Electron/Chromium/Node versions, data directory, log file and schema version. Shown in
the sidebar footer, the About dialog (app menu) and Settings.

## ATLAS Sessions (SDD-003 Milestone B)

Sessions are persistent orchestration records. `packages/sessions` holds the domain:
the state machine, task graph validation, `SessionService` and `SessionSettingsStore`.
It depends only on contracts and ports (`SessionRepository`, `SessionWorkspaces`), like
`packages/terminal`. The Engine composes it for every client; no execution happens.

### Lifecycle

| From                       | Allowed triggers (target)                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------ |
| DRAFT                      | markReady (READY), cancel (CANCELLED)                                                            |
| READY                      | returnToDraft (DRAFT), start (WAITING_EXECUTOR; RUNNING with an executor), cancel                |
| WAITING_EXECUTOR           | pause (PAUSED), cancel, run\* (RUNNING)                                                          |
| RUNNING\*                  | pause, requestApproval\* (WAITING_APPROVAL), complete\*, fail\*, cancel, interrupt (INTERRUPTED) |
| WAITING_APPROVAL           | approve\* (RUNNING), fail\*, cancel, interrupt                                                   |
| PAUSED                     | resume (WAITING_EXECUTOR; RUNNING with an executor), cancel                                      |
| INTERRUPTED                | resume (explicit only), cancel                                                                   |
| COMPLETED/FAILED/CANCELLED | final; can be archived                                                                           |

\* executor triggers. No execution adapter exists before SDD-004, so nothing calls them
and the service always runs with `executorAvailable: false`: a started session is
`WAITING_EXECUTOR` and `startedAt` stays `null`. `completedAt` is only set for COMPLETED;
`endedAt` marks any final status. Users act through named actions (`markReady`,
`returnToDraft`, `start`, `pause`, `resume`, `cancel`, `archive`); there is no API that
sets a status. `markReady`, `start` and `resume` first check that the workspace exists and
is readable and writable. Drafts are the only editable sessions.

### Restart reconciliation

Only the Engine host (the process that would own executions) reconciles: at startup and
at shutdown, RUNNING and WAITING_APPROVAL sessions become INTERRUPTED (event reason
`engine-restart` / `engine-shutdown`) and their IN_PROGRESS tasks become INTERRUPTED.
WAITING_EXECUTOR and PAUSED are kept (nothing was in flight). Nothing resumes
automatically and nothing is marked completed. Short-lived clients (CLI) never reconcile.

### Workspace

A session works in a registered project (its current directory), in a standalone
directory (validated and stored as its realpath) or has none yet. Removing a project
first converts its sessions into standalone sessions in the same directory
(`SESSION_PROJECT_DETACHED`); `ON DELETE SET NULL` is the database backstop. A workspace
association is not a sandbox; execution isolation belongs to later specifications.

### Tasks, events and approvals

- Tasks (at most 200 per session, 20 dependencies each) are planned by the user while the
  session is not finished. Dependencies must be tasks of the same session; self-references
  and cycles (iterative DFS) are rejected (`SESSION_TASK_CYCLE`). `blockedBy` is derived
  from dependencies that have not completed. Users can add, edit, cancel and remove
  pending tasks; progression (IN_PROGRESS → COMPLETED/FAILED) is reserved for executors.
  Cancelling a session cancels its unfinished tasks.
- Every change appends events in the same transaction. Metadata is structured and
  allow-listed (statuses, task ids, changed field names, reasons, counts); objectives,
  constraints and task text are never copied into events or logs.
- `session_approvals` and `ApprovalRequest` are prepared for SDD-004 adapters; nothing
  creates approvals yet, and details only list pending ones.

### Execution profiles

ECONOMY / BALANCED / MAXIMUM are planning metadata: `maxParallelTasks` (defaults 1/2/4,
1–8, ECONOMY ≤ BALANCED ≤ MAXIMUM) and a global `maxConcurrentSessions` (default 3, 1–16)
are stored in `application_settings` (`sessions.settings`) and validated, but nothing
enforces them until a scheduler exists. Profiles have no security-related fields.

### Persistence and concurrency

Migration v4 adds `atlas_sessions`, `session_tasks`, `session_task_dependencies`
(composite foreign keys keep dependencies inside one session; a task others depend on
cannot be deleted), `session_events` and `session_approvals`. Each change is one
`BEGIN IMMEDIATE` transaction guarded by the session `revision`
(`UPDATE … WHERE revision = ?`): a writer that read an older revision changes nothing and
gets `SESSION_CONFLICT`; Engine-initiated changes re-read and retry.

### Clients

- Desktop: IPC channels `atlas:sessions:*`; workspace directories must come from the
  native picker. Session changes are pushed as `session-changed` events on
  `atlas:sessions:changed`; the Sessions view also refreshes on window focus.
- CLI: `atlas session …` commands call the running Engine host over the socket (so the
  app updates live) and otherwise run the same dispatcher on the database. The CLI
  allow-list includes list, get, create, perform, tasks and events.

## CLI transport

- The Engine host listens on `<data dir>/run/engine.sock` (directory 0700, socket 0600).
  Paths longer than 100 bytes fall back to `$TMPDIR/atlas-<hash>.sock`. Windows uses
  `\\.\pipe\atlas-engine-<hash>`.
- `<data dir>/run/engine.json` (0600, written atomically) holds the endpoint, pid and a
  random 32-byte token. Clients must send `{type:"hello", token}` within 2 s; tokens are
  compared with `timingSafeEqual` over SHA-256 digests. Messages are newline-delimited JSON
  (2 MiB limit); malformed input drops the connection.
- A stale socket left by a crash is detected (connect fails) and replaced; a live one
  makes a second Engine refuse to start.
- After `atlas project remove`, the CLI tells a running Engine (`terminals.detachProject`)
  so its live terminals drop the association; the database clears it for stored ones.

## Projects (SDD-001)

Domain rules, path normalization (`path_key`), Git detection and availability handling
are unchanged; see SDD-001. `ProjectService.resolveAvailableWorkspace(id)` was added for
terminal authorization, plus `resolveAvailableDirectory` and `findContaining` (deepest
registered project containing a directory) for SDD-003. Removing a project keeps its
terminals running as standalone terminals (SDD-003 §2).

## Persistence

- SQLite through `node:sqlite` (`DatabaseSync`), WAL, 5 s busy timeout, `STRICT` tables,
  append-only migrations in `schema_migrations` (`BEGIN IMMEDIATE`), newer schemas refused.
- Schema v1: `projects`, `application_settings`. Schema v2: `terminal_sessions`. Schema v3:
  standalone terminals, names, groups (table rebuild; SDD-002 per-project layouts dropped).
  Schema v4: ATLAS Sessions (additive). Schema v5: Shared Context with FTS5 (additive).
  Schema v6: context retrieval — required entries, task branch and budget,
  reconciliation runs (additive). Schema v7: Git operation and command log (additive).
  Schema v8: Skills Hub (additive).
- Data dir: macOS `~/Library/Application Support/ATLAS`, Windows `%APPDATA%\ATLAS`, Linux
  `$XDG_DATA_HOME/atlas`; `ATLAS_DATA_DIR` overrides.

## Desktop security model

- `contextIsolation`, `sandbox`, no `nodeIntegration`, `webSecurity`; preload exposes only
  `AtlasApi` (`projects`, `dialog`, `terminals`, `app`). Event subscriptions never expose
  `IpcRendererEvent`.
- Every IPC message (invoke and send) must come from the main window's main frame at the
  app URL and is validated with Zod in main **and** again in the Engine.
- Renderer-supplied paths (projects, standalone terminal directories, the default working
  directory) must come from the native picker; registering a terminal's directory uses the
  Engine's own record of it; shells are selected by id.
- Production CSP: `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline';
connect-src 'none'; …` — inline styles are required by xterm.js and Radix (ADR-011).
- New windows denied, navigation blocked, permission requests denied, single-instance
  lock per data directory.
- Logs record terminal lifecycle (ids, pid, shell id, exit code) — never input, output,
  environment or command lines.
- Project-scoped terminals are **not** an OS sandbox: a shell has the user's full
  privileges and can leave its starting directory.

## Errors and logging

`AtlasError` codes now also include `TERMINAL_NOT_FOUND`, `TERMINAL_NOT_RUNNING`,
`TERMINAL_LIMIT_REACHED` (32 live / 64 total sessions), `TERMINAL_SHELL_UNAVAILABLE`,
`TERMINAL_START_FAILED` and `ENGINE_UNAVAILABLE`. Clients
only receive `{ code, message, issues }`. Logs: `<data dir>/logs/atlas.log` (JSON lines,
0600, rotated at 5 MB) from the main process (`desktop`), Engine host (`engine`) and CLI.

## Renderer

React 19 with shadcn/ui components (Radix primitives, Tailwind CSS v4, lucide icons),
dark theme only. Generated components live in `src/renderer/src/components/ui` and are
owned by the project. Views: Projects (with Git details), Terminals (groups) and
Settings (terminal preferences, About and diagnostics). Responsive: the sidebar collapses to icons below 1024 px; the Terminals view
replaces its project list with a select below 768 px.

## Build and tooling

- pnpm workspaces, exact versions; `allowBuilds` for electron, esbuild and node-pty.
- Packages/engine/CLI: `tsc -b` to `dist/`. Desktop: electron-vite bundles main and the
  Engine host (ESM; node-pty and xterm headless externalized), preload (CJS) and the
  minified renderer.
- Tests: Vitest (unit with fake PTYs, integration with real PTYs/sockets), Playwright
  `_electron` (end-to-end, including a 10-terminal performance check).
