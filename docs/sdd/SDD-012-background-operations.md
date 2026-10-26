# SDD-012 — Background Operations & Task Scheduler

**Status:** Milestone A (background job manager) implemented (PLAN-040, v0.27.0, schema
v13). It is waiting for validation. Milestones B (scheduling and recovery) and C (integrations) have
not started; each needs its own plan after the previous milestone is validated.
**Priority:** High.
**Dependencies:** Engine, SQLite, Preflight, Notification Service, Project Registry,
Terminal Manager (unchanged), Git, Agent Orchestration and Shared Context (Milestone C).

Core principle: background operations are observable, controllable and recoverable without
a second execution engine. Jobs are a thin, persistent queue in front of the services that
already run things.

## Part I — Milestone A as implemented (PLAN-040)

### Decisions taken with the developer (2026-10-26)

- Approved by Anderson Andrade (Git `user.name`): "pode seguir com a implementação" for
  PLAN-040 revision 1, with its proposed defaults. Risks R1–R7 were presented with the
  plan: arbitrary commands, queue races, write volume, Preflight contention, two records
  per Preflight run, expectations about lifetime, and size.
- Q1: jobs left QUEUED or RUNNING by an Engine that stopped become INTERRUPTED; nothing
  restarts by itself. A manual retry is always possible (resume policies are Milestone B).
- Q2: defaults are 2 jobs at once and 1 per project, configurable in Operations → Limits.
- Q3: the CLI only reads jobs (`atlas jobs list`, `atlas jobs show`).

### Process lifetime (§2.4)

| Lifetime                  | What happens to jobs                                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| A view or panel closes    | Nothing: jobs belong to the Engine.                                                                                                  |
| A terminal tab closes     | Nothing: a job is never a terminal and never uses a PTY.                                                                             |
| The window closes (macOS) | Nothing: the Engine keeps running, as for terminals.                                                                                 |
| ATLAS quits               | The quit confirmation counts jobs. Queued jobs never start; running ones are stopped (process tree included) and become INTERRUPTED. |
| The Engine crashes        | On the next start, unfinished jobs become INTERRUPTED with "ATLAS stopped before the job finished."                                  |

Jobs do **not** survive a full shutdown: there is no daemon or system service. Ordinary
terminals are not affected by jobs in any way (FR-1214).

### Architecture

```text
 Renderer: Operations view, header indicator, Preflight "Run in background"
      │ preload `atlas.jobs` ─► main IPC (validates) ─► Engine host dispatcher `jobs.*`
      ▼
 JobService (packages/jobs) ── state machine, queue selection, limits, progress throttle
      │                       └─► SqliteJobRepository (migration v13)
      ├─ CommandJobExecutor ──► ShellPreflightExecutor.run (process tree, timeout, cancel)
      │                         LogBuffer + FilePreflightLogStore (<data>/jobs/logs)
      └─ PreflightJobExecutor ─► PreflightService.start / cancel / settled
      │
      ├─► terminals.publish({ type: 'jobs', job }) ─► renderer (lists, indicator)
      └─► NotificationService (BACKGROUND_TASK) for outcomes no service reports itself
```

- `packages/jobs` holds the model's behavior and its ports; it depends only on contracts and
  shared. Executors live in the Engine because they use Engine adapters.
- No new process manager, PTY, Git engine, Preflight engine or provider manager. COMMAND jobs
  reuse Preflight's shell executor; PREFLIGHT jobs call the Preflight service.
- GIT, AGENT, ATLAS_SESSION and INTEGRATION are reserved types without executors; creating
  one is refused until a milestone adds its executor.

### Job lifecycle (FR-1201, FR-1202)

```text
QUEUED ──► RUNNING ──► COMPLETED
  │           ├──────► FAILED ───────┐
  │           ├──────► CANCELLED ────┤ manual retry ─► QUEUED (new attempt)
  ├───────────┴──────► INTERRUPTED ──┘
  └──► CANCELLED
RUNNING ◄─► WAITING_APPROVAL (no executor uses it yet)
```

- Every change is validated (`JOB_TRANSITION_INVALID` otherwise) and appended to the status
  history with a short reason. COMPLETED is final; a retry is a new attempt of the same job.
- A job is COMPLETED only when its executor reports success: exit code 0 for a command, a
  PASSED run for Preflight. INCOMPLETE Preflight runs fail the job. Nothing is inferred.
