# SDD-010 — Project Hub, Notes, Tasks & Multi-Jira Integration

**Status:** Milestone A (notes) implemented (PLAN-032, v0.24.0, schema v12) — awaiting
approval. Milestones B (local task manager) and C (multiple Jira connections) not started;
each needs its own plan after the previous milestone is validated.
**Priority:** High.
**Dependencies:** Project Registry, SQLite, Shared Context, ATLAS Sessions, Notification
Service.

Core principle: project organization belongs to ATLAS. External task-management platforms
are optional integrations. The Project Hub works completely offline, without Jira, AI
providers or any external service.

## Part I — Milestone A as implemented (PLAN-032)

### Decisions taken with the developer (2026-10-23)

- Approved by Anderson Andrade (Git `user.name`): "pode seguir, q1 ok, q2 a, q3 ok, q4 ok,
  ciente R1-R5".
- Q1: the Project Hub is its own view in the main navigation (below Projects), with
  section chips Overview · Notes · Tasks · Jira, following the developer's sketch. Tasks
  and Jira are shown as upcoming and hold no data; nothing is invented to fill them.
- Q2: removing a project from the registry keeps its notes. They lose the project
  association but keep the folder (workspace notes) and appear again in a project
  registered for the same folder.
- Q3: categories are free text, with autocomplete from the categories already used.
- Q4: `atlas:file/...` links only reveal the file in the system file manager; ATLAS never
  opens or edits project files from a note.
- R1–R5 acknowledged: Markdown from pasted notes (XSS, malicious links), data loss on
  project removal (mitigated by Q2), two new renderer dependencies, FTS5 query syntax,
  concurrent edits between the app and other clients.

### Architecture

```text
 Renderer (Project Hub view) ─► preload `atlas.notes` ─► main IPC (validates) ─► Engine host
                                                                                   │
   NotesService (packages/notes) ◄─ dispatcher `notes.*` ◄──────────────────────────┘
        │  links: projects, sessions, Git branches, files (realpath inside the project)
        ▼
   SqliteNoteRepository (migration v12: notes + notes_search FTS5)
        │
        └─► terminals.publish({ type: 'notes', noteId }) ─► main ─► renderer (lists reload)
```

- `packages/notes` holds the service, its ports and pure helpers (FTS query quoting, list
  excerpts). It depends only on contracts and shared. The Engine implements the link
  targets with the existing Project Registry, Session service and Git workspace service.
- Notes use the existing database connection, migration system and lifecycle event
  channel. There is no JSON file backend, no new database and no polling.
- The CLI does not expose notes (they are not in `CLI_ENGINE_METHODS`).

### Model and storage (FR-1002, FR-1004, FR-1008)

- `ProjectNote`: `id`, `projectId`, `workspacePath`, `title` (1–200), `content` (Markdown,
  at most 200,000 characters), `category` (free text, at most 60, or null), `pinned`,
  `archived`, `revision`, `createdAt`, `updatedAt`. Optional fields of the specification are
  `null` when absent, as elsewhere in the contracts.
- Owners: a project note has `projectId` and the project's folder; a workspace note only
  the folder (Q2); a global note neither. A schema `CHECK` keeps project notes with a folder.
- Migration v12 (additive): table `notes` (`project_id` references `projects` with
  `ON DELETE SET NULL`), indexes by project and by folder, FTS5 table `notes_search`, and a
  trigger that updates the folder of project notes when the project's folder changes.
- Lists return summaries (a plain-text excerpt instead of the content), pinned first, then
  the most recently updated; a project's list includes the workspace notes of its folder.
- Revisions: every change increments `revision`, and an update must name the revision it
  edited. The repository writes with `WHERE revision = ?`, so a write between the read and
  the write is also detected. A mismatch fails with `NOTE_CONFLICT`; nothing is merged or
  overwritten automatically.

### Search (FR-1005)

- SQLite FTS5 over title and content. User text becomes quoted prefix terms, so quotes and
  FTS operators typed by the user are never interpreted as query syntax.
- Filters: scope (project, global, all), active / pinned / archived, category.

### Links (FR-1006)

- Syntax: `atlas:note/<id>`, `atlas:session/<id>`, `atlas:branch/<name>` and
  `atlas:file/<relative path>` (`noteLinkHref` builds them; "Copy link to this note" in the
  editor puts a Markdown link to the clipboard).
- `parseNoteLink` (contracts) rejects malformed ids, branch names with `..`, spaces or a
  leading dash, and file paths that are absolute, contain `.`/`..` segments, backslashes or
  NUL.
- `notes.checkLinks` reports which links resolve: the note or ATLAS Session exists, the
  local branch exists in the project's repository, or the file exists inside the project's
  folder after resolving symbolic links. Broken links are shown struck through and are not
  clickable. Branch and file links need a project; in global notes they are broken.
