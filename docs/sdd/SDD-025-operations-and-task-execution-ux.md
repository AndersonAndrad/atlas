# SDD-025 — Operations & Task Execution UX

Status: Task 01 implemented (PLAN-049 revision 1). Later tasks need their own plans.

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
