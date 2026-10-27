# SDD-024 — Git Intelligence & Project Sync

Status: Task 01 (PLAN-047), Task 02 (PLAN-048) and Task 03 (PLAN-051) implemented. Later
tasks need their own plans.

## Task 01 — Per-project Git monitoring and status badges

Approved 2026-10-27 by Anderson Andrade ("aprovo e q1 a q3 recomendado"). Version
0.33.0, schema v17.

### Decisions (Q1–Q3)

- **Q1:** new projects are monitored by default. Settings → Git → "Monitor the Git status
  of new projects automatically" changes this default. The change only applies to projects
  registered afterwards.
- **Q2:** the terminal header keeps its live Git status, even in a paused project. A
  terminal is active use, and terminal behavior is out of scope.
- **Q3:** a monitored project's details still read the full live status: identity, local
  and recent branches. A paused project shows its stored subset until Refresh.

### Data (migration v17)

- `projects.git_monitoring_enabled`: `INTEGER NOT NULL DEFAULT 1`. Existing projects keep
  being monitored, so current behavior is preserved.
- `project_git_snapshots`: one row per project, `ON DELETE CASCADE`.
  - The last successful status: state (`repository` / `not-repository`), branch,
    detached/unborn HEAD, upstream, ahead/behind, upstream gone, change counts and
    `refreshed_at`.
  - The last failed refresh: `error_reason` and `error_at`. A failure never replaces the
    last good snapshot.
- Never stored: Git identity, file names, branch lists, file contents.
- Rollback: older ATLAS versions refuse schema v17. Keep a database copy taken before
  0.33.0 first runs.

### Monitoring behavior

`ProjectGitMonitor` (`packages/git/src/project-monitor.ts`) sits on top of the existing
`GitInspectionService` and `RepositoryWatcher`. It is not a second engine.

- **Disabled projects.** They are never scheduled or watched by monitoring. Disabling a
  project:
  - stops its watcher;
  - drops queued work;
  - discards a running automatic result, using a per-project generation counter.
- **Enabled projects.** Their schedule adapts:
  - The interval starts at 30 s.
  - It doubles while nothing changes or Git fails, up to 120 s.
  - It returns to 30 s, with an immediate check, after any of these:
    - a `.git` watcher notification;
    - a command finishing in a terminal of that repository;
    - a file saved from the editor.
- **Running refreshes.** One refresh per project runs at a time, and other callers share
  it. At most 2 automatic refreshes run at once. The inspection service already limits
  Git processes to 4.
- **The periodic watcher refresh** (every 30 s) still refreshes clients such as terminal
  headers and the Git view. It no longer drives project monitoring.
- **Lifecycle:**
  - Monitoring starts only in the desktop Engine host. The CLI's Engine never polls.
  - Engine shutdown stops the timer, and late results are ignored.
  - Removing a project forgets it, and the snapshot is cascaded away.
  - Changing a project's folder clears its snapshot.
- **Never done:** fetch, pull, push, commit or any write to the repository.
- **Explicit reads** run Git whatever the preference: Refresh Git status, `git.project`
  (project details while monitored, `atlas project show`) and the Git view's repository
  discovery. They update the snapshot but do not start watching a paused project.

### Contracts

- `ProjectGitState`: `monitoringEnabled`, `freshness` (`live` / `cached` / `none`), the
  snapshot, `refreshedAt` and `error`.
  - `live`: monitored, refreshed by ATLAS since it started, and the last check succeeded.
  - `cached`: everything else that has a snapshot. This includes paused projects, failed
    checks, and the time after a restart before the first check.
- Engine methods:
  - `git.projectStates()`: reads SQLite only, never Git.
  - `git.refreshProject(id)`: returns the stored state and the full status just read.
  - `git.setProjectMonitoring(id, enabled)`.
- `GitPreferences.monitorNewProjects` (default `true`).
- Event: `{ type: 'project-git', state }`.

### Badges (FR-006)

`ProjectGitBadge` appears in the Terminals sidebar and on the Projects cards. It reads a
renderer store shared by all views, filled by one request plus `project-git` events.
Rendering a badge never runs Git.

