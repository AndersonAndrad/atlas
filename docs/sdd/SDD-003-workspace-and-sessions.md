# ATLAS — SDD-003: Workspace Experience & Orchestration Sessions

**Project:** ATLAS — Autonomous Task Leadership & Agent System  
**Specification:** SDD-003  
**Dependencies:** SDD-001 and SDD-002  
**Status:** Milestone A implemented, validated and approved by the developer ("pode seguir",
2026-10-20). Milestone B implemented and validated — awaiting the developer's approval.

Part I documents the implementation of Milestone A, Part I-B the implementation of
Milestone B. Part II preserves the specification as received.

---

# Part I — Milestone A implementation

## Approved plan

PLAN-003 revision 1 (Milestone A and the README logo) was approved with "pode seguir"
(developer, Git `user.name`: Anderson Andrade; recorded 2026-10-20), acknowledging risks
R1–R9 (R1 High: Git configuration executing commands in untrusted repositories).

| ID  | Decision                                                                                     | ADR     |
| --- | -------------------------------------------------------------------------------------------- | ------- |
| D1  | Terminal workspaces are groups (plus Ungrouped), each with its own tabs and splits           | ADR-016 |
| D2  | Current directory read from the OS (`/proc`, `lsof`) after a command settles; not on Windows | ADR-017 |
| D3  | Read-only Git via the system executable, hardened against repository configuration           | ADR-018 |
| D4  | Git refresh on request, cwd change, git-directory watch and every 30 s                       | ADR-019 |
| D5  | Removing a project keeps its terminals running, unassociated                                 | ADR-020 |
| D6  | Native drag and drop plus menu moves; no new dependency                                      | ADR-021 |

## Requirement mapping

| Requirement                       | Implementation                                                                                                                                                                                                                                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-301 Standalone terminals       | `projectId` nullable; start in a picked folder, the default working directory (Settings) or home; any shell; tabs/splits; associate later (terminal menu, project sheet); `atlas terminal open --cwd`                                                                                                         |
| FR-302 Custom names               | `customTitle` stored apart from `autoTitle`; never overwritten by directory changes; "Restore automatic name"; shown in tabs, groups sidebar and pane headers; `atlas terminal rename … [--auto]`                                                                                                             |
| FR-303 Groups                     | Create, rename, delete (ungroup or explicitly terminate), add/remove/move (drag and drop or menu), reorder groups and terminals, collapse/expand; mixed projects                                                                                                                                              |
| FR-304 Group persistence          | `terminal_groups` table; membership/order on `terminal_sessions`; collapsed state; per-group layouts; ended sessions never shown as running                                                                                                                                                                   |
| FR-305 Version                    | Desktop and Engine versions from package metadata, channel, build id, platform: sidebar footer, About dialog, Settings → About/diagnostics                                                                                                                                                                    |
| FR-306–FR-310 Project Git details | Root, branch (detached/unborn), identity, branch count, three recent branches _by latest commit_, modified/staged/untracked/deleted/renamed/conflicted plus distinct total, ahead/behind with upstream and "as of the last fetch" note, last refresh; "No Git repository" state; never initializes or fetches |
| FR-311 Terminal Git indicators    | Branch, `M:n`, `S:n`, `↑n ↓n` (or "—" without upstream) with tooltips, following the detected cwd; hidden outside repositories                                                                                                                                                                                |
| FR-312 Refresh                    | On open/select, cwd change, git-directory watcher, 30 s periodic, manual refresh; never per output chunk; git in separate processes                                                                                                                                                                           |
| FR-313 Quick details              | Pane ⓘ opens a sheet: associated project, or a matching registered project (with "Associate"), or "Register this directory"                                                                                                                                                                                   |
| FR-314 Projects without Git       | Plain folders, subdirectories of repositories, removed `.git`, unavailable directories handled with explicit states                                                                                                                                                                                           |

## Git inspection

