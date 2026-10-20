# ATLAS Status

Last updated: 2026-10-20 — SDD-004 Milestone A (PLAN-008 revision 1, PLAN-009 revision 1).

**Overall status:** SDD-001, SDD-002 and SDD-003 Milestone A approved. SDD-003 Milestone B
(ATLAS Sessions) implemented and validated on macOS (arm64). SDD-004 Milestone A (Git
workflow, PLAN-008) and its improvements (PLAN-009: file review that approves by staging,
per-project Conventional Commits enforcement, up to five pre-commit steps with durations,
pending-action dots, changed-file counts in the Terminals sidebar) implemented and validated.
Both await the developer's approval. Version 0.7.0 adds merges without auto-commit (with
conflict reporting and abort) and commit counts on Push and Pull (PLAN-011); 0.6.1 moved Git
operations into a side panel (PLAN-010). SDD-004 Milestone B (Claude Code and Codex execution) not started — it needs its
own plan. Earlier: 0.6.0 (PLAN-009), 0.5.0 (PLAN-008).

Earlier in this version line: 0.4.1 (PLAN-005: sidebar logo, full window title,
ahead/behind per project in the Terminals sidebar) and 0.4.2 (PLAN-007: dialogs stay within
bounds with long values).

## SDD-004 Milestone A — Git workflow

| Requirement | Summary                                                                                                                                |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| FR-401      | Git view from the sidebar, project details, terminal header, terminal context menu and ⌘⇧G; standalone terminals; empty state          |
| FR-402/403  | Staged / unstaged / untracked / conflicts with per-file and all-file staging; read-only diff (binary, truncated, untracked)            |
| FR-404/405  | Commit dialog: branch, file count, line stats, staged indicators, explicit inclusion of unstaged files, keyboard (⌘/Ctrl+Enter)        |
| FR-406      | Conventional Commits 1.0.0 validator (header, body, footers, breaking changes); stricter project rules in Settings                     |
| FR-407      | Deterministic suggestions with rationale; pluggable provider port; AI strategy deferred to Milestone B                                 |
| FR-408/409  | Real commits with hooks, index fingerprint, Git errors; Commit & Push with separate results and explicit upstream                      |
| FR-410–413  | Push (destination, ahead), Pull (fast-forward only by default, strategy explained), Fetch (progress, cancel), branches (no deletion)   |
| FR-414–416  | Operation records and events, per-repository lanes, argv-only execution, literal pathspecs, no destructive commands, no stored secrets |

### Acceptance criteria (§11, Milestone A)

| Criterion                                         | Evidence                                                                            |
| ------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Git panel with registered projects                | E2E "inspects, stages and commits…"; IPC authorization test                         |
| Git panel with standalone terminals               | E2E "opens the Git view from standalone terminals…"                                 |
| Changed files inspected and selected; diff viewer | integration (status mapping, diffs) and E2E                                         |
| Staging and unstaging                             | integration (literal pathspecs, renames, unborn HEAD) and E2E                       |
| Conventional Commits validated                    | validator unit tests (specification examples) and E2E validation feedback           |
| Manual messages without AI; optional suggestions  | E2E (manual message; deterministic suggestion)                                      |
| Real commits; Commit & Push                       | integration (hooks, partial staging, selection) and E2E against a bare remote       |
| Push, Pull, Fetch                                 | integration (rejected push, explicit upstream, ff-only, divergent, conflicts) + E2E |
| Branch creation and switching                     | integration and E2E                                                                 |
| Git errors reported                               | integration (hooks, identity, nothing to commit, network without credential leaks)  |
| Conflicting operations coordinated                | coordinator unit tests; integration "serializes conflicting mutations"              |
| Existing terminal functionality                   | full unit and E2E suites                                                            |
| Unit, integration and desktop tests pass          | see below                                                                           |

### Validation results (2026-10-20, macOS arm64, Node 24.18.0, Git 2.55.0)

Current revision (PLAN-011, version 0.7.0): `pnpm test` 542/542, `pnpm test:e2e` 52/52 in two
consecutive runs, renderer 1,123 kB; typecheck, lint, format and audit clean.

PLAN-010 (version 0.6.1): `pnpm test` 537/537, `pnpm test:e2e` 50/50 in two
consecutive runs, renderer 1,115 kB; typecheck, lint, format and audit clean.

