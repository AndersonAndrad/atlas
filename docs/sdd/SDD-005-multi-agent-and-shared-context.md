# ATLAS — SDD-005: Multi-Agent Orchestration & Shared Context

**Project:** ATLAS — Autonomous Task Leadership & Agent System  
**Specification:** SDD-005  
**Dependencies:** SDD-001 through SDD-004  
**Status:** Milestone A, stage A1 (shared context foundation and managed AI sessions in
terminals) implemented and validated with automated tests (PLAN-013 revision 1) — awaiting
the developer's approval and a manual check with the real Claude Code and Codex CLIs.
Stage A2 (headless execution and automatic outcome capture) depends on SDD-004
Milestone B and has not started. Milestones B and C have not started.

Part I documents the implementation. Part II preserves the specification as received.

---

# Part I — Milestone A, stage A1

## Scope and sequencing (PLAN-013)

SDD-005 depends on SDD-004 Milestone B (provider adapters with headless execution), which
does not exist yet. Milestone A was therefore split:

- **A1 (this stage):** the provider-independent Context Engine (FR-501–FR-507), handoffs
  (FR-511/512), session summaries (FR-513), the Shared Context UI (FR-514), and individual
  AI sessions started **in ATLAS terminals** through the documented interactive CLIs
  (`claude [prompt]`, `codex [PROMPT]`), plus best-effort tracking of existing terminals
  (FR-508–FR-510).
- **A2 (next):** SDD-004 Milestone B, then automatic capture of provider outcomes and the
  remaining Milestone A acceptance items that need it.

Verified locally while planning: Claude Code 2.1.304 and codex-cli 0.156.1 both accept an
initial prompt in interactive mode; SQLite FTS5 is available in Node 24 and in Electron 44.

## Context model (FR-501–FR-503)

| Entity            | Purpose                                                                                                        |
| ----------------- | -------------------------------------------------------------------------------------------------------------- |
| `ContextEntry`    | A record with scope, category, title, body, verification, source, file/commit references and a revision number |
| `ContextRevision` | Every version of an entry (who changed it, when and why); corrections never overwrite history                  |
| `ContextTask`     | A development objective with a base commit; its knowledge outlives the sessions that work on it                |
| `DecisionRecord`  | Question, decision, alternatives, reasoning, evidence; `ACTIVE`, `SUPERSEDED` (never erased) or `REJECTED`     |
| `AiSession`       | An individual Claude Code / Codex / terminal session: provider, capture mode, task, terminal, start commit     |
| `ContextHandoff`  | The FR-512 packet, extended with the owner and the evidence (entry and decision ids) it was built from         |
| `ContextSnapshot` | A stored bundle at a point in time (head commit and markdown)                                                  |

**Scopes.** `global` (explicitly shared conventions, no owner), `project` (registered
project), `workspace` (a Git repository root without a project), `task`, `session` and
`agent` (reserved for Milestone B). Every non-global record belongs to exactly one owner:
a project **or** a repository root. A removed project's records move to its repository root
(or its directory), like ATLAS Sessions.

**Categories.** overview, architecture, convention, command, objective, progress,
files-changed, commit, test-result, known-failure, blocker, pending-decision, next-action,
provider-reference, summary, note.

**Verification (FR-502).** `verified` entries come only from evidence ATLAS collected
(Git commits and changed files); `user` entries were written or approved by the user;
`observed` is reserved for agent reports (Milestone B). Editing an entry makes it the user's
statement. Test results are never marked as passed without execution evidence — handoff
validations stay empty until execution capture exists (A2).

**Storage (§11).** Migration v5 adds `context_tasks`, `ai_sessions`, `context_entries`,
`context_revisions`, `context_decisions`, `context_handoffs`, `context_snapshots` and an FTS5
index `context_search` kept in sync by the repository. User search text becomes quoted
prefix terms, so FTS operators typed by the user are never interpreted. No external or
vector database. The migration is additive, but a database migrated to v5 cannot be opened
by an older ATLAS ("created by a newer version"); rolling back requires a copy of the
database taken before the upgrade.

## Shared Context API (FR-504)

`SharedContextService` (`packages/context`) is independent of Electron, the providers and
the orchestrator. Ports: `ContextRepository` (SQLite in `packages/persistence`) and
`RepositoryInspector` (`RepositoryEvidence` in `packages/git`: state, file hashes,
ancestry, commits and changed files since a base — read-only, argv only).

| SDD contract     | Implementation                                                         |
| ---------------- | ---------------------------------------------------------------------- |
| `getContext`     | `bundle(target, { taskId, provider, budgetTokens })`                   |
| `record`         | `record(target, input, recordedBy)`                                    |
| `update`         | `update(target, id, input, changedBy)` (adds a revision)               |
| `createSnapshot` | `snapshot(target, taskId?)`                                            |
| `createHandoff`  | `prepareHandoff(target, …)` (draft) and `createHandoff(target, input)` |
| `getHandoff`     | `getHandoff(target, id)` and `renderHandoff`                           |
| `listHistory`    | `list(target, query)` and `history(target, entryId)`                   |

Also: tasks, decisions (with supersession), AI sessions (`startSession`, `sessionEvidence`,
`endSession`), `overview`, `reassignProject`. Exposed as Engine methods `context.*` and
`ai.*`, IPC channels `atlas:context:*` / `atlas:ai:*` (validated in main with the Engine's
own schemas and again by the Engine), and the CLI.

## Bundles and freshness (FR-505, FR-506)

