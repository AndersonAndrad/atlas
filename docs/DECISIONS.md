# Architecture Decision Records

Each decision lists context, decision, and consequences. Entries are append-only;
superseded decisions are marked, not deleted.

## ADR-001 — Lightweight Engine embedded in-process (superseded for the desktop by ADR-009)

- **Context**: SDD-001 requires an Engine independent of Electron, reused by the CLI,
  without an unnecessary public HTTP server.
- **Decision**: The Engine is a library with a single composition root
  (`createEngine`). Electron main and the CLI each create an instance in-process. A
  standalone `atlas-engine` binary boots it without Electron.
- **Alternatives**: Electron `utilityProcess` running the Engine (better isolation, but an
  extra RPC protocol now); NestJS (rejected by the spec).
- **Consequences**: Simple, testable, no network surface. Moving the Engine out of process
  later only requires a transport adapter around `ProjectService`.

## ADR-002 — SQLite through built-in `node:sqlite`

- **Context**: Persistent local storage shared by the desktop app and CLI.
- **Decision**: Use Node's `node:sqlite` (`DatabaseSync`). Verified working in Electron
  44.5.1 (Node 24.21.0, SQLite 3.53.4) and Node 24.18.0 before adoption.
- **Alternatives**: `better-sqlite3` (mature, but a native add-on requiring separate
  builds for the Node and Electron ABIs).
- **Consequences**: No native rebuilds. The API is newer than better-sqlite3; it is
  isolated behind the repository classes in `packages/persistence`, so a swap is local.

## ADR-003 — Separate `path_key` column for duplicate detection

- **Context**: FR-007 requires rejecting the same directory twice with OS-specific path
  semantics.
- **Decision**: Store the realpath in `workspace_path` (display) and a platform-normalized
  `path_key` with a UNIQUE constraint (macOS/Windows case-folded; macOS NFC; Linux exact).
- **Consequences**: Duplicates are rejected by the service and by the database. On a
  case-sensitive APFS volume, two directories differing only by case would be treated as
  duplicates (rare; accepted risk R5).
- **Spec change**: adds a column not listed in SDD-001 §9 (approved as D6 in PLAN-001).

## ADR-003a — Git detection by reading `.git` metadata

- **Decision**: Walk parents for `.git` (dir or `gitdir:` file) and read `HEAD`; no `git`
  executable dependency.
- **Consequences**: Fast, works without Git installed. Exotic setups (`GIT_DIR`, bare
  repositories as workspaces) are not detected.

## ADR-004 — Paths from the renderer must come from the native picker

- **Context**: FR-002 and the security requirement "no arbitrary filesystem access from
  React".
- **Decision**: The main process remembers paths returned by the native picker during the
  session and rejects create/update requests with any other path.
- **Consequences**: A compromised renderer cannot register or probe arbitrary
  directories. Relocation of an unavailable project also uses the picker.

## ADR-005 — Shared data directory resolution

- **Decision**: One resolver (`resolveDataDir`) used by desktop, CLI and Engine binary;
  `ATLAS_DATA_DIR` overrides. Electron's `userData` is moved below it before the
  single-instance lock.
- **Consequences**: CLI and UI always see the same registry; tests are fully isolated.

## ADR-006 — Interpretation of "restore if it remains available"

- **Decision**: The selection is restored if the project is still registered. If its
  directory is unavailable it is restored anyway and shown with an unavailable status,
  so the user can update the path (FR-009). Stale ids are cleared.

## ADR-007 — Toolchain versions

- **Decision**: Node 24 LTS; Electron 44.5.1; electron-vite 5.0.0 with Vite 7.3.7;
  TypeScript 5.9.3; React 19.3.0; Zod 4.6.5; Vitest 4.1.12; Playwright 1.63.0. All pinned
  exactly; each release was at least two weeks old when chosen (R2: prefer stable/LTS
  lines over the newest majors such as Vite 8, Vitest 5 and TypeScript 7).

## ADR-008 — No packaging in SDD-001

- **Decision**: `pnpm build` produces runnable bundles (`electron-vite build`, `tsc -b`).
  Installers, signing and auto-update belong to a future specification.

## ADR-009 — Engine host in an Electron utility process (SDD-002, PLAN-002 D1)

- **Context**: SDD-002 makes terminals Engine-owned resources, requires that PTY work
  never blocks the Electron main thread, and that the CLI talks to the running Engine.
- **Decision**: The desktop runs the whole Engine (projects, terminals, SQLite, CLI socket)
  in `utilityProcess.fork`. Main validates renderer IPC and forwards it as Engine requests;
  the host validates again in `EngineDispatcher`. Supersedes ADR-001 for the desktop; the
  CLI still embeds an Engine (without terminals) for project commands.