See `docs/ARCHITECTURE.md` → "Workspace and Git". Counting policy: each changed path once
in `total`; categories may overlap (a staged-and-modified file is in both `staged` and
`modified`). Ahead/behind reflect local remote-tracking refs (last fetch).

## Behavior changes from SDD-002

- Terminal tabs belong to groups (or Ungrouped) instead of projects.
- Removing a project no longer terminates its terminals and is no longer refused by the CLI.
- Per-project layouts from SDD-002 were dropped by migration v3 (one-time).
- Automatic names follow the current directory (`~` for home) instead of `<shell> N`.

## Known limitations

- Verified on macOS only. Windows cannot report a shell's current directory (initial
  directory is shown, labeled); Linux/Windows Git and cwd paths are covered by unit tests.
- The cwd is read after a submitted command; directory changes made otherwise appear later.
- Editors changing files outside the terminal show up within 30 s (or on refresh).
- Requires the `git` executable for Git details; without it an explicit state is shown.
- "Recent branches" uses the latest commit date, not checkout time.

---

# Part I-B — Milestone B implementation

## Approved plan

PLAN-004 revision 1 (Milestone B) was approved with "sim pode seguir" (developer, Git
`user.name`: Anderson Andrade; recorded 2026-10-20), acknowledging risks R1–R8 (none
High). Milestone A had been approved first ("pode seguir"), as §11 requires.

| ID  | Decision                                                                                    | ADR     |
| --- | ------------------------------------------------------------------------------------------- | ------- |
| D1  | Without an executor a started session is `WAITING_EXECUTOR`; never a fake RUNNING           | ADR-022 |
| D2  | Engine host reconciles RUNNING / WAITING_APPROVAL into INTERRUPTED on start and stop        | ADR-023 |
| D3  | Workspace is a project, a directory or none; removing a project keeps the directory         | ADR-024 |
| D4  | CLI uses the running Engine (live updates), otherwise the same services on the database     | ADR-025 |
| D5  | User-planned tasks with in-session dependencies; cycles rejected; progression for executors | ADR-026 |
| D6  | Execution profiles and concurrency limits are validated configuration only                  | ADR-027 |
| D7  | Append-only events with allow-listed metadata, never free text                              | ADR-028 |
| D8  | Approval contracts and storage prepared; read-only pending list                             | ADR-029 |
| D9  | Finished sessions are archived (hidden by default), never deleted                           | ADR-030 |
| D10 | Sessions view (list, details tabs, no-executor banner), "New session" on projects, CLI      | —       |

Risks presented: R1 Medium (executor states without an end-to-end path), R2 Medium
(concurrent writers), R3 Medium (v4 database does not open in 0.3), R4 Low (free text in
the local database), R5 Low (workspace access checked before use), R6 Low (manual task
editing and extra CLI commands), R7 Low (planned limits not enforced), R8 Low (renderer
size).

## Requirement mapping

| Requirement                  | Implementation                                                                                                                                       |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-315 Session entity        | `AtlasSession` (plus `constraints`, `endedAt`, `archivedAt`); explicit transition table in `packages/sessions`; invalid transitions rejected         |
| FR-316 Creation              | From a project ("New session"), a folder (picker / `--cwd`) or the Sessions view; name and objective required; no provider needed                    |
| FR-317 Lifecycle             | Create, list, details, edit draft, mark ready, back to draft, start (→ WAITING_EXECUTOR), pause, resume, cancel, archive                             |
| FR-318 Concurrent sessions   | Any number per project and across projects, each with its own state, profile, tasks and events; planned `maxConcurrentSessions`; no worker processes |
| FR-319 Task graph            | Tasks with status, dependencies, agent id slot, validation criteria, timestamps; derived `blockedBy`; cycle and cross-session rejection              |
| FR-320 Events                | `session_events`, written atomically with each change; structured metadata only                                                                      |
| FR-321 Profiles              | ECONOMY / BALANCED / MAXIMUM with planned `maxParallelTasks`; configurable in Settings; no security fields                                           |
| FR-322 Dashboard             | Session list with status, profile, workspace and task counts; creation dialog; "No execution adapter" banner; "Not executing" label                  |
| FR-323 Details               | Overview, tasks (graph as dependency list), event timeline, pending approvals, agents placeholder                                                    |
| §21 Persistence and recovery | Migration v4; host reconciliation (INTERRUPTED, never completed, never resumed automatically)                                                        |
| §22 CLI                      | `atlas session create\|list\|show\|tasks\|cancel` plus `ready\|start\|pause\|resume\|archive`                                                        |
| §23 Security                 | Validated references; picker-only directories; named actions only; CLI allow-list; no free text in events                                            |