| State     | Rule                                                           | Look                            |
| --------- | -------------------------------------------------------------- | ------------------------------- |
| attention | changed files (incl. untracked, conflicts) or commits ahead    | yellow, dot icon, changed count |
| clean     | repository with nothing to commit or push                      | subdued, check icon             |
| unknown   | no snapshot, not a repository, or Git unavailable with no data | dashed outline, question icon   |
| cached    | any snapshot that is not live                                  | clock icon and reduced opacity  |

- Commits behind are not an attention reason. They stay in the separate ↑/↓ chips.
- Every badge has an accessible name and a tooltip. The text states the summary, branch,
  live or cached with the update time, a failed refresh and a paused monitor.

### Git details (FR-007)

- The project details Git section shows:
  - the "Monitor Git status automatically" switch;
  - a Live / Cached / No data yet badge;
  - the last refresh time;
  - the last refresh error.
- Refresh reads Git now, whatever the preference.
- The project actions menu adds "Refresh Git status" and "Pause / Resume Git monitoring".

### Tests

- `packages/git/tests/project-monitor.test.ts` (18 tests):
  - disabled projects are never inspected;
  - disabling and enabling;
  - manual refresh while paused;
  - an error keeps the snapshot;
  - not a repository, no upstream, unavailable folder;
  - single-flight;
  - stale results are discarded, and never handed to a later manual refresh;
  - a repository shared by two monitored projects stays watched when one is paused;
  - a change during a running refresh is checked again on the next tick;
  - adaptive backoff and resets;
  - 200 projects never exceed 2 concurrent refreshes;
  - removal and folder change;
  - the new-project default;
  - close;
  - nothing runs before start.
- `packages/persistence/tests/project-git.test.ts` (6 tests):
  - v16 → v17 migration;
  - persistence after reopening;
  - an error keeps the snapshot;
  - unknown projects;
  - cascade;
  - clearing.
- `apps/engine/tests/project-git-monitoring.test.ts` (4 tests, real Git):
  - the new-project default;
  - manual refresh while paused, with the snapshot surviving an Engine restart;
  - a folder without Git;
  - a folder change and removal.
- `apps/desktop/tests/project-git-badge.test.ts` (7 tests): badge states, cached and
  paused labels, missing upstream, behind-only, unknown and errors.
- `tests/e2e/git-monitoring.spec.ts`:
  - a live attention badge;
  - pausing keeps a cached badge;
  - no background update while paused;
  - Refresh from the menu;
  - the cached badge after a restart;
  - Resume;
  - the new-project default from Settings.

### Known limitations

- Opening the Git view still inspects every project once to list repositories. Paused
  projects are not watched afterwards.
- `RepositoryWatcher` watches at most 32 repositories. Beyond that, monitored projects rely
  on the adaptive schedule alone.
- An edit made outside ATLAS in an idle monitored repository can take up to 120 s to show.
  Refresh shows it at once.
- A refresh made from the CLI while the desktop app runs updates the database, but no
  event reaches the window until its next refresh.
- After resuming monitoring, the terminal header of a paused project's repository may need
  a directory change before it is watched again.

## Task 02 — Pending Push sidebar

Approved 2026-10-27 by Anderson Andrade: "aprovo PLAN-048 rev 1, q1–q3 recomendado, ciente
R1–R6". Version 0.34.0, schema v18.

### Decisions (Q1–Q3)

- **Q1:** a collapsible **Pending push** section in the Terminals sidebar, below Projects.
- **Q2:** projects with nothing to push are hidden. A footer counts them as "up to date".
- **Q3:** up to 50 commits are stored per project. **Load more** reads further pages live.

### Detection

- The status inspection now keeps the HEAD commit (`headOid`, from `# branch.oid`).
- When a tracking branch is ahead of its upstream, ATLAS runs
  `git log --max-count=50 -z --format=%H%x1f%h%x1f%an%x1f%aI%x1f%s <branch>@{upstream}..<headOid> --`:
  - It uses Git's commit graph, so diverged branches list only their local commits.
  - The range is pinned to the inspected branch and commit, so a list never mixes branches.
  - Arguments only, no shell, `--no-optional-locks`, read-only.
