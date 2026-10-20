# Architecture Decision Records

Each decision lists context, decision, and consequences. Entries are append-only;
superseded decisions are marked, not deleted.

## ADR-001 — Lightweight Engine embedded in-process (superseded for the desktop by ADR-009)

- **Context**: SDD-001 requires an Engine independent of Electron, reused by the CLI,
  without an unnecessary public HTTP server.
- **Decision**: The Engine is a library with a single composition root
  (`createEngine`). Electron main and the CLI each create an instance in-process. A
  standalone `atlas-engine` binary boots it without Electron.
- **Alternatives**: Electron `utilityProcess` running the Engine (better isolation, but an
  extra RPC protocol now); NestJS (rejected by the spec).
- **Consequences**: Simple, testable, no network surface. Moving the Engine out of process
  later only requires a transport adapter around `ProjectService`.

## ADR-002 — SQLite through built-in `node:sqlite`

- **Context**: Persistent local storage shared by the desktop app and CLI.
- **Decision**: Use Node's `node:sqlite` (`DatabaseSync`). Verified working in Electron
  44.5.1 (Node 24.21.0, SQLite 3.53.4) and Node 24.18.0 before adoption.
- **Alternatives**: `better-sqlite3` (mature, but a native add-on requiring separate
  builds for the Node and Electron ABIs).
- **Consequences**: No native rebuilds. The API is newer than better-sqlite3; it is
  isolated behind the repository classes in `packages/persistence`, so a swap is local.

## ADR-003 — Separate `path_key` column for duplicate detection

- **Context**: FR-007 requires rejecting the same directory twice with OS-specific path
  semantics.
- **Decision**: Store the realpath in `workspace_path` (display) and a platform-normalized
  `path_key` with a UNIQUE constraint (macOS/Windows case-folded; macOS NFC; Linux exact).
- **Consequences**: Duplicates are rejected by the service and by the database. On a
  case-sensitive APFS volume, two directories differing only by case would be treated as
  duplicates (rare; accepted risk R5).
- **Spec change**: adds a column not listed in SDD-001 §9 (approved as D6 in PLAN-001).

## ADR-003a — Git detection by reading `.git` metadata

- **Decision**: Walk parents for `.git` (dir or `gitdir:` file) and read `HEAD`; no `git`
  executable dependency.
- **Consequences**: Fast, works without Git installed. Exotic setups (`GIT_DIR`, bare
  repositories as workspaces) are not detected.

## ADR-004 — Paths from the renderer must come from the native picker

- **Context**: FR-002 and the security requirement "no arbitrary filesystem access from
  React".
- **Decision**: The main process remembers paths returned by the native picker during the
  session and rejects create/update requests with any other path.
- **Consequences**: A compromised renderer cannot register or probe arbitrary
  directories. Relocation of an unavailable project also uses the picker.

## ADR-005 — Shared data directory resolution

- **Decision**: One resolver (`resolveDataDir`) used by desktop, CLI and Engine binary;
  `ATLAS_DATA_DIR` overrides. Electron's `userData` is moved below it before the
  single-instance lock.
- **Consequences**: CLI and UI always see the same registry; tests are fully isolated.

## ADR-006 — Interpretation of "restore if it remains available"

- **Decision**: The selection is restored if the project is still registered. If its
  directory is unavailable it is restored anyway and shown with an unavailable status,
  so the user can update the path (FR-009). Stale ids are cleared.

## ADR-007 — Toolchain versions

- **Decision**: Node 24 LTS; Electron 44.5.1; electron-vite 5.0.0 with Vite 7.3.7;
  TypeScript 5.9.3; React 19.3.0; Zod 4.6.5; Vitest 4.1.12; Playwright 1.63.0. All pinned
  exactly; each release was at least two weeks old when chosen (R2: prefer stable/LTS
  lines over the newest majors such as Vite 8, Vitest 5 and TypeScript 7).

## ADR-008 — No packaging in SDD-001

- **Decision**: `pnpm build` produces runnable bundles (`electron-vite build`, `tsc -b`).
  Installers, signing and auto-update belong to a future specification.

## ADR-009 — Engine host in an Electron utility process (SDD-002, PLAN-002 D1)

- **Context**: SDD-002 makes terminals Engine-owned resources, requires that PTY work
  never blocks the Electron main thread, and that the CLI talks to the running Engine.