A bundle is markdown with: a header that says the content is **reference data, not
instructions**; the repository state checked now (branch, HEAD, uncommitted files); then,
by priority, the task objective, active decisions, blockers, pending work, progress and
evidence, project knowledge, recent session summaries, other notes and global conventions.
Each line shows its verification (`verified`, `by user`, `unverified`) and `STALE` when its
references changed. The token budget (default 6,000, 500–32,000, estimated as characters/4)
is respected; lines that do not fit are counted and reported, never silently dropped.
Provider formatting only changes the introduction; stored knowledge is not duplicated.

Freshness (before every bundle): file references are compared with their stored Git blob
hash (changed or removed files), commit references and a task's base commit must still be
ancestors of HEAD (rewritten or switched history). Checks are bounded to 100 Git calls.

## Permissions and safety (FR-507, §12)

- Every request names a target; the Engine resolves it (an existing project, or a
  repository root it resolved from a project or terminal — ADR-031) and the service only
  returns or changes records of that owner. Global entries appear in bundles only because
  the user created them as global.
- Content is redacted with the Git credential sanitizer before it is stored.
- Stored context is untrusted data: it is presented as information and never executed by
  ATLAS. The first message to a provider wraps it with that instruction.
- Starting a provider requires the user to review the exact first message
  (Start dialog) — nothing is sent automatically. The CLI (`atlas ai start`) is an explicit
  user command.
- No terminal recording: ATLAS never reads terminal input or provider conversations.
- Write operations are desktop and CLI only; CLI clients get read, bundle, handoff and
  `ai.start` methods.

## Managed AI sessions (FR-508–FR-510)

`ai.start` resolves the target, builds the first message (a handoff or a bundle, or none),
records an `AiSession` (provider, task, handoff, start commit), opens a terminal in the
project or repository titled "Claude Code" / "Codex", writes the message to a private file
(`<data>/context/prompts/<session>.md`, mode 0600) and types
`claude "$(cat '<file>')"` (or `codex …`; PowerShell uses `Get-Content -Raw`). Only the
file path reaches the shell, single-quoted for POSIX shells.

Existing terminals: **Track as AI session** records an `attached` session (provider
`external`) from the terminal's directory. **Save session summary** ends a session: ATLAS
adds the commits and changed files since the session started (verified, from Git) and
stores the user's summary, completed and pending work, decisions and next actions (by user).

**Limitations, stated in the UI:** ATLAS does not read Claude's or Codex's conversation,
cannot capture outcomes automatically yet (A2), and relies on `claude` / `codex` being on
the terminal's PATH. POSIX shells and PowerShell are supported; `cmd.exe` is not.

## Handoffs (FR-511–FR-513)

A handoff draft is prefilled from the owner's memory (progress → completed work,
next-action → pending work, blockers and known failures, pending decisions → next actions,
active decisions) and from Git (commits since the task's or session's base commit — or the
latest 10 without one — and changed files including uncommitted and untracked ones). The
user edits it; on creation ATLAS collects the Git evidence again and stores the source
revision (HEAD). It is rendered as markdown for the receiving provider and can be copied or
used to start Claude Code or Codex. Both directions (Claude → Codex and Codex → Claude) use
the same packet.

## User interface (FR-514)

Main sidebar → **Context** (also from project details and the terminal context menu).
A project/repository selector and tabs: Overview (Claude / Codex / ATLAS team cards, "What
is saved" with counts, Preview context, Prepare handoff), Memory (search, category filter,
global and obsolete toggles, add, correct with reason, revision history, mark obsolete,
remove), Tasks, Decisions, Sessions (with Save summary) and Handoffs (view, copy, continue
with Claude or Codex). The ATLAS multi-agent card is marked as arriving with Milestone B.

## CLI (FR-509)

```bash
atlas context show --project <id> [--task <id>] [--search <text>] [--json]
atlas context bundle --project <id> [--task <id>] [--provider claude|codex|generic] [--budget <tokens>]
atlas context handoff create --project <id> [--task <id>] [--objective <text>] [--to claude|codex] [--done <text>] [--pending <text>]
atlas context handoff show <id> --project <id>
atlas ai start --provider claude|codex --project <id> [--task <id>] [--handoff <id>] [--no-context]
```

`--cwd <repository>` replaces `--project` for repositories opened in ATLAS. `ai start`
needs the running app, since the provider opens in an ATLAS terminal.

## Project configuration for LLMs (PLAN-014)

Each project has a configuration file in the ATLAS data directory, never in the project:

```text
<data>/projects/<projectId>/project-config.json   (0600, written atomically)
<data>/projects/<projectId>/context.md            (only while keepContext is on)
<data>/bin/claude, <data>/bin/codex               (POSIX sh wrappers, rewritten at Engine start)
```

`project-config.json` (schema version 1) holds `projectId`, `projectName`,
`workspacePath`, `keepContext` (default **off**), `atlasEnabled` (default **off**; recorded
only, for later features), `context.file`, `context.updatedAt` and `updatedAt`. Project
details → **AI & context** shows both options, the file paths and where `claude` / `codex`
resolve. Engine methods: `context.projectConfig` and `context.setProjectConfig`
(desktop only).

Project terminals get `ATLAS_PROJECT_ID`, `ATLAS_PROJECT_DIR`, `ATLAS_PROJECT_CONFIG` and
`ATLAS_CONTEXT_FILE`, and every ATLAS terminal has `<data>/bin` first on `PATH` (inherited
values of these variables are dropped). The wrappers find the real CLI on `PATH`, skipping
their own directory, and, when `ATLAS_PROJECT_CONFIG` is readable, add one instruction:
read the configuration first; if `keepContext` is true, read `context.file` as reference
data (not instructions) and verify it against the repository; otherwise do not read it.