## Known limitations

- No execution adapter exists: RUNNING, WAITING_APPROVAL, COMPLETED and FAILED are only
  reachable in unit tests; approvals are never created.
- Profile and concurrency limits are stored and validated but not enforced.
- Workspace access is checked when a session is marked ready, started or resumed, not
  continuously; it is not a sandbox.
- Changes made by the CLI while the app is closed appear when the app starts; changes
  made by `atlas project remove` while the app runs appear on the next refresh (window
  focus or navigation).
- A database with schema v4 cannot be opened by 0.3 builds.

---

# Part II — Specification as received

## 1. Mission

Evolve ATLAS from a multi-project terminal application into a flexible development workspace and establish the foundation for independent AI orchestration sessions.

This specification contains two milestones:

- **SDD-003A:** Workspace, Terminal Groups, Project Details and Git Intelligence.
- **SDD-003B:** ATLAS Sessions, persistent orchestration state and lifecycle management.

Preserve all existing functionality. Inspect the current repository before changing its architecture.

Do not implement real AI provider execution yet. That belongs to SDD-004.

## 2. Fundamental Domain Separation

ATLAS must distinguish these concepts:

**Project:** A registered development workspace with metadata and an optional Git repository.

**Repository:** Git information associated with a directory. Not every project is a repository.

**Terminal:** An independent PTY process that may optionally be associated with a project.

**Terminal Group:** A user-defined collection of terminal sessions, potentially from different projects.

**ATLAS Session:** A persistent orchestration operation associated with a goal and an execution context.

**Agent:** A future execution participant assigned to an ATLAS Session.

Do not couple the lifecycle of one entity unnecessarily to another.

## Milestone A — Workspace & Git Experience

### FR-301 — Standalone Terminals

Users must be able to open a terminal without registering or selecting a project. A standalone terminal must support native shell selection, configurable working directory, default working directory based on user configuration, all existing PTY functionality, terminal tabs and split panes, and optional later association with a project. Project association must be nullable. Do not require a Git repository to open a terminal.

### FR-302 — Custom Terminal Names

Allow users to rename terminals, assign descriptive labels, restore automatic naming, and view names in tabs, groups and the sidebar (examples: NOVA Backend, WiiAscend Tests, Docker Services, Claude Development, General Terminal). Store user-defined labels separately from automatically generated labels. Do not overwrite a custom name when the working directory or process changes.

### FR-303 — Create and Manage Groups

Required operations: create group, rename group, delete group, add terminal to group, remove terminal from group, move terminal between groups, reorder groups, reorder terminals inside groups, collapse and expand groups. Groups may contain terminals from different projects. Deleting a group must not automatically terminate running PTY processes. When deleting a group, allow terminals to become ungrouped or explicitly offer termination with confirmation.

### FR-304 — Group Persistence

Persist group identifier, name, ordering, terminal associations, collapsed state and relevant layout preferences. Distinguish persisted terminal metadata from live PTY processes. Never represent a terminated process as running after application restart.

### FR-305 — Version Display

Display the actual application version in application settings, the About ATLAS dialog, application diagnostics and appropriate secondary interface locations. Use the authoritative package/build version. Do not hardcode arbitrary version strings in React components. Provide application name, version, development or production channel, build identifier when available, and platform information. Use semantic versioning. The About dialog must distinguish the Desktop version from the Engine version if they can differ.