- **Decision**: The desktop runs the whole Engine (projects, terminals, SQLite, CLI socket)
  in `utilityProcess.fork`. Main validates renderer IPC and forwards it as Engine requests;
  the host validates again in `EngineDispatcher`. Supersedes ADR-001 for the desktop; the
  CLI still embeds an Engine (without terminals) for project commands.
- **Alternatives**: Engine in main with only PTYs in a child process (split state, more
  protocol); everything in main (blocks the main thread, a native crash kills the app).
- **Consequences**: Crash isolation and a single owner for terminals; project calls take an
  extra hop. Terminal output is still relayed by main (batched); a direct MessagePort to
  the renderer is a possible optimization.

## ADR-010 — Headless xterm mirror for reattachment (PLAN-002 D2)

- **Context**: Views are rebuilt after renderer reloads, project switches and pane changes;
  a new xterm.js instance cannot reconstruct full-screen programs from a byte log.
- **Decision**: Each session feeds an `@xterm/headless` terminal; `addon-serialize`
  produces the snapshot (1,000 lines of scrollback) together with a sequence number.
- **Consequences**: Correct alternate-screen restoration; output is parsed twice (Engine
  host and renderer). Some modes (e.g. mouse tracking) may need the program to redraw.

## ADR-011 — shadcn/ui and inline styles in the CSP (PLAN-002 rev 2, R5)

- **Context**: The developer chose shadcn/ui for every screen. xterm.js and Radix inject
  `<style>` elements at runtime.
- **Decision**: Tailwind CSS v4 + shadcn components generated with a pinned CLI (4.21.1)
  and reviewed; production CSP allows `style-src 'unsafe-inline'`, scripts remain `'self'`.
- **Consequences**: Consistent, accessible components owned by the repo. A CSS injection
  could restyle the page but cannot execute script.

## ADR-012 — Authenticated local socket for the CLI

- **Context**: The CLI must manage terminals of the running Engine without creating its
  own and without a network surface.
- **Decision**: Unix domain socket / named pipe in a private run directory, NDJSON
  protocol, random token in a 0600 run file, CLI method allow-list (no terminal input).
- **Consequences**: `atlas terminal …` requires ATLAS Control to be running. Same-user
  processes that can read the run file can use the allow-listed methods — the same trust
  boundary as the user's shell.

## ADR-013 — Terminal processes do not outlive the Engine

- **Context**: SDD-002 FR-010 asks to define quit behavior and forbids claiming survival
  without an implemented, tested mechanism.
- **Decision**: Quitting asks for confirmation when terminals run, then terminates them
  (SIGHUP, SIGKILL after 3 s). On macOS, closing the window keeps the app and terminals.
  Sessions are persisted as metadata only and shown as ended after a restart.
- **Consequences**: Simple and honest semantics; long-running servers stop with the app.

## ADR-014 — Confirmation based on the foreground process

- **Context**: Closing a tab must confirm when termination is expected (FR-010), without
  nagging for idle shells.
- **Decision**: Confirm when the PTY's foreground process differs from the shell (node-pty
  `process`). Windows cannot report it, so it always confirms there.
- **Consequences**: Background jobs (`cmd &`) are not detected and end without a prompt.

## ADR-015 — Layout is presentation state stored by the Engine (keyed by group since ADR-016)

- **Context**: Tabs/splits belong to the desktop (SDD-002 §4) but must persist.
- **Decision**: A pure split-tree model in the renderer (max 6 panes, one session per pane)
  saved per project in `application_settings`, validated by the Engine on write and
  repaired against existing sessions on load.
- **Consequences**: The CLI does not see layouts; closing a pane never affects processes.

## ADR-016 — Terminal workspaces are groups, not projects (SDD-003, PLAN-003 D1)

- **Context**: SDD-003 requires standalone terminals and groups mixing projects.
- **Decision**: The Terminals view is organized by user-defined groups plus Ungrouped;
  each group is a workspace with its own tabs and split layout. Projects are listed for
  quick actions. Supersedes the per-project tabs of SDD-002 FR-005.
- **Consequences**: One terminal lives in exactly one workspace. SDD-002 per-project
  layouts are dropped once by migration v3; processes and sessions are unaffected.

## ADR-017 — Working directory from the operating system (PLAN-003 D2)

- **Decision**: Read the shell's cwd (`/proc` on Linux, `lsof` on macOS) after a command
  settles instead of injecting shell-integration scripts (OSC 7).
- **Consequences**: No changes to the user's shell startup. Windows keeps the initial
  directory, labeled as such. Changes made without a submitted command are seen late.

