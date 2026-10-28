# SDD-025 — Operations & Task Execution UX

Status: Task 01 implemented (PLAN-049 revision 1). Task 02 Milestones A and B implemented
(PLAN-053 revision 1). Milestone C (the ATLAS team option) is provided by SDD-026 Task 02
(PLAN-055) as a sequential minimal integration, since SDD-005 Milestone B does not exist.
Later tasks need their own plans.

## Task 02 — Unified task execution

Approved 2026-10-27 by Anderson Andrade ("pode seguir, q1 a q5 recomendado, ciente R1–R8").
Version 0.39.0, schema v20.

### Gaps found before planning

The specification assumed four subsystems that do not exist yet. Only the minimal
compatible integration was built.

| Assumed                         | Actual state                                                                 | Decision                                                         |
| ------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Project Hub tasks               | SDD-010 Milestone B not started                                              | **Q1:** shared-context tasks (`ContextTask`) are "the task"      |
| ATLAS multi-agent orchestration | SDD-005 Milestone B and SDD-004 Milestone B not started                      | **Q1:** Milestone C deferred; the ATLAS option is shown disabled |
| Provider router and accounts    | SDD-008 Milestones A and C not started                                       | **Q3:** existing wrapper check and usage account profiles        |
| Background operations for AI    | Task 01 classifies AI sessions as foreground; jobs are not tied to terminals | A dedicated execution record, not a job or a second queue        |

Other decisions:

- **Q2:** no acceptance-criteria field; the task's objective carries them.
- **Q4:** existing terminals only when zsh or bash and idle; the prompt line is cleared first.
- **Q5:** cancellation sends Ctrl+C.

### Entry points

In Context → Tasks, an open task offers **Execute…**:

- as a button;
- in its **More actions** (⋯) menu;
- in its right-click menu.

All three open the same dialog. The other task actions (Continue with Claude or Codex,
Prepare handoff, Mark done, Abandon, Reopen) are also in both menus.

### Execution modes

| Mode              | Terminal                                                                                                          |
| ----------------- | ----------------------------------------------------------------------------------------------------------------- |
| New terminal      | Created by the Terminal Manager in the task's project (or folder), with its environment, titled "Claude Code · …" |
| Existing terminal | An open terminal the user picks; checked again by the Engine when the run starts                                  |
| ATLAS team        | Disabled: "Multi-agent teams arrive with SDD-005 Milestone B"                                                     |

Both terminal modes:

1. build the context bundle for the task (the same selection the dialog previewed);
2. record a managed shared-context AI session for the terminal;
3. write the first message to a private file (mode 0600);
4. type `claude "$(cat '<file>')"` (or `codex …`). The task's text never becomes shell text.

When the user picks an account profile, the line starts with `CLAUDE_CONFIG_DIR='<dir>'`
or `CODEX_HOME='<dir>'` (PowerShell: `$env:…='<dir>';`). The default uses the CLI's own
account.

The terminal is then shown. Closing the dialog never affects an accepted run.

### Provider selection

- Providers are Claude Code and Codex, with the PLAN-014 wrapper check of the task's
  project or folder:
  - `wrapped`: available and tracked;
  - `shadowed` or `unknown`: available, but the run is recorded as **untracked** (warning
    shown);
  - `missing`: cannot be chosen, and the Engine refuses it (`TASK_EXECUTION_PROVIDER_UNAVAILABLE`).
- An unavailable provider is never preselected.
- Account profiles come from the usage profiles (SDD-008 Milestone B), filtered by provider,
  hidden ones excluded. Their status is informative; authentication is not checked.

### Terminal selection rules

An existing terminal can receive a task only when all of these hold (`blocker` is null):

| Check                                                 | Blocker             |
| ----------------------------------------------------- | ------------------- |
| The PTY is running                                    | `disconnected`      |
| It hosts no active task execution                     | `execution-active`  |
| It has no active shared-context AI session            | `ai-session-active` |
| Its shell is zsh or bash                              | `unsupported-shell` |
| Its foreground process is the shell itself (node-pty) | `busy`              |
| The platform reports a foreground process at all      | `process-unknown`   |