### FR-306 — Enhanced Project Metadata

Show project name, description, local path, project availability, Git repository availability, repository root, current branch, configured Git user name and email, total number of local branches, three most recently updated local branches, number of modified files, ahead and behind commit counts, and last Git refresh timestamp. Do not require Git for project registration. If no repository exists, display a clear "No Git repository" state. The application must not automatically initialize Git.

### FR-307 — Git Identity

Read the effective Git identity (user.name, user.email) respecting Git configuration precedence. Do not confuse the repository's configured identity with the author of the most recent commit. If no identity is configured, display an unavailable state. Never modify Git identity while inspecting it.

### FR-308 — Branch Statistics

Display total local branches, current branch and the three most recently updated local branches, using the latest commit timestamp as the documented approximation, labeled e.g. "Recent branches by latest commit". Do not claim this represents the last checkout. Handle detached HEAD states and repositories without commits.

### FR-309 — Working Tree Statistics

Display modified tracked, staged, untracked, deleted and renamed file counts with a consistent counting policy, avoiding double-counting in any combined total. The terminal header may show a compact summary; the Project Details view should provide the breakdown.

### FR-310 — Ahead and Behind Commits

Display ↑ ahead and ↓ behind relative to the configured upstream using local tracking references. Do not automatically execute `git fetch`. Explain that values reflect the most recently fetched remote-tracking state. If no upstream exists, display an unavailable indicator rather than zero; handle invalid tracking information.

### FR-311 — Compact Git Indicators

When a terminal's working directory is inside a Git repository, display current branch, modified file count, ahead and behind (e.g. `NOVA Backend | main | M:5 | ↑2 | ↓1`), with icons and tooltips. Do not display invented counts. Hide Git indicators outside repositories. Git context should follow the terminal's actual current working directory when reliably detectable; otherwise use an explicitly labeled fallback or omit the indicators.

### FR-312 — Git Refresh

Update Git information when opening a terminal, when selecting a project, after relevant repository changes, on manual refresh and through reasonable debounced background refresh. Avoid expensive polling on every output chunk. Do not block PTY I/O. Use asynchronous operations and caching.

### FR-313 — Project Details Shortcut

Add a quick-access action in the terminal header: open the associated project's details; for standalone terminals whose directory matches a registered project, optionally offer to open it; otherwise offer to register the current directory. The action must not interrupt the terminal process.

### FR-314 — Project Without Repository

A project may be a normal folder, a Git repository, a subdirectory inside a repository, a folder whose repository was removed, or a temporarily unavailable folder. Handle each case without errors or misleading metadata. Keep the Project Registry independent of Git.

### §9 Terminal Group UI

Collapsible terminal group sidebar, ungrouped section, drag-and-drop or equivalent accessible move controls, rename and create actions, group context menu, clear distinction between terminals and groups, active terminal and running process indicators. Maintain the split-pane experience. Do not recreate PTY processes when moving terminals between groups.

### §10 Git Inspection Architecture

A read-only Git inspection service producing a `GitRepositorySnapshot` (repositoryRoot, branch, detachedHead, identity, localBranchCount, recentBranches, changes {modified, staged, untracked, deleted, renamed}, ahead, behind, upstream, inspectedAt), executed through a safe process adapter: no shell string interpolation, proper argument escaping, bounded execution time, cancellation where supported, graceful handling of missing Git, no repository mutations, no automatic network requests, no assumption that a project directory is the repository root, porcelain output where available.

### §11 Milestone A Acceptance Criteria

Standalone terminals work without registered projects; terminals can be renamed; groups can be created and managed; groups support terminals from multiple projects; group operations do not restart processes; application version is displayed correctly; projects without Git remain usable; Git user name and email are displayed; local branch count is accurate; three recent branches are displayed; modified, staged and untracked files are counted correctly; ahead/behind are accurate with an upstream; missing upstream is handled; terminal headers show Git information; Git inspection does not block terminal interaction; project details can be opened from the terminal; SDD-001 and SDD-002 remain operational; automated tests pass. **Do not start Milestone B until Milestone A passes validation.**