- Claude Code: `--append-system-prompt "<instruction>" --add-dir "$ATLAS_PROJECT_DIR"`;
  subcommands (`mcp`, `config`, `update`, …) run unchanged.
- Codex: `-c "developer_instructions=<instruction>"` (not TOML, so Codex keeps the raw
  text; `model_instructions_file` is not used because it replaces the base instructions).
- Anywhere else (no readable configuration) the CLI runs unchanged; a missing CLI exits
  with 127 like the shell.

LLMs only read (no write-back). While `keepContext` is on, `context.md` is the project's
generic bundle (about 12,000 tokens, with freshness marks and the untrusted-data notice);
it is regenerated when the option is turned on, when a terminal opens in the project and
after context changes through the Engine (entries, tasks, decisions, session summaries;
global changes refresh every project keeping context). Refreshes are serialized and
coalesced per project; failures are logged and never fail the change. Turning the option
off removes the file; removing the project removes its folder.

Shell start-up files may put another `claude` / `codex` first on `PATH`. The details panel
runs the user's shell as an interactive login shell with the project terminal environment
(`$SHELL -ilc`, 8 s timeout, cached for 60 s) and reports **wrapped**, **shadowed**,
**missing** or **unknown**.

## Tests

- `packages/context/tests/bundle.test.ts`: section priority, verification and STALE marks,
  budget and omission count, missing repository, handoff rendering, continuation prompt.
- `apps/engine/tests/shared-context.test.ts` (SQLite and Git): project isolation and global
  entries, FTS search (including quote-safe queries), revisions, obsolete and removal,
  secret redaction, stale file and rewritten-history detection, decision supersession,
  handoffs with Git evidence, managed session start (terminal command, 0600 prompt file,
  POSIX quoting checked by a real shell), session summary with verified evidence,
  persistence across restarts, reassignment when a project is removed.
- `apps/desktop/tests/ipc.test.ts`: target authorization, record and list, provider
  validation, `ai.start` terminal command and session lookup.
- `apps/cli/tests/cli.test.ts`: show, bundle, handoff create/show, usage errors, offline
  `ai start`.
- `tests/e2e/context.spec.ts` (Electron, with fake `claude` / `codex` executables that
  record their first argument): memory, tasks and decisions; Claude started with reviewed
  context, then a session summary with Git evidence; a Claude → Codex handoff received by
  Codex; tracking an existing terminal; no horizontal overflow at 380 and 1,440 px; a
  project's AI options and `claude` typed in its terminal receiving the instruction
  (PLAN-014).
- `apps/engine/tests/project-config.test.ts` (PLAN-014): defaults and file location,
  context file refresh and removal, terminal variables and `PATH`, project removal,
  wrapper arguments (Claude, subcommands, Codex, pass-through, missing CLI) and the
  wrapped / shadowed / missing check through a real shell.

**Not verified automatically:** the real Claude Code and Codex CLIs. Automated tests use
fake executables; a manual end-to-end check with the real, authenticated CLIs is pending
and must not be reported as done until it is performed.

## Known limitations

- No automatic capture of provider outcomes or test results (A2); summaries are written or
  approved by the user, and validations in handoffs stay empty.
- Provider availability is not detected (SDD-004 Milestone B); a missing CLI shows the
  shell's own error in the terminal.
- `cmd.exe` is not supported for managed sessions.
- The LLM wrappers are POSIX only; on Windows the configuration file is written but CLIs
  are not told to read it. The wrappers cannot help when shell start-up files put another
  copy first on `PATH` (reported as **shadowed**), when a CLI is started by absolute path,
  or for LLM CLIs other than Claude Code and Codex.
- Following the instruction is up to the LLM; ATLAS cannot verify that it read the files.
- In a project terminal the Codex wrapper sets `developer_instructions` on the command line,
  which takes precedence over a `developer_instructions` value in the user's Codex
  configuration for that run. A user-supplied `--append-system-prompt` for Claude Code is
  passed after the wrapper's one; how Claude Code combines both is up to the CLI.
- Context changed outside the Engine API (another ATLAS CLI process writing the database)
  is reflected in `context.md` at the next refresh trigger.
- The first message is regenerated when the session starts; if the repository changes between
  the preview and the start, freshness marks in the sent text can differ from the preview.
- Workspace context requires a Git repository opened through a project or terminal.
- Retention is manual (remove or mark obsolete); compaction and retention policies belong to
  Milestone C.
- `agent` scope and `observed` verification are defined but unused until Milestone B.

---

# Part II — Specification as received

# 1. Mission

Implement ATLAS's first real multi-agent orchestration engine and a persistent, provider-independent context system.

The system must support:

1. Ordinary terminals with optional AI assistance.
2. Individual Claude Code, Codex CLI, and future LLM sessions.
3. Autonomous ATLAS multi-agent teams.
4. Context sharing between different AI providers.
5. Persistent project knowledge across sessions.
6. Task continuation after agents or sessions terminate.
7. Controlled collaboration between multiple agents.
8. Auditable decisions, execution results, and handoffs.

The defining requirement is:

**Context must outlive agents, provider sessions, orchestration sessions, and terminal processes.**

Users must be able to start a task with Claude Code, continue with Codex, delegate remaining work to an ATLAS team, and resume it later without manually reconstructing the complete history.

Do not build a system that merely copies entire conversations between providers.

Build structured, evidence-backed, reusable context.

---

# 2. Product Principles

## 2.1 Terminal Mode Remains Independent