- Readiness never comes from terminal output.
- The dialog lists every terminal with its project, folder, shell and state; blocked ones
  cannot be chosen.
- The Engine repeats the checks when the run starts (`TASK_EXECUTION_TERMINAL_UNAVAILABLE`).
- **Project match:** a terminal of the task's project, or a terminal without project whose
  current folder is inside the task's folder. Any other terminal shows a warning naming its
  project and folder, and needs the checkbox "Run the task in this terminal anyway"
  (`acknowledgeOtherProject`). Without it the Engine answers
  `TASK_EXECUTION_CONFIRMATION_REQUIRED`.
- Before typing, ATLAS sends Ctrl+E, Ctrl+U: text left at the prompt is removed.

### Task, execution and terminal relationships

`task_executions` (migration v20) has one row per confirmation:

- task (removed with it) and owner (project or folder; it follows a removed project's
  folder, like the rest of the shared context);
- mode, provider, account profile id and name;
- terminal id and title (not a foreign key: history outlives terminals);
- the managed AI session and the wrapper run (`runRef`);
- status, exit code, end reason;
- created, started, ended, cancel-requested and reviewed times.

Further rules:

- **Duplicates:** `request_id` is unique. The dialog sends one id per confirmation, so a
  double click or a retry returns the same run. Starts are serialized in the Engine.
- **One active run per task:** a second start answers `TASK_EXECUTION_ACTIVE`.
- **Opening the terminal:** every execution has **Open terminal**. Notifications open the
  task.
- **Tab status:** the run uses the SDD-023 tab indicator (running, attention, failed),
  because it is a wrapper run in that terminal.

### Status transitions

```text
LAUNCHING ──wrapper start──▶ RUNNING ──exit 0──▶ REVIEW_REQUIRED
    │                           ├──exit ≠ 0 or unknown──▶ FAILED
    │                           ├──terminal ended──▶ INTERRUPTED
    │                           └──cancel, then end──▶ CANCELLED
    ├──no start within 60 s──▶ UNTRACKED
    ├──cancel──▶ CANCELLED
    └──typing failed──▶ FAILED (launch-failed)
untracked provider ──▶ UNTRACKED (from the start)
ATLAS restarted with LAUNCHING/RUNNING ──▶ INTERRUPTED (engine-restart)
```

- A finished status never changes again; late or repeated events are ignored.
- A start binds only to the oldest LAUNCHING run of the same terminal and provider.
- **Review:** **Mark reviewed** sets `reviewedAt` and also reviews the terminal's tab
  status. **Mark as reviewed** on a terminal also reviews its finished runs.
- **The task is never completed by a run.** It stays `open` until the user marks it done.
  The task card shows the latest unreviewed run's state.
- `BLOCKED` / "input required" is not detected (a permission prompt shows as running, as
  in SDD-023 Q1).

### Notifications

One notification per run that ends by itself, published once when its final status is
saved:

| Status          | Type            | Title                                          |
| --------------- | --------------- | ---------------------------------------------- |
| REVIEW_REQUIRED | ACTION_REQUIRED | "Claude Code finished a task: review required" |
| FAILED          | ERROR           | "Claude Code task failed" (with exit code)     |
| INTERRUPTED     | WARNING         | "Claude Code task interrupted"                 |

- Category `AGENT`, action `task-execution`. Opening it shows the task in Context → Tasks,
  after checking the task still exists.
- Cancellations, untracked runs, launch failures (shown in the dialog) and interruptions by
  an ATLAS restart do not notify.

### Recovery behaviour

