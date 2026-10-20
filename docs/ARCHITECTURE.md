# ATLAS Architecture

Status: reflects the implementation of SDD-001 (Project Registry).

## Overview

ATLAS is a local-first desktop application backed by a headless Engine. The Engine
owns all business logic and persistence; the Electron app and the CLI are clients
of the same Engine composition root.

```text
            ┌──────────────────────┐        ┌───────────────┐
            │ Renderer (React)     │        │ CLI (atlas)   │
            │ sandboxed, no Node   │        │ commander     │
            └─────────┬────────────┘        └───────┬───────┘
     window.atlas     │ contextBridge                │
            ┌─────────▼────────────┐                │
            │ Preload (CJS)        │                │
            │ typed invoke() only  │                │
            └─────────┬────────────┘                │
          ipcRenderer │ IPC (validated)             │
            ┌─────────▼────────────┐                │
            │ Electron main        │                │
            │ IPC handlers + dialog│                │
            └─────────┬────────────┘                │
                      │ in-process                  │ in-process
            ┌─────────▼─────────────────────────────▼───────┐
            │ Engine (apps/engine) — createEngine()          │
            │  ProjectService (packages/projects)            │
            │  adapters: NodePathInspector, inspectGit,      │
            │            FileLogger, data dir resolution     │
            │  persistence: SQLite repos (packages/persistence)
            └───────────────────────┬───────────────────────┘
                                    │ node:sqlite (WAL)
                         <data dir>/atlas.db
```

## Workspace layout

| Path                   | Responsibility                                                                                                      | Depends on                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `packages/shared`      | `AtlasError`, error codes and user-safe messages, `Logger` port                                                     | —                                   |
| `packages/contracts`   | Zod schemas and types (`Project`, inputs, inspection, details), IPC channel contract (`./ipc`)                      | shared, zod                         |
| `packages/projects`    | Domain: `ProjectService`, ports (`ProjectRepository`, `SettingsRepository`, `PathInspector`, …), path normalization | shared, contracts                   |
| `packages/persistence` | SQLite database, versioned migrations, `SqliteProjectRepository`, `SqliteSettingsRepository`                        | shared, contracts, projects (ports) |
| `apps/engine`          | Composition root `createEngine()`, filesystem/Git adapters, file logger, data directory, `atlas-engine` binary      | all packages                        |
| `apps/cli`             | `atlas` command line client                                                                                         | engine                              |
| `apps/desktop`         | Electron main (IPC, native dialog, window security), preload bridge, React renderer                                 | engine (main only), contracts       |

Dependency direction is strictly inward: `projects` defines ports; `persistence` and
`engine` implement them. The domain never imports Node filesystem, SQLite or Electron.

## Engine

`createEngine({ dataDir?, component?, … })` wires the repositories, inspector, clock and
logger and returns `{ projects, dataDir, databasePath, logger, schemaVersion(), close() }`.

- The desktop main process embeds the Engine in-process (allowed by SDD-001 §8).
- The CLI creates its own Engine instance per invocation.
- `pnpm engine status` (`apps/engine/dist/bin.js status|migrate`) boots the Engine standalone (no Electron) and prints a
  health report — proof that the Engine runs independently.
- No HTTP server exists. A future local API (socket/HTTP) can wrap `ProjectService`
  without changing the domain layer.

## Domain rules (ProjectService)

- **Create**: validate input (Zod) → require an absolute path → inspect the directory →
  reject if missing / not a directory / not accessible → compute the platform path key →
  reject duplicates → persist stable metadata.
- **Update**: partial updates; `description: null` clears it; a new `workspacePath` is
  re-inspected and re-checked for duplicates. `createdAt` is immutable.
- **Remove**: deletes the registry row only and clears the selection if it pointed to the
  project. The filesystem is never modified.
- **Select**: stores the id in `application_settings` (`projects.selectedProjectId`),
  sets `lastOpenedAt`, and refreshes stored Git metadata when the directory is reachable.
- **Restore**: `getSelectedProject()` returns the selected project while it is still
  registered — even if its directory is unavailable — so the user can fix the path.
  Stale ids are cleared.
- **Details**: availability and Git branch are read live on each request
  (`listDetails`, `getDetails`), never persisted.

### Path normalization and duplicate detection

The stored `workspace_path` is the `realpath` of the selected directory (symlinks
resolved). Uniqueness is enforced on a separate `path_key` column (UNIQUE):

