# ATLAS Status

Last updated: 2026-10-27 — PLAN-044 (SDD-016 Task 01: debugger foundation).

**Overall status:** SDD-001, SDD-002 and SDD-003 Milestone A approved. SDD-003 Milestone B,
SDD-004 Milestone A (with PLAN-009–PLAN-012) and SDD-005 Milestone A stage A1 (Shared
Context) implemented and validated on macOS (arm64) with automated tests; all await the
developer's approval. SDD-005 A1 still needs a manual check with the real Claude Code and
Codex CLIs. SDD-004 Milestone B (provider execution) and SDD-005 stage A2, Milestones B and
C are not started. PLAN-014 (project configuration read by LLMs) is implemented and awaits
approval. SDD-006 Milestone A (intelligent context retrieval, PLAN-015) is implemented and
validated with automated tests and awaits approval; SDD-006 Milestones B and C are not
started (C depends on SDD-004 B and SDD-005 B). PLAN-016 (persistent Git operation log
and reflog) is implemented and validated and awaits approval. SDD-006 Milestone B (Skills
Hub, PLAN-017) is implemented and validated and awaits approval. PLAN-018 (commits use a
fresh shell environment; ATLAS's development NODE_ENV no longer leaks) is implemented and
awaits approval. PLAN-019 (cherry-pick from another branch, keeping commits) is
implemented and awaits approval. PLAN-020 (Git actions in one menu at the top right; long
names truncate) is implemented and awaits approval. PLAN-021 (automatic LLM sessions and
checkpoints, wrappers first on PATH, import of a folder of skills) is implemented and awaits
approval. PLAN-022 (reflog search and the files of each entry's commit) is implemented and
awaits approval. PLAN-023 (quick commands, project action menus in Terminals, project
details in tabs; revision 2: commands enabled per project) is implemented and awaits
approval. PLAN-024 (GitHub Actions: all checks on Linux and macOS, then Debian and macOS
installers) is implemented; revision 2 pins pnpm 11.28.5 because 11.13.0 is a broken
release the CI cannot install. PLAN-025 (the app is presented as A.T.L.A.S with its own
icon) is implemented and awaits approval. PLAN-026 (terminal copy/paste on Linux, context
menu Copy/Paste/Select all, file drops, Linux primary selection, forced selection while a
program captures the mouse) is implemented and awaits approval. PLAN-027 (SDD-008 Milestone
B: account profiles, provider limit windows, daily and weekly usage) is implemented and
awaits approval; SDD-008 Milestones A and C are not started. PLAN-028 (SDD-007 Milestone A:
Preflight local validation) is implemented and awaits approval; SDD-007 Milestones B and C
are not started. PLAN-030 (SDD-009 Milestone A: notification center with Git and Preflight
events; commits run in the background) is implemented and awaits approval; SDD-009
Milestones B and C are not started. PLAN-031 (the terminal header shows the Claude Code
account open in it with its session usage) is implemented and awaits approval. PLAN-032
(SDD-010 Milestone A: Project Hub with Markdown notes) is implemented and awaits approval;
SDD-010 Milestones B (tasks) and C (Jira) are not started. PLAN-033 (SDD-011 Milestone A:
code editor with Monaco, explorer and terminal panel) is implemented and awaits approval;
SDD-011 Milestones B and C are not started. PLAN-034 (GitHub Actions also builds a Windows
x64 NSIS installer; the checks still run only on Linux and macOS) is implemented and awaits
approval. PLAN-035 (zod 4.6.5 → 4.6.7 for GHSA-mrhx-c7xc-m3w5) is implemented and awaits
approval. PLAN-036 (the watched-folder Engine test no longer races macOS FSEvents) is
implemented and awaits approval. PLAN-037 (CI build steps get a 4 GB Node heap) is
implemented and awaits approval. PLAN-038 (15 s default test timeout; the Git hook timeout
test waits for the hook) is implemented and awaits approval. PLAN-039 (the Hub E2E selects
Preview instead of relying on Split) is implemented and awaits approval. PLAN-040 (SDD-012
Milestone A: background jobs, Operations Center and header indicator) is implemented and
awaits approval; SDD-012 Milestones B and C are not started. PLAN-041 (SDD-013 Milestone
A: Container Manager over the Docker CLI) is implemented and awaits approval; SDD-013
Milestones B and C are not started. PLAN-042 (SDD-014 Milestone A: API Workbench, HTTP in
the Engine) is implemented and awaits approval; SDD-014 Milestones B and C are not
started. PLAN-043 (SDD-015 Milestone A: Extensions Hub with Open VSX and declarative
contributions) is implemented and awaits approval; SDD-015 Milestones B and C are not
started. PLAN-044 (SDD-016 Task 01: Debug Adapter Protocol foundation, no UI) is
implemented and awaits approval. Version 0.31.0 (schema v15).

## PLAN-044 — SDD-016 Task 01: debugger foundation

- Approved 2026-10-27 by Anderson Andrade ("pode seguir, q1 a q4 recomendado"). R1–R5 were
  presented but not acknowledged by ID. Details: `docs/sdd/SDD-016-debugger.md`, ADR-068.
  - Q1: no window API yet; the `debug.*` Engine methods are desktop only.
  - Q2: `@vscode/debugprotocol` 1.68.0 types, with ATLAS's own framing.
  - Q3: sessions in memory only.
  - Q4: one active session at a time.
- New `packages/debugger`:
  - `DapMessageReader` and `encodeDapMessage`;
  - `DapConnection`;
  - the status machine;
  - `DebugSessionManager`: adapter registry, create, start, stop, status, events, detach,
    close.
- Contracts: `packages/contracts/src/debug.ts`, a `debug` engine event, and `DEBUG_*`
  error codes.
- Engine adapter `ProcessTreeAdapterLauncher`; `process-tree` can now pipe stdin. The main
  process detaches a reloaded window's sessions, and Engine shutdown stops them all.
- One dependency: `@vscode/debugprotocol` 1.68.0 (exact, types only). No schema change.
- Staff review found one High finding, fixed before validation: an `initialized` event sent
  in the same chunk as the `initialize` response was missed, so such adapters would time
  out. The waiter now exists before `initialize` is sent, with a test that fails without
  the fix.
- Validation (2026-10-27):
  - format, lint and typecheck are clean.
  - `pnpm test`: 1105 passed, 6 skipped.
  - New tests: 26 unit, 21 integration with a real fake adapter process (every adapter PID
    checked to be gone), 1 IPC. Mutation checks: two.
  - E2E in Linux Docker (workspace, security, terminals): 22 passed, 1 skipped.

## PLAN-043 — SDD-015 Milestone A: Extensions Hub

- Approved 2026-10-27 by Anderson Andrade ("pode seguir com o plan, e q1 a q6 pode seguir
  com o recomendado sem problema"). The plan had Q1–Q5; all take the recommended option.
  R1–R12 were presented but not acknowledged by ID. Details:
  `docs/sdd/SDD-015-vscode-extension-compatibility.md`, ADR-067.
  - Q1: TextMate grammars with `vscode-textmate` and the Oniguruma WASM; the CSP adds
    `'wasm-unsafe-eval'`.
  - Q2: color themes change the editor only.
  - Q3: icon themes with SVG and PNG icons only.
  - Q4: SUPPORTED only from the tested matrix (opt-in live Open VSX test).
  - Q5: dependencies install only after the user confirms the list.
- New `packages/extensions`: manifest checks, declarations, compatibility levels,
  resolvers for themes, grammars, snippets, language configuration and icon themes, and
  `ExtensionsService`.
  - Engine adapters: `OpenVsxRegistry` and `FileExtensionPackages` (yauzl, staging,
    atomic commit). Migration v15 with `SqliteExtensionRepository`.
  - `extensions.*` methods, desktop only. Only https homepage links can be opened.
  - The Extensions view (lazy): Open VSX search with category and publisher, Installed,
    Updates on demand, details with the compatibility report, versions, enablement per
    project, dependencies and diagnostics.
  - A renderer runtime applies the contributions to Monaco (Editor and API Workbench) and
    to the file explorer. Settings can pick extension themes.
- Dependencies, all exact: `yauzl` 3.4.0 (with `@types/yauzl` 3.4.0) and `zod` 4.6.7 in
  the Engine; `jsonc-parser` 3.3.1; `vscode-textmate` 9.3.2 and `vscode-oniguruma` 2.0.1
  in the desktop bundle.
- Rolling back to 0.29.x needs a database copy taken before 0.30.0 first ran: older
  versions refuse schema v15.
- Fixed on the way: with Zod 4, `.partial()` of the editor preferences applied every
  default, so changing one editor preference reset the others (since SDD-011). The update
  schema is now built without defaults, with a regression test.
- Staff review found no Critical or High findings. Fixed during the review:
  - registry metadata was cached for 5 minutes, so update checks and installing "latest"
    could use stale data (they now ask the registry again);
  - a transfer that broke midway surfaced as an internal error instead of "registry
    unavailable";
  - cached file icons stayed old after the icon extension was updated;
  - using a registry from `ATLAS_EXTENSIONS_REGISTRY_URL` was not logged;
  - extension themes could be chosen only in the Extensions view; Settings now offers them
    too.
- Validation (2026-10-27):
  - format, lint, typecheck and `pnpm audit --prod` are clean.
  - `pnpm test`: 1057 passed, 6 skipped (opt-in real Docker and live Open VSX tests).
  - New tests: 43 + 14 unit, 6 persistence (v14 → v15), 25 integration with a local
    registry and hostile packages, 1 IPC, 1 preferences regression. Mutation checks: the
    symbolic link test fails without the check; the preferences test fails with the old
    schema.
  - Live Open VSX (opt-in): 4/4. Dracula 2.25.1, JavaScriptSnippets 1.8.0 and vscode-apache
    1.2.0 are SUPPORTED; Material Icon Theme 5.40.0 is PARTIALLY_SUPPORTED.
  - E2E in Linux Docker with Xvfb: full suite 111 passed, 1 skipped.

## PLAN-042 — SDD-014 Milestone A: API Workbench

- Approved 2026-10-26 by Anderson Andrade ("pode seguir, q1 recomendado, q2 recomendado, q3
  recomendado, q4 recomendado, q5 feito o commit pode seguir"). R1–R12 were presented but
  not acknowledged by ID. Details: `docs/sdd/SDD-014-api-workbench.md`, ADR-066.
  - Q1: secret values are never stored; the secure store comes in Milestone B.
  - Q2: `tough-cookie` 6.0.2 for the cookie jar.
  - Q3: `{{variables}}` block sending.
  - Q4: the view is named "API".
  - Q5: PLAN-041 was committed first.
- New `packages/api-workbench` (`HttpWorkbenchService`, request preparation, secret
  stripping, the redirect plan).
  - Engine adapters: `NodeHttpTransport` (node:http/https), `MemoryCookieJars` and
    `FileHttpResponses`.
  - Migration v14 with `SqliteHttpWorkbenchRepository`.
  - `http.*` methods, desktop only. The main process adds the window, the picked upload
    files and the save-dialog path.
  - The API view is lazy-loaded and stays mounted. It has collections and history, request
    tabs, an editor for method, URL, parameters, headers, body and settings, and a response
    viewer with body, headers, cookies, timing and what was sent, plus download, saved
    responses and comparison.
- One runtime dependency: `tough-cookie` 6.0.2 (exact), which brings `tldts` 7.4.19.
  `pnpm audit --prod` is clean.
- Rolling back to 0.28.x needs a database copy taken before 0.29.0 first ran: older versions
  refuse schema v14.
- Staff review found no Critical or High findings. Fixed during the review:
  - the response body was reformatted on every keystroke in the request editor;
  - the unsaved-changes mark serialized every tab on every render;
  - "Load more" could bring a whole large body into the window (now capped at 16 MB, with
    download for the rest);
  - a transport failure logged the error message (now only its name and code);
  - the saved state took edits made during a save, and a download message stayed when
    switching tabs.
- Validation (2026-10-26):
  - format, lint, typecheck and `pnpm audit --prod` are clean.
  - `pnpm test`: 967 passed, 2 skipped (the opt-in real Docker tests).
  - New tests:
    - 19 unit tests;
    - 11 persistence tests, including the v13 → v14 migration;
    - 14 integration tests against real local HTTP and HTTPS servers; the credential-removal
      test was checked to fail when removal is turned off;
    - 1 IPC test.
  - E2E in Linux Docker with Xvfb: the API Workbench and security specs passed 9/9. The
    full suite had 106 passed, 1 skipped and 1 failed: the workspace spec still expected
    schema 13. After updating it to 14, the workspace spec passed 5/5.

## PLAN-041 — SDD-013 Milestone A: Container Manager

- Approved 2026-10-26 by Anderson Andrade ("pode seguir, q1 ok, q2 ok, q3 ok, q4 ok"); R1–R8
  presented, not acknowledged by ID. Q1 local images only, Q2 audit in the Engine log, Q3
  disposable real-Docker tests, Q4 "Containers". Details:
  `docs/sdd/SDD-013-docker-container-manager.md`, ADR-065.
- New `packages/docker` (CLI output parsing, `DockerService`) and the Engine
  `DockerCliRunner`.
  - `docker.*` methods (desktop only) and a `docker` event.
  - The Containers view, lazy-loaded: context selector, connection state, list with search
    and filters, actions by state, details without environment values, logs, usage, shell in
    an ATLAS terminal with root confirmation, and creation with risk confirmations.
  - No schema change; the context choice is the `docker.context` setting.
- Inside the approved scope: environment values of new containers go through a private
  `--env-file` instead of the CLI's environment, where `DOCKER_HOST` and similar names
  could redirect the CLI.
- Staff review: one Medium security finding was fixed. Risk warnings covered only exact
  system folders; they now cover anything inside them and credential folders in the home
  folder (`.ssh`, `.aws`, `.kube`, `.docker`…).
- Validation (2026-10-26):
  - format, lint, typecheck and `pnpm audit --prod` are clean.
  - `pnpm test`: 921 passed, 2 skipped (the opt-in real Docker tests), plus 1 failure in the
    known 100 ms `redactCredentials` timing test under load. That file is unchanged and
    passed alone three times (71/71).
  - Real Docker (`ATLAS_DOCKER_TESTS=1`, Docker Desktop 4.81 / Engine 29.6.1): 8/8. No test
    container remained, and the developer's containers were untouched.
  - E2E in Linux Docker with Xvfb (fake CLI): containers and security specs 9/9; full suite
    102 passed, 1 skipped.

## PLAN-040 — SDD-012 Milestone A: background jobs

- Approved 2026-10-26 by Anderson Andrade ("pode seguir com a implementação"). Defaults:
  unfinished jobs become INTERRUPTED after a restart, limits 2 / 1 per project, CLI
  read-only. Details: `docs/sdd/SDD-012-background-operations.md`, ADR-064.
- New `packages/jobs` (state machine, queue selection, service), migration v13
  (`background_jobs`, `background_job_attempts`, `background_job_status_history`),
  `SqliteJobRepository`, Engine executors: COMMAND over Preflight's shell executor and
  PREFLIGHT over the Preflight service (`isRunning` and `settled` added). `jobs.*` methods
  (CLI: list and get only), a `jobs` event, BACKGROUND_TASK notifications, and background
  jobs in the quit confirmation.
- UI: Operations in the main navigation (active and history, filters, details with log,
  attempts and status history, Cancel, Retry, Open result, Open project, New command job
  with confirmation of destructive commands, Limits), the header indicator, and Preflight →
  Run in background. `LogViewer` can read a job's log. CLI: `atlas jobs list` and
  `atlas jobs show`.
- Jobs stop when ATLAS quits (reported as interrupted); no daemon. Rolling back to 0.26.x
  needs a database copy taken before 0.27.0 first ran (older versions refuse schema v13).
- Staff review: no Critical or High findings. Fixed: a token typed in a command could reach
  the job title and notifications (now redacted); the log of a job opened as it started
  could stop polling; an interrupted job showed the executor's stop message instead of
  why it was interrupted; a nondeterministic test assertion.
- Validation (2026-10-26): format, lint, typecheck and `pnpm audit --prod` clean.
  `pnpm test` passed with 892 tests in three full runs. The last run had two timing
  failures under load (load average 54, with the Docker E2E in parallel). They were the
  existing cherry-pick and `redactCredentials` timing tests, which this change does not
  touch, and both files passed alone (76/76). Full E2E in Linux Docker with Xvfb: 97
  passed, 1 skipped. The first full run found the two issues fixed above; the affected
  specs then passed 12/12.

## PLAN-039 — Hub E2E on smaller screens

- After PLAN-038 Ubuntu passed, but on macOS "keeps project notes after a restart" did not
  find the preview heading. The note editor opens in Split only when the window is at least
  80rem (1280 px) wide, otherwise in Edit (intended); the macOS runner's screen makes the
  1280 px window narrower, while Xvfb without a window manager does not.
- The test now chooses Editor mode → Preview before checking the rendered Markdown (heading,
  table, no script or `javascript:` link). No application change.
- Validation (2026-10-26, macOS arm64): reproduced with a temporary copy of the test at a
  1100 px window (failed as on CI; passed with the change; copy removed); `hub.spec` 5/5 at
  the normal width. Full `pnpm test:e2e` on the Mac: 90 passed and 3 focus-dependent tests
  failed while the developer used the computer; in a Linux container (node:24.18.0-bookworm,
  Xvfb, nothing shown on the host): 93 passed, 1 skipped.

## PLAN-038 — Tests that start processes on busy machines

- A local `pnpm test` on a loaded machine (load average about 5, with E2E running) had 7
  timeouts in tests that start real processes (commit environment, Git executor, Preflight
  `act`, LLM wrappers, Claude status line wrapper); the CLI standalone test had shown the
  same before. With an idle machine they pass.
- `vitest.config.ts` sets `testTimeout: 15_000` (was Vitest's 5 s). The Git executor test
  that stops hook processes on timeout gives `git commit` 3 s instead of 1 s, so the hook can
  write its pid first; it still checks that the hook dies with Git.
- Validation (2026-10-25, macOS arm64, 10 cores): `pnpm test` 842/842 twice idle and twice
  while `pnpm test:e2e` ran in parallel (load averages 14 and 28); that E2E run: 93 passed.

## PLAN-037 — Renderer build out of memory on the macOS runner

- With PLAN-036 the macOS unit tests passed, but `electron-vite build` (E2E step) stopped
  with "JavaScript heap out of memory" in the renderer build. Since PLAN-033 it bundles
  Monaco and its workers and needs about 3 GB of heap (peak RSS 3.1 GB); the macOS runner
  has 7 GB of RAM, so Node's default limit is about 2 GB. Ubuntu and Windows runners have
  16 GB. Earlier runs had stopped before this step.
- `ci.yml` sets `NODE_OPTIONS=--max-old-space-size=4096` on the E2E and installer build
  steps only. Reducing the build's memory (for example without the TypeScript worker) is a
  possible later plan.
- Validation (2026-10-25, macOS arm64): with a 2 GB limit the build fails as on CI; with
  3 GB and 4 GB it passes (about 18 s). `pnpm test:e2e` with the CI setting: 93 passed,
  1 skipped.

## PLAN-036 — Watched-folder test race on macOS CI

- The first CI run after PLAN-035 failed on macOS in "reports changes in watched folders":
  the test wrote the file right after starting the watch, and FSEvents starts
  asynchronously and drops earlier changes. Ubuntu was canceled by `fail-fast`, and the
  build job (Windows included) was skipped because it needs the tests.
- The test now writes the file on every poll attempt (200 ms, 5 s limit) until a change is
  reported. Test-only change; the editor still rechecks versions on focus and before saving.
- Validation (2026-10-25, macOS arm64): the test passed 10/10 alone; full `pnpm test` 4 runs,
  3 at 842/842 and 1 with an unrelated timeout in the CLI standalone-process test (two Node
  processes under load, default 5 s limit; not changed here). Format, lint, typecheck and
  production audit clean.

## PLAN-035 — zod security update

- `pnpm audit --prod` failed in CI with GHSA-mrhx-c7xc-m3w5 (High): zod up to 4.6.5 keeps
  every issue of a failing array, so a huge invalid array can exhaust memory. Patched in
  4.6.6.
- zod is pinned to 4.6.7 (exact) in `apps/desktop`, `packages/contracts` and
  `packages/usage`; the lockfile changed only the zod entries (eslint-plugin-react-hooks
  and zod-validation-error now resolve 4.6.7 too). 4.6.7 was 13 days old, below the
  two-week rule of ADR-007: accepted for a security patch release approved by the developer.
- Validation (2026-10-25, macOS arm64): `pnpm audit --prod` no known vulnerabilities;
  format, lint, typecheck clean; `pnpm test` 842/842; `pnpm test:e2e` 93 passed, 1 skipped.

## PLAN-034 — Windows installer in GitHub Actions

- The `build` job of `.github/workflows/ci.yml` gains `windows-x64` (`windows-2025`):
  electron-builder makes `atlas-control-<version>-win-x64.exe` (NSIS, x64, per user,
  installation folder can be changed), kept as a run artifact and attached to `v*` Releases.
- Build only, chosen by the developer (option A): the `test` job still runs on Ubuntu and
  macOS; a step checks that the installer exists and that `node-pty`'s ConPTY addon is
  unpacked. Not signed (SmartScreen warns).
- Validation (2026-10-25): cross-build on macOS arm64 with the same configuration produced
  the `.exe` (127 MB) and a `win-unpacked` with a PE32+ x86-64 `atlas-control.exe` and
  `conpty.node` unpacked; the CI check command passed on it. The installer has not been run
  on Windows; the workflow job runs for the first time on GitHub after the push.
- Details: README "Download builds"; ADR-056 (PLAN-034 update).

## PLAN-033 — SDD-011 Milestone A: code editor

- New Editor view (below Terminals): project selector, explorer, Monaco tabs, optional
  terminal panel of the project, resizable panes; narrow windows show the explorer over the
  editor. Monaco loads only when the view is first opened; terminal-only use is unchanged.
- Explorer: lazy, virtualized tree; filter by name; quick open (Cmd/Ctrl+P); create, rename,
  move (drag and drop), move to Trash (with confirmation), reveal, copy path; ignored files
  hidden by the project's Git rules (or a default list) and shown on request.
- Editing: syntax highlighting, folding, find/replace, multiple cursors, minimap, word wrap,
  bracket matching, basic completion; Save, Save As, Save All, auto save (optional).
- Safety: paths stay inside the project after resolving symbolic links; saves never replace
  a file changed or deleted on disk without asking; unmodified tabs reload automatically;
  closing, switching project or quitting with unsaved changes asks first.
- Encoding (UTF-8, UTF-8 BOM, UTF-16 BOM) and line endings are kept; binary files and files
  over 5 MB are not opened.
- Preferences in Settings → Editor; open files, positions and panel sizes restored per
  project (references only, never contents).
- New exact dependency: monaco-editor 0.57.0 (renderer bundle, loaded on demand).
- Not yet: diff, Git decorations, search, command palette, language servers, AI (B and C).
- Details: `docs/sdd/SDD-011-code-editor.md`, ADR-063.

## PLAN-032 — SDD-010 Milestone A: Project Hub notes

- New Project Hub view (below Projects): project selector (projects, Global notes, All
  notes) and sections Overview · Notes · Tasks · Jira; Tasks and Jira are marked "soon" and
  hold no data.
- Markdown notes per project, per folder (kept when a project is removed from the registry)
  or global: create, edit with a formatting toolbar, Edit / Split / Preview, categories with
  autocomplete, pin, archive, delete, search (SQLite FTS5) and filters. Notes survive
  restarts (schema v12).
- Links `atlas:note/…`, `atlas:session/…`, `atlas:branch/…`, `atlas:file/…` are checked
  (broken ones are struck through); files are only revealed in Finder, never opened.
- Saving a note changed elsewhere asks what to keep; nothing is overwritten silently.
- Preview never runs scripts or loads images; only web and e-mail links open outside ATLAS.
- New exact dependencies: react-markdown 10.1.0, remark-gfm 4.0.1 (renderer bundle).
- Not yet: notes as AI context (Milestone B), revision history, tasks, Jira.
- Details: `docs/sdd/SDD-010-project-hub.md`, ADR-062.

## PLAN-031 — Session usage of the open LLM in the terminal header

- While Claude Code runs in an ATLAS terminal, the pane header shows its account and the
  session (5h) window next to the Git chips, e.g. `claude-my: 26%`: green below 70%, yellow
  from 70%, red from 90%. The name is the profile's name in the Usage view (`claude` for the
  default profile); the tooltip shows the reset time and how old the value is.
- The value is the account's latest provider report, so terminals using the same account
  agree. It updates when Claude Code refreshes its status line (activity), not while idle.
- Codex is not shown yet (no status line; planned separately).
- Details: `docs/sdd/SDD-008-multi-account-and-routing.md` (PLAN-031), ADR-061.

## PLAN-030 — SDD-009 Milestone A: notifications and background commits

- Bell with the unread count at the top right of every view; panel with history, All/Unread,
  mark read, mark all read, delete and clear all; toasts at the bottom right.
- Finished commits, pushes, pulls and cherry-picks, failed merges and fetches, and finished
  Preflight runs are notified once, stored in SQLite (schema v11, retention 1,000 / 30 days
  after read) and survive restarts. Clicking opens the Git operation or the Preflight run.
- The commit dialog closes once the commit started; the operations panel shows its steps
  and a failed commit offers "Edit commit" with the same message.
- Quitting asks first while Git operations or Preflight runs are in progress.
- PLAN-029: the redaction timing test measures the fastest of three runs, so a busy machine
  no longer fails it.
- Details and limitations: `docs/sdd/SDD-009-notifications.md`, ADR-060.

## PLAN-028 — SDD-007 Milestone A: Preflight

- Preflight view (and entries from project details, the Git view, the terminal context menu
  and session details): checks per project or picked folder — commands, package scripts,
  GitHub Actions jobs through act — with profiles, dependencies, concurrency, timeouts,
  required/advisory, live redacted logs, cancellation, history and Markdown reports.
- Discovery reads package.json, Make, Gradle, Maven and workflows without running anything;
  workflow jobs are classified (compatible, partial, unsupported, unknown) with reasons and
  side effects found in what steps do.
- A check runs only after the developer authorized its exact definition; side-effecting
  checks ask every time; changed files block a check. Jobs that need secrets are blocked.
- Each run records HEAD, branch and a code-state fingerprint (informative until quality gates).
- act and Docker are detected, never installed. Real act runs are not validated yet (act is
  not installed on the development machine; a fake act verified the arguments).
- Details and limitations: `docs/sdd/SDD-007-preflight-and-quality-gates.md`, ADR-059.

## PLAN-027 — SDD-008 Milestone B: usage and limits

- Usage view: per account profile, the current session (5h) and weekly windows side by
  side with percentage, reset time, source and age; history with a daily chart and weekly
  totals; filters; refresh and automatic refresh (default 10 min).
- Profiles: `~/.claude`, `~/.claude-<name>`, `~/.codex`, `~/.codex-<name>`, the
  environment's folders, and folders picked by the user (minimal registry; Milestone A
  extends it).
- Codex: `codex app-server` account reads (no model runs). Claude Code: the documented status
  line input, saved by the ATLAS status line in sessions started in ATLAS terminals.
- Details, capabilities and limitations: `docs/sdd/SDD-008-multi-account-and-routing.md`.

## PLAN-026 — Terminal clipboard, selection and file drops

- Right-click in a terminal offers Copy (enabled with a selection), Paste and Select all.
- Windows/Linux: Ctrl+Shift+C copies, Ctrl+Shift+V and Shift+Insert paste, Ctrl+Shift+A
  selects all. xterm consumed these keys before the Edit menu accelerators could run, so
  they never worked there. Ctrl+C (interrupt) and Ctrl+V (image paste in AI CLIs) still
  reach the program.
- Programs that capture the mouse (TUIs, Claude Code, Codex) blocked plain drag selection;
  Option+drag (macOS) and Shift+drag (elsewhere) now select.
- Dropping files or images on a terminal types their shell-quoted paths and a space; nothing
  runs by itself. Paths come from Electron's `webUtils.getPathForFile` in the preload.
- Linux only: selecting fills the primary selection, a middle click pastes it (unless the
  program captures the mouse).
- Clipboard text is read and written by the main process (`atlas:app:read-text`,
  `atlas:app:copy-text` with an optional `selection` target); the renderer still has no
  clipboard permission.

## PLAN-025 — A.T.L.A.S name and icon

The application is presented as **A.T.L.A.S** wherever its name is shown: `A.T.L.A.S.app`,
menu bar, Dock and ⌘Tab (packaged), window title, sidebar, About, application menu items,
quit and start-up dialogs, CLI descriptions and messages that name the app. Explanatory
text keeps "ATLAS"; the CLI (`atlas`), the bundle identifier (`dev.atlas.control`), the
installer file names, the Linux package/command (`atlas-control`) and the data folder do
not change. The window (Linux) and, when running from source on macOS, the Dock use the app
icon (`apps/desktop/build/icon.png`). From source the bold macOS menu-bar title still reads
"Electron" (it comes from Electron's bundle). Details: ADR-057.

Validation (2026-10-21): macOS `pnpm test` 664/664 and `pnpm test:e2e` 70/70 twice (title,
sidebar, About, `app.getName()` and the application menu say A.T.L.A.S); packaged
`A.T.L.A.S.app` (CFBundleName/DisplayName A.T.L.A.S, same bundle identifier, app icon)
opened a working terminal. Debian x64 container: all checks clean, E2E 69 passed + 1
skipped, `.deb` installs to `/opt/A.T.L.A.S` with desktop entry `Name=A.T.L.A.S` and the
1024 px icon.

## PLAN-024 — GitHub Actions and installers

`.github/workflows/ci.yml`: format, lint, typecheck, production audit, unit and E2E tests on
Ubuntu 24.04 and macOS 15; when all pass, electron-builder builds `atlas-control-*.deb`
(x64) and `.dmg`/`.zip` (arm64) as run artifacts, and a `v*` tag also creates a Release.
Details: README "Download builds"; ADR-056.

Validation (2026-10-21): macOS arm64 — `pnpm test` 663/663, `pnpm test:e2e` 70/70 in two
consecutive runs, build, typecheck, lint, format and production audit clean; `pnpm package`
produced the `.dmg`/`.zip` (app archive 3.2 MB, `node-pty` unpacked, ad-hoc signature, DMG
checksum valid) and the packaged app opened a working terminal. Linux — the same workflow
steps in a Debian x64 container (Node 24.18.0, Xvfb): format, lint, typecheck and audit
clean, E2E 69 passed and 1 macOS-only skipped, `.deb` built and inspected. That run found
and fixed a Linux bug (the LLM wrapper check used a login shell, whose `/etc/profile`
replaces `PATH`, so wrappers showed as "Not installed") and two timing-sensitive tests.
The workflow itself runs for the first time on GitHub after the push.

Revision 2 (pnpm 11.28.5): the first GitHub run stopped at `pnpm/action-setup` because npm
marks pnpm 11.13.0 as broken. With 11.28.5 (lockfile unchanged): macOS `pnpm test` 663/663,
`pnpm test:e2e` 70/70 twice, `.dmg`/`.zip` built; Debian x64 container with pnpm installed
through npm like the action: all checks clean, unit 662 passed + 1 macOS-only skipped, E2E
69 passed + 1 skipped, `.deb` built.

First GitHub runs: a pre-commit runner test checked too early that stopped children had
exited (now waits); on macOS runners long prompts wrap paths across rows (two E2E tests now
compare text without row breaks); on Ubuntu the PLAN-021 E2E exposed a race — a session
started at the HEAD seen when ATLAS processed the start event, missing commits made before —
fixed by carrying the wrapper's HEAD in the start event. Revision 3 validation
(2026-10-21): macOS `pnpm test` 664/664 and `pnpm test:e2e` 70/70 twice; Debian x64
container: all checks clean, unit 663 passed + 1 skipped, E2E 69 passed + 1 skipped, `.deb`
built.

## PLAN-023 — Quick commands, project actions and project tabs

Navigation → Quick commands keeps named one-line commands; prioritized ones appear in each
project's Actions menu in Terminals (a three-dot options button that replaces the `+`),
after Open terminal, and run
in a new project terminal. Each project can hide them in its new Quick commands tab, and
enable there any other command for that project only (revision 2); project details are
now in tabs. Details: SDD-003 Part I-C; ADR-055.

Revision 2 validation (2026-10-21): `pnpm test` 663/663 (enabled per project, library
order, revision-1 settings still read, unknown ids dropped); `pnpm test:e2e` 70/70 in two
consecutive runs (a non-prioritized command enabled only in one project); build,
typecheck, lint, format and audit clean. Staff review: no material findings.

Validation (2026-10-21, macOS arm64, Node 24.18.0): `pnpm test` 662/662 (library order,
limits, invalid single-line commands, unreadable stored values, concurrent writes, hidden
per project, run by id with the terminal named after the command); `pnpm test:e2e` 70/70 in
three consecutive runs (run from the menu with real shell output, hide per project, tabs by
keyboard, the new terminal keeps the keyboard focus); build, typecheck, lint, format and
audit clean. Staff review: findings fixed (focus taken back by the closing menu, stale
hidden ids, overstated security rationale).

## PLAN-022 — Reflog search and commit files

Operations → Reflog searches by reflog message, commit subject or hash prefix (latest 1,000
entries) and each entry opens as an accordion with the commit's message and changed files
(change, path, +/−; merges against the first parent). CLI: `atlas git reflog --search`,
`atlas git show-files`. Details: SDD-004 Part I, "Operation log and reflog"; ADR-054.

Validation (2026-10-21, macOS arm64, Node 24.18.0): `pnpm test` 658/658 (real-repository
search by message, commit subject and hash prefix; added, renamed, binary, root, merge and
missing commits; invalid hashes refused), `pnpm test:e2e` 67/67 in two consecutive runs;
build, typecheck, lint, format and audit clean. Staff review: no material findings.

## PLAN-021 — Automatic LLM sessions, checkpoints and bulk skill import

`claude` / `codex` typed in a project terminal that keeps context now start and end an AI
session by themselves; the LLM's checkpoint is imported as unverified work in progress and
the end records what Git shows. The wrappers stay first on PATH in zsh and bash without
editing the user's files. Skills → import accepts a folder of skills. Details: SDD-005
Part I, "Automatic LLM sessions and checkpoints"; SDD-006 Part I-B; ADR-051–ADR-053.

Validation (2026-10-21, macOS arm64, Node 24.18.0): `pnpm test` 653/653 (50 files),
including real zsh/bash PATH-first, wrapper events, checkpoint revisions, automatic end on
exit, terminal close and restart, and folder import; `pnpm test:e2e` 66/66 in two
consecutive runs; build, typecheck, lint, format and audit clean. Staff review: no Critical
or High findings; two Medium/Low findings fixed (session recording can no longer block the
Engine start; terminals closed during shutdown are left to the next start).

## PLAN-019 — Cherry-pick

Git view → Cherry-pick…: commits of another local or remote-tracking branch, already
applied ones marked, applied in source order as normal commits (original message and
author, optional `-x`); conflicts and empty commits stop with Continue, Skip and Abort in
the Git view. Details: SDD-004 Part I, "Cherry-pick"; ADR-050.

Validation (2026-10-21, macOS arm64, Node 24.18.0, Git 2.55.0): `pnpm test` 645/645
(51 files), including real-repository tests for already-applied marks, source order,
`-x`, remote-tracking sources, conflicts (continue, skip, abort restoring HEAD) and a commit
that becomes empty; `pnpm test:e2e` 63/63 in two consecutive runs; clean build (renderer
1,253 kB), typecheck, lint, format and audit clean. Staff review: no Critical or High
findings; accepted by design: picked commits skip the project's commit checks (R1).

## PLAN-018 — Fresh shell environment for commits

Checks and Git hooks of every commit and push get the environment a new terminal would
have, read from the user's interactive login shell at that moment; `NODE_ENV` from `pnpm
dev` is no longer passed to terminals, checks or Git. Details: SDD-004 Part I, "Commit
environment"; ADR-049.

Validation (2026-10-20, macOS arm64, Node 24.18.0, zsh): `pnpm test` 640/640 (50 files),
including a real-zsh test where a `.zshrc` change made while ATLAS runs reaches the next
commit's check and hook; `pnpm test:e2e` 62/62 in two consecutive runs (a check of a commit
from an app launched with `NODE_ENV=development` sees it unset); clean build, typecheck,
lint, format and audit clean. Staff review: no Critical or High findings; Low (documented):
hooks of pull, merge and branch switching keep ATLAS's environment (without NODE_ENV).

## SDD-006 Milestone B — Skills Hub (PLAN-017)

| Requirement | Summary                                                                                         |
| ----------- | ----------------------------------------------------------------------------------------------- |
| FR-614/618  | Registry; immutable versions copied into the data folder; update available; version diff        |
| FR-615/619  | Global, project, provider, role and session rules with deterministic precedence and reasons     |
| FR-616/623  | Discovery only in authorized folders; import review with content hash; source never changed     |
| FR-617      | Claude Code / Codex adapters: compatible, partial (ignored features listed) or incompatible     |
| FR-620/621  | Dependencies checked without running anything; scripts, permissions, credentials, links, limits |
| FR-622      | Skills view (Installed, Available, Sync) and `atlas skills` CLI                                 |
| FR-624      | User-level sync with marker files, conflicts, preview, apply and rollback                       |
| FR-625      | Seven versioned templates, editable, never enabled automatically                                |

| Acceptance (§7)                         | Evidence                                                              |
| --------------------------------------- | --------------------------------------------------------------------- |
| Registered and imported from folders    | hub and IPC tests; E2E import                                         |
| Metadata validated                      | analyze tests (frontmatter, adapters, credentials, limits)            |
| Global and project scopes; role rules   | resolve tests; hub and Engine tests                                   |
| Provider compatibility reported         | analyze tests; E2E "Codex: partial"                                   |
| Enable / disable; version history       | hub tests (versions, diff); CLI test; E2E                             |
| Dependency validation                   | analyze tests (executables, skills, tools, providers)                 |
| Unsafe execution prevented (documented) | no execution path; scripts and permissions shown; credentials refused |
| Skills Hub UI                           | E2E (Available → review → Installed → Sync), 380 px                   |
| Provider configurations preserved       | hub sync test (foreign folder untouched, conflict); E2E rollback      |
| Unit and integration tests pass         | see below                                                             |

Validation (2026-10-20, macOS arm64, Node 24.18.0): `pnpm test` 635/635 (49 files);
`pnpm test:e2e` 61/61 in two consecutive runs; clean build ok (renderer 1,244 kB);
typecheck, lint, format and audit clean. New dependency `yaml` 2.8.4 (exact): the plan
approved 2.8.1, the audit reported GHSA-48c2-rrv3-qjmp and the developer approved 2.8.4.
Not verified: that the real Claude Code and Codex CLIs load synchronized skills or follow
listed skill files.

Staff review: no Critical or High findings. Low (open): CLI clients may inspect and import
any folder (explicit command arguments, local authenticated socket); a skill folder linked
from a source to a location outside it must be added or picked separately; turning skills
on or off does not refresh a project's `context.md` until the next context change.

## PLAN-016 — Persistent Git operation log and reflog

Every Git operation ATLAS runs is kept across restarts with each Git command it executed
(arguments, exit code, duration, credential-free output, bounded per command and per
operation); unfinished operations are closed at start; retention by age and count
(Settings → Git operation log). Operations panel: Recent, History (filters, commands,
Copy log) and Reflog (HEAD changes by any tool, "ATLAS" or "Outside ATLAS" by time and
kind). CLI: `atlas git log-operations`, `log-operation <id>`, `reflog`. Details: SDD-004
Part I, "Operation log and reflog"; ADR-046.

Validation (2026-10-20, macOS arm64, Node 24.18.0, Git 2.55.0): `pnpm test` 613/613
(44 files); `pnpm test:e2e` 60/60 in two consecutive runs; clean build ok (renderer
1,212 kB); typecheck, lint, format and audit clean.

Staff review: no Critical or High findings. Corrected: a terminal commit made while ATLAS
was staging was attributed to ATLAS (attribution now requires an operation kind that can
move HEAD in that way); stored output is bounded per operation (about 256 KB). Remaining
Low: authenticated local CLI clients can read the log of every repository ATLAS operated
on; pagination by start time can skip operations started in the same millisecond; a
reflog that cannot be read is shown as empty.

## SDD-006 Milestone A — Intelligent context retrieval (PLAN-015)

| Requirement | Summary                                                                                              |
| ----------- | ---------------------------------------------------------------------------------------------------- |
| FR-601/602  | Objective, role, files and keywords; FTS5 bm25 + structured filter; scores as sums of named factors  |
| FR-603      | Estimated-token budgets: request → task → profile → role → provider → default; Settings and Tasks UI |
| FR-604/605  | Priority sections; objective and required entries never left out; included / excluded with reasons   |
| FR-606/607  | Branch changes, conflicts, pending of closed tasks; duplicates collapsed, history untouched          |
| FR-608      | Context → Health and `atlas context health`; reconciliation runs recorded; no overall score          |
| FR-609      | Preview context and Start dialog: records, exclusions (required locked), warnings, exact text        |
| FR-610–613  | Bundle-time compaction; essential detail + on-demand `atlas context retrieve`; LRU cache; isolation  |

| Acceptance (§5)                    | Evidence                                                                      |
| ---------------------------------- | ----------------------------------------------------------------------------- |
| Retrieval by objective             | Engine test "retrieves by objective…"; bundle unit tests; E2E preview         |
| Project and task filters           | Engine isolation and task budget tests; bundle task scope                     |
| Relevance scoring                  | `retrieval.test.ts` (explainable factors, recency vs decisions, roles, files) |
| Budgets enforced                   | bundle budget and over-budget tests; Engine budget resolution; E2E Settings   |
| Source references preserved        | bundle "relevant files … contract" test (source, files)                       |
| Stale context detected             | Engine cache + freshness test; Health test (removed file)                     |
| Duplicates reduced                 | consistency and bundle duplicate tests; Health duplicates                     |
| Context Health                     | Engine Health/reconcile test; IPC and CLI tests; E2E                          |
| Context previews                   | E2E (objective, exclusion, locked required, text, 380 px)                     |
| Cache invalidation                 | Engine test: Engine write and another database connection invalidate          |
| SDD-005 handoffs remain functional | SDD-005 handoff, session and E2E tests pass unchanged                         |
| Unit and integration tests pass    | see below                                                                     |

Validation (2026-10-20, macOS arm64, Node 24.18.0): `pnpm test` 599/599 (41 files);
`pnpm test:e2e` 59/59 in two consecutive runs; clean build ok (renderer 1,202 kB);
typecheck, lint, format and audit clean. Not verified: the real Claude Code and Codex CLIs
(fake executables in tests) and ranking quality on real project histories (heuristic
weights; no objective relevance measure).

Staff review: no Critical or High findings. Corrected: start guarded until the preview of
the current selection is loaded; true FNV-1a fingerprint (reference vectors tested);
near-duplicate comparison reuses word sets; required-flag changes recorded as revision
reasons; score explanation exposed to assistive technology; locale-independent token
numbers. Remaining Low: score factors are shown on hover / to screen readers, not as
visible text; any context write invalidates every cached bundle (documented).

## PLAN-014 — Project configuration for LLMs

Per-project `project-config.json` (keepContext and atlasEnabled, both off by default) and a
generated `context.md` in the ATLAS data directory; `claude` / `codex` typed in a
project's ATLAS terminal are told to read them first (POSIX wrappers). Project details →
AI & context. Details: SDD-005 Part I; ADR-042. Real Claude Code and Codex CLIs: manual
check pending.

## SDD-005 Milestone A, stage A1 — Shared Context

| Requirement | Summary                                                                                                  |
| ----------- | -------------------------------------------------------------------------------------------------------- |
| FR-501–503  | Scopes, entities and categories; entries with verification, source, file/commit references and revisions |
| FR-504      | `SharedContextService` (packages/context), independent of Electron and providers                         |
| FR-505/506  | Token-budgeted bundles with priorities; freshness checked against Git before every bundle                |
| FR-507      | Engine-authorized owners per request; global only by explicit choice; redaction; untrusted content       |
| FR-508–510  | Managed Claude Code / Codex sessions in ATLAS terminals; tracked terminals; no conversation access       |
| FR-511–513  | Handoffs with Git evidence (both directions); session summaries with verified commits and files          |
| FR-514      | Context view: overview, memory, tasks, decisions, sessions, handoffs; terminal and project entry points  |

| Acceptance (§5)                                    | Evidence                                                                 |
| -------------------------------------------------- | ------------------------------------------------------------------------ |
| Persists independently of AI processes / restart   | Engine test "keeps context across restarts…"                             |
| Works without orchestration; standalone workspaces | Engine and E2E tests (projects and repositories from terminals)          |
| Project and task context separated                 | Engine bundle and handoff tests; UI scopes                               |
| Bundles; revisions; source references              | Unit, Engine and E2E tests                                               |
| Claude → Codex and Codex → Claude handoffs         | Engine and E2E tests with fake CLIs; **real CLIs: manual check pending** |
| Ordinary sessions opt in; capture limits stated    | Start dialog (reviewed prompt), Sessions tab notice, SDD limitations     |
| Permissions respected                              | Engine isolation test; IPC authorization test                            |
| Automated tests pass                               | see below                                                                |

Validation (2026-10-20, macOS arm64, Node 24.18.0): `pnpm test` 559/559 (38 files);
`pnpm test:e2e` 57/57 in two consecutive runs; build ok (renderer 1,177 kB); typecheck,
lint, format and audit clean.

Staff review: no Critical or High findings. Low: the first message is regenerated when the
session starts, so it can differ from the reviewed preview if the repository changes in
between (documented).

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

Current revision (PLAN-012, version 0.7.1): `pnpm test` 545/545, `pnpm test:e2e` 53/53 in two
consecutive runs, renderer 1,125 kB; typecheck, lint, format and audit clean.

PLAN-011 (version 0.7.0): `pnpm test` 542/542, `pnpm test:e2e` 52/52 in two
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