ATLAS must continue functioning as a Warp-inspired terminal application.

Users must not be required to:

- Activate orchestration.
- Connect AI accounts.
- Create ATLAS Sessions.
- Enable context capture.
- Use agent teams.

All AI features must remain optional.

## 2.2 Shared Context Is a Platform Capability

The Context Engine must not belong exclusively to the multi-agent orchestrator.

It must be accessible to authorized:

- Claude Code sessions.
- Codex CLI sessions.
- Other supported LLM providers.
- ATLAS orchestration sessions.
- Individual ATLAS agents.
- Future integrations.

The same context infrastructure must support ordinary AI-assisted development and autonomous execution.

## 2.3 Knowledge Persists, Agents Are Disposable

Agents are temporary execution resources.

Knowledge must persist independently.

Destroying an agent or completing a session must not delete relevant project knowledge.

## 2.4 Source of Truth

Prioritize evidence in this order:

1. Current source code and repository state.
2. Verified test and build results.
3. Recorded architectural decisions.
4. Validated task outcomes.
5. Structured session summaries.
6. Unverified agent observations.

A previous agent's claim must not override current repository evidence.

---

# MILESTONE A — SHARED CONTEXT FOUNDATION

# 3. Context Architecture

## FR-501 — Context Scopes

Implement the following context scopes:

### Global Context

Reusable, non-sensitive preferences and conventions explicitly authorized for cross-project use.

Examples:

- Preferred development conventions.
- General architectural standards.
- Common tooling preferences.

### Project Context

Knowledge associated with a registered ATLAS project.

Examples:

- Architecture.
- Stack.
- Directory structure.
- Technical decisions.
- Development commands.
- Testing strategy.

### Workspace Context

Knowledge associated with a specific directory or repository/worktree.

A workspace may exist without a registered project.

### Task Context

Knowledge associated with a specific development objective.

Examples:

- Implement authentication.
- Fix a concurrency bug.
- Refactor a service.
- Add tests.

### Session Context

Execution-specific information associated with an individual AI or ATLAS session.

### Agent Context

Temporary, role-specific working information.

Agent context may be discarded after relevant knowledge has been consolidated.

## FR-502 — Persistent Memory

Create a persistent context repository.

Minimum entities:

- ContextEntry
- ContextScope
- ContextRevision
- ContextSource
- ContextSnapshot
- ContextLink
- ContextHandoff
- DecisionRecord

Every persistent entry must include:

- Unique identifier.
- Scope.
- Associated project/workspace/task when applicable.
- Content type.
- Creation timestamp.
- Update timestamp.
- Source reference.
- Confidence or verification status.
- Revision information.

Avoid treating all generated text as verified knowledge.

## FR-503 — Context Categories

Support structured records for:

- Project overview.
- Architecture.
- Technical decisions.
- Task objectives.
- Implementation progress.
- Files changed.
- Commits created.
- Test results.
- Known failures.
- Blockers.
- Pending decisions.
- Next actions.
- Provider execution references.

Context should be searchable by project, workspace, task, session, and category.

## FR-504 — Shared Context API

Implement provider-independent operations.

Suggested contract:

```typescript
interface SharedContextService {
  getContext(request: ContextRequest): Promise<ContextBundle>;

  record(entry: CreateContextEntry): Promise<ContextEntry>;

  update(id: string, revision: ContextRevisionInput): Promise<ContextEntry>;

  createSnapshot(scope: ContextScope): Promise<ContextSnapshot>;

  createHandoff(request: CreateHandoffRequest): Promise<ContextHandoff>;

  getHandoff(id: string): Promise<ContextHandoff>;

  listHistory(scope: ContextScope): Promise<ContextEntry[]>;
}
```

The service must remain independent of Electron, Claude Code, Codex CLI, and the orchestrator.

## FR-505 — Context Bundles

Generate compact context bundles for AI consumption.

A bundle should contain:

- Current objective.
- Relevant project architecture.
- Important decisions.
- Current task state.
- Relevant source files.
- Verified changes.
- Recent test results.
- Known blockers.
- Next recommended actions.
- References to additional context.

Do not include unrelated project history.

Use configurable token budgets.

Support provider-specific output formatting without duplicating stored knowledge.

## FR-506 — Context Freshness

Before constructing a context bundle:

- Inspect relevant repository state.
- Identify potentially stale file references.
- Detect changed branches or commits.
- Flag outdated assumptions.
- Distinguish verified information from historical notes.

Do not silently present stale context as current truth.

## FR-507 — Context Permissions

Implement explicit access boundaries.

A context request must identify:

- Requesting client or agent.
- Requested scope.
- Authorized project/workspace.
- Intended operation.

Do not expose unrelated project context by default.

Global context must not become a mechanism for leaking project secrets.

---

# 4. Ordinary AI Session Integration

## FR-508 — Provider-Independent Session Tracking

Support context continuity for ordinary Claude Code and Codex sessions, even when ATLAS orchestration is not active.

Create an AI Session concept separate from ATLAS multi-agent sessions.

An AI Session may be:

- A managed Claude Code session.
- A managed Codex CLI session.
- Another supported provider session.
- An externally started session with limited integration.

Each session should support optional association with:

- Project.
- Workspace.
- Task.
- Provider.
- Terminal.
- Shared context scope.

## FR-509 — Managed AI Sessions

Provide a way to launch an individual AI CLI through ATLAS with optional context integration.

Example conceptual commands:

```bash
atlas ai start --provider claude --project <id>

atlas ai start --provider codex --project <id>

atlas ai resume --task <task-id> --provider codex
```