- Opening: notes open in the editor, sessions in the Sessions view, branches in the Git
  view of the note's project; files are revealed with `shell.showItemInFolder` from the
  path the Engine resolved (the renderer never sends a path).

### Markdown editor and preview (FR-1003, FR-1007)

- A plain textarea with a toolbar (heading, bold, list, checklist, code, link, table), Edit
  / Split / Preview modes (Split only on wide windows), Ctrl/Cmd+S to save, an unsaved
  indicator and a confirmation before discarding unsaved edits.
- Preview: `react-markdown` 10.1.0 with `remark-gfm` 4.0.1 (tables, task lists,
  strikethrough, autolinks). It builds React elements; raw HTML is skipped (no
  `rehype-raw`), so scripts and event handlers never reach the DOM.
- URLs pass `safeNoteUrl`: only http(s), mailto, `atlas:` and in-page anchors survive.
  Images are never loaded (a placeholder shows the alternative text), so notes cannot track
  reading. External links open through `notes.openExternal`, which the main process accepts
  only for http(s) and mailto URLs.

### Interface

- Header: the project selector (registered projects, Global notes, All notes; it follows the
  selected project until the user chooses) and the section chips.
- Overview (FR-1019, notes part): Notes card with the count of active notes, pinned notes
  and recent notes; the Tasks card and the Jira line state that they arrive later.
- Notes: search, All / Pinned / Archived with counts, category filter, list, editor with
  pin, archive / restore, copy link and delete. On narrow windows the list and the editor
  are shown one at a time.
- Changes made elsewhere: the open note reloads when it has no unsaved edits; otherwise a
  banner warns, and saving reports the conflict with "Reload (discard my edits)" and "Save
  my version" (an explicit overwrite of the latest revision).

### Security boundaries

- Every IPC payload is validated in the main process and again by the Engine (zod strict
  schemas); SQLite access is parameterized.
- Notes never modify project files and are never sent anywhere. Note content is not
  logged; failures log the operation and error only.
- Files: realpath of the project folder and of the target; the target must be inside the
  folder (a symbolic link pointing outside is rejected).

### Test evidence

- `packages/notes/tests/notes.test.ts`: service (owners, validation, revisions and races,
  removal, FTS query quoting, link checks, file paths), link parsing and helpers.
- `packages/persistence/tests/notes.test.ts`: ordering, owners, filters, counts,
  categories, FTS after update and removal, revision guard, removal of the project (Q2),
  folder trigger, schema constraints, migration from v11.
- `apps/engine/tests/notes.test.ts`: persistence across Engine restarts, project removal
  and re-registration, links to sessions, branches and files (symbolic link escape), CLI
  scope.
- `apps/desktop/tests/hub-markdown.test.ts` and `ipc.test.ts`: sanitized rendering
  (script, iframe, `onerror`, `javascript:`, `data:`, `file:`, remote images), toolbar
  actions, reveal only inside the project, external links only http(s)/mailto.
- `tests/e2e/hub.spec.ts`: Scenario A (note survives a restart), search / pin / archive /
  global notes, conflict handling, terminals keep working, no horizontal overflow from 380
  to 1440 px. `security.spec.ts` checks the bridge surface.

### Known limitations

- No revision history of notes (only the conflict check) and no automatic merge.
- Notes are not attached to AI context yet: explicit attachment through the Shared Context
  Engine (section 8) comes with Milestone B, together with tasks.
- The editor is a textarea (no syntax highlighting); links to other notes are inserted by
  pasting the copied link.
- Tasks and Jira are not implemented.

## Part II — Specification

### Mission and objectives

Implement a local-first Project Hub for development knowledge, personal notes, TODO lists
and project tasks, extended with optional integration with multiple independent Jira
environments, for developers who work across several teams and organizations. Objectives:
notes per project, folders or categories, Markdown editing, local TODO lists, tasks and
priorities, association of tasks with ATLAS Sessions, files and Git branches, multiple Jira
connections, Jira issues linked to local projects, synchronization of authorized Jira
information, background notifications, and selected project knowledge available to AI
agents. ATLAS must not become a Jira replacement.

Reuse the Project Registry, SQLite, the Electron UI, Engine services, the Shared Context
Engine, the Notification Service, provider adapters and ATLAS Sessions. Do not introduce
external databases, a separate web server, another task execution engine, cloud storage or
a second project registry.

### Milestone A — Project notes

- FR-1001 Notes Service: create, update, delete, list, search, associate with a project or a
  workspace, pin, archive.
- FR-1002 Note model (`ProjectNote`) persisted in SQLite through the existing migrations.
- FR-1003 Lightweight Markdown editor: headings, lists, checklists, code blocks, links,
  tables, preview; no complete IDE editor.
