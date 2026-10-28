# SDD-024 — Git Intelligence & Project Sync

Status: Task 01 (PLAN-047), Task 02 (PLAN-048) and Task 03 (PLAN-051) implemented. Task 04
Milestone A (PLAN-059) implemented. Later tasks and milestones need their own plans.

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

> Amendment 2026-10-27 (PLAN-052, SDD-023 Task A03): the project list with its badges and
> the Pending push section moved from the Terminals sidebar to the Projects drawer. Their
> behavior is unchanged.

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

## Task 04 (B05) — Pull Request Center, Milestone A: repositories and hosting accounts

Approved 2026-10-28 by Anderson Andrade ("pode seguir aprovado"), PLAN-059 revision 1. Q1–Q5
were answered with the presented recommendations. R1–R9 were presented but not acknowledged
by ID. Version 0.45.0, schema v24.

Milestones B (pull requests and the dashboard), C (synchronization) and D (notifications)
need their own plans. The specification text received was cut after Milestone B, so C and D
come from its functional requirements (FR-012–FR-019).

### Decisions (Q1–Q5)

- **Q1:** Milestone A only.
- **Q2:** without a real system secret store, tokens are refused. On Linux without GNOME
  Keyring or KWallet, Electron would fall back to a hard-coded key.
- **Q3:** personal tokens:
  - **GitHub:** a fine-grained token with read-only _Pull requests_ and _Metadata_, or a
    classic token with `repo`.
  - **Bitbucket Cloud:** an Atlassian API token with scopes `read:user`,
    `read:repository` and `read:pullrequest`, sent with the account email. App passwords
    no longer work (creation was disabled on 2025-09-09; the final cutoff was mid-2026).

  OAuth and importing from `gh` are later options.

- **Q4:** a **Pull requests** view after Git in the main navigation, with **Repositories**
  and **Accounts** tabs.
- **Q5:** the network is used only when an account is tested (also right after saving its
  token) or when **Check access** is chosen.

### Discovery (FR-001)

- `git remote -v` of every available project that is a Git repository. Fetch URLs are used
  when present.
- **Supported forms:**
  - `git@host:owner/repo(.git)`;
  - `ssh://[user@]host[:port]/owner/repo`;
  - `https://[user@]host/owner/repo`.

  Local paths, `file://`, `git://` and plain `http://` are not hosted remotes.

- **Credentials** in URLs are removed before anything is stored or shown. An ssh user name
  such as `git@` is kept.
- **Provider hosts:**
  - GitHub: `github.com`, `ssh.github.com`, `www.github.com`;
  - Bitbucket Cloud: `bitbucket.org`, `altssh.bitbucket.org`, `www.bitbucket.org`.

  Enterprise and Data Center hosts are reported as other hosts.

- **SSH aliases.** ATLAS reads `~/.ssh/config` itself and inlines its `Include` files where
  they appear.
  - `ssh -G` is never run, because it executes `Match exec` and other commands of the
    configuration.
  - Host patterns follow ssh: `*`, `?` and `!` negation, and the first value wins.
  - `HostName` supports `%h` and `%%`. Any other token, and every `Match` block, is not
    evaluated.
  - `Include` accepts `~`, absolute and `~/.ssh`-relative paths, with wildcards only in the
    file name.
  - Limits: 256 KB per file, 32 files, depth 4.
- **An alias an account declares** names the provider even without a `HostName`.
- **Remote kinds:**
  - Supported;
  - Unknown SSH alias: choosing an account sets its provider;
  - Other host;
  - Not a hosted repository: also used for paths that are not exactly `owner/repo`.
- **Removed remotes** stay listed as removed until dismissed.
- **Repository identity** is `PROVIDER:host/owner/repo` in lower case. The same repository
  reached by several remotes or projects is checked once.

### Accounts (FR-002, FR-003)

- There can be several accounts per provider. Each has:
  - a name;
  - for Bitbucket, the Atlassian email;
  - optional SSH aliases, which are unique across accounts and ignore case.
- `git user.email` is never used to pick an account.
- **Testing an account** calls `GET /user` (GitHub) or `GET /2.0/user` (Bitbucket). It stores
  the login, display name, state and a short message:

| State              | When                                                        |
| ------------------ | ----------------------------------------------------------- |
| Not tested         | Created or email changed, not tested since                  |
| Connected          | The provider returned the user                              |
| No token           | No token is stored for the account                          |
| Token rejected     | 401; the message names what each provider needs             |
| Missing permission | 403 that is not a rate limit                                |
| Rate limited       | 429, or 403 with `x-ratelimit-remaining: 0`                 |
| Unreachable        | Network error, timeout (15 s) or 5xx                        |
| Error              | Anything else, including an answer ATLAS did not understand |

### Which account a remote uses (FR-004)

For a supported remote, the first rule that applies decides:

1. **Chosen by you:** a manual choice of an account of the same provider.
2. **From its SSH alias:** exactly one account declares the remote's alias.
3. **Only account:** the provider has exactly one account.
4. **Only account with access:** exactly one account was found able to read the repository
   by **Check access**.

Otherwise the remote is ambiguous (several accounts) or has no account. Choosing
"Automatic" removes a manual choice.

**Check access:**

- It asks `GET /repos/{owner}/{repo}` or `GET /2.0/repositories/{workspace}/{repo}` with
  every candidate account that has a token. A manual account is the only candidate of its
  remote.
- It checks at most 50 repositories per click.
- An account that is rate limited or unreachable is not asked again in the same click.
- 404, and 403 without a rate limit, mean "No access": providers hide private repositories.

