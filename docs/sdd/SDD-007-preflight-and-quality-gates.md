# SDD-007 — Preflight, Local CI & Quality Gates

**Status:** Milestone A implemented (PLAN-028, v0.21.0, schema v10) — awaiting approval.
Milestones B (quality gates and Git integration) and C (AI auto-fix) not started.
**Dependencies:** SDD-001 through SDD-006 and SDD-008 where implemented.

Core principle: a validation result is only valid for the exact code state and execution
environment it actually checked. Preflight never needs an AI provider.

## Part I — Milestone A as implemented (PLAN-028)

### Decisions taken with the developer (2026-10-23)

- Only Milestone A; B and C need their own plans after A is validated.
- Jobs that need secrets are **blocked**. No secret mapping or secure secret storage exists
  yet (a later revision may use Electron `safeStorage`).
- The pre-commit steps of PLAN-009 are unchanged; Milestone B is expected to fold them into
  quality gates.
- No entry point from agent views: they do not exist yet (SDD-005 B).
- Acknowledged risks: R1 (checks run project code on the computer, unsandboxed) and R2
  (act downloads images and actions; Docker does not fully isolate the host).

### Workspaces

A workspace is a registered project's folder or a folder chosen in the native picker
(`preflight-workspace` purpose). Requests name workspaces, checks and runs by id; the
renderer cannot name a folder by itself. Working folders are resolved through links and a
check whose folder resolves outside the workspace is blocked. When a project is removed its
workspace stays as a folder workspace with its history. Removing a workspace deletes its configuration,
authorizations, history and logs, never the folder.

### Checks and profiles (FR-701 – FR-705)

| Field                                | Meaning                                                                                                             |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `type`                               | `COMMAND`, `PACKAGE_SCRIPT` or `GITHUB_ACTIONS`                                                                     |
| `category`                           | Lint, type check, unit/integration/E2E tests, build, formatting, security, Git diff, …                              |
| `workingDirectory`                   | Relative to the workspace; `..`, absolute paths and links outside it are refused                                    |
| `command`                            | `COMMAND`: one line, run by the user's shell as typed                                                               |
| `packageManager`, `script`           | `PACKAGE_SCRIPT`: `<npm\|pnpm\|yarn> run '<script>'` (the name is quoted)                                           |
| `workflowPath`, `workflowJob`, `act` | `GITHUB_ACTIONS`: workflow, optional job, event, matrix filters, runner images, architecture, CPU and memory limits |
| `required`                           | Required or advisory                                                                                                |
| `enabled`, `timeoutSeconds`          | 5 s – 6 h                                                                                                           |
| `executionTriggers`                  | Stored; Milestone A runs checks manually only                                                                       |
| `dependsOn`, `exclusive`             | Order and gating within a run; cycles refused; act checks always run alone                                          |
| `requiredTools`                      | Executables that must be on PATH, otherwise the check is `BLOCKED`                                                  |
| `env`                                | Plain-text variables; names that look like secrets are refused                                                      |

Profiles are named, ordered sets of checks with a concurrency (1–8). Their names imply
nothing; the developer chooses what each contains. Up to 50 checks and 20 profiles.

### Discovery (FR-703, FR-706)

Only files are read: `package.json` scripts (servers, watchers and lifecycle hooks are left
out), the package manager (`packageManager`, lockfiles), Make targets, Gradle (`gradlew`,
`build.gradle[.kts]`) and Maven (`pom.xml`, `mvnw`) standard commands, and
`.github/workflows/*.yml|yaml` (up to 50 files of 512 KB; YAML aliases limited). Nothing
is executed; suggestions become checks only when the developer adds them.

### Workflow compatibility and side effects (FR-709, FR-710)

Per job, from the file only:

- `UNSUPPORTED`: self-hosted runners; only macOS or Windows runners.
- `PARTIALLY_COMPATIBLE`: reusable workflows, `needs`, service containers, secrets (blocked
  at run time), hosted artifacts and caches, deployment environments, runner lists mixing
  Linux and other systems (use a matrix filter).
- `UNKNOWN`: runners that cannot be determined (expressions without a literal matrix,
  unknown labels), unreadable files.
- `COMPATIBLE`: a Linux runner and none of the above. `act` may still fail; the result says
  where it ran.

Side effects are found in what steps do, not in names: package publishing, image pushes,
releases, `git push`, Terraform/Pulumi/CDK, Kubernetes and Helm changes, cloud CLIs,
deployment CLIs, database migrations, network writes (`curl -X POST`, `--data`), remote
shells, cloud credential and release actions, `environment:`, write permissions. The same
command patterns are applied to `COMMAND` checks and package script bodies. The lists cannot
be complete; the UI says so.

### Authorization (§13)

`preflight.plan` returns, per check, what runs, a SHA-256 digest of its definition (command,
script body and the `pre`/`post` hooks npm runs around it, workflow file and act settings,
variables, folder) and why it needs
authorization: `FIRST_RUN`, `CHANGED`, or `SIDE_EFFECTS` (asked on every run). The UI shows
the warnings (not sandboxed, actions downloaded, containers, act configuration files such as
`~/.actrc`) and the developer authorizes. `preflight.start` refuses a run unless every check
that needs it was authorized with its current digest. Before each check starts, its digest is
computed again; a check whose files changed after authorization is `BLOCKED`. Blocked and
unsupported checks need no authorization because nothing runs.

### Execution (FR-707, FR-713 – FR-716)

- Only the Engine host runs checks (the CLI cannot call Preflight).
- Commands and package scripts: the user's shell (login shell on macOS) with the terminal
  environment and `CI=1`, exactly like typing them in a terminal: **not sandboxed**.