- Progress has an optional percentage (null means indeterminate), a stage, a message and the
  time of the last activity. Any output counts as activity.

### SQLite schema (migration v13, FR-1204)

- `background_jobs`: type, status, priority, project (`ON DELETE SET NULL`), folder, title,
  origin, payload (JSON), progress (JSON), retry count, execution reference (JSON), error
  summary, exit code, cancel flag, and the created, queued, started and finished times.
  It has indexes on (status, queued_at), (project_id, created_at) and (created_at).
- `background_job_attempts`: one row per run (`job_id`, `attempt`), with its outcome and
  execution reference.
- `background_job_status_history`: every status change with time and detail.
- The migration is additive. As for every migration, an older ATLAS refuses to open a newer
  database ("created by a newer version"). Rolling back to 0.26.x therefore needs a copy of
  `atlas.db` taken before 0.27.0 first ran.
- Logs are files, never rows. A job's state is saved before it is dispatched, and a job
  whose RUNNING state cannot be saved fails instead of running.

### Queue and concurrency (FR-1205, FR-1206)

- FIFO by queue time; HIGH, NORMAL and LOW priorities go first in that order. A job that
  cannot start yet is passed over, so it never blocks other projects. It may be waiting
  because its project is at its limit, its resource is busy or its executor is not ready.
- Selection and registration are synchronous, so a job is never dispatched twice.
- Limits: `maxConcurrentJobs` (1–8, default 2) and `maxJobsPerProject` (1–8, default 1).
  Lowering a limit never stops running jobs or terminals.
- PREFLIGHT jobs hold their workspace (`preflight:<id>`). They also wait while a run started
  from the Preflight screen holds it, and they start when it ends.

### Cancellation and retries (FR-1207)

- A queued job is cancelled at once. A running job is asked to stop and stays RUNNING with
  `cancelRequested` until its executor reports the outcome; that report is what the user
  sees. Both executors stop their work: COMMAND stops the process tree, PREFLIGHT cancels
  the run.
- An executor may declare itself not cancellable; cancel is then refused
  (`JOB_NOT_CANCELLABLE`) and the action is not offered.
- Automatic retries do not exist yet (`maxRetries` is 0). A manual retry of a PREFLIGHT job
  drops the authorizations given when it was queued. Checks that need authorization on
  every run (side effects) then fail the retry instead of running unattended.

### Progress, logs and history (FR-1208–FR-1210)

- Progress is saved and published at most once per second per job.
- COMMAND output goes through Preflight's `LogBuffer`: redacted per line, private keys
  dropped, at most 20,000 lines and 4 MB per attempt. It is streamed while the job runs and
  saved to `<data>/jobs/logs/<jobId>/<attempt>.json` (mode 0600) when the attempt ends.
- PREFLIGHT jobs keep no log of their own: "Open result" shows the Preflight run, with its
  per-check logs.
- History is paged (newest first, `before` cursor). The 500 newest finished jobs are kept;
  older ones are removed with their logs.

### Notifications (FR-1228 subset)

- COMMAND jobs: completed (SUCCESS), failed (ERROR), interrupted (WARNING). A job the user
  cancelled is not reported. Each notification opens the job in Operations.
- PREFLIGHT jobs: Preflight's own run notification only, so there are no duplicates. An
  interrupted Preflight job is reported as interrupted.

### Interface (FR-1211–FR-1213)

- **Operations** (main navigation): Active (running, waiting, queued) and History, with
  project and status filters. The details panel shows the command, the timing, attempts,
  status history and the live log (with an attempt selector). Actions appear only when the
  executor and the job's state allow them: Cancel, Retry, Open result, Open project.
- **New command job**: project, command, optional name, timeout (1–1440 min) and priority.
  ATLAS warns when a command looks destructive or acts outside the computer, and the job is
  queued only after an explicit confirmation of the reasons it shows.
- **Header indicator**: "N running · M queued" while jobs exist, next to the notification bell;
  clicking it opens Operations.
- **Preflight → Run in background** queues the chosen profile after the same authorization
  dialog as a run started there.
- The quit confirmation lists background jobs.

### Security boundaries (§10)

- Only the desktop creates or changes jobs. The CLI and other socket clients can list and
  read them (`CLI_ENGINE_METHODS`).
- COMMAND jobs run only in a registered, available project folder that the Engine resolves.
  The renderer never sends a path. Before running, the Engine checks again that the project
  is still registered at the same folder.