## Milestone B — ATLAS Sessions

### 12. Objective

Introduce persistent orchestration sessions as first-class entities.

An ATLAS Session represents one autonomous or supervised task execution.

Examples:

- Implement authentication in NOVA.
- Refactor a banking API.
- Create integration tests.
- Review a pull request.
- Improve ATLAS itself.

SDD-003B must implement session management and orchestration state, not actual AI provider execution.

### 13. Session Domain

#### FR-315 — ATLAS Session Entity

Define:

```typescript
interface AtlasSession {
  id: string;
  name: string;
  objective: string;

  projectId: string | null;
  workspacePath: string | null;

  status: AtlasSessionStatus;

  executionProfile: 'ECONOMY' | 'BALANCED' | 'MAXIMUM';

  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}
```

Define status transitions explicitly.

Suggested states:

- DRAFT
- READY
- RUNNING
- PAUSED
- WAITING_APPROVAL
- COMPLETED
- FAILED
- CANCELLED
- INTERRUPTED

Do not allow arbitrary status changes.

Distinguish an interrupted session from a successfully completed session.

### 14. Session Creation

#### FR-316 — Create ATLAS Session

Allow users to create sessions from:

- A registered project.
- A standalone workspace directory.
- The ATLAS Sessions interface.

Required information:

- Session name.
- Objective.

Optional information:

- Project.
- Workspace.
- Execution profile.
- Initial constraints.

A session must not require an AI provider connection at creation time.

Validate workspace access and permissions before execution.

### 15. Session Manager

#### FR-317 — Session Lifecycle

Implement:

- Create session.
- List sessions.
- Get session details.
- Edit draft session.
- Start session.
- Pause session.
- Resume session.
- Cancel session.
- Archive completed session.

For SDD-003B, starting a session should initialize the orchestration state and prepare it for execution.

It must not pretend to run real AI agents.

If no execution adapter is available, the session should remain READY or enter an explicitly defined WAITING_EXECUTOR state rather than falsely becoming RUNNING.

### 16. Independent Sessions

#### FR-318 — Concurrent Session Management

Support multiple independent sessions across multiple projects.

Each session must have:

- Unique identifier.
- Independent lifecycle.
- Own objective.
- Own state.
- Own execution profile.
- Own event history.
- Own future agent assignments.

The Runtime Manager must not assume one ATLAS Session per project.

Prepare configurable concurrency limits.

Do not create unnecessary worker processes before real execution exists.

### 17. Orchestration Task Model

#### FR-319 — Task Graph Foundation

Define a task model for future agent delegation.

Each task should support:

- Identifier.
- Session identifier.
- Title.
- Description.
- Status.
- Dependencies.
- Assigned agent identifier, when available.
- Validation criteria.
- Created and updated timestamps.

Prepare support for dependency graphs.

Detect dependency cycles.

Do not implement a complex distributed scheduler yet.

### 18. Session Events

#### FR-320 — Persistent Event History

Record meaningful session events.

Examples:

- SESSION_CREATED
- SESSION_UPDATED
- SESSION_READY
- SESSION_STARTED
- SESSION_PAUSED
- SESSION_RESUMED
- SESSION_CANCELLED
- SESSION_INTERRUPTED
- TASK_CREATED
- TASK_UPDATED
- APPROVAL_REQUESTED

Events must contain timestamps, session identifiers and relevant metadata.

Use persistent storage for important lifecycle events.

Avoid logging secrets or full unfiltered model conversations.

### 19. Execution Profiles

#### FR-321 — Initial Profiles

Define:

**ECONOMY**

- Lower planned resource usage.
- Conservative concurrency.
- Preference for efficient executors.

**BALANCED**

- Standard execution strategy.
- Balanced resource allocation.