- **Alternatives**: Engine in main with only PTYs in a child process (split state, more
  protocol); everything in main (blocks the main thread, a native crash kills the app).
- **Consequences**: Crash isolation and a single owner for terminals; project calls take an
  extra hop. Terminal output is still relayed by main (batched); a direct MessagePort to
  the renderer is a possible optimization.

## ADR-010 — Headless xterm mirror for reattachment (PLAN-002 D2)

- **Context**: Views are rebuilt after renderer reloads, project switches and pane changes;
  a new xterm.js instance cannot reconstruct full-screen programs from a byte log.
- **Decision**: Each session feeds an `@xterm/headless` terminal; `addon-serialize`
  produces the snapshot (1,000 lines of scrollback) together with a sequence number.
- **Consequences**: Correct alternate-screen restoration; output is parsed twice (Engine
  host and renderer). Some modes (e.g. mouse tracking) may need the program to redraw.

## ADR-011 — shadcn/ui and inline styles in the CSP (PLAN-002 rev 2, R5)

- **Context**: The developer chose shadcn/ui for every screen. xterm.js and Radix inject
  `<style>` elements at runtime.
- **Decision**: Tailwind CSS v4 + shadcn components generated with a pinned CLI (4.21.1)
  and reviewed; production CSP allows `style-src 'unsafe-inline'`, scripts remain `'self'`.
- **Consequences**: Consistent, accessible components owned by the repo. A CSS injection
  could restyle the page but cannot execute script.

## ADR-012 — Authenticated local socket for the CLI

- **Context**: The CLI must manage terminals of the running Engine without creating its
  own and without a network surface.
- **Decision**: Unix domain socket / named pipe in a private run directory, NDJSON
  protocol, random token in a 0600 run file, CLI method allow-list (no terminal input).
- **Consequences**: `atlas terminal …` requires ATLAS Control to be running. Same-user
  processes that can read the run file can use the allow-listed methods — the same trust
  boundary as the user's shell.

## ADR-013 — Terminal processes do not outlive the Engine

- **Context**: SDD-002 FR-010 asks to define quit behavior and forbids claiming survival
  without an implemented, tested mechanism.
- **Decision**: Quitting asks for confirmation when terminals run, then terminates them
  (SIGHUP, SIGKILL after 3 s). On macOS, closing the window keeps the app and terminals.
  Sessions are persisted as metadata only and shown as ended after a restart.
- **Consequences**: Simple and honest semantics; long-running servers stop with the app.

## ADR-014 — Confirmation based on the foreground process

- **Context**: Closing a tab must confirm when termination is expected (FR-010), without
  nagging for idle shells.
- **Decision**: Confirm when the PTY's foreground process differs from the shell (node-pty
  `process`). Windows cannot report it, so it always confirms there.
- **Consequences**: Background jobs (`cmd &`) are not detected and end without a prompt.

## ADR-015 — Layout is presentation state stored by the Engine (keyed by group since ADR-016)

- **Context**: Tabs/splits belong to the desktop (SDD-002 §4) but must persist.
- **Decision**: A pure split-tree model in the renderer (max 6 panes, one session per pane)
  saved per project in `application_settings`, validated by the Engine on write and
  repaired against existing sessions on load.
- **Consequences**: The CLI does not see layouts; closing a pane never affects processes.

## ADR-016 — Terminal workspaces are groups, not projects (SDD-003, PLAN-003 D1)

- **Context**: SDD-003 requires standalone terminals and groups mixing projects.
- **Decision**: The Terminals view is organized by user-defined groups plus Ungrouped;
  each group is a workspace with its own tabs and split layout. Projects are listed for
  quick actions. Supersedes the per-project tabs of SDD-002 FR-005.
- **Consequences**: One terminal lives in exactly one workspace. SDD-002 per-project
  layouts are dropped once by migration v3; processes and sessions are unaffected.

## ADR-017 — Working directory from the operating system (PLAN-003 D2)

- **Decision**: Read the shell's cwd (`/proc` on Linux, `lsof` on macOS) after a command
  settles instead of injecting shell-integration scripts (OSC 7).
- **Consequences**: No changes to the user's shell startup. Windows keeps the initial
  directory, labeled as such. Changes made without a submitted command are seen late.

## ADR-018 — Read-only Git through the system executable (PLAN-003 D3)

- **Context**: Identity precedence, porcelain status, ahead/behind and branch recency need
  Git itself; inspecting untrusted repositories must not execute their configuration.
- **Decision**: `execFile('git', [...])` with `core.fsmonitor=false`,
  `--no-optional-locks`, no inherited `GIT_*`, timeouts, concurrency limit and caching;
  never `fetch`. Project registration keeps the git-free `.git` reader.
- **Consequences**: Without git installed, Git details show "not installed". Residual
  risk: configuration-driven behavior unknown today could appear in future git versions.