- Git runs only when commits are ahead **and** something changed since the stored list was
  read: branch, HEAD, upstream, ahead or behind. Otherwise the stored list is reused.
- With nothing ahead, no `git log` runs.
- The collection lives inside the Task 01 refresh:
  - same concurrency limits and single-flight;
  - paused projects are never collected in the background;
  - no new polling.

### States

| State           | Meaning                                                | Shown as                           |
| --------------- | ------------------------------------------------------ | ---------------------------------- |
| `ok`            | upstream known; the list is reliable (as of the fetch) | commits, or "up to date" (hidden)  |
| `no-upstream`   | branch without upstream                                | "Upstream not configured"          |
| `upstream-gone` | upstream configured, remote-tracking branch missing    | "Upstream branch no longer exists" |
| `detached`      | detached HEAD                                          | "Detached HEAD"                    |
| `unborn`        | repository without commits                             | hidden                             |
| `error`         | `git log` failed (the status snapshot is still stored) | "Could not read pending commits"   |

An empty list is shown as "up to date" only in the `ok` state.

### Snapshot behavior (migration v18)

- `project_git_snapshots` gains two columns:
  - `head_oid`;
  - `pending`: JSON with the state, up to 50 commits (full and short hash, subject, author
    name, author date) and the total ahead.
- Both are written in the **same statement** as the status. A stored list therefore always
  belongs to the stored branch, upstream, HEAD and refresh time.
- Switching branches replaces the list in that write.
- Snapshots stored by 0.33.0 read as "pending not collected" until their next refresh.
- Author e-mails are not stored.

### Interface

- The section header shows the total. Each project group is collapsible and shows:
  - the count;
  - `branch → upstream`;
  - Live or Cached with the update time, and whether monitoring is paused;
  - a refresh button.
- Each commit shows its subject, short hash, author and relative date.
- Selecting a commit opens its message and files through the existing `git.commitFiles`
  panel. There is no new diff engine.
- **Load more** reads the next 50 live (`git.pendingCommits`). The page carries its branch and
  commit. If they no longer match the stored list, the user is asked to refresh.

### Push

- Push reads the live working tree (an explicit action) and opens the existing Push dialog.
  The dialog shows the remote and branch and requires confirmation.
- The push itself is unchanged:
  - Git `pre-push` hooks run;
  - it is a Git operation (Operations sheet, notifications);
  - it never forces.
- Stage, commit and push made by ATLAS now refresh project monitoring at once.
- A successful push from the section also refreshes that project explicitly, which updates
  paused projects too.

### Tests

- `packages/git/tests/project-monitor.test.ts`:
  - identity of the stored list;
  - reuse while unchanged;
  - branch switch;
  - nothing ahead;
  - no upstream, upstream gone, detached, unborn;
  - `git log` failure;
  - Load more.
- `apps/engine/tests/project-git-monitoring.test.ts`, with real Git:
  - three unpushed commits in order, persisted across an Engine restart;
  - a clean branch;
  - diverged branches;
  - no upstream, detached, upstream deleted, and switching back without mixing;
  - a repository without commits;
  - 55 commits with Load more;
  - a pre-push hook failure, a rejected (non-fast-forward) push and a successful push.
- `packages/persistence/tests/project-git.test.ts`: v17 → v18 and the round trip with
  commits.
- `apps/engine/tests/git-porcelain.test.ts`: `headOid`.
- `tests/e2e/pending-push.spec.ts`:
  - three commits;
  - "Upstream not configured";
  - commit details;
  - Push with confirmation, after which the list empties.

### Known limitations

- Pending commits are relative to the last fetch. ATLAS never fetches, so commits already on
  the remote may still be listed until the next fetch.
- Only the first 50 commits are stored. More are read on request.
- A refresh made outside the desktop app (CLI) reaches the window only on its next refresh.
- Rolling back to 0.33.x needs a database copy taken before 0.34.0 first ran (schema v18).

## Task 03 — Git identity management