| Situation                               | Behaviour                                                                     |
| --------------------------------------- | ----------------------------------------------------------------------------- |
| Missing project directory               | The context target cannot be resolved; nothing starts                         |
| Provider missing                        | Refused before any terminal is created                                        |
| Terminal disconnected or busy           | Refused with the reason; nothing typed                                        |
| Failed terminal creation or preparation | Error in the dialog; a terminal created for the run is closed                 |
| Typing failed                           | Execution FAILED (`launch-failed`), error in the dialog                       |
| Terminal closed during the run          | INTERRUPTED and notified                                                      |
| ATLAS quits or crashes                  | Active runs INTERRUPTED at the next start (terminals do not survive, ADR-013) |
| Provider exits non-zero                 | FAILED and notified                                                           |
| Cancel                                  | Ctrl+C twice (0.4 s apart); CANCELLED when the provider ends                  |

Failed runs are never re-run automatically; executing again needs a new confirmation.

### Contracts

- `TaskExecution`, `ExecuteTaskSchema`, `TaskExecutionOptions` (`packages/contracts/src/context.ts`).
- Engine methods (desktop only, not in the CLI):
  - `ai.taskExecutionOptions`
  - `ai.executeTask`
  - `ai.taskExecutions`
  - `ai.cancelTaskExecution`
  - `ai.reviewTaskExecution`
- The same five keys under `window.atlas.ai`.
- Event `{ type: 'task-execution', execution }`. Notification action `task-execution`.
- Error codes:
  - `TASK_EXECUTION_NOT_FOUND`
  - `TASK_EXECUTION_TERMINAL_UNAVAILABLE`
  - `TASK_EXECUTION_PROVIDER_UNAVAILABLE`
  - `TASK_EXECUTION_CONFIRMATION_REQUIRED`
  - `TASK_EXECUTION_ACTIVE`
  - `TASK_EXECUTION_INVALID_STATE`
- Services:
  - `TaskExecutionTracker` (`packages/context`): the lifecycle.
  - `TaskExecutionService` (`apps/engine/src/task-executions.ts`): validation, readiness,
    launch, cancel, review, notifications.
  - `SqliteTaskExecutionRepository`.
- `ai.start` now shares the launch preparation (`prepareAiLaunch`), without behaviour
  change. The wrapper check also works for folders without a project.

### Tests

- `packages/context/tests/task-execution.test.ts` (11): transitions, late and repeated
  events, start binding, launch timeout, untracked, terminal end, cancel, restart, shutdown,
  review, launch failure.
- `packages/persistence/tests/task-executions.test.ts` (6): storage, unique request id,
  active and unreviewed lists, cascade with the task, owner moved with a removed project,
  schema checks.
- `apps/engine/tests/task-execution.test.ts` (10, real SQLite, wrapper event files and zsh
  wrapper check; fake PTYs):
  - options and readiness;
  - a new-terminal run to review, with prompt file, idempotent repeat, single notification
    and terminal review;
  - existing terminal with line clearing, then reused after the run ends;
  - busy, unknown and disconnected terminals;
  - another project's terminal;
  - missing provider, foreign profile, closed task, another owner;
  - account profile prefix;
  - failure, cancellation and interruption with their notifications;
  - restart.
- `tests/e2e/task-execution.spec.ts` (3, Electron with a fake `claude` behind the real
  wrapper):
  - confirmation, preview and summary, then the run, review required, notification and
    Mark reviewed (the task stays open);
  - a busy terminal refused and another project's terminal used only after the checkbox;
  - a failed run notified, the notification opening the task and its terminal.
- `tests/e2e/security.spec.ts`: the new bridge keys.

### Known limitations

- **ATLAS team execution (Milestone C) is not available.** It needs the orchestration engine
  of SDD-005 Milestone B.
- Tasks are shared-context tasks; Project Hub tasks (SDD-010 Milestone B) do not exist.
- Deviation from the approved plan (step 6): the tab tooltip does not name the task. A new
  terminal is titled "Claude Code · <task>"; an existing terminal keeps its name, and its
  tab shows the run through the SDD-023 indicator only.
- When a run settles, its managed AI session ends automatically (Git evidence only), so the
  terminal can take another task; an untracked run's session ends when its terminal closes,
  and until then that terminal is reported as `ai-session-active`.
- Clearing the prompt line assumes emacs key bindings; a shell in vi mode, or with custom
  bindings, may keep the typed text (R1).