## ADR-019 — Git refresh strategy (PLAN-003 D4)

- **Decision**: On request, on cwd change, on git-directory changes (watch, debounced) and
  every 30 s for watched repositories. Clients are notified with `git` events.
- **Consequences**: Working-tree edits by editors may take up to 30 s to show.

## ADR-020 — Removing a project keeps its terminals (PLAN-003 D5)

- **Decision**: The association is cleared (`ON DELETE SET NULL` and
  `terminals.detachProject`); processes keep running as standalone terminals. Replaces the
  SDD-002 behavior (terminate on removal, CLI refusal).

## ADR-021 — Accessible moves without a drag-and-drop library (PLAN-003 D6)

- **Decision**: Native HTML5 drag and drop plus equivalent menu actions (move to group,
  move up/down). No new dependency.

## ADR-022 — Sessions wait for an executor instead of running (PLAN-004 D1)

- **Context**: SDD-003 §15 forbids pretending that AI agents run before execution
  adapters exist (SDD-004).
- **Decision**: An explicit `WAITING_EXECUTOR` status. `start` and `resume` lead there
  while no adapter is available; RUNNING, WAITING_APPROVAL, COMPLETED and FAILED are
  reachable only through executor triggers, which have no caller yet. `startedAt` is set
  only when execution really starts.
- **Consequences**: The executor paths are defined and unit-tested but not exercised end
  to end until SDD-004.

## ADR-023 — Reconciliation in the Engine host only (PLAN-004 D2)

- **Decision**: At host startup and shutdown, RUNNING and WAITING_APPROVAL become
  INTERRUPTED (tasks in progress too); WAITING_EXECUTOR and PAUSED are kept. Interrupted
  sessions resume only on an explicit user action. CLI processes never reconcile.

## ADR-024 — Session workspace: project, directory or none (PLAN-004 D3)

- **Decision**: Project sessions follow the project's current directory. Removing a
  project converts its sessions into standalone sessions in that directory (same policy as
  terminals, ADR-020). Workspace existence and read/write access are checked when a
  session is marked ready, started or resumed; desktop clients must pick directories in
  the native dialog.
- **Consequences**: The check happens before execution, not during it (future executors
  must check again). A directory association is not a sandbox.

## ADR-025 — CLI session commands prefer the running Engine (PLAN-004 D4)

- **Decision**: `atlas session` calls the Engine host over the socket when it runs (live
  updates in the app) and otherwise runs the same dispatcher on the database.
  Optimistic concurrency (`revision`) protects against concurrent writers.

## ADR-026 — User-planned task graph (PLAN-004 D5)

- **Decision**: Users add, edit, cancel and remove pending tasks while the session is not
  finished; dependencies stay inside a session and cycles are rejected in the Engine (and
  by composite foreign keys in SQLite). Task progression is reserved for executors.

## ADR-027 — Execution profiles are configuration only (PLAN-004 D6)

- **Decision**: Profiles carry planned limits (`maxParallelTasks`, plus a global
  `maxConcurrentSessions`), validated and stored, not enforced before a scheduler exists.
  Profiles contain no security setting, so MAXIMUM cannot weaken any policy.

## ADR-028 — Append-only, allow-listed session events (PLAN-004 D7)

- **Decision**: Events are written in the same transaction as the change, with structured
  metadata only (statuses, ids, changed field names, reasons, counts). Free text is never
  copied into events or logs.

## ADR-029 — Approval contracts prepared, not used (PLAN-004 D8)

- **Decision**: `ApprovalRequest`, the `session_approvals` table and a read-only pending
  list exist; nothing creates or resolves approvals before SDD-004.

## ADR-030 — Archive instead of delete (PLAN-004 D9)

- **Decision**: Finished sessions (COMPLETED, FAILED, CANCELLED) can be archived and are
  hidden by default; sessions are never deleted, keeping their history.

## ADR-031 — Git workflow repositories are resolved by the Engine (PLAN-008, SDD-004 A)

- **Context**: Commits run repository hooks; a client-chosen directory would let any
  renderer run arbitrary code through Git.
- **Decision**: Git workflow requests name a repository root that must belong to the set
  the Engine resolves from registered projects and live terminals (re-checked on every request).
  Paths must be listed by `git status`; branch names must exist or pass
  `check-ref-format --branch`. Git workflow methods are desktop-only.
- **Consequences**: A repository is reachable only after it is registered or opened in a
  terminal; standalone terminals are enough.

## ADR-032 — Commits commit the index; selection is explicit staging (PLAN-008)

- **Decision**: A commit applies the user's explicit `stage`/`unstage` lists and then runs
  `git commit -F -`. Unstaged and untracked files are never selected by default; partially
  staged files contribute their staged part unless the user adds the rest. No `add -A`,
  `commit -a` or `commit --only`. An index fingerprint detects concurrent index changes.