- FR-1004 Organization: project, workspace and global notes, categories, pinned, archived;
  no complex hierarchy.
- FR-1005 Local search with SQLite (FTS where appropriate): title, content, project and
  category filters; no vector database.
- FR-1006 Links to notes, local tasks, ATLAS Sessions, Git branches and project files, with
  validated internal references; editing notes never modifies source files.
- FR-1007 Notes UI: sidebar, list, editor, preview, search, pin and archive controls,
  consistent with the ATLAS design system.
- FR-1008 Persistence in the existing database with safe updates and basic revision
  conflict detection; no JSON backend.

Acceptance: notes can be created and edited, persist after restart, Markdown editing works,
project and global notes work, search works, pinned and archived states work, terminals
are unaffected, tests pass.

### Milestone B — Local task manager

- FR-1009 Task Service: create, update, complete, reopen, archive, delete, list, filter;
  offline.
- FR-1010 Task model (`TaskStatus` TODO, IN_PROGRESS, BLOCKED, DONE, CANCELLED;
  `TaskPriority` LOW, MEDIUM, HIGH, CRITICAL; `ProjectTask` with project or workspace,
  title, description, status, priority, due date, session, parent task, timestamps),
  separate from the agent execution DAG: a TODO item is not an executable agent task.
- FR-1011 Multiple ordered TODO lists per project.
- FR-1012 List view and Board view (TODO, In Progress, Blocked, Done).
- FR-1013 Task details: description, priority, status, due date, checklist, related notes,
  session, branch and files.
- FR-1014 Checklists that do not complete the parent task unless configured.
- FR-1015 Create or associate an ATLAS Session from a task, open it, inspect progress; no
  automatic AI execution.
- FR-1016 Explicit AI delegation (Claude, Codex, an ATLAS team) through the Shared Context
  Engine and existing account routing; no duplicate orchestration.
- FR-1017 Optional associations with branch, commit, pull request URL and files.
- FR-1018 Notifications through the existing Notification Service (delegated task
  finished or failed, approval required, deadline approaching; deadlines only while ATLAS
  runs unless a scheduler exists).
- FR-1019 Compact Project Hub overview: recent and pinned notes, pending, in-progress and
  blocked tasks, recent related sessions.

### Milestone C — Multiple Jira connections

- FR-1020 Connection registry with independent connections (id, name, site URL,
  authentication, account identity, project mappings, synchronization settings).
- FR-1021 Jira Cloud REST APIs first, after checking current Atlassian documentation; other
  deployment types are future adapters.
- FR-1022 Officially supported authentication per connection, secure credential storage,
  no plaintext tokens in SQLite, no credentials in logs, explicit authorization, clear
  status; nothing copied between connections.
- FR-1023 `JiraConnection` metadata only in SQLite.
- FR-1024 Project mappings (none, one or several connections per project; a connection for
  several projects), composite issue identifiers `connectionId + issueId`.
- FR-1025 / FR-1026 Issue discovery and details limited to what the account may see,
  handling missing fields and permissions.
- FR-1027 Local-only, Jira-linked and Jira-synchronized tasks kept distinct.
- FR-1028 MANUAL and READ_ONLY synchronization first; TWO_WAY opt-in for documented, tested
  fields.
- FR-1029 Remote updates: read latest state, check permissions, detect conflicts, preview,
  authorize, apply, verify; failures are never reported as success.
- FR-1030 Independent authentication, mappings, status and errors per connection; no
  cross-connection leakage.
- FR-1031 A Jira issue may become the objective of an ATLAS Session; Jira status is never
  updated automatically.
- FR-1032 Notifications through the existing service; no continuous polling by default.
- FR-1033 Offline: local data stays available, cached Jira data shows freshness, no remote
  update is reported as completed, no silent mutation queue without an outbox design.
- FR-1034 Jira UI: environments, connection management, mappings, linked issues, details,
  synchronization status.

### Shared Context, security and scope

- Notes, tasks and Jira issues reach AI sessions only when the user attaches them
  explicitly, within project and account boundaries, with source references, stale Jira
  data identified and existing context budgets.
- Security: ATLAS-managed storage, parameterized queries, sanitized Markdown without script
  execution, validated internal links, protected Jira credentials and permissions, no
  cross-project leakage, external descriptions treated as untrusted data, private notes
  never published to Jira.
- Mandatory end-to-end scenarios: A (local notes survive a restart), B (TODO state across
  projects), C (AI delegation with linked task and session), D (two independent Jira
  environments), E (offline continuity).
- Out of scope: Jira replacement, enterprise reporting, time tracking, sprint planning, Jira
  administration or permission management, cloud synchronization of notes, real-time
  collaborative editing, an Obsidian replacement, external database servers.
- Milestones are implemented in order; each begins only after the previous one is
  validated.