Approved 2026-10-27 by Anderson Andrade ("pode seguir, q1 a q3 pode seguir com o
recomendavel"). R1–R5 were presented but not acknowledged by ID. Version 0.37.0. No schema
change: the identity lives in Git's own configuration.

### Decisions (Q1–Q3)

- **Q1:** an email without "@" is accepted (Git accepts it); the window shows a warning.
- **Q2:** environment overrides are detected in the shell environment new terminals get. This
  is the same environment the commit flow reads.
- **Q3:** the global identity is in Settings → Git. The project identity is in the project
  details, **Commit checks** tab.

### Behavior

- `GitIdentityService` (`packages/git/src/identity.ts`) runs `git config` through the Git
  executor: no shell, arguments only, no prompts.
  - **Global:** read with `config -z --global --show-origin --get`, written with
    `config --global user.name|user.email`. Only on Save.
  - **Effective, per project:** `config -z --show-scope --show-origin --get` in the project's
    repository, so Git applies its own precedence: local, worktree, includes and
    `includeIf`, global, system and command line. The UI shows the value, its scope and the
    file it came from, including an included file such as `~/.gitconfig-work`.
  - **Local overrides:** read with `config -z --local --get`. Written with
    `config --local …`, or removed with `--unset-all`, where exit code 5 (nothing to remove)
    is not an error.
- **Which repository is written:** the Engine resolves it from the project id. Its folder
  must be available and be a Git repository; otherwise `GIT_REPOSITORY_UNAVAILABLE`. Clients
  never pass a path. Local values apply to the whole repository and its worktrees, and the
  UI names the repository.
- **Environment:** `GIT_AUTHOR_*`, `GIT_COMMITTER_*`, `EMAIL` and `GIT_CONFIG_*` in the shell
  environment of new terminals are reported, because they change commits made in terminals.
  ATLAS's own commits never inherit `GIT_*` variables: the Git executor removes them. They
  therefore use the configured identity.
- **Validation:**
  - Names: 1–200 characters after trimming; no control characters, `<` or `>`.
  - Emails: 1–254 characters; no whitespace, control characters, `<` or `>`.
- **Failures:** a broken or locked configuration file gives `GIT_CONFIG_FAILED` with a short
  message; nothing is partially written by ATLAS. A broken repository configuration makes the
  repository unreadable, so the project's identity reports `GIT_REPOSITORY_UNAVAILABLE`.
- **Safety:** commits are never created, amended or rewritten. Opening a project or Settings
  only reads.
- **After a save:** the Engine drops cached Git status and tells clients, so the Git details
  show the new identity.

### Contracts

- Engine methods:
  - `git.globalIdentity`
  - `git.setGlobalIdentity({ name, email })`
  - `git.projectIdentity(projectId)`
  - `git.setProjectIdentity(projectId, { name?, email? })`, where `null` removes an
    override and an absent field leaves it.
- Types: `GitConfigValue` (value, scope, origin), `ProjectGitIdentity` (effective, local,
  environment, `environmentChecked`).
- New error code `GIT_CONFIG_FAILED`.

### Tests

- `apps/engine/tests/git-identity.test.ts`, with real Git and an isolated HOME:
  - global read and write with its file;
  - inheritance, local override, removal, removing a missing override, and a commit
    authored with the override while HEAD stays unchanged;
  - `includeIf "gitdir:"` resolved to the included file;
  - validation;
  - projects without a repository, unknown projects;
  - a broken global file (`GIT_CONFIG_FAILED`, file unchanged);
  - a broken repository configuration;
  - shell variables not checked without terminals;
  - `identityOverrides`.
- `tests/e2e/git-identity.spec.ts`:
  - global save with the email warning;
  - the project inherits, overrides and uses the inherited value again;
  - values verified with `git config`.

### Known limitations

- Settings shows the plain global value. `includeIf` conditions that depend on a repository
  apply only in the project view.
- System-level configuration (`/etc/gitconfig`) is shown when it decides the effective value,
  but ATLAS never writes it.
- Reading the shell environment for the project view starts a login shell, which takes up to
  about a second.
- Removing the global identity is not offered; edit it or remove it with
  `git config --global --unset`.
