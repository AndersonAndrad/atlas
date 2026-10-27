# SDD-024 — Git Intelligence & Project Sync

Status: Task 01 implemented (PLAN-047 revision 1). Later tasks need their own plans.

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