These are proposed ATLAS CLI contracts, not assumed native provider commands.

The adapter must determine the actual supported invocation method.

When context integration is enabled:

1. Resolve the project and task.
2. Retrieve relevant context.
3. Generate a provider-compatible handoff.
4. Start the provider.
5. Supply context through a supported mechanism.
6. Track execution metadata.
7. Capture relevant outcomes.
8. Update persistent context after validation.

Do not rely on undocumented provider internals.

## FR-510 — Existing Terminal Integration

Allow users to associate an existing terminal with a context scope.

Provide actions such as:

- Attach Context.
- View Context.
- Prepare Handoff.
- Continue with Another Provider.
- Save Session Summary.

For arbitrary external CLI processes, do not claim automatic access to hidden provider conversation state.

Support best-effort integration through documented hooks, adapters, wrappers, explicit export, or user-approved summaries.

If automatic capture is unavailable, clearly indicate the limitation.

## FR-511 — Claude-to-Codex Handoff

Support this workflow:

1. User starts development with Claude Code.
2. Claude modifies files and records progress.
3. User requests continuation with Codex.
4. ATLAS creates a handoff packet.
5. Codex receives the relevant context.
6. Codex verifies the current repository state.
7. Codex continues the implementation.
8. The resulting knowledge is saved back to shared context.

The reverse direction must also be supported.

Provider changes must not require copying the complete original conversation.

## FR-512 — Handoff Packet

Define a structured handoff format.

Example:

```typescript
interface ContextHandoff {
  id: string;

  sourceSessionId: string | null;
  targetProviderId: string | null;

  projectId: string | null;
  taskId: string | null;

  objective: string;

  completedWork: string[];
  pendingWork: string[];

  decisions: string[];
  blockers: string[];

  changedFiles: string[];

  commits: string[];

  validations: Array<{
    command: string;
    status: 'PASSED' | 'FAILED' | 'NOT_RUN';
    evidence?: string;
  }>;

  nextActions: string[];

  sourceRevision: string | null;

  createdAt: string;
}
```

The implementation may extend this contract.

A handoff must reference its source evidence.

## FR-513 — Session Summarization

Support session summaries containing:

- Original objective.
- Actions performed.
- Verified results.
- Decisions made.
- Files modified.
- Tests executed.
- Incomplete work.
- Suggested continuation.

Summaries must distinguish observations from verified results.

Never mark tests as passed without execution evidence.

## FR-514 — Context UI

Create a Shared Context interface.

Minimum views:

- Project Memory.
- Task Memory.
- Session History.
- Decisions.
- Handoffs.
- Pending Work.

Allow users to:

- Inspect context.
- Search records.
- Correct inaccurate entries.
- Mark entries obsolete.
- Remove records.
- Create a manual handoff.
- Choose which context is shared.

Do not expose credentials or sensitive content unnecessarily.

---

# 5. Milestone A Acceptance Criteria

- [ ] Context persists independently of AI processes.
- [ ] Context works without multi-agent orchestration.
- [ ] Registered and standalone workspaces are supported.
- [ ] Project and task context are separated.
- [ ] Context bundles are generated.
- [ ] Context revisions are tracked.
- [ ] Claude-to-Codex handoff is supported.
- [ ] Codex-to-Claude handoff is supported.
- [ ] Ordinary AI sessions can opt into context integration.
- [ ] Unsupported automatic capture is clearly identified.
- [ ] Source references are preserved.
- [ ] Context remains available after application restart.
- [ ] Context access respects project permissions.
- [ ] Automated tests pass.

Do not begin Milestone B until Milestone A is validated.

---

# MILESTONE B — MULTI-AGENT ORCHESTRATION

# 6. Orchestration Engine

## FR-515 — Team Orchestrator

Implement a central orchestrator responsible for:

- Understanding a task objective.
- Building an execution plan.
- Selecting required roles.
- Assigning tasks.
- Tracking dependencies.
- Coordinating execution.
- Managing approvals.
- Collecting results.
- Validating outcomes.
- Producing a final report.

The orchestrator must not simply launch multiple LLMs with identical prompts.

Each agent must have a defined responsibility and deliverable.

## FR-516 — Dynamic Team Assembly

Support configurable roles:

- Product Owner.
- Software Architect.
- Staff Engineer.
- Senior Engineer.
- Junior Engineer.
- Security Engineer.
- QA Engineer.
- UI/UX Designer.
- Technical Reviewer.

Do not require every role for every task.

Select roles according to task complexity and configured team templates.

Support adding or removing roles before execution.

## FR-517 — Role-Based Context

Each agent must receive context appropriate to its responsibility.

Examples:

**Product Owner**

- Requirements.
- Acceptance criteria.
- Business constraints.

**Architect**

- System architecture.
- Existing design decisions.
- Integration boundaries.

**Developer**

- Assigned task.
- Relevant files.
- Coding conventions.
- Dependencies.

**QA**

- Acceptance criteria.
- Changed behavior.
- Testing strategy.

**Security**

- Threat boundaries.
- Sensitive changes.
- Security requirements.

Avoid injecting the entire project history into every agent.

## FR-518 — Planning Phase

Before executing a complex task, the orchestrator must produce:

- Task breakdown.
- Dependencies.
- Required roles.
- Acceptance criteria.
- Execution strategy.
- Risk assessment.
- Expected deliverables.

Store the plan in persistent task context.

Allow the user to review the plan when required by execution policy.

## FR-519 — Task Graph

Extend the SDD-003 task graph.

Support:

- Task dependencies.
- Parallelizable tasks.
- Blocking tasks.
- Assigned roles.
- Execution attempts.
- Validation requirements.
- Task results.
- Failure states.

