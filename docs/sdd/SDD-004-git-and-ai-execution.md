# ATLAS — SDD-004: Git Workflow & AI Provider Execution

**Project:** ATLAS — Autonomous Task Leadership & Agent System  
**Specification:** SDD-004  
**Dependencies:** SDD-001, SDD-002, SDD-003  
**Status:** Milestone A implemented and validated (PLAN-008 revision 1) — awaiting the
developer's approval. Milestone B not started; it requires its own plan.

Part I documents the implementation of Milestone A. Part II preserves the specification as
received.

---

# Part I — Milestone A implementation (Git workspace)

## Overview

The Git workspace works in Terminal Mode: no AI, provider or session is involved. It is
available for registered projects and for any open terminal whose directory is inside a
Git repository.

| Layer                           | Responsibility                                                                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/conventional-commits` | Pure TypeScript: Conventional Commits 1.0.0 validator, stricter project rules, deterministic suggestions, `CommitSuggestionProvider` port         |
| `packages/git`                  | `GitInspectionService` (moved, unchanged), porcelain parsers, `GitWorkspaceService`, `GitOperationCoordinator`, credential redaction, preferences |
| `apps/engine`                   | `createGitExecutor` (spawn, no shell), repository authorization, `git.*` RPC methods, `git-operation` events                                      |
| `apps/desktop`                  | IPC channels (validated again in main), Git view, commit/push/pull/branches dialogs, terminal context menu, ⌘⇧G, Settings section                 |

## Entry points (FR-401)

- Main sidebar → **Git**; shortcut **⌘⇧G** (Ctrl+Shift+G on Windows/Linux, View menu).
- Project details → **Git** (shown when the project directory is a repository).
- Terminal header → Git button (shown when the terminal's directory is a repository).
- Terminal context menu (right click) → **Open Git panel**.

The view lists the repositories of registered projects and open terminals (standalone
terminals included). The last selected repository is remembered.

## Repository authorization

Commits run repository hooks, so the Engine never runs Git workflow commands in a
directory chosen by a client. `git.repositories` resolves roots from registered, available
projects and from live terminals' current directories (`rev-parse --show-toplevel`).
Every `git.*` request names a `repositoryRoot`, which must be one of those roots
(`GIT_REPOSITORY_UNAVAILABLE` otherwise). On every request the Engine checks that one of the
root's sources (a project or terminal) still resolves to it — a cached, cheap check — so
removed projects and closed terminals stop authorizing their repositories immediately.
Git workflow methods are desktop-only; the CLI allow-list is unchanged.

Paths and branch names are validated twice: shape (Zod, in main and in the Engine) and
membership (a path must be listed by `git status` with changes in the requested area; a
branch must exist; new names pass `git check-ref-format --branch`, and `@{` shorthands are
rejected).

## Git execution

`createGitExecutor` spawns `git` with an argument array (never a shell), the same safe
prefix as inspection (`-c core.fsmonitor=false --no-optional-locks`), inherited `GIT_*`
variables removed, `GIT_TERMINAL_PROMPT=0` and `LC_ALL=C`. Every workflow command adds
`--literal-pathspecs`, so file names such as `:(glob)*` are literal. Diffs use
`--no-ext-diff --no-textconv`, so repository configuration cannot run programs while
reading. Commit messages are passed on standard input (`commit -F -`).

| Operation | Command                                                                                                | Lane         | Timeout |
| --------- | ------------------------------------------------------------------------------------------------------ | ------------ | ------- |
| Status    | `status --porcelain=v2 --branch -z --untracked-files=all`, `diff [--cached] --numstat -z`              | read         | 15 s    |
| Diff      | `diff [--cached] --no-color --no-ext-diff --no-textconv -M -- <path>`; untracked files read by Node    | read         | 15 s    |
| Stage     | `add -- <paths>`                                                                                       | index        | 60 s    |
| Unstage   | `restore --staged -- <paths>` (`rm --cached` without commits; both sides of a staged rename)           | index        | 60 s    |
| Commit    | `commit -F -` (hooks run; never `--no-verify`)                                                         | index        | 10 min  |
| Push      | `push --progress <remote> refs/heads/<branch>:<merge ref>` or `--set-upstream` to a chosen destination | remote       | 10 min  |
| Pull      | `pull --progress --ff-only --no-rebase` (default) or `pull --progress` (repository configuration)      | index+remote | 10 min  |
| Fetch     | `fetch --progress [<remote>]` (cancellable)                                                            | remote       | 10 min  |
| Branches  | `for-each-ref refs/heads refs/remotes`, `switch [-c\|--track]`, `branch [-m]`                          | index        | 60 s    |

Never used: `reset --hard`, `clean`, `push --force`, branch deletion, `init`, `add -A`,
`commit -a`, `commit --only`.

## Index semantics (FR-402, FR-405)

`GitFileChange.staged` compares the index with HEAD and `unstaged` the working tree with
the index; a partially staged file has both. The Git view shows Merge conflicts, Staged
changes, Changes and Untracked files; staging and unstaging are per file, and "Stage all"
sends the explicit list of files of that section.

A commit commits exactly the index after applying the user's explicit selection:

- staged files are selected by default; unselecting one unstages it (`unstage`, shown as
  "will be unstaged"; as with `git restore --staged`, a staged version that differs from
  the working tree leaves the index);
- unstaged and untracked files appear only with **Include unstaged changes** and are never
  selected by default; selecting one stages it (`stage`), and the dialog lists them as
  "Will stage before committing";
- a partially staged file contributes its staged part; its working tree part is added only
  with its own **+ unstaged** choice.

**Concurrent changes (FR-408/415).** The working tree carries an `indexFingerprint`
(SHA-256 of HEAD and `diff --cached --raw`). The dialog works on the snapshot taken when it
opened and shows "Review again" when the live fingerprint changes; the Engine re-checks the
fingerprint inside the repository lock and refuses with `GIT_INDEX_CHANGED`.

## Conventional Commits (FR-406)

`validateCommitMessage` implements the 1.0.0 grammar: `type(scope)!: description`, a blank
line before the body, footers with `Token: value` or `Token #value` (multi-line values),
`BREAKING CHANGE` / `BREAKING-CHANGE` (uppercase; `: ` separator required), case-insensitive
types and any valid type. Errors are structured messages. Project rules (Settings → Git:
allowed types, required scope, header length) can only add restrictions. The renderer
validates while typing; the Engine validates again before committing. Commit buttons stay
disabled while the message is invalid.

## Commit suggestions (FR-407)

The deterministic strategy uses only paths and change types. It names a type only when
every selected file belongs to one unambiguous category (documentation, tests, CI,
manifests/lockfiles); otherwise the suggestion contains a `<type>` placeholder, which is
intentionally invalid so the user must choose. The scope is the common package or folder.
Suggestions are shown with their rationale and applied only by the user ("Use
suggestion", or filling an empty message on request). The `CommitSuggestionProvider` port
is where Milestone B can add an AI-assisted strategy. Suggestions can be turned off.

## Operations, feedback and concurrency (FR-414, FR-415)

`GitOperationCoordinator` serializes mutations per repository on two lanes: `index`
(index, HEAD, branches, working tree) and `remote` (network and remote-tracking refs). Pull
takes both. Read-only inspection never waits for it. Each operation has an id, kind,
repository, start/finish time, status (`queued`, `running`, `succeeded`, `failed`,
`cancelled`), throttled progress parsed from `--progress`, a summary, and an error with a
code and Git's own output. Operations are published as `git-operation` events; the Git
view shows the last ten with "Git output" on demand. Queued operations can be cancelled;
running ones only when safe (fetch). Git runs in the Engine host process, so Electron's
main and renderer processes never block. After every mutation the inspection cache is
invalidated and a `git` event refreshes all views (terminal headers, sidebar counters).

## Errors and security log (FR-408–FR-412)

Expected Git failures are reported on the operation, not thrown: `authentication`,
`network`, `rejected`, `conflict`, `no-upstream`, `identity-missing`, `nothing-to-commit`,
`hook-or-command-failed`, `locked`, `timeout`, `unavailable`. Their output is the real Git
output with credentials removed (`user:password@` / `token@` in URLs and token-like query
parameters) and limited to 8 KB. Logs record the kind, failure code and exit code only.
Validation problems (`VALIDATION_FAILED` with issues, `GIT_INDEX_CHANGED`,
`GIT_NO_UPSTREAM`, `GIT_REPOSITORY_UNAVAILABLE`) are request errors. A commit that fails
after staging the selection says that the selection remains staged.

- **Commit & Push**: the commit result and the push result are separate operations; a
  failed push keeps the commit. Without an upstream the dialog asks for a remote and a
  branch name (default: the current branch) before anything runs.
- **Push**: shows `branch → upstream` and the commits to push (as of the last fetch).
- **Pull**: shows `upstream → branch`, the commits to pull, the configured strategy
  (merge, rebase, fast-forward only, or unset) and a warning for local changes. The default
  is fast-forward only. Conflicts stop the pull and are listed; nothing is aborted or
  resolved automatically. A pull is refused while a merge or rebase is in progress.
- **Fetch**: default or chosen remote, progress, cancellable; never touches the working
  tree. The last fetch time comes from `FETCH_HEAD`.
- **Branches**: local branches (current, upstream, ahead/behind, gone), remote-tracking
  branches (check out creates a tracking branch), create (optionally from a branch and
  switching), switch (warns about uncommitted changes; Git refuses to overwrite them),
  rename, copy name. No deletion.

Authentication relies on the user's Git setup (credential helpers such as the macOS
Keychain, or ssh-agent). ATLAS cannot answer password prompts and never stores Git
credentials.

## Persistence (§9)

No migration: `application_settings` key `git.preferences` stores `commitTypes`,
`requireScope`, `headerMaxLength`, `suggestions` (`deterministic` or `off`) and
`lastRepositoryRoot`. Operation history is kept in memory (last 100) and never persisted.

## Tests

- `packages/conventional-commits`: specification examples, invalid messages, project
  rules, deterministic suggestions.
- `packages/git`: per-file status, numstat, refs, remotes, progress parsing, credential
  redaction; coordinator lanes, queueing, cancellation, failures and history.
- `apps/engine/tests/git-workspace.test.ts`: real repositories and bare remotes in
  temporary directories — status mapping, diffs (partial staging, untracked, binary,
  truncated, symbolic links not followed), staging (literal pathspecs, renames, unborn
  HEAD), commits (partial staging preserved, explicit selection, invalid messages, changed
  index, project rules, failing and passing hooks, missing identity, empty commit),
  Commit & Push, rejected push, explicit upstream, fetch/pull fast-forward, divergent pull,
  merge conflicts, network failure without credential leaks, branch create/switch/rename,
  refusal to overwrite local changes, serialized mutations.
- `apps/desktop/tests/ipc.test.ts`: repositories outside projects and terminals are
  refused; invalid paths and unknown fields rejected; operations emitted as events.
- `tests/e2e/git.spec.ts`: commit with validation then Commit & Push to a bare remote;
  explicit inclusion of unstaged files, suggestion and a failing hook with Git output;
  fetch, behind count, fast-forward pull and branch create/switch; entry from standalone
  terminals, the context menu and the shortcut; stricter rules from Settings; no
  horizontal overflow from 380 px to 1440 px.

## Known limitations

- File-level staging only; hunk-level staging is deferred (allowed by FR-405).
- No syntax highlighting in the diff viewer (added/removed lines are colored); diffs are
  limited to 512 KB and 5,000 lines.
- Changed files listed per repository are limited to 2,000; untracked line counts are
  computed for up to 200 files of at most 1 MB.
- Password and passphrase prompts cannot be answered; configure a credential helper or
  ssh-agent. Real authenticated remotes (e.g. GitHub) were not exercised in automated
  tests; network behavior was verified against local bare remotes and an unreachable URL.
- Push uses the branch's upstream (`branch.<name>.remote` / `.merge`); `pushRemote` and
  `remote.pushDefault` are not applied.
- Hooks run with the Engine host's environment; hooks that rely on tools only available in
  a login shell's PATH may fail when ATLAS is launched from the Finder.
- Minimum Git version: 2.23 (`git restore`, `git switch`); verified with Git 2.55.
- AI-assisted suggestions (FR-407 Strategy B) wait for Milestone B.

---

# Part II — Specification as received

## 1. Objective

Extend ATLAS with two major capabilities:

- **Milestone A:** A fully functional Git workflow inspired by Warp, including Conventional Commits.
- **Milestone B:** Real Claude Code and Codex CLI execution through independent ATLAS Sessions.

The application must remain fully usable as a traditional terminal manager without AI accounts, providers, or orchestration.

Do not rebuild existing modules unnecessarily.

Inspect the actual repository and preserve established architecture, conventions, and functionality.

## 2. Fundamental Product Rule

ATLAS supports two independent usage patterns.

**Terminal Mode**

- Normal interactive terminals.
- Terminal groups and tabs.
- Multiple projects.
- Git repository inspection.
- Git operations.
- Conventional Commit validation.
- Manual commit messages.
- No AI required.

**ATLAS Mode**

- Everything available in Terminal Mode.
- AI-powered task execution.
- Claude Code and Codex integrations.
- Persistent execution sessions.
- Supervised execution.
- Agent activity and result reporting.

AI execution must be opt-in.

Never automatically invoke an AI provider merely because a terminal, project, or Git panel is opened.

---

# MILESTONE A — GIT WORKSPACE

## 3. Git Workspace Interface

### FR-401 — Git Panel

Implement a Git management interface accessible from:

- Main sidebar.
- Project Details.
- Terminal header.
- Terminal context menu.
- Keyboard shortcut.

The panel must display:

- Repository name and path.
- Current branch.
- Git identity.
- Working tree status.
- Staged changes.
- Unstaged changes.
- Untracked files.
- Ahead and behind counts.
- Configured upstream.
- Last fetch information when available.

Support standalone terminals located inside Git repositories.

A registered ATLAS project is not required.

If the directory is not a Git repository, show an informative empty state.

### FR-402 — File Selection

Allow users to:

- View changed files.
- Select files for commit.
- Stage individual files.
- Unstage individual files.
- Stage all files.
- Unstage all files.
- Inspect file diffs.
- View file change types.
- Refresh repository status.

Support:

- Added files.
- Modified files.
- Deleted files.
- Renamed files.
- Untracked files.

Use Git index semantics correctly.

Do not confuse staged and unstaged changes.

### FR-403 — Diff Viewer

Implement a read-only diff viewer.

Display:

- File path.
- Change type.
- Added and removed lines.
- Unified diff.
- Syntax highlighting where practical.

Support large files gracefully.

Do not load unlimited diffs into memory.

Handle binary files and unsupported diff formats without crashing.

### FR-404 — Commit Dialog

Create a commit dialog inspired by the supplied Warp reference.

Required elements:

- Current branch.
- Selected file count.
- Changed file list.
- Added and removed line statistics.
- Staged/unstaged indicators.
- Commit message editor.
- Conventional Commit validation.
- Commit action.
- Commit & Push action.
- Cancel action.

Support keyboard navigation.

Do not automatically commit every modified file.

### FR-405 — Include Unstaged Changes

Provide an explicit option to include unstaged changes.

Default behavior:

- Commit only the selected staged content.

When unstaged changes are included:

- Clearly display which changes will be staged.
- Require an explicit selection.
- Avoid staging unrelated files.

Preserve partially staged changes.

Do not implement file selection using unsafe blanket staging commands.

For the initial implementation, file-level staging is sufficient.

Hunk-level staging may be deferred.

### FR-406 — Conventional Commits

All commits created through the ATLAS Git UI must comply with Conventional Commits 1.0.0.

Official specification:

https://www.conventionalcommits.org/en/v1.0.0/

Supported format:

`<type>[optional scope][!]: <description>`

Optional body and footer sections must also be supported.

Recommended commit types:

- feat
- fix
- docs
- style
- refactor
- perf
- test
- build
- ci
- chore
- revert

The validator must support any valid Conventional Commit type rather than restricting users to this recommended list.

Examples:

`feat(terminal): add terminal groups`

`fix(git): correct ahead and behind counters`

`refactor(engine): separate execution providers`

`docs: update architecture documentation`

`feat(api)!: change authentication contract`

For breaking changes, support the `!` marker and the `BREAKING CHANGE:` footer according to the specification.

The Commit button must remain disabled when the message is invalid.

Provide clear validation feedback.

Allow additional project-specific conventions without weakening the mandatory Conventional Commits format.

### FR-407 — Commit Message Suggestions

Implement a pluggable suggestion system.

Support two strategies.

**Strategy A — Deterministic**

Works without AI.

Uses:

- Selected file paths.
- Change types.
- Diff statistics.
- Available project metadata.

May propose a basic Conventional Commit message.

Must not invent functionality or claim to understand changes based only on filenames.

**Strategy B — AI-Assisted**

Optional.

Uses an available, explicitly authorized AI provider or compatible installed Skill.

The suggestion provider may analyze the selected diff and relevant repository context.

Requirements:

- Reuse existing compatible Skills when possible.
- Support user-configured suggestion providers.
- Avoid mandatory provider dependencies.
- Display generated suggestions for review.
- Never commit automatically.
- Validate the generated message.
- Never send secrets or sensitive diffs without appropriate authorization.
- Respect provider capabilities and project policies.

If no AI provider is configured, the Git workflow must remain fully functional.

AI suggestion integration may be activated after Milestone B is implemented.

### FR-408 — Commit

Implement real Git commits.

Requirements:

- Validate repository state.
- Validate selected changes.
- Validate commit message.
- Respect Git author configuration.
- Preserve Git hooks.
- Handle hook failures.
- Detect concurrent index changes.
- Report actual Git errors.
- Refresh repository status after success.

Never bypass hooks automatically.

Never claim success before Git confirms the commit.

### FR-409 — Commit & Push

Implement a combined action:

1. Validate commit message and selected changes.
2. Create the commit.
3. Confirm successful commit creation.
4. Push to the configured upstream.
5. Report the result of each operation separately.

If the commit succeeds but the push fails, preserve the commit and report the push failure.

Never automatically force push.

If no upstream is configured, offer an explicit upstream configuration flow.

Do not silently select an arbitrary remote branch.

### FR-410 — Push

Provide a standalone Push action.

Requirements:

- Display current branch.
- Display upstream destination.
- Show ahead count when available.
- Require confirmation when destination is ambiguous.
- Report authentication and network failures.
- Support ordinary push operations.

Force push is out of scope.

### FR-411 — Pull

Provide a standalone Pull action.

Requirements:

- Display the current branch and upstream.
- Detect uncommitted changes.
- Respect repository pull configuration.
- Support fast-forward-only behavior when appropriate.
- Clearly explain merge or rebase behavior before execution.
- Report conflicts.
- Preserve working tree state on failure where Git permits.

Never automatically discard local changes.

Do not silently resolve merge conflicts with AI.

### FR-412 — Fetch

Provide a standalone Fetch action.

Requirements:

- Fetch from a selected or configured remote.
- Display progress.
- Refresh ahead/behind indicators.
- Handle authentication failures.
- Handle offline operation.

Fetch must not modify the working tree.

### FR-413 — Branch Management

Add lightweight branch management.

Support:

- List local branches.
- List remote-tracking branches.
- Create branch.
- Switch branch.
- Rename local branch.
- Copy branch name.
- View current branch.
- View upstream information.

Branch deletion is optional and should require explicit confirmation if implemented.

Before switching branches, inspect uncommitted changes and warn when necessary.

Never discard changes automatically.

### FR-414 — Git Operation Feedback

Git operations must expose:

- Operation type.
- Repository.
- Start time.
- Current status.
- Progress where available.
- Completion status.
- Relevant errors.

Long-running operations must not freeze Electron.

Support cancellation where safe and technically possible.

Do not terminate Git operations in ways that risk corrupting repository state.

### FR-415 — Git Operation Concurrency

Prevent conflicting Git mutations on the same repository or worktree.

Use a repository-scoped operation coordinator.

Allow safe read-only operations concurrently.

Serialize conflicting operations such as:

- Commit.
- Checkout.
- Pull.
- Index mutation.

Detect repository changes made by external terminals or editors.

Refresh state before critical operations.

### FR-416 — Git Safety

Git operations must use safe argument-based process execution.

Never interpolate arbitrary paths into shell commands.

Do not automatically execute:

- git reset --hard
- git clean -fd
- git push --force
- destructive branch deletion
- repository reinitialization

Do not add these operations to the initial UI.

Respect Git hooks, configured credentials, and existing repository policies.

Do not store Git authentication secrets in ATLAS databases.

---

# MILESTONE B — AI PROVIDERS & EXECUTION

## 4. Objective

Implement the first real AI execution capability for ATLAS Sessions.

Users must be able to select an existing session, choose an available provider, and execute a task using a real installed AI CLI.

Initial targets:

- Claude Code.
- Codex CLI.

Provider integration must not require the user to abandon normal terminal usage.

## 5. Provider Registry

### FR-417 — Provider Detection

Detect installed providers.

For each provider, report:

- Provider identifier.
- Executable availability.
- Executable path.
- Detected version.
- Supported capabilities.
- Authentication readiness when reliably detectable.
- Relevant platform limitations.

Do not claim that an executable is authenticated merely because it exists.

Support custom executable paths.

Do not modify provider credentials automatically.

### FR-418 — Provider Adapters

Implement a provider-agnostic adapter contract.

Suggested interface:

```typescript
interface AgentProvider {
  id: string;

  detect(): Promise<ProviderDetection>;

  capabilities(): ProviderCapabilities;

  execute(
    input: AgentExecutionInput,
    context: AgentExecutionContext,
  ): Promise<AgentExecutionHandle>;
}
```

The execution handle must support, when available:

- Streaming output.
- Lifecycle events.
- Cancellation.
- Exit status.
- Structured result metadata.
- Usage information.

Provider-specific limitations must be documented.

Do not assume Claude Code and Codex CLI expose identical features or flags.

Consult the actual installed CLI help and supported documentation before implementing adapters.

### FR-419 — Real Execution

Allow an ATLAS Session to execute a task through a configured provider.

The execution must:

1. Validate the session.
2. Validate the workspace.
3. Validate provider availability.
4. Validate execution permissions.
5. Start the provider.
6. Stream real execution events.
7. Record execution state.
8. Capture the final result.
9. Handle errors and cancellation.
10. Persist relevant execution metadata.

Do not simulate provider output.

### FR-420 — Session Execution States

Extend the existing session state machine as needed.

Distinguish:

- READY
- STARTING
- RUNNING
- WAITING_APPROVAL
- COMPLETED
- FAILED
- CANCELLED
- INTERRUPTED

Use validated state transitions.

A session may contain multiple execution attempts.

An execution attempt must have its own identifier and lifecycle.

### FR-421 — Execution Interface

In the Electron Sessions view, provide:

- Session objective.
- Provider selection.
- Execution start action.
- Streaming output.
- Execution status.
- Stop action.
- Result summary.
- Execution history.

The user must be able to navigate away without terminating a running execution.

Closing a view must not automatically kill the provider process.

### FR-422 — Provider Terminal Integration

Where supported, expose the agent execution process through an integrated terminal or structured execution panel.

Reuse existing PTY and streaming infrastructure when appropriate.

Do not require every provider to behave like an interactive shell.

Support provider-specific execution modes through adapters.

### FR-423 — Execution Isolation

Execute agents within explicitly authorized workspaces.

For development tasks, prefer isolated Git worktrees.

Never automatically allow unrestricted modification of arbitrary directories.

The provider's native permission model must remain active.

ATLAS approval policies must not be bypassed.

### FR-424 — Supervised Execution

Implement the foundation for supervised autonomy.

The user may authorize a defined execution scope.

Sensitive operations must require explicit approval.

Examples:

- Destructive filesystem changes.
- Production deployments.
- Credential access.
- Infrastructure changes.
- Irreversible Git operations.

If an operation cannot be reliably intercepted or controlled by the selected provider integration, do not advertise it as safely supervised.

Restrict or disable unsupported execution modes.

### FR-425 — Provider Output

Capture:

- Provider identity.
- Execution identifier.
- Start and end timestamps.
- Execution status.
- Output events.
- Exit code when available.
- Result summary.
- Error information.
- Usage metrics when supported.

Never invent token usage or costs.

### FR-426 — Multiple Sessions

Support at least two independent ATLAS Sessions executing concurrently.

Sessions may belong to:

- The same project.
- Different projects.
- Standalone workspaces.

Use configurable concurrency limits.

Prevent workspace collisions.

Do not allow simultaneous agents to modify the same working tree without explicit coordination.

### FR-427 — Provider Cancellation

Support user-initiated cancellation.

Cancellation must:

- Target the correct execution.
- Avoid terminating unrelated terminals.
- Update lifecycle state.
- Release resources.
- Preserve execution history.

Document provider-specific cancellation limitations.

### FR-428 — Failure Handling

Handle:

- Missing executable.
- Unsupported CLI version.
- Authentication failure.
- Provider rate limits.
- Process crash.
- Timeout.
- Invalid workspace.
- User cancellation.
- Interrupted Engine process.

Do not retry potentially side-effecting operations automatically unless safe retry behavior is established.

### FR-429 — CLI Execution

Extend the ATLAS CLI with commands similar to:

```bash
atlas provider list
atlas provider inspect claude
atlas provider inspect codex

atlas session run <session-id> --provider claude
atlas session run <session-id> --provider codex

atlas session stop <session-id>
atlas session executions <session-id>
```

The CLI must communicate with the shared Engine.

Do not create duplicate provider processes when multiple clients observe the same session.

---

# 6. Architecture

Preserve the existing modular monorepo.

Suggested modules:

```text
packages/
├── git/
│   ├── domain/
│   ├── application/
│   ├── infrastructure/
│   └── contracts/
│
├── conventional-commits/
│   ├── validator/
│   └── suggestions/
│
├── providers/
│   ├── contracts/
│   ├── claude/
│   └── codex/
│
├── execution/
│   ├── lifecycle/
│   ├── runtime/
│   └── events/
│
└── policies/
```

Adapt to the existing repository.

Do not create duplicate services if suitable abstractions already exist.

## 7. Git Service Contracts

Provide typed operations for:

- Inspect repository.
- Get status.
- List changes.
- Get diff.
- Stage files.
- Unstage files.
- Validate commit message.
- Suggest commit message.
- Commit.
- Push.
- Pull.
- Fetch.
- List branches.
- Create branch.
- Switch branch.

The Git Service must remain independent of Electron and AI providers.

## 8. Conventional Commit Service

Define a reusable validation service.

Example:

```typescript
interface CommitMessageValidation {
  valid: boolean;
  type?: string;
  scope?: string;
  description?: string;
  breaking: boolean;
  errors: string[];
}
```

Provide:

- Full-message validation.
- Structured error reporting.
- Optional suggestion generation.
- Configurable project-specific rules.

Prefer established parsers or validators when appropriate.

Avoid simplistic regular expressions that reject valid bodies, footers, or breaking changes.

## 9. Persistence

Persist:

- Git UI preferences.
- Commit suggestion preferences.
- Last selected repository.
- Provider configuration metadata.
- Execution attempts.
- Execution lifecycle events.
- Relevant execution results.

Do not persist:

- Plaintext provider credentials.
- Unfiltered sensitive terminal input.
- Entire model conversations by default.
- Unbounded output logs.

Use bounded retention policies.

## 10. Automated Tests

### Milestone A

Unit tests:

- Conventional Commit validation.
- Commit message parsing.
- Git status mapping.
- Staged and unstaged file selection.
- Branch metadata.
- Operation concurrency.
- Error handling.

Integration tests:

- Real Git repositories in temporary directories.
- Commit creation.
- Commit hooks.
- Push and pull against temporary local remotes.
- Fetch.
- Ahead and behind tracking.
- Branch creation and switching.
- Partial staging preservation.
- Concurrent repository changes.

Desktop tests:

- Commit dialog.
- File selection.
- Diff inspection.
- Commit validation.
- Commit and push.
- Git operation feedback.
- Standalone terminal Git integration.

### Milestone B

Unit tests:

- Provider capability detection.
- Adapter contracts.
- Execution state transitions.
- Cancellation.
- Permission validation.

Integration tests:

- Real provider detection.
- Streaming execution.
- Session persistence.
- Multiple concurrent sessions.
- Process interruption.
- Failure recovery.

Use mock providers for deterministic automated tests.

Additionally, verify at least one real installed provider end-to-end when credentials and access are available.

Do not report real provider integration as verified based only on mocks.

## 11. Acceptance Criteria

### Milestone A

- [ ] Git panel works with registered projects.
- [ ] Git panel works with standalone terminals.
- [ ] Changed files can be inspected and selected.
- [ ] Staging and unstaging work.
- [ ] Diff viewer works.
- [ ] Conventional Commits are validated correctly.
- [ ] Manual commit messages work without AI.
- [ ] Optional commit suggestions are supported.
- [ ] Real commits can be created.
- [ ] Commit & Push works.
- [ ] Standalone Push works.
- [ ] Pull works.
- [ ] Fetch works.
- [ ] Branch creation and switching work.
- [ ] Git errors are reported correctly.
- [ ] Conflicting Git operations are coordinated.
- [ ] Existing terminal functionality remains operational.
- [ ] Unit, integration and desktop tests pass.

### Milestone B

- [ ] Claude Code detection works.
- [ ] Codex CLI detection works.
- [ ] Provider capabilities are represented accurately.
- [ ] A real ATLAS Session can execute a task.
- [ ] Execution output streams to Electron.
- [ ] Execution lifecycle is persisted.
- [ ] Cancellation works.
- [ ] Multiple independent executions are supported.
- [ ] Workspace isolation is enforced within documented limits.
- [ ] Provider failures are handled correctly.
- [ ] CLI execution commands work.
- [ ] Normal terminals remain usable without AI.
- [ ] Relevant tests and builds pass.

## 12. Documentation

Create:

`docs/sdd/SDD-004-git-and-ai-execution.md`

Update:

- docs/ARCHITECTURE.md
- docs/ROADMAP.md
- docs/STATUS.md
- docs/DECISIONS.md

Document:

- Git operation architecture.
- Conventional Commit rules.
- Commit suggestion strategy.
- Provider adapter contracts.
- Provider limitations.
- Execution lifecycle.
- Security boundaries.
- Test results.
- Platform compatibility.

## 13. Implementation Order

### Milestone A

1. Inspect the current repository.
2. Define Git operation contracts.
3. Implement Git mutation services.
4. Implement Git operation coordination.
5. Implement Conventional Commit validation.
6. Build the Git panel and diff viewer.
7. Build the commit dialog.
8. Implement Commit and Commit & Push.
9. Implement Push, Pull and Fetch.
10. Implement branch management.
11. Add deterministic commit suggestions.
12. Run tests and validate Milestone A.

### Milestone B

1. Inspect installed Claude and Codex capabilities.
2. Define provider adapter contracts.
3. Implement provider detection.
4. Implement Claude Code adapter.
5. Implement Codex CLI adapter.
6. Connect adapters to ATLAS Sessions.
7. Implement real execution lifecycle.
8. Implement output streaming.
9. Implement cancellation and failure handling.
10. Add execution UI and CLI commands.
11. Connect optional AI commit suggestions where supported.
12. Run tests and validate Milestone B.

## 14. Strict Scope

Do not implement yet:

- Dynamic multi-agent team generation.
- Autonomous task planning.
- Intelligence Router.
- Multiple-account orchestration.
- Shared Skills Hub.
- Context Engine.
- Remote workers.
- Self-development automation.
- Automatic production deployment.

These belong to future specifications.

However, provider adapters and execution contracts must allow their later integration.

## 15. Final Instructions for Claude Code

Act as a Principal Software Architect and implementation lead.

Follow Spec-Driven Development.

First inspect the existing implementation.

Do not overwrite working architecture without justification.

Implement Milestone A completely and validate it before beginning Milestone B.

Make separate, Conventional Commit-compliant commits for each coherent implementation milestone.

Do not bypass tests or Git hooks.

Do not fabricate provider execution, token metrics, Git results, or successful tests.

Preserve the distinction between normal terminal usage and optional AI execution.

At the end, provide:

- Completed functionality.
- Architectural decisions.
- Relevant files changed.
- Test evidence.
- Build results.
- Manual verification steps.
- Known limitations.
- Remaining work.

**Expected result:** ATLAS becomes a fully functional Git-enabled terminal workspace and gains its first real Claude Code and Codex execution capabilities.
