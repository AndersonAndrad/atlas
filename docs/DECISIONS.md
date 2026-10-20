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

## ADR-015 — Layout is presentation state stored by the Engine

- **Context**: Tabs/splits belong to the desktop (SDD-002 §4) but must persist.
- **Decision**: A pure split-tree model in the renderer (max 6 panes, one session per pane)
  saved per project in `application_settings`, validated by the Engine on write and
  repaired against existing sessions on load.
- **Consequences**: The CLI does not see layouts; closing a pane never affects processes.