- act: started without a shell, with a minimal environment (PATH, HOME, user, locale,
  Docker variables), empty secret, variable, input and `.env` files, no Docker socket in job
  containers (`--container-daemon-socket -`), `--rm`, optional `--container-options
"--cpus=N --memory=Mm"`. act and Docker are detected (`act --version`, `docker version`),
  never installed; their availability is cached for 30 s.
- Every check runs in its own process group: timeouts and cancellation stop the whole tree
  (SIGTERM, then SIGKILL; `taskkill /t` on Windows). The process code is shared with the
  pre-commit steps (`process-tree.ts`).
- Statuses: `PASSED` only on exit code 0; `FAILED`; `TIMED_OUT`; `CANCELLED`; `SKIPPED` (a
  dependency did not pass); `BLOCKED` (not authorized for the current files, missing tool,
  act or Docker unavailable, secrets needed, missing script or folder); `UNSUPPORTED`.
- Run status: `PASSED` only when every check passed; `FAILED` when one failed or timed out;
  `INCOMPLETE` when nothing failed but something did not run; `CANCELLED`. The verdict over
  required checks is kept separately (`requiredOutcome`) for Milestone B.
- One run per workspace at a time. Runs left running by a stopped Engine are cancelled on
  the next start.

### Code state (FR-713)

Each run records HEAD, the branch and a fingerprint of the repository: SHA-256 over HEAD,
`git diff --cached --binary`, `git diff --binary` and the untracked, non-ignored files
(names, sizes and content up to 5,000 files of 50 MB). It is computed again at the end;
`sourceChangedDuringRun` warns when the code changed meanwhile. Only read-only Git commands
run, without optional locks. Not covered: ignored files, build output, the environment,
installed dependencies outside the repository. In Milestone A the fingerprint only informs;
it authorizes nothing.

### Logs and reports (FR-717)

Output is split into lines, redacted line by line with the Git credential redaction (URL
credentials, tokens, `KEY=value` secrets, authorization headers, private keys — dropped from
their first line to their last), and limited to 20,000 lines and about 4 MB per check (the
newest kept; the log says when older lines were dropped). Logs are stored as files in
`<data>/preflight/logs/<run>/<position>.json` (0700/0600) and deleted with their run; the
newest 100 runs per workspace are kept. The Engine log records each run's start and end
(ids, status and counts only; no commands or paths). The UI polls the output every second and offers
search, an errors-only filter, copy, and a Markdown report (copy, or save through the native
save dialog). The report states that it is not a GitHub-hosted CI result.

### API (Engine methods, IPC `atlas:preflight:*`)

`workspaces`, `openProject`, `addFolder` (picker only), `removeWorkspace`, `workspace`,
`saveConfig`, `discover`, `environment`, `plan`, `start`, `cancel`, `runs`, `run`,
`output`, `report`. `app.saveText` writes a file only where the user chose in the save
dialog, with a plain suggested name.

### Data model (schema v10, additive)

- `preflight_workspaces`: id, unique path, project id, name, configuration (JSON), times.
- `preflight_authorizations`: workspace, check id, digest, time.
- `preflight_runs`: id, workspace, project, path, profile, trigger, status, required
  outcome, revision, branch, fingerprint, changed flag, retry of, times, results (JSON).

### UI

Sidebar **Preflight**; also from project details, the Git view header, the terminal context
menu (**Run Preflight**, for the terminal's project) and session details (sessions with a
project). Tabs: Run (profile or selected checks; the current run follows the running check,
then the first one that did not pass), Checks (with discovered suggestions), Profiles,
Workflows (compatibility, reasons, side effects), History.

### Acceptance (Milestone A)

| Criterion                                   | Evidence                                                              |
| ------------------------------------------- | --------------------------------------------------------------------- |
| Works without AI accounts                   | No provider is used; E2E runs without any                             |
| Custom commands execute                     | Engine tests with `/bin/sh`; E2E                                      |
| Package scripts discovered                  | Unit tests; E2E                                                       |
| Profiles persist                            | Engine test across a restart; E2E                                     |
| Workflows discovered                        | Unit tests; E2E                                                       |
| Compatible workflows run through act        | Fake `act` (argument and environment checks); **no real act run yet** |
| act and Docker detected                     | Adapter tests; E2E shows "act: not installed"                         |
| Unsupported workflows reported              | Unit tests; E2E                                                       |
| Dangerous workflows need authorization      | Unit tests (`SIDE_EFFECTS` every run); E2E                            |
| Logs stream; cancellation and timeouts work | Engine tests (process trees); E2E                                     |
| Results persist                             | Repository and Engine tests                                           |

### Known limitations

- Local commands are not sandboxed and see the terminal environment (cloud credentials in
  variables included), like a terminal. Docker is not a full isolation boundary.
- act was validated only with a fake binary; real act runs need `act` installed by the
  developer. On Apple silicon act usually needs `linux/amd64` emulation (slow).
- Secrets are not supported; jobs referencing them are blocked.
- Side-effect detection is a pattern list; a script may call another file that publishes.
  The digest covers the command or script body and workflow file, not every file they run.
- Resource limits apply to act containers only; local commands have none.
- Triggers other than manual are stored but not used until Milestone B.

## Part II — Original specification

The full specification (FR-701 – FR-743, scenarios A–E, Milestones B and C) is the one
provided by the developer on 2026-10-23 for PLAN-028. Milestones B and C are to be planned
separately; scenario E (stale-result protection) belongs to Milestone B and must not pass
by reusing Milestone A fingerprints as authorization without its own design.