- **Alternatives**: A temporary index (`GIT_INDEX_FILE`) decoupled from the real index —
  rejected: hooks would see an alternate index and the model is harder to verify.
- **Consequences**: A failed commit (e.g. a hook) leaves the selection staged; the error
  says so.

## ADR-033 — Own Conventional Commits validator (PLAN-008)

- **Context**: SDD-004 §8 prefers established parsers but forbids simplistic header-only
  regular expressions.
- **Decision**: A dependency-free implementation of the 1.0.0 grammar (header, blank line,
  body, `Token: value` / `Token #value` footers, `BREAKING CHANGE` / `BREAKING-CHANGE`),
  shared by the renderer and the Engine. Project rules can only add restrictions.
- **Alternatives**: `@commitlint/parse` plus rules — rejected for its dependency footprint
  and lenient defaults that would need re-implementing the same checks.

## ADR-034 — Repository-scoped operation coordinator with two lanes (PLAN-008)

- **Decision**: Mutations queue per repository on an `index` lane (index, HEAD, branches,
  working tree) and a `remote` lane (network, remote-tracking refs); pull takes both. Reads
  never queue. Queued operations are cancelled immediately; while running, only fetch and
  project commit checks (ADR-037) can be cancelled. Engine shutdown cancels queued and
  cancellable running operations, stops accepting new operations, and waits a bounded time
  (derived from the pre-commit step kill grace period) for operations that cannot be
  cancelled (commit, push) to finish.
- **Consequences**: A long fetch does not block commits; a pull waits for staging and
  commits to finish.

## ADR-035 — Expected Git failures are operation results (PLAN-008)

- **Decision**: Authentication, network, rejection, conflict, hook and similar failures
  resolve with a failed `GitOperation` carrying a code, a user-facing message and Git's
  output with credentials removed (8 KB). Validation problems remain request errors.
  Logs keep the kind, failure code and exit code only.
- **Consequences**: Commit & Push reports both results; a failed push keeps the commit.

## ADR-036 — Pull defaults to fast-forward only; no syntax highlighting yet (PLAN-008)

- **Decision**: The Pull dialog defaults to `--ff-only --no-rebase` and explains the
  configured strategy before running it. Diffs show colored lines without syntax
  highlighting (no highlighting dependency); hunk staging is deferred.

## ADR-037 — Project commit checks (SDD-004 A)

- **Context**: The desktop client can store shell commands in a project's Git settings
  (`git.setProjectSettings`). The Engine runs them with the user's login shell before a
  commit, so storing a command is equivalent to scheduling code execution.
- **Decision**: Commit checks are desktop-only: CLI socket clients are blocked from Git
  workflow methods. Commands are persisted in project settings and schema-validated
  (single line, at most 1,000 characters, at most five steps). The commit RPC carries only
  a project ID, never commands; the Engine resolves them from stored settings. The
  renderer can already run arbitrary commands through terminals, so this adds no new
  privilege to the trust boundary.
- **Consequences**: Stopping a step terminates its process group on POSIX; on Windows a
  `taskkill` tree termination is best-effort. Step output is redacted and capped. Invalid
  stored settings refuse the commit instead of silently dropping checks. The committed
  content is fingerprinted, including the selected files' content, and re-checked after
  the checks finish. Checks run against the working tree, not an isolated snapshot, so
  they can see and modify uncommitted files.
- **Rollback**: The feature is opt-in; removing a project's steps in its settings disables
  it. Older builds ignore the stored settings.

## ADR-038 — Merge without committing; Git's merge message is accepted (PLAN-011)

- **Decision**: Merges run `git merge --no-commit --no-ff` and require a clean working tree
  (tracked files). The user commits the merge manually from the commit dialog, prefilled
  with Git's `MERGE_MSG`, and the project's pre-commit steps run. While a merge is in
  progress, a message starting with `Merge ` is accepted even when Conventional Commits are
  enforced (as commitlint ignores merge commits by default). `git merge --abort` is offered
  only after an explicit confirmation.
- **Alternatives**: Committing the merge automatically (rejected: the user wants to review
  and run the checks); requiring Conventional messages for merges (rejected by the user's
  workflow, which keeps Git's default message); allowing dirty working trees (rejected:
  aborting could lose local changes).
- **Consequences**: `--no-ff` always creates a merge commit. Clipboard writes go through the
  main process (`app.copyText`), since `navigator.clipboard` needs document focus.

## ADR-039 — Shared Context before provider execution (PLAN-013, SDD-005 A1)

- **Context**: SDD-005 depends on SDD-004 Milestone B (headless provider execution), which
  does not exist yet.
- **Decision**: Build the provider-independent Context Engine now and start Claude Code or
  Codex in ATLAS terminals through their documented interactive prompt argument. Automatic
  outcome capture waits for SDD-004 Milestone B (stage A2).