## ADR-018 — Read-only Git through the system executable (PLAN-003 D3)

- **Context**: Identity precedence, porcelain status, ahead/behind and branch recency need
  Git itself; inspecting untrusted repositories must not execute their configuration.
- **Decision**: `execFile('git', [...])` with `core.fsmonitor=false`,
  `--no-optional-locks`, no inherited `GIT_*`, timeouts, concurrency limit and caching;
  never `fetch`. Project registration keeps the git-free `.git` reader.
- **Consequences**: Without git installed, Git details show "not installed". Residual
  risk: configuration-driven behavior unknown today could appear in future git versions.

## ADR-019 — Git refresh strategy (PLAN-003 D4)

- **Decision**: On request, on cwd change, on git-directory changes (watch, debounced) and
  every 30 s for watched repositories. Clients are notified with `git` events.
- **Consequences**: Working-tree edits by editors may take up to 30 s to show.

## ADR-020 — Removing a project keeps its terminals (PLAN-003 D5)

- **Decision**: The association is cleared (`ON DELETE SET NULL` and
  `terminals.detachProject`); processes keep running as standalone terminals. Replaces the
  SDD-002 behavior (terminate on removal, CLI refusal).

## ADR-021 — Accessible moves without a drag-and-drop library (PLAN-003 D6)

- **Decision**: Native HTML5 drag and drop plus equivalent menu actions (move to group,
  move up/down). No new dependency.

## ADR-022 — Sessions wait for an executor instead of running (PLAN-004 D1)

- **Context**: SDD-003 §15 forbids pretending that AI agents run before execution
  adapters exist (SDD-004).
- **Decision**: An explicit `WAITING_EXECUTOR` status. `start` and `resume` lead there
  while no adapter is available; RUNNING, WAITING_APPROVAL, COMPLETED and FAILED are
  reachable only through executor triggers, which have no caller yet. `startedAt` is set
  only when execution really starts.
- **Consequences**: The executor paths are defined and unit-tested but not exercised end
  to end until SDD-004.

## ADR-023 — Reconciliation in the Engine host only (PLAN-004 D2)

- **Decision**: At host startup and shutdown, RUNNING and WAITING_APPROVAL become
  INTERRUPTED (tasks in progress too); WAITING_EXECUTOR and PAUSED are kept. Interrupted
  sessions resume only on an explicit user action. CLI processes never reconcile.

## ADR-024 — Session workspace: project, directory or none (PLAN-004 D3)

- **Decision**: Project sessions follow the project's current directory. Removing a
  project converts its sessions into standalone sessions in that directory (same policy as
  terminals, ADR-020). Workspace existence and read/write access are checked when a
  session is marked ready, started or resumed; desktop clients must pick directories in
  the native dialog.
- **Consequences**: The check happens before execution, not during it (future executors
  must check again). A directory association is not a sandbox.

## ADR-025 — CLI session commands prefer the running Engine (PLAN-004 D4)

- **Decision**: `atlas session` calls the Engine host over the socket when it runs (live
  updates in the app) and otherwise runs the same dispatcher on the database.
  Optimistic concurrency (`revision`) protects against concurrent writers.

## ADR-026 — User-planned task graph (PLAN-004 D5)

- **Decision**: Users add, edit, cancel and remove pending tasks while the session is not
  finished; dependencies stay inside a session and cycles are rejected in the Engine (and
  by composite foreign keys in SQLite). Task progression is reserved for executors.

## ADR-027 — Execution profiles are configuration only (PLAN-004 D6)

- **Decision**: Profiles carry planned limits (`maxParallelTasks`, plus a global
  `maxConcurrentSessions`), validated and stored, not enforced before a scheduler exists.
  Profiles contain no security setting, so MAXIMUM cannot weaken any policy.

## ADR-028 — Append-only, allow-listed session events (PLAN-004 D7)

- **Decision**: Events are written in the same transaction as the change, with structured
  metadata only (statuses, ids, changed field names, reasons, counts). Free text is never
  copied into events or logs.

## ADR-029 — Approval contracts prepared, not used (PLAN-004 D8)

- **Decision**: `ApprovalRequest`, the `session_approvals` table and a read-only pending
  list exist; nothing creates or resolves approvals before SDD-004.

## ADR-030 — Archive instead of delete (PLAN-004 D9)

- **Decision**: Finished sessions (COMPLETED, FAILED, CANCELLED) can be archived and are
  hidden by default; sessions are never deleted, keeping their history.
