# ATLAS Status

Last updated: 2026-10-19 — SDD-001 implementation (PLAN-001 revision 1).

**Overall status:** SDD-001 implemented and validated on macOS (arm64). Awaiting the
developer's explicit approval before SDD-002 (per SDD-001 §16).

## Implemented

| Requirement | Summary                                                                                                               |
| ----------- | --------------------------------------------------------------------------------------------------------------------- |
| FR-001      | Register projects (name, path, optional description/tags); detects existence, access, Git repository, root and branch |
| FR-002      | Native directory picker; the main process validates through the Engine and only accepts picker-returned paths         |
| FR-003      | Project cards (name, path, Git status/branch, last opened, availability) and a details panel                          |
| FR-004      | Edit name, description, tags and directory (directory changes are re-validated)                                       |
| FR-005      | Remove with confirmation; registry entry only — files are never touched                                               |
| FR-006      | SQLite in the per-user data directory with versioned migrations                                                       |
| FR-007      | Duplicate detection via realpath + platform-specific path key (DB UNIQUE constraint)                                  |
| FR-008      | Multiple projects; selected project persisted and restored                                                            |
| FR-009      | Unavailable directories stay registered, are flagged, and can be relocated                                            |
| FR-010      | `atlas project list/add/show/remove` CLI using the same Engine and database                                           |

Also: standalone Engine entry point (`pnpm engine status`), structured errors with
user-safe messages, JSON-lines logging, hardened Electron configuration, responsive
dark UI, disabled placeholders for future sections.

## Validation results (2026-10-19, macOS 26 / Darwin 25.6.0 arm64, Node 24.18.0)

| Check                                                                | Result                                                                        |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile` from an empty `node_modules`        | Pass (Electron binary downloaded by `postinstall`)                            |
| `pnpm build`                                                         | Pass                                                                          |
| `pnpm typecheck` (packages, tests, desktop main/preload/renderer)    | Pass                                                                          |
| `pnpm lint` (ESLint)                                                 | Pass, 0 problems                                                              |
| `pnpm format:check` (Prettier)                                       | Pass                                                                          |
| `pnpm test` (Vitest unit + integration)                              | Pass — 10 files, 118 tests                                                    |
| `pnpm test:e2e` (Playwright + Electron 44.5.1)                       | Pass — 10 tests                                                               |
| `pnpm audit`                                                         | No known vulnerabilities                                                      |
| Desktop smoke run (`pnpm --filter @atlas/desktop start`, `pnpm dev`) | App starts, migration applied, startup logged                                 |
| CLI and Engine without Electron                                      | `atlas project add/list`, `pnpm engine status` verified manually and by tests |

### Acceptance criteria (SDD-001 §12)

| Criterion                              | Status     | Evidence                                                                   |
| -------------------------------------- | ---------- | -------------------------------------------------------------------------- |
| Monorepo installs and builds           | Verified   | Fresh install + `pnpm build`                                               |
| Electron launches                      | Verified   | E2E suite, smoke runs                                                      |
| Headless Engine runs independently     | Verified   | `engine.test.ts`, `pnpm engine status`                                     |
| CLI works without Electron             | Verified   | `cli.test.ts` (in-process and spawned binary)                              |
| Register via native picker             | Verified\* | E2E with stubbed `dialog.showOpenDialog`                                   |
| Registered projects appear             | Verified   | E2E `lists multiple projects…`                                             |
| Metadata can be edited                 | Verified   | Unit, IPC and E2E tests                                                    |
| Removal does not delete files          | Verified   | Engine, CLI and E2E tests assert directory contents                        |
| Duplicates rejected                    | Verified   | Unit (case/Unicode/symlink), SQLite constraint, CLI and E2E tests          |
| Projects persist after restart         | Verified   | Engine restart test, E2E restart                                           |
| Selected project restored              | Verified   | E2E `restores the last selected project after restart`                     |
| Unavailable directories handled        | Verified   | Unit, Engine and E2E tests (relocation flow)                               |
| Git info detected                      | Verified   | Git inspector tests incl. real `git init`, worktree pointer, detached HEAD |
| Renderer has no unrestricted Node APIs | Verified   | E2E security test (no `require`/`process`, sandbox, CSP, bridge surface)   |
| Unit and integration tests pass        | Verified   | 118/118                                                                    |
| UI tests pass                          | Verified   | 10/10                                                                      |
| TypeScript checks pass                 | Verified   | `pnpm typecheck`                                                           |
| Application builds                     | Verified   | `pnpm build`                                                               |
| Documentation reflects implementation  | Verified   | This file, ARCHITECTURE, DECISIONS, ROADMAP, SDD                           |

\* Not verified automatically: the real macOS directory panel itself (automation stubs
`dialog.showOpenDialog`). Manual check pending (risk R6).

## Known limitations

- Verified only on macOS. Windows/Linux path semantics are covered by unit tests with
  injected platform rules, not on real systems (R4).
- Desktop UI picks up CLI changes on window focus or manual refresh, not in real time (R3).
- A case-sensitive APFS volume would treat directories differing only by case as
  duplicates (R5).
- Git detection does not cover `GIT_DIR` overrides or bare repositories used as workspaces.
- Directory inspection times out after 3 s; unresponsive volumes are reported as
  unavailable.
- No installer, code signing or auto-update (out of scope, ADR-008).
- Dark theme only.
- The renderer bundle includes Zod (~0.8 MB uncompressed) for client-side validation.

## Pending

- Manual verification of the real native directory picker.
- Developer approval of SDD-001 before starting SDD-002.