Prevent dependency cycles.

Do not schedule tasks before required dependencies complete.

## FR-520 — Provider Assignment

Allow agents to use available provider adapters.

Examples:

- Claude Code for architecture.
- Codex CLI for implementation.
- Claude Code for review.
- Codex CLI for tests.

These are examples, not hardcoded role assignments.

Use explicit provider selection and configurable defaults.

Advanced automatic model/account routing belongs to SDD-008.

## FR-521 — Parallel Execution

Support parallel execution of independent tasks.

Requirements:

- Configurable concurrency.
- Task dependency enforcement.
- Resource limits.
- Cancellation.
- Timeout handling.
- Execution history.

For code-modifying tasks, prefer isolated Git worktrees.

Do not permit multiple agents to write to the same working tree concurrently without explicit coordination.

## FR-522 — Worktree Management

Implement or extend worktree management for agent execution.

Support:

- Creating an isolated worktree.
- Associating a worktree with an agent task.
- Tracking its branch and base commit.
- Inspecting changes.
- Detecting conflicts.
- Cleaning up after approval.

Do not automatically delete worktrees containing unmerged changes.

Do not automatically merge agent changes into protected branches.

## FR-523 — Agent Communication

Agents must communicate through structured messages.

Supported message types:

- TASK_ASSIGNED
- TASK_PROGRESS
- TASK_COMPLETED
- TASK_FAILED
- BLOCKER_REPORTED
- REVIEW_REQUESTED
- REVIEW_COMPLETED
- CONTEXT_REQUESTED
- CONTEXT_UPDATED
- APPROVAL_REQUIRED

Persist important messages as execution events.

Avoid unrestricted agent-to-agent conversation loops.

## FR-524 — Shared Task Knowledge

Agents must be able to publish relevant findings to task context.

Examples:

- Discovered API contract.
- Relevant architecture constraint.
- Test failure.
- Implementation decision.
- Identified dependency.

Shared context updates must be versioned and attributed.

Conflicting claims must be detected or flagged rather than silently overwritten.

## FR-525 — Review and Validation

Implement a review phase.

The orchestrator must:

1. Collect implementation results.
2. Inspect changed files.
3. Request review where configured.
4. Run available validation commands.
5. Record test evidence.
6. Identify unresolved issues.
7. Request corrections when appropriate.
8. Produce a final delivery report.

A reviewer must not claim to have inspected files or tests it did not access.

## FR-526 — Automatic Correction

Allow bounded correction cycles.

Example:

Implementation → Tests → Failure → Diagnosis → Correction → Tests.

Requirements:

- Configurable retry limits.
- Time and resource budgets.
- Failure classification.
- Progress detection.
- Escalation when blocked.

Do not create infinite agent loops.

## FR-527 — Supervised Autonomy

Support approval checkpoints.

Require approval for sensitive or destructive operations.

Examples:

- Production deployment.
- Destructive database operations.
- Credential access.
- Protected branch modification.
- Irreversible Git operations.

Do not bypass provider-native permission mechanisms.

If the system cannot reliably enforce an approval boundary, it must restrict execution rather than claiming safe supervision.

## FR-528 — Team Templates

Provide initial reusable templates:

- Backend Feature Team.
- Fullstack Feature Team.
- Bug Fix Team.
- Security Review Team.
- QA Automation Team.
- Architecture Review Team.

Templates define roles, responsibilities, and execution strategy.

They must not hardcode provider account credentials.

## FR-529 — Execution Profiles

Integrate existing profiles:

- ECONOMY.
- BALANCED.
- MAXIMUM.

Profiles may control:

- Concurrency.
- Planning depth.
- Review intensity.
- Retry budgets.
- Preferred provider configuration.

They must not weaken security policies.

## FR-530 — Team Lifecycle

A team must have an explicit lifecycle:

- CREATED
- PLANNING
- READY
- EXECUTING
- REVIEWING
- WAITING_APPROVAL
- COMPLETED
- FAILED
- CANCELLED

Agent processes must be released after completion.

Persistent task knowledge and execution evidence must remain available.

## FR-531 — Multi-Agent Interface

Create a Team Execution view.

Display:

- Session objective.
- Team members.
- Assigned providers.
- Task graph.
- Task statuses.
- Active executions.
- Agent activity.
- Validation results.
- Pending approvals.
- Final summary.

Allow users to inspect individual agent execution logs.

Do not invent activity or show fake progress.

---

# 7. Milestone B Acceptance Criteria

- [ ] Orchestrator creates execution plans.
- [ ] Teams are assembled according to task requirements.
- [ ] Roles have distinct responsibilities.
- [ ] Agents receive scoped context.
- [ ] Tasks respect dependencies.
- [ ] Independent tasks can execute concurrently.
- [ ] Agents can use Claude and Codex through existing adapters.
- [ ] Code modifications use isolated workspaces where required.
- [ ] Agent findings update shared context.
- [ ] Review and validation stages work.
- [ ] Correction cycles are bounded.
- [ ] Approval checkpoints work within documented enforcement limits.
- [ ] Team execution is visible in Electron.
- [ ] Team processes terminate without deleting project knowledge.
- [ ] Automated tests pass.
- [ ] At least one real multi-agent workflow is verified end-to-end.

Do not begin Milestone C until Milestone B is validated.

---

# MILESTONE C — CONTINUITY & RECOVERY

# 8. Persistent Development Continuity

## FR-532 — Cross-Session Continuation

A new session must be able to continue work performed by previous sessions.