- Tracking depends on the ATLAS wrapper:
  - zsh/bash on macOS and Linux, not shadowed;
  - PowerShell and Windows runs are untracked.
- "Input required" is not detected; a provider waiting for an answer shows as running.
- If the user starts the same provider by hand in that terminal before the typed command
  starts, that run may be the one linked (R5).
- Profiles are not authenticated by ATLAS; an unauthenticated profile shows the CLI's login.
- A provider that ignores Ctrl+C stays RUNNING (cancelling) until it ends or the terminal is
  closed.
- The real Claude Code and Codex CLIs were not exercised automatically (fake executables),
  as for SDD-005.

## Task 01 — Non-blocking background operations

Approved 2026-10-27 by Anderson Andrade ("aprovo PLAN-049 rev 1, q1–q3 recomendado, ciente
R1–R5"). Version 0.35.0. No schema change: the `background_jobs.type` column already
allowed `GIT`.

### Decisions (Q1–Q3)

- **Q1:** only push, pull and fetch are migrated. Everything else follows the
  classification below.
- **Q2:** GIT jobs do not wait for, or count toward, the job concurrency limits. The Git
  coordinator already serializes Git operations per repository.
- **Q3:** after a submission, an inline notice in the Git view and in the Pending push
  section reads "… started in the background · View in Operations".

### Classification of modal actions (FR-001)

| Action                                                                                       | Class                  | Result                                                           |
| -------------------------------------------------------------------------------------------- | ---------------------- | ---------------------------------------------------------------- |
| Push, Pull (dialogs); Fetch (Actions menu)                                                   | Background-capable     | **Migrated** to `GIT` jobs                                       |
| Push from the Pending push section                                                           | Background-capable     | **Migrated** (same Push dialog)                                  |
| Commit, with an optional push                                                                | Background-capable     | Unchanged: already handed to the Git operations panel (PLAN-030) |
| Command jobs, Preflight "Run in background"                                                  | Background-capable     | Unchanged: already jobs (SDD-012)                                |
| Preflight run from its view                                                                  | Background-capable     | Unchanged: already owned by the Engine, with its own view        |
| Merge, cherry-pick (continue, skip, abort)                                                   | Foreground interaction | Unchanged: conflicts need the user                               |
| Start an AI or ATLAS session                                                                 | Foreground interaction | Unchanged: opens an interactive terminal                         |
| Branch create/switch/rename, Docker actions (local images only), skill import, project forms | Short synchronous      | Unchanged                                                        |

### Submission and lifecycle

1. The dialog keeps its confirmation unchanged, for example the Push destination
   (remote/branch).
2. On confirmation, the renderer calls `jobs.create({ type: 'GIT', action, repositoryRoot, … })`.
3. The `GitJobExecutor.prepare` step accepts nothing it would refuse later:
   - The repository must be one the Engine resolved itself.
   - The action is validated like the direct action: `preparePush` (branch, upstream,
     configured remote), `preparePull` (branch, upstream, no merge in progress) and
     `prepareFetch` (configured remote).
   - A refusal leaves the dialog open with its message.
4. The job is saved as QUEUED and its id is returned. Only then does the dialog close and
   show the notice.
5. The job runs `GitWorkspaceService.push/pull/fetch`, the same code as before:
   - same coordinator lanes, Git `pre-push` hooks and shell environment;
   - same operation log and notification;
   - never forced.
   - The job records the Git operation as its `executionReference` (`git-operation`).
   - Progress shows Git's percentage when Git reports one, otherwise "indeterminate". It
     is never invented.
6. Output comes from the Git operation log: each command, its standard output and
   standard error (credentials removed, tail-limited), its exit code and the operation
   outcome.
7. Duplicate submission:
   - The button is disabled while the request is pending.
   - The Engine refuses a second push, pull or fetch for the same repository while one is
     queued or running (`duplicateKey`). This also holds for two simultaneous requests.
   - Different actions on the same repository wait for each other (`resourceKey`).

Closing the dialog, switching projects, terminals or sections, unmounting the Git view,
and reloading the renderer have no effect on the job: it belongs to the Engine.

### Operations, navigation and notifications

- The job appears in the Operations view and in the header indicator with:
  - its title (e.g. "Push main → origin/main");
  - its project;
  - status, start time and duration;
  - progress;
  - log, result and error.
- Its details show `git push · <repository>` and an **Open in Git** action, which opens the
  repository's Git operations.
- **View in Operations** in the notice opens the job.
- Notifications: the executor declares `notifiesOutcome`, so the Git operation's
  notification is the only one, with no duplicate job notification. It opens the
  repository's Git operations.

### Cancellation

- A queued GIT job can always be cancelled.
- A running **fetch** can be cancelled: the coordinator stops its process tree.
- A running **push** or **pull** cannot be cancelled. Stopping it midway is unsafe, as it
  already was in the dialog. The job offers no Cancel action, and `jobs.cancel` answers
  `JOB_NOT_CANCELLABLE`.
- Closing a dialog is never treated as cancellation.
- GIT jobs are never retried, manually or automatically.

### Application shutdown

Jobs do not survive ATLAS.

- When ATLAS quits, queued GIT jobs become INTERRUPTED.
- A running fetch is cancelled.
- A running push or pull gets the same bounded time Git operations already had
  (`GIT_SHUTDOWN_TIMEOUT_MS`). If it has not finished by then, the job is recorded as
  INTERRUPTED ("ATLAS quit while the job was running.") and the coordinator stops waiting.
- ATLAS never claims an operation continued after it exited.

### Supporting changes

- **`JobExecutor`** gains optional settings, all off by default, so existing executors
  behave as before:
  - `isCancellable(job)`
  - `retryable`
  - `exemptFromLimits`
  - `duplicateKey(payload)`
- **Queue selection:** exempt jobs skip the global and per-project limits but still
  respect resources. They take no slot from limited jobs.
- **`GitOperationCoordinator.run`:** accepts a per-operation observer.
- **`GitWorkspaceService`:** gains `preparePush`, `preparePull` and `prepareFetch`, and an
  optional observer on push, pull and fetch.

### Tests

- `packages/jobs/tests/jobs.test.ts`:
  - exempt queue selection;
  - duplicate refusal, including two simultaneous submissions;
  - no retry for non-retryable executors;
  - per-job cancellation;
  - exempt jobs start while the project is at its limit.
- `apps/engine/tests/git-jobs.test.ts`, with real Git:
  - a push accepted, completed, logged and listed with Git operations, with a single
    notification;
  - invalid submissions accept nothing (detached HEAD, unknown remote, unknown repository);
  - a pre-push hook failure and a rejected push fail the job, which cannot be retried;
  - pull and fetch;
  - a duplicate push refused;
  - a queued fetch cancelled;
  - a running push not cancellable;
  - a push still running at shutdown is recorded as interrupted.
- `tests/e2e/background-operations.spec.ts`:
  - the dialog closes once the push is accepted;
  - the notice appears;
  - navigating and reloading the renderer leave the push running;
  - Operations shows status, log and no Retry;
  - the notification is delivered;
  - a failing pre-push hook shows a failed job reached through **View in Operations**;
  - a detached HEAD keeps the dialog's refusal.
- `tests/e2e/git.spec.ts`: Pull now waits for the background job.

### Known limitations

- The Git operation's notification opens the Git view's operations panel, not the
  Operations view; **Open in Git** links the two.
- A push or pull cannot be cancelled once it runs, the same as before.
- Errors of an accepted push (rejected, authentication) are no longer shown in the dialog.
  They appear in the notification, the Git operations panel (which opens by itself on
  failure in the Git view) and the job.
- An SSH key passphrase without an agent can still wait until the network timeout, as
  before. HTTPS prompts are disabled (`GIT_TERMINAL_PROMPT=0`).
- The submission notice is kept in memory by the view that showed it. Operations keeps the
  job.