### Credentials (FR-020)

```text
 Accounts tab ─► atlas.hosting.saveCredential(accountId, token) ─► main process
        HostingCredentialVault: safeStorage.encryptString ─► <data>/credentials/
          hosting-<accountId>.bin (0600, folder 0700; temporary file + rename)
        ─► Engine host over the private parent port ('hosting-credential' message)
        ─► Engine memory (Map) ─► Authorization header of provider requests
```

- **The renderer** sends the token once; the field is cleared and no method returns it.
  Accounts only report `hasCredential`.
- **SQLite** stores metadata only. Its tables have no token column, and a test checks it.
- **Startup.** The main process decrypts the files when the Engine host starts or restarts
  and sends them before `start`. A file that cannot be decrypted (another computer or user)
  is skipped and logged without content; the account shows "No token".
- **Removing an account** deletes its file and its in-memory token. The token stays valid at
  the provider, and the dialog says so.
- **Requests.**
  - They are read-only, with a 15 s timeout and a 1 MB answer limit.
  - Answers are validated with zod.
  - Redirects are followed only on the API's own origin, at most three, so the
    `Authorization` header never leaves the provider.
  - Tokens never appear in URLs, logs or messages.
- **The CLI** cannot call `hosting.*`. It has no access to the tokens, which only the desktop
  main process can decrypt.
- **Tests only:** `ATLAS_GITHUB_API_URL` and `ATLAS_BITBUCKET_API_URL` point the Engine at a
  fake provider. Only loopback addresses are accepted, so a token cannot be sent elsewhere by
  changing the environment.

### Data (migration v24)

- `hosting_accounts`: provider, label, email, login, display name, SSH aliases (JSON),
  state, message, test and update times.
- `hosting_remotes`: one row per project and remote name.
  - What discovery found: kind, provider, alias, host, owner, name and repository key.
  - The manual account, and the removal time.
  - Rows are deleted with their project. Removing an account clears the manual choices
    that point at it.
- `hosting_repository_access`: one row per repository key and account, with the result and
  its time. Rows are deleted with their account.

Rolling back to 0.44.x needs a database copy taken before 0.45.0 first ran. The
`credentials` folder can be deleted.

### Contracts

- **Engine methods** (desktop only):
  - `hosting.accounts`, `createAccount`, `updateAccount`, `removeAccount` and `testAccount`;
  - `hosting.repositories`, `setRemoteAccount`, `dismissRemote` and `checkAccess`.
- **Renderer bridge:** `atlas.hosting` has the same operations, plus `credentialStatus` and
  `saveCredential`. `saveCredential` and `removeAccount` are handled by the main process,
  which also updates the vault.
- **New error codes:**
  - `HOSTING_ACCOUNT_NOT_FOUND`;
  - `HOSTING_REPOSITORY_NOT_FOUND`;
  - `HOSTING_ACCOUNT_MISMATCH`;
  - `HOSTING_CREDENTIAL_STORE_UNAVAILABLE`.

### Tests

- **`packages/hosting/tests/hosting.test.ts`:**
  - URL forms and non-hosted remotes;
  - credential removal;
  - classification;
  - SSH patterns, negation, first value, `%h`, and `Match` and unknown tokens not evaluated;
  - discovery without network;
  - missing folders;
  - the assignment precedence (alias, only account, access check, manual, after removal);
  - unknown aliases resolved by an account;
  - provider mismatch;
  - removed remotes and dismiss;
  - account states without the token;
  - rate-limit skip;
  - validation.
- **`packages/persistence/tests/hosting.test.ts`:**
  - the v23 → v24 migration, with no token column;
  - manual choices kept on rescans;
  - account removal effects;
  - writes for removed projects or accounts;
  - cascade with the project.
- **`apps/engine/tests/hosting.test.ts`:**
  - Bearer and Basic authentication;
  - status mapping;
  - access results;
  - same-origin redirects only;
  - size limit, invalid answers and unreachable hosts;
  - loopback-only overrides;
  - `Include` expansion;
  - the Engine with real Git remotes and a fake provider: one request per repository,
    `hosting.*` refused to the CLI.
- **`apps/desktop/tests/credential-vault.test.ts`:**
  - private encrypted files;
  - refusal without a secret store (Linux `basic_text`);
  - undecryptable and unrelated files;
  - identifiers that are not UUIDs.
- **`apps/desktop/tests/ipc.test.ts`:** tokens stored through the vault and never returned,
  unknown accounts, removal and store status.
- **`tests/e2e/pull-requests.spec.ts`** (Linux and Xvfb, fake GitHub, stubbed `safeStorage`):
  - discovery with an alias and another host;
  - two accounts, one rejected, then a new token;
  - alias assignment, Check access, manual choice;
  - tokens absent from the database and the credential files;
  - removal;
  - without a secret store, adding is disabled.
- **`security.spec`** pins the `hosting` bridge.

### Known limitations

- **Hosts:** only `github.com` and `bitbucket.org`. GitHub Enterprise and Bitbucket Data
  Center are not supported.
- **Teams:** team-based review responsibilities, pull requests, synchronization and
  notifications come with Milestones B–D.
- **SSH configuration:** `Match` blocks and tokens other than `%h` are not evaluated. Such an
  alias is shown as unknown and can be assigned by hand.
- **Moving computers:** tokens are not portable. On another computer or user account they
  must be entered again.
- **Linux:** without a running secret service, accounts cannot be added.
- **Proxies:** provider requests do not use `HTTPS_PROXY`; behind a mandatory proxy, tests
  and access checks report the provider as unreachable.