PLAN-009 (version 0.6.0):

| Check                                                        | Result                               |
| ------------------------------------------------------------ | ------------------------------------ |
| `pnpm install --frozen-lockfile`, `pnpm clean`, `pnpm build` | ok (renderer 1,112 kB, was 1,089 kB) |
| `pnpm typecheck`, `pnpm lint`, `pnpm format:check`           | ok                                   |
| `pnpm audit`                                                 | no known vulnerabilities             |
| `pnpm test`                                                  | 537/537 (35 files)                   |
| `pnpm test:e2e` (Playwright, Electron)                       | 49/49                                |

Baseline (PLAN-008, version 0.5.0): 371/371 unit and integration tests, 41/41 E2E.

### Staff review

PLAN-009 review: no Critical or High findings remain. Pre-commit commands come only from
stored project settings (never from a commit request), Git workflow and commit-check
methods are desktop-only, commits can be cancelled only while steps run, the index and the
selected files are re-checked after the steps, and step output is redacted before it is
shown.

Baseline review (before project commit checks): no Critical or High findings. Fixed during
review: repository authorization rediscovered every project and terminal periodically and
kept a removed project's repository authorized for a few seconds (Medium; now a cached
per-request check); an upstream remote read from the configuration was not checked against
the configured remotes; untracked files were opened without `O_NOFOLLOW`; the commit dialog
did not say that unselected staged files leave the index; a pull during an unfinished merge
reported a misleading conflict (all Low). Regression tests were added for each.

### Known limitations

See `docs/sdd/SDD-004-git-and-ai-execution.md` → Part I "Known limitations".

## SDD-003 Milestone B — ATLAS Sessions

| Requirement | Summary                                                                                                                      |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------- |
| FR-315      | `AtlasSession` with an explicit transition table; invalid transitions rejected (`SESSION_TRANSITION_INVALID`)                |
| FR-316      | Creation from a project, a picked folder (`--cwd`) or the Sessions view; no provider required                                |
| FR-317      | Create, list, details, edit draft, ready, back to draft, start (→ WAITING_EXECUTOR), pause, resume, cancel, archive          |
| FR-318      | Independent sessions per project and across projects; planned concurrency limit; no worker processes                         |
| FR-319      | Tasks with dependencies, derived blocking, cycle and cross-session rejection                                                 |
| FR-320      | Persistent, append-only events with allow-listed metadata                                                                    |
| FR-321      | ECONOMY / BALANCED / MAXIMUM planning limits, configurable in Settings, no security fields                                   |
| FR-322/323  | Sessions view: list, creation dialog, details (overview, tasks, events, approvals, agents placeholder), "no executor" banner |
| §21         | Migration v4; Engine host reconciles in-flight sessions into INTERRUPTED on start and stop                                   |
| §22         | `atlas session create\|list\|show\|tasks\|cancel\|ready\|start\|pause\|resume\|archive` (live through the running Engine)    |

### Acceptance criteria (§25)

| Criterion                                                  | Evidence                                                                          |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Sessions can be created                                    | service, IPC, CLI and E2E tests                                                   |
| Project or standalone workspace                            | service tests; E2E "from a project" and "standalone folder"                       |
| Several sessions per project / independent across projects | service test "independent sessions"                                               |
| Transitions validated                                      | exhaustive state-machine test; invalid actions over IPC and CLI                   |
| Events persist                                             | SQLite and Engine restart tests; E2E event timeline                               |
| Task dependencies / cycles rejected                        | task-graph, service, SQLite (composite keys) and E2E tests                        |
| Profiles configurable                                      | settings store tests; Settings section                                            |
| Details visible in Electron                                | E2E                                                                               |
| CLI commands work                                          | CLI tests with and without a running Engine; E2E live update                      |
| Restart keeps records / interrupted represented accurately | Engine host restart and shutdown tests; E2E restart                               |
| No fake AI execution                                       | WAITING_EXECUTOR, `startedAt` null, "Not executing" label and banner (unit + E2E) |
| Existing features functional                               | full unit and E2E suites                                                          |
| Tests, type checks and builds pass                         | see below                                                                         |

### Validation results (2026-10-20, macOS arm64, Node 24.18.0)