Example:

Session 1:
Claude implements authentication.

Session 2:
Codex implements integration tests.

Session 3:
ATLAS team reviews and refactors.

Session 4:
Claude continues unfinished work.

All sessions must be able to retrieve relevant verified context.

The user must not be required to manually explain the entire development history again.

## FR-533 — Task Continuity Record

Maintain a durable record of:

- Objective.
- Original requirements.
- Current implementation state.
- Completed tasks.
- Pending tasks.
- Relevant decisions.
- Files modified.
- Commits.
- Validation evidence.
- Known issues.
- Recommended next steps.

The record must be updated at meaningful checkpoints.

## FR-534 — Automatic Checkpoints

Create checkpoints:

- After planning.
- After significant implementation.
- After validation.
- Before provider handoff.
- Before session termination.
- After task completion.
- Before sensitive operations when practical.

Checkpoints must not require saving entire raw conversations.

## FR-535 — Resume Context

When starting a new session, ATLAS should identify:

- Relevant prior work.
- Current repository state.
- Pending objectives.
- Previous blockers.
- Decisions that remain applicable.
- Unverified assumptions.

Present a concise continuation summary.

Allow users to inspect or modify it before execution.

## FR-536 — Context Reconciliation

Before resuming work:

1. Inspect the current branch and commit.
2. Compare relevant files with saved references.
3. Identify changes made outside ATLAS.
4. Detect stale assumptions.
5. Revalidate relevant decisions.
6. Flag conflicting context.
7. Produce an updated continuation bundle.

Do not blindly trust historical context.

## FR-537 — Decision History

Implement persistent decision records.

Each decision should include:

- Decision identifier.
- Problem or question.
- Chosen approach.
- Alternatives considered.
- Reasoning summary.
- Supporting evidence.
- Affected modules.
- Timestamp.
- Author or agent.
- Current status.

Support statuses such as:

- ACTIVE.
- SUPERSEDED.
- REJECTED.

Do not erase superseded decisions.

## FR-538 — Context Health

Track context quality.

Detect:

- Excessive context size.
- Duplicate entries.
- Stale references.
- Conflicting decisions.
- Missing source evidence.
- Excessive irrelevant history.

Generate compact context bundles without discarding important durable knowledge.

Do not equate a shorter context with a better context unless required information is preserved.

## FR-539 — Context Compaction

Implement structured compaction.

Preserve:

- Verified decisions.
- Task state.
- Source references.
- Important constraints.
- Outstanding blockers.
- Validation evidence.

Reduce:

- Repeated conversation.
- Superseded temporary observations.
- Redundant summaries.
- Irrelevant tool output.

Keep the original audit history according to retention policy.

## FR-540 — Session Recovery

After an Engine interruption:

- Restore persisted session metadata.
- Identify interrupted executions.
- Reconcile task states.
- Preserve completed work.
- Restore context checkpoints.
- Offer safe continuation options.

Do not automatically replay side-effecting operations.

## FR-541 — Context Timeline

Provide a chronological development timeline.

Display:

- Sessions.
- Agents.
- Tasks.
- Decisions.
- Commits.
- Tests.
- Handoffs.
- Checkpoints.

Allow filtering by project, task, provider, and date.

## FR-542 — Manual Context Controls

Users must be able to:

- Inspect stored context.
- Edit or correct entries.
- Remove context.
- Mark information obsolete.
- Export a handoff.
- Import a compatible handoff.
- Disable context capture.
- Control retention.

Avoid silently capturing sensitive terminal activity.

---

# 9. Milestone C Acceptance Criteria

- [ ] Completed session knowledge remains accessible.
- [ ] New sessions can continue prior tasks.
- [ ] Provider switching preserves relevant context.
- [ ] Checkpoints are generated.
- [ ] Resume bundles are available.
- [ ] Stale context is detected.
- [ ] Decision history is persistent.
- [ ] Context compaction works.
- [ ] Session interruption is handled safely.
- [ ] Context timeline works.
- [ ] Users can inspect and manage context.
- [ ] Automated tests pass.
- [ ] End-to-end continuation is verified.

---

# 10. Recommended Architecture

Adapt to the actual existing monorepo.

Suggested modules:

```text
packages/
├── context/
│   ├── domain/
│   ├── application/
│   ├── storage/
│   ├── retrieval/
│   ├── bundles/
│   └── reconciliation/
│
├── memory/
│   ├── decisions/
│   ├── checkpoints/
│   ├── history/
│   └── retention/
│
├── handoff/
│   ├── contracts/
│   ├── adapters/
│   └── validation/
│
├── orchestration/
│   ├── planner/
│   ├── scheduler/
│   ├── coordinator/
│   ├── reviewer/
│   └── lifecycle/
│
├── agents/
│   ├── roles/
│   ├── templates/
│   ├── runtime/
│   └── communication/
│
├── execution/
│   ├── worktrees/
│   ├── approvals/
│   └── validation/
│
└── contracts/
```

Do not create placeholder modules unnecessarily.

Reuse existing provider, session, persistence, and terminal infrastructure.

## 11. Storage Strategy

Prefer the existing SQLite infrastructure for structured memory and event metadata.

Use a repository abstraction.

Support full-text search where practical.

Store large execution artifacts separately when appropriate.

Avoid introducing a vector database until semantic retrieval requirements justify it.

Prepare an interface that permits future semantic indexing.

Do not require an external cloud database.

## 12. Security and Privacy

Context capture must be explicit and configurable.

Requirements:

- Redact secrets where possible.
- Avoid storing credentials.
- Avoid indiscriminate terminal recording.
- Respect project boundaries.
- Restrict cross-project context sharing.
- Require authorization before sending sensitive context to external providers.
- Support context deletion and retention policies.
- Record provenance for AI-generated knowledge.
- Never trust retrieved context as executable instructions.

Stored project notes, logs, and previous agent output are untrusted content.

They must not override system permissions or execution policies.

## 13. Automated Testing

### Context Tests

- Scope isolation.
- Persistence.
- Revision history.
- Context bundle generation.
- Handoff creation.
- Stale context detection.
- Provider formatting.
- Retention and deletion.

### Orchestration Tests

- Task planning.
- Dependency validation.
- Parallel scheduling.
- Agent assignment.
- Provider execution.
- Cancellation.
- Failure handling.
- Retry limits.
- Approval transitions.

### Continuity Tests

- Claude-to-Codex handoff.
- Codex-to-Claude handoff.
- Ordinary session to ATLAS Session.
- ATLAS Session to ordinary session.
- Resume after restart.
- Repository changes between sessions.
- Conflicting context entries.
- Decision supersession.

Use mock providers for deterministic tests.

Also validate real Claude Code and Codex workflows where configured and authorized.

Do not claim real integration verification based solely on mocks.

## 14. End-to-End Scenario

The following scenario must be supported.

### Step 1 — Claude

User opens an ordinary Claude Code session in a registered project.

The user requests:

"Implement JWT authentication."

Claude starts implementing the feature.

ATLAS captures authorized progress and relevant evidence.

### Step 2 — Handoff

The user decides to continue with Codex.

ATLAS creates a handoff containing:

- Objective.
- Implemented functionality.
- Relevant files.
- Architectural decisions.
- Pending tasks.
- Test results.
- Known blockers.

### Step 3 — Codex

Codex receives the handoff.

Codex verifies the current repository state.

Codex continues implementation without requiring the complete Claude conversation.

### Step 4 — ATLAS Team

The user requests a multi-agent review.

ATLAS creates a temporary team:

- Staff Engineer.
- Security Engineer.
- QA Engineer.

Agents receive role-specific context.

They inspect the implementation and report findings.

### Step 5 — Completion

ATLAS consolidates:

- Final implementation state.
- Relevant decisions.
- Tests.
- Commits.
- Remaining limitations.

The temporary team terminates.

### Step 6 — Future Session

Days later, the user starts a new session.

ATLAS retrieves the relevant development context.

The new session understands the previous implementation and can continue from the actual repository state.

**This scenario is a mandatory architectural acceptance test.**

If the provider cannot expose its ordinary session history, validate the scenario using managed sessions and documented integration mechanisms, and report the limitation explicitly.

---

# 15. Implementation Sequence

## Milestone A

1. Inspect existing provider and session architecture.
2. Define context scopes and contracts.
3. Implement persistent context storage.
4. Implement context retrieval.
5. Implement context bundles.
6. Implement provider-independent handoffs.
7. Integrate managed individual AI sessions.
8. Add optional ordinary terminal integration.
9. Build Shared Context UI.
10. Validate Claude/Codex handoff.

## Milestone B

1. Implement orchestrator contracts.
2. Implement team templates.
3. Implement planning.
4. Implement task scheduling.
5. Implement role-specific context.
6. Implement agent execution coordination.
7. Implement worktree isolation.
8. Implement agent communication.
9. Implement review and correction cycles.
10. Build multi-agent UI.
11. Validate real team execution.

## Milestone C

1. Implement persistent continuity records.
2. Implement checkpoints.
3. Implement resume bundles.
4. Implement context reconciliation.
5. Implement decision history.
6. Implement context health.
7. Implement compaction.
8. Implement recovery.
9. Build context timeline.
10. Validate cross-session continuation.

## 16. Documentation

Create:

`docs/sdd/SDD-005-multi-agent-and-shared-context.md`

Update:

- docs/ARCHITECTURE.md
- docs/ROADMAP.md
- docs/STATUS.md
- docs/DECISIONS.md

Document:

- Context model.
- Scope boundaries.
- Provider integration capabilities.
- Handoff contracts.
- Orchestration architecture.
- Team lifecycle.
- Execution isolation.
- Recovery limitations.
- Security policies.
- Test evidence.

## 17. Out of Scope

Do not fully implement:

- Advanced multi-account routing.
- Automatic subscription quota discovery.
- Distributed remote workers.
- Centralized team-wide memory server.
- Full Skills Hub management.
- Semantic vector database.
- Automatic production deployment.
- Self-modifying ATLAS updates.
- VS Code editor integration.

These belong to future specifications.

However, preserve interfaces that permit their later integration.

## 18. Final Instructions for Claude Code

Act as the Principal Software Architect and implementation lead.

Follow Spec-Driven Development.

Inspect the existing repository and reuse established architecture.

Implement the specification incrementally.

Do not begin Milestone B before validating Milestone A.

Do not begin Milestone C before validating Milestone B.

Use Conventional Commits for implementation commits.

Preserve the normal terminal experience.

Do not fabricate agent execution, context capture, test results, or provider capabilities.

Provide a concise report after each milestone:

- Implemented features.
- Files changed.
- Architectural decisions.
- Tests executed.
- Test results.
- Known limitations.
- Remaining work.

**Expected result:**

ATLAS must support persistent, shared development context across individual Claude Code sessions, Codex CLI sessions, and temporary multi-agent teams.

Agents may come and go, but the development knowledge must remain available, verifiable, and reusable.

A future session must be able to understand what previous sessions accomplished and continue the work without reconstructing the entire conversation history.
