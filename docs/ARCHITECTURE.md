# ATLAS Architecture

Status: reflects SDD-001 (Project Registry) and SDD-002 (Terminal Manager).

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

| Path                   | Responsibility                                                                                                                | Depends on                    |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `packages/shared`      | `AtlasError`, error codes and user-safe messages, `Logger` port                                                               | —                             |
| `packages/contracts`   | Zod schemas/types: projects, terminals, layouts, Engine method contract (`engine-api`), IPC contract (`./ipc`, Zod-free)      | shared, zod                   |
| `packages/projects`    | Project domain: `ProjectService`, ports, path normalization                                                                   | shared, contracts             |
| `packages/terminal`    | Terminal domain/application: `TerminalService`, lifecycle state machine, `TerminalSettings`, ports (PTY, mirror, shells, …)   | shared, contracts             |
| `packages/persistence` | SQLite, migrations, project/settings/terminal-session repositories                                                            | shared, contracts, ports      |
| `apps/engine`          | Composition root `createEngine()`, `startEngineHost()`, adapters (node-pty, headless mirror, shells), RPC dispatcher + socket | all packages, node-pty, xterm |
| `apps/cli`             | `atlas` command line client                                                                                                   | engine                        |
| `apps/desktop`         | Electron main (broker), Engine host entry, preload bridge, React renderer (shadcn/ui, xterm.js)                               | engine (main/host), contracts |

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
  `terminals.list|get|create|terminate|closeInfo`).

### Engine host process (desktop)

`apps/desktop/src/engine-host/index.ts` runs inside `utilityProcess.fork`. Main sends
`start`, `request` and `shutdown` messages; the host answers with `ready`/`start-failed`,
`response`, `event` and `stopped`. `EngineHostClient` (main) correlates requests by id,
restarts the host after an unexpected exit (at most 3 times per minute, then reports a
fatal error) and notifies the renderer (`engine:restarted`) so it reloads its state.

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
- The working directory always comes from `ProjectService.resolveAvailableWorkspace`
  (registered project, directory currently available, realpath). Clients never send a cwd.
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

- `terminal_sessions` (migration v2): metadata only — no output, no input, no command
  history. Rows cascade with their project.
- `application_settings`: `terminal.preferences` (font size 8–32, font family preset,
  scrollback 500–50,000, default shell id) and `terminal.layout.<projectId>` (validated
  split tree, at most 6 panes).
- After a restart, previous sessions appear as ended tabs ("ended when ATLAS stopped")
  with **Restart** (new process, same title/shell) and **Close**.

### Desktop presentation

- **Terminals** view: project list (running counts), per-project workspace with a tab bar
  (one tab per session: status dot, title, rename by double-click/F2, close), toolbar
  (new terminal + shell menu, split right/down, single pane, settings), and a split tree
  rendered with shadcn `Resizable` (react-resizable-panels).
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
- `atlas project remove` asks the running Engine whether the project has live terminals
  and refuses if so; without a running Engine no terminals can exist.

## Projects (SDD-001)

Domain rules, path normalization (`path_key`), Git detection and availability handling
are unchanged; see SDD-001. `ProjectService.resolveAvailableWorkspace(id)` was added for
terminal authorization. Removing a project through the Engine (`Engine.removeProject`)
also dismisses its terminals and deletes its terminal layout.

## Persistence

- SQLite through `node:sqlite` (`DatabaseSync`), WAL, 5 s busy timeout, `STRICT` tables,
  append-only migrations in `schema_migrations` (`BEGIN IMMEDIATE`), newer schemas refused.
- Schema v1: `projects`, `application_settings`. Schema v2: `terminal_sessions`.
- Data dir: macOS `~/Library/Application Support/ATLAS`, Windows `%APPDATA%\ATLAS`, Linux
  `$XDG_DATA_HOME/atlas`; `ATLAS_DATA_DIR` overrides.

## Desktop security model

- `contextIsolation`, `sandbox`, no `nodeIntegration`, `webSecurity`; preload exposes only
  `AtlasApi` (`projects`, `dialog`, `terminals`, `app`). Event subscriptions never expose
  `IpcRendererEvent`.
- Every IPC message (invoke and send) must come from the main window's main frame at the
  app URL and is validated with Zod in main **and** again in the Engine.
- Renderer-supplied project paths must come from the native picker; terminal working
  directories are never accepted from the renderer; shells are selected by id.
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
`TERMINAL_START_FAILED`, `PROJECT_HAS_ACTIVE_TERMINALS` and `ENGINE_UNAVAILABLE`. Clients
only receive `{ code, message, issues }`. Logs: `<data dir>/logs/atlas.log` (JSON lines,
0600, rotated at 5 MB) from the main process (`desktop`), Engine host (`engine`) and CLI.

## Renderer

React 19 with shadcn/ui components (Radix primitives, Tailwind CSS v4, lucide icons),
dark theme only. Generated components live in `src/renderer/src/components/ui` and are
owned by the project. Views: Projects (SDD-001 screens migrated to shadcn) and
Terminals. Responsive: the sidebar collapses to icons below 1024 px; the Terminals view
replaces its project list with a select below 768 px.

## Build and tooling

- pnpm workspaces, exact versions; `allowBuilds` for electron, esbuild and node-pty.
- Packages/engine/CLI: `tsc -b` to `dist/`. Desktop: electron-vite bundles main and the
  Engine host (ESM; node-pty and xterm headless externalized), preload (CJS) and the
  minified renderer.
- Tests: Vitest (unit with fake PTYs, integration with real PTYs/sockets), Playwright
  `_electron` (end-to-end, including a 10-terminal performance check).