| Check                                                        | Result                                                   |
| ------------------------------------------------------------ | -------------------------------------------------------- |
| `pnpm install --frozen-lockfile`, `pnpm clean`, `pnpm build` | ok (renderer 1,028 kB, was 985 kB)                       |
| `pnpm typecheck`, `pnpm lint`, `pnpm format:check`           | ok                                                       |
| `pnpm audit`                                                 | no known vulnerabilities                                 |
| `pnpm test`                                                  | 297/297 (24 files)                                       |
| `pnpm test:e2e`                                              | 33/33, two consecutive runs                              |
| Performance (10 terminals, sustained output)                 | 3.6 s, IPC p95 3 ms, max frame gap 33 ms (no regression) |

### Staff review

No Critical or High findings. Fixed during review: a "New session" / "Open terminal"
request from the Projects view was replayed when its view mounted again (Medium; E2E
regression test added); task counting used one SQL parameter per session (Low). Earlier
self-review: project lookups for the session list no longer inspect the filesystem.

### Known limitations

See `docs/sdd/SDD-003-workspace-and-sessions.md` → Part I-B "Known limitations".

## SDD-003 Milestone A — Workspace & Git (approved)

| Requirement | Summary                                                                                                                                                         |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-301      | Standalone terminals (default directory, picked folder, `--cwd`), optional project association                                                                  |
| FR-302      | Custom names stored apart from automatic names (current directory); restore automatic                                                                           |
| FR-303/304  | Terminal groups: create, rename, delete (ungroup or terminate), move, reorder, collapse; persisted with per-group layouts                                       |
| FR-305      | Desktop/Engine versions, channel, build id, platform in sidebar, About and Settings                                                                             |
| FR-306–310  | Project Git details: root, branch, identity, branch count, recent branches by latest commit, change counts, ahead/behind vs upstream (last fetch), refresh time |
| FR-311/312  | Terminal header Git chips following the detected cwd; refresh on open, cwd change, commands, git-dir watcher, 30 s periodic, manual                             |
| FR-313/314  | Project details sheet from terminals (associated, matching or register directory); plain folders and edge cases handled                                         |

### Validation results (2026-10-20, macOS 26 arm64, Node 24.18.0, Electron 44.5.1)