- **Consequences**: Session outcomes are Git evidence plus summaries written or approved by
  the user; handoff validations stay empty until execution evidence exists.

## ADR-040 — Context owners, verification and untrusted content (PLAN-013)

- **Decision**: Every record belongs to a project or a repository root resolved by the
  Engine, or is global by explicit choice. Entries carry a verification level (`verified`
  from Git, `user`, `observed`) and full revision history; decisions are superseded, never
  erased. Content is redacted before storage and always presented to providers as reference
  data, never as instructions, behind a reviewed first message.
- **Alternatives**: Copying provider conversations (rejected by the specification); a
  vector database (out of scope; FTS5 search with a repository abstraction instead).

## ADR-041 — Prompt delivery through a private file (PLAN-013)

- **Decision**: The first message is written to `<data>/context/prompts/<session>.md` (0600)
  and passed as `"$(cat '<path>')"`; only the quoted path reaches the shell.
- **Consequences**: Arbitrary context text can never be interpreted by the shell. POSIX
  shells and PowerShell are supported; `cmd.exe` is not. Prompt files remain in the data
  directory (private) until removed with it.

## ADR-042 — Project configuration read by LLMs through PATH wrappers (PLAN-014)

- **Context**: Any LLM CLI run from an ATLAS terminal must read the project's ATLAS
  configuration first and, when the project keeps context, the shared context, so a
  successor knows what predecessors did and tested. Nothing may be written in the project.
- **Decision**: A JSON file per project in the data directory (`keepContext` and
  `atlasEnabled`, both off by default) plus a generated `context.md`; terminal variables
  point to them; POSIX wrappers for `claude` and `codex`, first on the PATH of ATLAS
  terminals, pass one instruction through each CLI's documented additive option
  (`--append-system-prompt`, `developer_instructions`). LLMs only read.
- **Alternatives**: Instruction files in the project (`CLAUDE.md`, `AGENTS.md`; rejected:
  they live in the project); shell functions or aliases injected into shell start-up
  (rejected: shell-specific and they modify user configuration); provider hooks or MCP
  servers (rejected for now: more setup per provider, larger surface).
- **Consequences**: Works for the two supported CLIs in POSIX shells; a copy placed first
  by shell start-up files bypasses it, so the app reports where each CLI resolves.

## ADR-043 — Lexical, explainable context retrieval (PLAN-015)

- **Context**: SDD-006 asks for relevant context by objective, role and files within a token
  budget, explainable and testable, without requiring embeddings.
- **Decision**: Candidates from the structured filter plus FTS5 (`bm25`, any term) and a
  score that is the sum of named factors (text, search rank, scope, files, category by
  role, decision, verification, small recency, stale and branch penalties). A pure
  `buildBundle` fits sections in the FR-604 order; the objective and required entries are
  never left out; every other candidate is included or listed as excluded with a reason.
  A task's own objective only ranks; an explicit objective, keywords or files also leave
  unrelated history out.
- **Alternatives**: Local embeddings (heavier dependency, spec says not required); only
  ordering by category (no relevance); stored compaction summaries (risk to audit history).
- **Consequences**: Deterministic and testable, but synonyms without shared words are not
  found and the weights are heuristics, not a measured quality.

## ADR-044 — Estimated token budgets resolved by specificity (PLAN-015)

- **Decision**: Budgets in estimated tokens (characters / 4, always labelled), resolved
  request → task → execution profile → role → provider → default, stored in
  `application_settings`. ATLAS never claims measured provider usage.
- **Alternatives**: Provider token-counting APIs (need credentials ATLAS does not hold);
  a single global budget (does not meet FR-603).

## ADR-045 — Context cache keyed by database revision; freshness always checked (PLAN-015)

- **Decision**: A 32-entry LRU of stored records per owner, task and query terms, keyed by
  `PRAGMA data_version` plus local writes, so writes by the CLI or another process
  invalidate it. Git freshness, scoring and budgets are computed on every request.
- **Consequences**: A cache hit can never hide repository changes; any context write
  invalidates every cached bundle (simple and safe; the cache only saves database work).

## ADR-046 — Persistent Git operation log and reflog view (PLAN-016)

- **Context**: The developer asked to keep logs of every Git action to review them in
  Operations; operations were only kept in memory, without their commands.
- **Decision**: Persist operations (journal hook in the coordinator) and the Git commands
  run inside them (executor wrapper with an `AsyncLocalStorage` scope) in SQLite, with
  credential-free, size-limited output and a retention by age and count. Show the HEAD
  reflog, read on demand, for changes made outside ATLAS, marked by matching logged
  operations by time and kind.
- **Alternatives**: Logging read-only polling commands too (rejected: noise and volume);
  capturing terminal input (rejected: ATLAS never records terminals); reflog only
  (rejected: no output, durations or failures).