**MAXIMUM**

- Higher configurable resource allowance.
- Greater potential parallelism.

For SDD-003B, implement configuration and validation only.

Do not claim to optimize actual model usage before the Intelligence Router exists.

Security policies must not be weakened by selecting MAXIMUM.

### 20. ATLAS Sessions Interface

#### FR-322 — Sessions Dashboard

Provide:

- Session list.
- Session creation dialog.
- Project association.
- Session status.
- Execution profile.
- Session objective.
- Task list.
- Event timeline.
- Future agent panel.

Display a clear distinction between configured sessions and sessions actively executing tasks.

Do not use fake agent activity.

#### FR-323 — Session Details

The user should be able to inspect:

- Objective.
- Project or workspace.
- Execution profile.
- Current status.
- Task graph.
- Lifecycle events.
- Pending approvals, when applicable.

Prepare a location for future agent terminals and execution results.

### 21. Session Persistence

Persist:

- Session metadata.
- Tasks.
- Dependencies.
- Lifecycle events.
- Execution profiles.
- Relevant settings.

After Engine restart:

- Restore session records.
- Reconcile incomplete execution states.
- Mark sessions as INTERRUPTED when necessary.
- Never fabricate successful completion.
- Do not automatically resume side-effecting operations.

Use database migrations consistent with existing project conventions.

### 22. CLI

Extend the ATLAS CLI.

Suggested commands:

```bash
atlas session create --name "NOVA Auth" --project <id>
atlas session list
atlas session show <id>
atlas session tasks <id>
atlas session cancel <id>
```

CLI and Electron must use the same Engine services.

Avoid duplicating business logic.

### 23. Security and Isolation

- Validate project and workspace references.
- Enforce authorized filesystem scope.
- Keep session state isolated.
- Avoid exposing credentials in events.
- Do not allow arbitrary session mutation through unvalidated IPC.
- Prepare approval contracts for future sensitive operations.
- Keep future AI execution behind explicit adapters.

Session association with a directory is not a filesystem sandbox.

Actual execution isolation will be implemented in later phases.

### 24. Automated Tests

#### Domain Tests

- Session creation.
- State transitions.
- Invalid transitions.
- Task dependency validation.
- Cycle detection.
- Profile validation.

#### Integration Tests

- Session persistence.
- Event persistence.
- Multiple simultaneous sessions.
- Engine restart recovery.
- Project deletion or unavailability.
- CLI operations.

#### Desktop Tests

- Create session.
- Select project.
- Select execution profile.
- View session details.
- View tasks and event history.
- Cancel or archive sessions.
- Restore sessions after restart.

Use isolated test databases and temporary directories.

### 25. Milestone B Acceptance Criteria

- [ ] ATLAS Sessions can be created.
- [ ] Sessions can be associated with projects or standalone workspaces.
- [ ] Multiple sessions can exist for one project.
- [ ] Multiple projects can have independent sessions.
- [ ] Session state transitions are validated.
- [ ] Session events persist.
- [ ] Task dependencies are supported.
- [ ] Dependency cycles are rejected.
- [ ] Execution profiles are configurable.
- [ ] Session details are visible in Electron.
- [ ] CLI session commands work.
- [ ] Engine restart does not lose session records.
- [ ] Interrupted sessions are represented accurately.
- [ ] No fake AI execution is reported.
- [ ] Existing features remain functional.
- [ ] Tests, type checks and builds pass.

## 26–29. Documentation, sequence, scope and delivery

Create this document and update ARCHITECTURE, ROADMAP, STATUS and DECISIONS with the actual
implementation. Implement Milestone A steps 1–10, then Milestone B steps 1–10. Out of scope:
Claude/Codex adapters, real multi-agent execution, automatic team assembly, Intelligence
Router, Context Engine, Skills Hub, account dashboards, remote workers, automatic
self-modification. Each milestone delivery reports features, architecture changes, files,
test and build results, manual verification, limitations and documentation, with evidence.