- The command is the text the user typed. It runs through the user's shell with the user's
  rights; there is no sandbox or isolation, and the UI says what runs and where.
  Confirmation is required for destructive or external patterns: recursive deletion,
  discarding Git changes, force-push, `sudo`, disk writes and Preflight's external list.
  The list cannot be complete.
- Payloads are validated by strict schemas, again by the executor, and once more before
  execution. Preflight jobs need the same digest authorizations as Preflight.
- Logs and Engine logs never hold commands or paths; Engine logs record ids, types and
  statuses.

### Test evidence

- Unit (`packages/jobs/tests`, 25): transitions, FIFO, priorities, global and per-project
  limits, resources, readiness, no double dispatch with 12 simultaneous creates, queued and
  running cancellation, refused cancellation, no false cancellation, manual retry and
  simultaneous retries, progress throttle with a fake clock, references, save failures,
  shutdown, recovery, notifications, paging, settings.
- Persistence (`packages/persistence/tests/jobs.test.ts`, 8): history, attempts, paging,
  interruption, pruning, project removal, schema checks, migration v12 → v13.
- Engine integration (`apps/engine/tests/jobs.test.ts`, 16, real processes): command logs
  and redaction, no tokens in titles or notifications, a starting job's log, notifications, exit codes, retries, confirmation, process tree
  cancellation, concurrency, removed projects, interrupted recovery, Preflight jobs (run,
  workspace wait, cancel, no reused authorizations), and the read-only CLI scope.
- IPC (`apps/desktop/tests/ipc.test.ts`): validation, confirmation, settings. CLI: `jobs list`
  and `jobs show`. Quit warning wording.
- End-to-end (`tests/e2e/operations.spec.ts`, Linux Docker with Xvfb, full suite 97 passed and
  1 skipped):
  - Scenario B: command, log, indicator, notification.
  - Scenario D: confirmation, limits, cancellation.
  - Scenario A: Preflight in the background, Open result.
  - Scenario C: quit, restart, interrupted, Retry offered.
  - Scenario E (approval) needs an executor that asks for approval (Milestone C).

### Known limitations

- Jobs stop when ATLAS quits; there is no daemon.
- No scheduling, automatic retries, reusable definitions or resume policies (Milestone B).
- No Git, agent, session or integration executors; WAITING_APPROVAL is unused (Milestone C).
- Destructive-command detection is pattern based and incomplete.
- A Preflight job and its run are two records, linked by the execution reference.

## Part II — Specification (summary)

### Milestone A — Background job manager

FR-1201 job model · FR-1202 job service with validated transitions · FR-1203 executor
adapters over existing services · FR-1204 SQLite storage (jobs, attempts, status history,
execution references, indexes, persist before dispatch) · FR-1205 local FIFO queue with
priority, limits, queued cancellation and duplicate protection · FR-1206 global and
per-project concurrency without touching terminals · FR-1207 cancellation without false
confirmation · FR-1208 rate-limited progress (indeterminate allowed) · FR-1209 logs with
streaming, history, retention and redaction · FR-1210 job history · FR-1211 Operations
Center · FR-1212 actions limited to what is supported · FR-1213 header indicator ·
FR-1214 terminal independence; background execution is explicit.

### Milestone B — Scheduling & recovery

FR-1215 scheduling service (run now, once, after a delay, interval) · FR-1216 schedule model
(cron only with a validated library) · FR-1217 schedule configuration with next run time ·
FR-1218 missed executions: SKIP or RUN_ONCE_ON_STARTUP, no backlog · FR-1219 overlap:
SKIP_IF_RUNNING (default), QUEUE_NEXT, ALLOW_CONCURRENT · FR-1220 restart recovery without
assuming processes survived · FR-1221 retry policies; no automatic retries for irreversible
operations · FR-1222 reusable job definitions, one record per execution · FR-1223 scheduled
jobs only within previously authorized scopes.

### Milestone C — Integrations & automation

FR-1224 Preflight (scheduled) · FR-1225 Git operations (no scheduled push by default) ·
FR-1226 agents through the existing orchestration · FR-1227 account-aware execution ·
FR-1228 notifications · FR-1229 Project Hub task references · FR-1230 Shared Context
outcomes · FR-1231 a documented extension point for future modules.

### Out of scope

Distributed queues, external brokers, cloud workers, a mandatory system daemon, remote
scheduling, container management, HTTP API testing, extension hosting, a CI/CD platform,
and unattended destructive automation.
