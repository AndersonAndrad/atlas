# ATLAS

**Autonomous Task Leadership & Agent System** — a local-first development environment
for managing multiple projects (and, in future specifications, terminal sessions and AI
agent teams).

Current scope: **SDD-001 — Project Registry** (see `docs/sdd/SDD-001-project-registry.md`).

## Requirements

- macOS (verified), Linux/Windows (not yet verified)
- Node.js 24 LTS (`>= 24`)
- pnpm 11 (`corepack enable` or a global install)

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

The CLI works without the desktop app and shares its database.

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
Logs are written to `<data dir>/logs/atlas.log`.

## Quality checks

```bash
pnpm typecheck     # packages, tests and desktop
pnpm lint
pnpm format:check
pnpm test          # unit + integration (Vitest)
pnpm test:e2e      # builds, then runs Electron end-to-end tests (Playwright)
```

All tests use isolated temporary directories and databases.

## Documentation

- `docs/ARCHITECTURE.md` — modules, boundaries, persistence, security model
- `docs/DECISIONS.md` — architecture decision records
- `docs/ROADMAP.md` — milestones
- `docs/STATUS.md` — implemented features, limitations and validation results
- `docs/sdd/` — specifications
