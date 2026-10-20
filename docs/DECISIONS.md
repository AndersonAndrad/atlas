# Architecture Decision Records

Each decision lists context, decision, and consequences. Entries are append-only;
superseded decisions are marked, not deleted.

## ADR-001 — Lightweight Engine embedded in-process

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
