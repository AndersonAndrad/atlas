# ATLAS Status

Last updated: 2026-10-19 — SDD-002 implementation (PLAN-002 revision 2).

**Overall status:** SDD-001 approved. SDD-002 implemented and validated on macOS (arm64);
awaiting the developer's explicit approval before SDD-003 (SDD-002 §15).

## SDD-002 — Terminal Manager

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

- Manual verification of shortcuts with the physical keyboard and of the real directory
  picker.
- Developer approval of SDD-002 before starting SDD-003.
