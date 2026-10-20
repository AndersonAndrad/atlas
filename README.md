# ATLAS

**Autonomous Task Leadership & Agent System** — a local-first development environment
for managing multiple projects and their terminals (and, in future specifications, AI
agent teams).

Implemented: **SDD-001 — Project Registry** and **SDD-002 — Terminal Manager** (see
`docs/sdd/`).

## Requirements

- macOS (verified), Linux/Windows (not yet verified)
- Node.js 24 LTS (`>= 24`)
- pnpm 11 (`corepack enable` or a global install)

Linux needs a C/C++ toolchain and Python for `node-pty`, which compiles during installation
(macOS and Windows use prebuilt binaries).

## Getting started

```bash
pnpm install          # also downloads the Electron binary
pnpm build            # builds packages, Engine, CLI and the desktop bundles
pnpm --filter @atlas/desktop start   # run the built desktop app
pnpm dev              # run the desktop app with hot reload
```

### CLI

```bash
pnpm atlas project list
pnpm atlas project add <path> [--name <name>] [--description <text>] [--tag <tag>...]
pnpm atlas project show <id>
pnpm atlas project remove <id> [--yes]
# add --json to list/add/show for machine-readable output
```

The project commands work without the desktop app and share its database.

```bash
pnpm atlas terminal list [--project <id>] [--json]
pnpm atlas terminal open --project <id> [--shell <shell-id>] [--title <title>] [--json]
pnpm atlas terminal show <terminal-id> [--json]
pnpm atlas terminal close <terminal-id> [--yes]
```

Terminal commands talk to the Engine of the running ATLAS Control app through an
authenticated local socket; they fail with "The ATLAS Engine is not running" otherwise.
Terminals opened from the CLI appear as tabs in the app.

### Terminals

Open **Terminals** in the sidebar (or "Open terminal" on a project). Each project has its
own tabs and split panes; switching projects never stops processes. Keyboard shortcuts
are listed in the application menu and in `docs/sdd/SDD-002-terminal-manager.md`.
Quitting ATLAS terminates all terminal processes (it asks first while any are running).
Extra shells, such as a WSL launcher, can be added in `<data dir>/shells.json`.

### Headless Engine

```bash
pnpm engine status    # boots the Engine without Electron and prints a health report
```

### Data location

| OS      | Directory                                       |
| ------- | ----------------------------------------------- |
| macOS   | `~/Library/Application Support/ATLAS`           |
| Windows | `%APPDATA%\ATLAS`                               |
| Linux   | `$XDG_DATA_HOME/atlas` (`~/.local/share/atlas`) |

Set `ATLAS_DATA_DIR` to use another directory (for example, a throwaway one for testing).
Logs are written to `<data dir>/logs/atlas.log`; the CLI socket and its token file live in
`<data dir>/run/` (user-only permissions).

## Quality checks

```bash
pnpm typecheck     # packages, tests and desktop
pnpm lint
pnpm format:check
pnpm test          # unit + integration (Vitest)
pnpm test:e2e      # builds, then runs Electron end-to-end tests (Playwright)
```

All tests use isolated temporary directories and databases. Terminal tests run real
shells only with harmless commands, an empty temporary `HOME` and `/bin/bash`.

## Documentation

- `docs/ARCHITECTURE.md` — modules, boundaries, persistence, security model
- `docs/DECISIONS.md` — architecture decision records
- `docs/ROADMAP.md` — milestones
- `docs/STATUS.md` — implemented features, limitations and validation results
- `docs/sdd/` — specifications