- **Consequences**: Git output, file and branch names are stored locally (unencrypted).
  Attribution of reflog entries is heuristic. Schema v7 cannot be opened by older ATLAS.

## ADR-047 — Skills are copied into ATLAS as immutable versions (PLAN-017)

- **Decision**: Importing copies a reviewed skill folder into the ATLAS data directory as
  an immutable version; the source is never modified; changes at the source are offered
  as updates and imported only after a new review.
- **Alternatives**: Referencing the source folder in place (no real history; content can
  change under ATLAS without review).
- **Consequences**: Reliable history, diffs and rollback; disk use bounded by 5 MB per
  version; edits at the source need an explicit re-import.

## ADR-048 — Skill delivery: context references and user-level sync only (PLAN-017)

- **Decision**: Active skills are delivered to AI sessions as references (name, short
  description, SKILL.md path) in the context bundle, honouring project, role, provider and
  session rules. Synchronization writes only globally enabled skills into user-level
  provider folders chosen by the user, marks every folder it writes, never changes other
  folders, and can roll back.
- **Alternatives**: Writing into project folders (`.claude/skills`, `.agents/skills`;
  rejected: ATLAS does not write into projects); inlining skill text into prompts (rejected:
  token cost and prompt injection surface).
- **Consequences**: Narrower scopes only work for sessions ATLAS prepares; whether
  providers load synchronized skills was not verified with the real CLIs.

## ADR-049 — Commits read a fresh shell environment (PLAN-018)

- **Context**: ATLAS started with `pnpm dev` passed `NODE_ENV=development` to terminals,
  commit checks and Git hooks, breaking `next build`; checks also used an environment
  captured once at Engine start, so profile changes never reached them.
- **Decision**: Drop the variables ATLAS's development tooling sets from every user-facing
  environment, and for each commit and push start the user's shell as an interactive login
  shell to read the environment a new terminal would have, used by checks and hooks; fall
  back to ATLAS's environment after 8 s with a visible note.
- **Alternatives**: Only dropping `NODE_ENV` (profile changes still ignored); typing the
  commit into a new visible terminal (loses structured results, index checks and
  cancellation).
- **Consequences**: Each commit takes the shell's start-up time longer; start-up files that
  wait for input hit the timeout.

## ADR-050 — Cherry-pick as a normal, commit-preserving Git cherry-pick (PLAN-019)

- **Decision**: Use `git cherry-pick [-x]` with Git's sequencer: one commit per picked
  commit with the original message and author; conflicts are continued, skipped or
  aborted through Git (`--continue`, `--skip`, `--abort`). Source: another branch only.
- **Alternatives**: `--no-commit` like ATLAS's merge (rejected by the developer: it squashes
  commits and loses authorship; Git has no in-progress state to abort it safely).
- **Consequences**: The project's commit checks and Conventional Commits rules do not run
  for picked commits; the dialog warns about non-conventional messages.

## ADR-051 — Automatic LLM sessions from wrapper events (PLAN-021)

- **Decision**: The `claude` / `codex` wrappers write start and end event files to
  `<data>/context/events`; the Engine turns them into attached AI sessions and ends them
  automatically with Git evidence, also when the terminal closes or after a restart.
- **Alternatives**: Ask the user to end sessions (forgotten in practice); read the CLIs'
  conversation logs (private, provider-specific, rejected); provider hooks (edit the
  user's provider configuration).
- **Consequences**: Sessions without changes leave no entries; the record says what changed,
  not why. Events are validated strictly because a shell script writes them.

## ADR-052 — LLM checkpoints as unverified context (PLAN-021)

- **Decision**: LLMs keep a progress checkpoint in `ATLAS_CHECKPOINT_FILE`; ATLAS imports it
  as an `observed` `checkpoint` entry per run, revised on every change, and puts the newest
  ones first in bundles.
- **Alternatives**: Only a summary at the end (lost when tokens run out); parse the
  terminal output (unreliable and private).
- **Consequences**: Depends on the LLM following the instruction; the content is never
  treated as verified and is wrapped as untrusted data like every other entry.

## ADR-053 — Wrappers stay first on PATH through shell start-up hooks (PLAN-021)

- **Decision**: zsh terminals use an ATLAS `ZDOTDIR` that sources the user's files and adds
  a `precmd` hook; bash gets an exported function in `PROMPT_COMMAND`. The hook moves
  `<data>/bin` to the front before each prompt.
- **Alternatives**: Edit the user's `.zshrc` (rejected: never touch the user's files);
  only report shadowing (PLAN-014, left the problem to the user).
- **Consequences**: Commands run from start-up files before the first prompt still see the
  user's PATH order; other shells keep only the PLAN-014 report.