| Platform      | Key                                                    |
| ------------- | ------------------------------------------------------ |
| macOS         | normalized path, Unicode NFC, lower-cased              |
| Windows       | normalized path, `\\?\` prefixes stripped, lower-cased |
| Linux / other | normalized path, byte-exact                            |

### Git detection

`inspectGit` walks up from the directory looking for `.git` (directory, or file with a
`gitdir:` pointer for worktrees/submodules) containing `HEAD`. The branch comes from
`HEAD` (`ref: refs/heads/<name>`); a raw hash means detached HEAD. The `git` executable
is not required.

## Persistence

- SQLite through Node's built-in `node:sqlite` (`DatabaseSync`); no native add-ons.
- Location: `<data dir>/atlas.db`. Data dir: macOS `~/Library/Application Support/ATLAS`,
  Windows `%APPDATA%\ATLAS`, Linux `$XDG_DATA_HOME/atlas` (default `~/.local/share/atlas`).
  `ATLAS_DATA_DIR` overrides it (tests, portable use). The desktop app also stores its
  Chromium profile under `<data dir>/electron`.
- `PRAGMA journal_mode=WAL` and a 5 s busy timeout allow the CLI and desktop app to use
  the database concurrently.
- Migrations (`packages/persistence/src/migrations.ts`) are append-only, tracked in
  `schema_migrations`, each applied inside `BEGIN IMMEDIATE … COMMIT`. Opening a database
  whose schema is newer than the code is refused.
- All statements are parameterized. Tables are `STRICT` with `CHECK` constraints
  (lengths, JSON array tags, boolean flags) as a second line of defense.

### Schema (v1)

`projects(id PK, name, description, workspace_path, path_key UNIQUE, tags JSON,
git_repository_root, is_git_repository, created_at, updated_at, last_opened_at)`

`application_settings(key PK, value)`

## Desktop security model

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webSecurity: true`.
- Preload exposes `window.atlas` with exactly the operations in `AtlasApi`; no
  `ipcRenderer`, Node APIs, filesystem or database handles reach the renderer.
- Main process validates every IPC call: sender must be the main window's main frame
  loaded from the app URL; arguments are parsed with Zod tuples/strict objects.
- Directory paths in create/update requests are accepted only if they were returned by
  the native picker in the current session (FR-002); the renderer cannot register
  arbitrary paths.
- Production CSP: `default-src 'none'; script-src 'self'; style-src 'self'; …`.
- New windows are denied; navigation away from the app is blocked; all permission
  requests are denied.
- Single-instance lock per data directory.

## Errors and logging

- `AtlasError` carries a code (`PROJECT_NOT_FOUND`, `PROJECT_ALREADY_EXISTS`,
  `PROJECT_PATH_INVALID`, `PROJECT_PATH_UNAVAILABLE`, `PROJECT_PERMISSION_DENIED`,
  `PROJECT_PERSISTENCE_ERROR`, `VALIDATION_FAILED`, `INTERNAL_ERROR`), a fixed
  user-safe message, field-level issues, and internal `details`/`cause`.
- IPC and CLI only expose `{ code, message, issues }`. Unknown errors become
  `INTERNAL_ERROR` with a generic message.
- Technical details go to `<data dir>/logs/atlas.log` (JSON lines, mode 0600, rotated at
  5 MB, one backup).

## Renderer

React 19 without a UI library. Dark-first CSS tokens in `styles.css`. Components:
sidebar (Projects active; Sessions, Agents, Skills, Accounts, Usage, Settings disabled
and labelled "Soon"), project list cards, details panel, add/edit dialog (native
`<dialog>`), remove confirmation, empty state. The renderer reuses the Zod schemas from
`@atlas/contracts` for client-side feedback; the main process re-validates.
The list refreshes on window focus to pick up CLI changes.

Responsive breakpoints: sidebar collapses to icons at ≤ 1000 px; at ≤ 760 px the sidebar
becomes a top bar and list/details stack vertically.

## Build and tooling

- pnpm workspaces; exact dependency versions (`save-exact=true`).
- Packages/engine/CLI: `tsc -b` (project references) to `dist/` (ESM, NodeNext).
- Desktop: `electron-vite` bundles main (ESM), preload (CJS, required by sandbox) and
  renderer; workspace packages are compiled from source into the main bundle.
- Tests: Vitest (unit + integration, aliases to package sources), Playwright `_electron`
  (end-to-end against the built app).