| Check                                                        | Result                                                        |
| ------------------------------------------------------------ | ------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`, `pnpm clean && pnpm build` | Pass                                                          |
| `pnpm typecheck`, `pnpm lint`, `pnpm format:check`           | Pass                                                          |
| `pnpm test`                                                  | Pass — 20 files, 251 tests (real Git repositories, real PTYs) |
| `pnpm test:e2e`                                              | Pass — 28 tests, two consecutive full runs                    |
| `pnpm audit`                                                 | No known vulnerabilities                                      |
| Performance (10 terminals × 500,000 lines)                   | 3.7–4.6 s; IPC p95 2–3 ms; longest frame gap 23–32 ms         |

### Acceptance criteria (SDD-003 §11)

| Criterion                                     | Status   | Evidence                                                                   |
| --------------------------------------------- | -------- | -------------------------------------------------------------------------- |
| Standalone terminals without projects         | Verified | Service/IPC/CLI tests, E2E `opens standalone terminals…`                   |
| Terminals can be renamed                      | Verified | Service tests, CLI `rename`, E2E rename/restore                            |
| Groups created and managed                    | Verified | `terminal-groups.test.ts`, IPC test, E2E groups                            |
| Groups with multiple projects                 | Verified | Unit and E2E (two projects in one group)                                   |
| Group operations do not restart processes     | Verified | Unit (no spawn/kill), IPC (same pid), E2E (same ids/pids)                  |
| Version displayed correctly                   | Verified | E2E compares with package.json versions                                    |
| Projects without Git fully usable             | Verified | Integration, CLI `project show`, E2E "No Git repository"                   |
| Git user name and email                       | Verified | Integration (global vs local precedence), E2E                              |
| Local branch count accurate                   | Verified | Integration (4 branches), E2E (2)                                          |
| Three recent branches                         | Verified | Integration ordering by commit date                                        |
| Modified, staged, untracked counted correctly | Verified | Parser unit tests, integration with real changes                           |
| Ahead/behind with upstream                    | Verified | Integration (before/after fetch), E2E                                      |
| Missing upstream handled                      | Verified | Integration (`null`), header "—", details "Unavailable"                    |
| Terminal headers show Git information         | Verified | E2E chips (branch, M, S, ↑, ↓) and absence outside repos                   |
| Git does not block terminal interaction       | Verified | Separate processes, timeouts, concurrency limit; performance E2E unchanged |
| Project details from the terminal             | Verified | E2E sheet + register directory                                             |
| SDD-001 and SDD-002 operational               | Verified | All previous unit, integration and E2E tests (adapted to groups)           |
| Automated tests pass                          | Verified | 251/251, 28/28                                                             |

### Known limitations (Milestone A)

- Verified on macOS only; Windows cannot detect a shell's current directory (initial
  directory shown, labeled).
- Directory changes are read after a submitted command; file edits outside the terminal
  appear within 30 s or on refresh.
- Git details require the `git` executable; repositories git does not trust ("dubious
  ownership") show an explicit unavailable state.
- SDD-002 per-project layouts were discarded once by migration v3; schema v3 databases
  cannot be opened by 0.2 builds.

## SDD-002 — Terminal Manager (approved)

| Requirement | Summary                                                                                                               |
| ----------- | --------------------------------------------------------------------------------------------------------------------- |
| FR-001      | Sessions per registered project: id, project, cwd (registry realpath), shell, pid, timestamps, status, exit code      |
| FR-002      | Real PTYs (node-pty) rendered by xterm.js: interactive input, ANSI colors, cursor movement, alternate screen, Ctrl+C  |
| FR-003/004  | Independent concurrent sessions within and across projects; closing one never affects others                          |
| FR-005      | Tabs: create, select, rename (double-click/F2), close, active indicator, status dot                                   |
| FR-006      | Split right/down, resizable panes, hide pane, restore single pane; panes reference sessions (one view per session)    |
| FR-007      | Shell detection for macOS/Linux/Windows, custom shells (incl. explicit WSL launcher) via `shells.json`, default shell |
| FR-008      | Validated request/response + ordered output events with sequence numbers; output never persisted                      |
| FR-009      | CREATED → STARTING → RUNNING → EXITED / TERMINATING → TERMINATED, FAILED; enforced transitions                        |
| FR-010      | Hide vs terminate; confirmation when a program runs; quit behavior defined (ADR-013)                                  |
| FR-011      | Fit-to-pane with debounced resize, propagated to PTY and mirror only on change                                        |
| FR-012      | Dark theme, monospace fonts, font size, copy/paste, scrollback, search, clear, focus; preferences persisted           |
| FR-013      | Engine session list; views rebuilt from Engine state; bounded headless-mirror replay; reload never duplicates PTYs    |
| FR-014      | `atlas terminal list/open/show/close` over the authenticated local socket to the running Engine                       |
| FR-015      | Shortcuts in the application menu, documented in SDD-002                                                              |

Also: Engine moved to an Electron utility process with automatic restart, entire UI
migrated to shadcn/ui, version 0.2.0.

### Validation results (2026-10-19, macOS 26 / Darwin 25.6.0 arm64, Node 24.18.0, Electron 44.5.1)

| Check                                                            | Result                                                                  |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Fresh install in a clean copy (`pnpm install --frozen-lockfile`) | Pass — node-pty prebuild used, `spawn-helper` made executable           |
| `pnpm clean && pnpm build`                                       | Pass                                                                    |
| `pnpm typecheck`                                                 | Pass                                                                    |
| `pnpm lint`                                                      | Pass, 0 problems                                                        |
| `pnpm format:check`                                              | Pass                                                                    |
| `pnpm test` (Vitest)                                             | Pass — 17 files, 209 tests (incl. 13 real-PTY/socket integration tests) |
| `pnpm test:e2e` (Playwright + Electron)                          | Pass — 23 tests; 4 consecutive full runs green after the last fix       |
| `pnpm audit`                                                     | No known vulnerabilities                                                |
| Smoke: built app + CLI (`terminal open/list/close`), `pnpm dev`  | Pass (temporary data directory)                                         |

### Performance (E2E `performance.spec.ts`)

Ten terminals of one project (six visible panes, four hidden tabs) each run
`seq 1 500000` (~34 MB of output in total):

| Metric                                            | Result                                              |
| ------------------------------------------------- | --------------------------------------------------- |
| Time until all ten shells finished                | 3.7–3.9 s                                           |
| Renderer → Engine IPC round trip during the flood | p50 0 ms, p95 2–3 ms, max 4 ms                      |
| Longest gap between animation frames              | 28–32 ms                                            |
| Memory (working set) after the run                | renderer ~310 MB, Engine host ~135 MB, main ~170 MB |

Back-pressure pauses a PTY when a view is more than 1 MiB behind. Each session keeps a
1,000-line mirror in the Engine host; renderer scrollback follows the preference.

### Acceptance criteria (SDD-002 §11)

| Criterion                                  | Status   | Evidence                                                                             |
| ------------------------------------------ | -------- | ------------------------------------------------------------------------------------ |
| Terminal created from a registered project | Verified | Service unit tests, IPC tests, E2E                                                   |
| Starts in the project directory            | Verified | Integration (`pwd`), E2E                                                             |
| Real interactive shell commands work       | Verified | Integration (`read`), E2E                                                            |
| ANSI colors and interactive applications   | Verified | Integration (raw escapes, alternate-screen snapshot), E2E (`xterm-fg-1`, alt screen) |
| Multiple terminals simultaneously          | Verified | Integration (10 concurrent), E2E performance                                         |
| Multiple projects with active terminals    | Verified | Integration (3 projects), E2E project switching                                      |
| Tabs created, renamed, selected, closed    | Verified | E2E `manages tabs…`                                                                  |
| Horizontal and vertical splits             | Verified | Layout unit tests, E2E `splits panes…`                                               |
| Pane resizing updates PTY dimensions       | Verified | Integration (`stty size`), E2E divider drag                                          |
| Input/output streamed correctly            | Verified | Service tests (ordering, seq, isolation), integration, E2E                           |
| Process exits detected and displayed       | Verified | Unit, integration (exit 0/7, signal), E2E (`exit 4`)                                 |
| Closing handles running processes safely   | Verified | E2E confirm/cancel, quit confirmation, CLI `--yes`                                   |
| Renderer reload does not duplicate PTYs    | Verified | E2E reload (same ids and pids)                                                       |
| CLI uses the shared Engine                 | Verified | Integration (socket), CLI tests, E2E (tab appears), smoke run                        |
| Terminal settings persist across restarts  | Verified | E2E restart (font size, titles, layout)                                              |
| Unauthorized project paths rejected        | Verified | Service, IPC, security E2E (unknown project, `cwd` field rejected)                   |
| SDD-001 functionality operational          | Verified | All SDD-001 unit, IPC and E2E tests pass after the shadcn migration                  |
| Unit / integration / desktop tests pass    | Verified | 209/209, 23/23                                                                       |
| Type checking and builds pass              | Verified | `pnpm typecheck`, `pnpm build`                                                       |
| Documentation updated                      | Verified | ARCHITECTURE, DECISIONS (ADR-009–015), ROADMAP, this file, SDD-002, README           |

## Known limitations

- Verified on macOS only. Windows (ConPTY, PowerShell/cmd) and Linux run the same code
  but were not executed; Linux builds node-pty from source during installation.
- Keyboard accelerators are verified through the menu items they belong to, not by
  physical key presses; the native directory picker remains stubbed in automation.
- Terminals end when ATLAS quits (by design, ADR-013). `atlas terminal …` needs the app
  running.
- Background jobs (`cmd &`) are not detected by the close confirmation; Windows always asks.
- Reattach replays at most 1,000 lines; some modes (e.g. mouse tracking) may need a redraw.
- Ended sessions stay as tabs until closed and count toward the 64-session limit.
- ⌘W now closes the active terminal; "Close Window" moved to ⇧⌘W (changed from SDD-001).
- On macOS the `spawn-helper` permission is fixed by the `@atlas/engine` postinstall; if
  terminals fail with "The shell could not be started", run
  `pnpm --filter @atlas/engine run postinstall`.
- Terminal output is relayed through the Electron main process (batched; see ADR-009).
- Database schema v2 cannot be opened by SDD-001 builds (they refuse newer schemas).
- Project registry: the SDD-001 limitations still apply (refresh on focus, case-sensitive
  APFS volumes, no packaging, dark theme only).

## Pending

- Final validation of the current SDD-004 Milestone A revision (project commit checks,
  review actions and related corrections); its results will replace the baseline above.
- Manual verification of shortcuts with the physical keyboard and of the real directory
  picker.
- Developer approval of SDD-003 Milestone B. Real execution (Claude/Codex adapters) is SDD-004.