## ADR-054 — Reflog search in the Engine and commit files on demand (PLAN-022)

- **Decision**: `git.reflog` accepts a `query` matched in the Engine against the latest
  1,000 entries (reflog message, the commit's subject, hash prefix); `git.commitFiles`
  lists a commit's files against its first parent, loaded only when an entry is opened.
- **Alternatives**: Filter only the 100 loaded entries (misses older ones); 5,000 entries
  (reduced by the developer: 1,000 is enough); full per-file diffs (left to the hosting
  platform).
- **Consequences**: Older entries are not searched, and the panel says so; merge commits
  show only first-parent changes.

## ADR-055 — Quick commands as stored, id-addressed project actions (PLAN-023)

- **Decision**: Quick commands live in the application settings; the renderer runs them
  by id through `quickCommands.run`, which opens a project terminal and types the stored
  command. Menus get a generic `ProjectAction` list from the Engine, so other places can
  reuse it.
- **Alternatives**: Renderer-sent command text (rejected: what runs must be what the user
  saved and sees in the menu; this is not a security boundary, since the renderer can
  already type into terminals); a database table (migration for a small list). Revision 2
  (developer request): prioritized means "every project" (hide per project); other
  commands are enabled per project.
- **Consequences**: Commands run without per-use confirmation, as the user configured
  them; they are typed into the shell before its start-up files finish, like AI sessions.

## ADR-056 — GitHub Actions gate and electron-builder installers (PLAN-024)

- **Decision**: One workflow runs every check on Ubuntu 24.04 and macOS 15; a build job
  that needs all of them produces a Debian x64 `.deb` and macOS arm64 `.dmg`/`.zip` with
  electron-builder, kept as run artifacts and attached to a GitHub Release for `v*` tags.
  Actions are pinned by commit; the release uses the `gh` CLI with the job token.
- **Alternatives**: electron-forge (more configuration for the same targets); macOS x64
  builds (another runner, not needed now); signing and notarization (need an Apple
  certificate; later).
- **Consequences**: Only `node-pty` and the headless xterm modules are runtime
  dependencies of the desktop package; everything else is bundled, so it moved to
  `devDependencies` and the app archive stays small. `node-pty` is a Node-API addon and is
  not rebuilt for Electron. macOS builds are ad-hoc signed and need "Open" the first time.

## ADR-057 — The application is presented as A.T.L.A.S (PLAN-025)

- **Decision**: One constant, `APP_DISPLAY_NAME = 'A.T.L.A.S'` (contracts, dependency-free
  subpath), names the app in the window title, menus (`app.setName`), About, sidebar and
  dialogs; electron-builder's `productName` is `A.T.L.A.S`. The app icon is also the window
  icon and, from source, the Dock icon.
- **Alternatives**: Renaming every "ATLAS" in explanatory text (rejected: less readable;
  the developer chose the presented name only); renaming the bundle identifier, data folder
  or CLI (would lose macOS permissions and existing data).
- **Consequences**: An installed "ATLAS Control.app" stays until removed; both use the same
  data. Running from source still shows "Electron" as the bold macOS menu-bar title.

## ADR-058 — Usage comes only from supported provider interfaces (PLAN-027)

- **Decision**: Codex limits and daily tokens are read with `codex app-server`
  (`account/rateLimits/read`, `account/usage/read`, `account/read`), which runs no model.
  Claude Code limits are read only from the documented status line input, by giving ATLAS
  sessions (wrapper, `--settings`) a status line that saves it for ATLAS and prints nothing.
  Profiles are configuration folders (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`); the developer's
  convention `~/.<cli>-<name>` is detected. Windows are shown separately (session and weekly
  side by side), never merged; a reset is assumed only when the provider's reset time passed.
- **Alternatives**: Reading the CLIs' session files (undocumented formats); starting a
  provider session to read limits (spends quota); building Milestone A first (the developer
  asked for limits first).
- **Consequences**: Claude Code limits exist only for Pro/Max plans and only after a session
  in an ATLAS terminal got its first answer; between sessions they age and are marked. The
  app-server protocol is experimental: unexpected answers show "unavailable" with a reason,
  never numbers. Claude daily activity covers ATLAS sessions only (API time, list-price cost
  as an estimate); the status line's token fields are the context window, not usage.

## ADR-059 — Preflight runs authorized definitions locally and says where (PLAN-028)

- **Decision**: Preflight (SDD-007 Milestone A) is an Engine service with no AI dependency.
  Checks are commands, package scripts or GitHub Actions jobs run through `act`. A check runs
  only after the developer authorized the SHA-256 digest of what it runs (command, script
  body, workflow file, settings); checks whose commands or steps look like they change
  something outside the computer are authorized on every run, and a check whose files changed
  after authorization is blocked. A check passes only on exit code 0; blocked, unsupported,
  skipped and cancelled checks make a run incomplete, never passed. Results record where they
  ran (local shell or local act runner) and the code state (HEAD plus a fingerprint of staged,
  unstaged and untracked changes). Jobs that need secrets are blocked; act gets a minimal
  environment, empty secret/variable/input/`.env` files and no Docker socket. Process trees
  are managed by code shared with the pre-commit steps. Workflows are parsed with `yaml`
  2.9.1 (exact).
- **Alternatives**: Milestones A and B together (rejected: larger unreviewed change, against
  the specification's order); reusing the pre-commit step model (too narrow: five steps, no
  profiles or workflows); listing jobs with `act -l` (needs act installed and does not show
  steps, actions or secrets); storing logs in SQLite (unbounded database growth); secret
  mapping now (deferred by the developer: Q1).
- **Consequences**: Local commands are not sandboxed and see the terminal environment, like
  a terminal; Docker is not full isolation (risks R1 and R2 acknowledged by the developer).
  Side-effect detection is a pattern list and the digest does not cover files a command
  calls. act runs were validated only with a fake binary until act is installed. Milestone B
  must design its own stale-result rules on top of the fingerprint.

## ADR-060 — Notifications are an Engine service fed by finished operations (PLAN-030)

- **Decision**: The notification center (SDD-009 Milestone A) is a `NotificationService` in
  the Engine host with a SQLite table (migration v11). Git operations and Preflight runs
  publish one notification when they finish, mapped by pure functions that copy only short
  summaries, never command output. Changes reach the renderer on the existing Engine
  lifecycle event channel. Destinations are a closed, validated union (Git operation,
  Preflight run). Publishing never throws. Commits run in the background: the commit dialog
  closes once the Engine started the commit and the Git operations panel shows it. Quitting
  asks first while Git operations or Preflight runs are in progress.
- **Alternatives**: a JSON file store (rejected: SQLite and migrations already exist);
  polling the Engine (rejected: the event channel exists); free-form `{ type, targetId }`
  actions (rejected: not validatable); a toast library such as `sonner` (rejected: a new
  dependency for a small component); keeping the commit dialog open until the steps finish
  (the blocking behaviour the developer asked to remove); the bell in each view's header
  (rejected: collides with the Git view's top-right actions; Q1).
- **Consequences**: Every view is 40 px shorter. Quitting still stops background work (R1,
  acknowledged) but now warns first; on macOS closing the window keeps the Engine running.
  Dismissing deletes. Native notifications, deduplication windows, priorities, preferences
  and Quiet Mode are left to Milestones B and C.

## ADR-061 — The terminal header shows the open LLM's session usage from the inbox (PLAN-031)

- **Decision**: The Claude wrapper names the ATLAS terminal in the usage run folder
  (`terminal-id`). The Claude status inbox keeps, per terminal, the latest run whose process
  (the folder name's suffix) is alive, and publishes an `llm-usage` lifecycle event when that
  changes or a status arrives. `terminals.llmUsage` returns the profile's name from the Usage
  view and its latest session window, so all terminals on one account show the same value.
- **Alternatives**: only the run's own `status.json` (rejected: stale when another terminal
  uses the same account); keep showing the last account after the CLI exits (rejected: the
  developer asked for the open LLM only); an `ended` marker written by the wrapper (not
  needed: process liveness also covers killed terminals, and the wrapper keeps `exec`).
- **Consequences**: No schema change. Values change only when Claude Code refreshes its
  status line. Codex needs its own run tracking and is left to a later plan.

## ADR-062 — Project Hub notes live in SQLite with revision checks and sanitized Markdown (PLAN-032)

- **Decision**: Notes are a new Engine service (`packages/notes`) stored in the existing
  database (migration v12) with an FTS5 index maintained by the repository. Every update
  names the revision it edited and the write is conditional on it (`NOTE_CONFLICT`
  otherwise). Removing a project keeps its notes as workspace notes (`ON DELETE SET NULL`,
  folder kept). The preview uses `react-markdown` + `remark-gfm` without raw HTML, a URL
  allowlist and no image loading; internal `atlas:` links are validated by the Engine, and
  file links are only revealed after a realpath check inside the project.
- **Alternatives**: `marked` + DOMPurify (rejected: HTML strings and `innerHTML` widen the
  XSS surface); CodeMirror (rejected for now: several new dependencies, the specification
  asks for a lightweight editor); deleting notes with their project (rejected by the
  developer, Q2); notes as Shared Context entries (rejected: different lifecycle and
  ownership; attaching selected notes to AI context comes with Milestone B); last write wins
  (rejected: FR-1008 requires conflict detection).
- **Consequences**: Two exact-pinned renderer dependencies (bundled, not shipped as
  runtime packages). No revision history or merge. Tasks and Jira remain to be planned.
