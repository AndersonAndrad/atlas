# SDD-026 — AI Project Audit & Task Discovery

Status:

- **Task 01 Milestone A** is implemented (PLAN-054 revision 1). Its Milestones B (findings
  review and decision memory) and C (task creation and execution) need explicit authorization.
- **Task 02** (Execute with ATLAS) is implemented as a sequential minimal integration
  (PLAN-055 revision 1), because the multi-agent orchestration engine does not exist.

## Task 01 — Milestone A: audit engine and structured findings

Approved 2026-10-27 by Anderson Andrade ("aprovado, pode seguir e q1 a q4 segue o
recomendado"). R1–R10 were presented but not acknowledged by ID. Version 0.40.0, schema v21.

Decisions:

- **Q1:** audits run as `AGENT` background jobs; `AGENT` was already reserved in SDD-012.
- **Q2:** Codex can be used after the user acknowledges a warning. Its sandbox lets it run
  commands.
- **Q3:** the prompt carries no shared context, only the project name, the categories and the
  scope.
- **Q4:** the results are a read-only list. Review actions come in Milestone B.

### Gaps found before planning

| Assumed                    | Actual state                                                            | Decision                                                                  |
| -------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| AI Provider Router         | SDD-008 Milestones A and C not started; providers only run in terminals | Usage account profiles and the real CLI found outside the ATLAS wrappers  |
| Headless AI execution      | Does not exist                                                          | Claude Code and Codex in their non-interactive modes, without a shell     |
| Project indexing for scope | Git's file list and ignore rules (editor)                               | Reused for scope checks and evidence; the provider reads the files itself |
| AI Usage metrics for a run | Per-session cost comes from the Claude Code status line only            | Tokens and cost reported by the CLI are stored with the audit             |

### Architecture

```text
Analyze Project dialog ── audit.start ──► ProjectAuditService (packages/audit)
                                           │ validates the input, provider and scope
                                           │ stores the audit (QUEUED)
                                           ▼
                                   JobService: AGENT job (SDD-012)
                                           │
                                   AuditJobExecutor ──► ProjectAuditService.execute
                                                         │ Git snapshot before
                                                         │ CliAuditRunner (claude / codex)
                                                         │ Git snapshot after
                                                         │ parseAuditReport + validateFinding
                                                         ▼
                                           project_audits + project_audit_findings
```

- `packages/audit` holds the pure logic: the report schema, validation, fingerprints, the
  prompt and the service. It reaches the outside only through ports: the store, the project
  lookup, the workspace, the runner, the jobs and the account profiles.
- Engine adapters:
  - `CliAuditRunner` (`adapters/audit-cli.ts`) runs the CLIs.
  - `GitAuditWorkspace` (`adapters/audit-workspace.ts`) reads paths and Git status.
  - `AuditJobExecutor` (`jobs/audit-executor.ts`) runs the job and keeps a redacted log.
- `audit` events carry each change to the clients. No new queue or orchestration exists.
- The Engine methods are `audit.options`, `audit.start`, `audit.list`, `audit.get` and
  `audit.cancel`. They are desktop only; the CLI does not offer them.

### Entry points

- **Project Hub → Audits** (a project must be chosen): **Analyze project…**, the history of
  audits, and the results.
- **Analyze project…** in a project's actions, from the Projects drawer and the project
  palette. It opens the Hub's Audits with the dialog.

The dialog shows:

- the project;
- each provider with its availability or the reason it is unavailable;
- the account profiles;
- the eight categories, with a **Default profile** button;
- the scope;
- the read-only mode and where the data goes;
- any warnings to acknowledge.

No cost or duration estimate is shown: none can be computed reliably. Closing the dialog
after **Start audit** does not stop the audit. The job appears in Operations, with its log
and cancellation.

### Categories and scopes

Categories:

- `architecture`
- `security`
- `design-patterns`
- `code-quality`
- `reliability`
- `testing`
- `performance`
- `developer-experience`

The default profile is architecture, security, code quality and reliability.

| Scope          | Checked before queueing                                                                                                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entire project | The folder is reachable; the prompt asks to skip generated, vendored and ignored files                                                                                                            |
| Folders/files  | At most 50 relative paths. No absolute paths and no `..`. Resolved with symbolic links inside the project, existing, of the right kind, and not ignored by Git (ATLAS's default list outside Git) |
| Changed files  | Only Git repositories with uncommitted changes. Deleted files are left out. At most 300 files are recorded                                                                                        |

A second audit of the same project and scope cannot be queued while one is active
(`AUDIT_ACTIVE`). The check is serialized.

### Read-only enforcement and limitations (FR-006)

| Provider    | How it runs                                                                                                                                                                                                                                                                                                                                                   | What it still allows                                                                               |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Claude Code | `claude -p --restricted --tools Read,Grep,Glob --allowedTools Read,Grep,Glob --permission-mode dontAsk --strict-mcp-config --no-session-persistence --output-format json --json-schema …`. Restricted mode removes the tools that run commands or code, ignores user and project settings (and so their hooks), and confines file tools to the project folder | Reading files of the project, which are sent to Anthropic                                          |
| Codex       | `codex exec --sandbox read-only -c approval_policy="never" --ephemeral --json --output-schema … --output-last-message … -C <project> -`. The operating system sandbox blocks writes and network access                                                                                                                                                        | Running commands, including project scripts, inside the sandbox; requires the acknowledged warning |

- ATLAS checks the CLI's `--help` for these options. A CLI without them is unavailable, so
  ATLAS never falls back to a less restricted mode.
- The prompt goes through standard input. Arguments never go through a shell.
- The real CLI is used, never the ATLAS terminal wrapper.
- The prompt's rules are a request to the model, not the guarantee.
- ATLAS records the Git status (HEAD, and the status, size and time of changed paths)
  before and after. A difference is shown as "Project files changed while the audit ran",
  with the paths. ATLAS cannot tell whether the provider or the user changed them.
- Outside Git the check is "unverifiable".
- ATLAS itself never writes to the project during an audit.

### Finding schema (FR-007)

The CLI must answer with JSON that matches `AUDIT_REPORT_JSON_SCHEMA`. The schema is strict:
every property is required, and nullable when optional. The report has two fields:

- `summary`
- `findings`

Each finding has these fields:

- `title`
- `category`
- `severity`: `CRITICAL`, `HIGH`, `MEDIUM`, `LOW` or `INFORMATIONAL`
- `confidence`: `HIGH`, `MEDIUM` or `LOW`
- `kind`: `observation` or `hypothesis`
- `description`
- `evidence`
- `excerpt`
- `locations`: each has `path`, `startLine`, `endLine` and `symbol`
- `impact`
- `recommendation`
- `suggestedTaskTitle`
- `acceptanceCriteria`
- `effort`: `small`, `medium`, `large` or null

How the answer is parsed:

- **Text cleanup.** Text is plain: control and bidirectional characters are removed and
  lengths are capped. Enumerations are accepted in any letter case.
- **Malformed entries.** Each finding is validated on its own. An entry without the required
  fields is counted as malformed and not shown. At most 100 findings are kept.
- **Answers that are not a report.** These fail the audit, and no finding is stored.

ATLAS adds these fields to each finding:

- `fingerprint`
- `validation`: `evidence-located`, `needs-review` or `invalid`
- `validationNotes`
- `containsCommands`

Each location gets a status:

- `located`
- `line-out-of-range`
- `missing`
- `outside-project`
- `ignored`
- `not-a-file`

### Evidence validation (FR-008)

- Paths are resolved relative to the project, or absolute inside it, following symbolic
  links. Paths outside the project are shown as "(outside the project)" and never read.
- A finding is **invalid** when none of its files exist inside the project.
- A finding **needs review** when:
  - it has no location;
  - a line is past the end of the file (it is kept, not discarded);
  - it quotes no excerpt;
  - its excerpt is not in the files;
  - its title, task title or a symbol contains a shell command.
- Excerpt matching ignores whitespace, line-number gutters and `...`. Files over 2 MB or
  binary files are checked for existence only.
- **Evidence located** means only that the files, lines and quoted code exist. The UI states
  that the issue is still the provider's claim. Hypotheses are labelled "not confirmed".
- Commands are labelled and shown as text. ATLAS never runs them.

### Deduplication (FR-010, groundwork for Milestone B)

The fingerprint is a SHA-256 of these values:

- the project;
- the category;
- the sorted file paths;
- the symbols;
- the normalized excerpt, or the description's sorted distinct terms when no code was quoted.

Titles and line numbers are not used. Milestone B adds decision memory, deduplication across
audits and suppression.

### Persistence

Migration v21 adds two tables:

- `project_audits`: the chosen configuration as JSON, the result as JSON, the status and the
  job.
- `project_audit_findings`: indexed by project and fingerprint.

Both are removed with their project. Findings are stored in one transaction with the
completed audit. Only `setJob` writes the job link, so a lifecycle update cannot erase it.

After a restart, audits that were queued or running become **interrupted**, like their jobs.
A job cancelled while queued ends its audit as **cancelled**.

### Metrics (FR-016)

Usage comes from the CLIs:

- Claude Code reports input tokens (including cache), output tokens, `total_cost_usd` (shown
  as "provider estimate") and duration.
- Codex reports the tokens of its `turn.completed` events.

Missing values are shown as not reported. Subscription percentages are never converted to
money.

### Security assumptions (FR-015)

- No credentials go into prompts. Logs pass through the credential redactor.
- The account profile is selected with `CLAUDE_CONFIG_DIR` or `CODEX_HOME`, as in terminals.
- Repository content is untrusted:
  - The prompt says so.
  - The tools or sandbox limit what injected instructions can do.
  - The answer is schema-validated plain text, rendered as text.
- File paths are validated before display and before opening in the editor.
- Data goes to the selected provider the same way it does when the user runs that CLI in a
  terminal, and the dialog says so.
- Audits run only in the desktop Engine host. Other clients see the providers as
  unavailable.

### Known limitations

- Codex can still run commands, including project scripts, inside its read-only sandbox.
- Claude Code's guarantees depend on its `--restricted` mode. The option is checked, but its
  behavior is the CLI's.
- The change check does not cover files inside ignored folders, or projects outside Git.
- Large projects: the provider chooses what to read. There is no context packing, token
  budget or cost estimate.
- Opening evidence in the editor moves to the reported line only the first time the file is
  opened.
- No filters, decisions, deduplication across audits or task creation yet (Milestones B and
  C).
- Tested with fake CLIs only. A manual check with real Claude Code and Codex is pending.

### Tests

- **Unit, `packages/audit`:** report parsing, validation, fingerprints, prompt, snapshot
  comparison and the service lifecycle.
- **Persistence:** the v21 repository.
- **Engine:**
  - the CLI runner with fake POSIX CLIs: arguments, standard input, profile, time-out,
    cancellation, errors;
  - the Git workspace in a real repository: symbolic links, ignore rules, changed files,
    snapshots;
  - the executor behind a real job queue: redacted log, cancelling running and queued
    audits, no second job;
  - an Engine without process ownership: providers unavailable.
- **E2E** (`tests/e2e/audit.spec.ts`, Linux and Xvfb):
  - entry from the Projects drawer, defaults, nothing before Start, validated findings,
    restricted arguments, prompt on standard input, files unchanged, opening evidence;
  - the Codex warning gate and a provider failure.

---

## Task 02 — Execute with ATLAS (one-click team execution)

Approved 2026-10-27 by Anderson Andrade ("aprovado, q1 a q4 recomendado, ciente R1–R4").
R5–R8 were presented but not acknowledged by ID. Version 0.41.0, schema v22.

Decisions:

- **Q1:** all three milestones, as a sequence of members.
- **Q2:** the next member starts automatically when the previous one succeeds. The preview
  offers manual advance instead.
- **Q3:** the assessment is deterministic; no provider is called.
- **Q4:** Preflight at the end is optional. It runs as a job with the checks authorized in
  the preview.

### Gap: no orchestration engine

The specification assumed SDD-005 Multi-Agent Orchestration. It does not exist:

- SDD-005 Milestone B was never started.
- There is no task DAG, no agent-to-agent handoff and no worktree isolation.
- AI providers can change files only interactively in ATLAS terminals.

The minimal compatible integration reuses what exists:

| Specified                  | Implemented with                                                                                   |
| -------------------------- | -------------------------------------------------------------------------------------------------- |
| Orchestration engine / DAG | A fixed order of members; each is an ordinary task execution (SDD-025) in a new terminal           |
| Agent handoffs             | Each member's objective carries a handoff of what Git shows the earlier members changed            |
| Role-specific context      | The member's context bundle uses its role (`agentRole`); the task's shared context is not repeated |
| Parallel execution         | Not offered: without worktrees two members could edit the same files                               |
| Quality gates              | Optional Preflight profile as a background job at the end                                          |
| Provider router            | Usage account profiles and their last reported subscription use                                    |

No second scheduler or queue exists. A team is a record that starts the next run when the
previous one settles. Teams are not background jobs, so the team's id stands in for the
operation id. Only its optional Preflight runs as a job.

### Task assessment (FR-002)

`assessTask` (`packages/context`, pure) reads these inputs:

- the task's title and objective;
- the files that the objective and the task's context entries name;
- the active decisions of the project or task.

It finds disciplines from words and file types:

- architecture
- backend
- frontend
- security
- testing
- documentation

It scores complexity (simple, moderate, complex) from these signals:

- both backend and frontend;
- structural impact;
- security;
- five or more files;
- four or more criteria;
- a long objective.

Acceptance criteria are the bullet, numbered or Given/When/Then lines of the objective. There
is no repository audit, and every conclusion comes with the evidence behind it.

### Team proposal (FR-003, FR-004)

`recommendRoles` returns the smallest team:

- **Simple task:** one Engineer, or a Documentation Specialist for documentation-only tasks.
- **Moderate or complex task:**
  - an Architect when the task is complex or has structural impact;
  - Backend and Frontend Engineers when both sides are involved, one Engineer otherwise;
  - a Security Reviewer when there is a security signal;
  - QA when there is a testing signal or the task is complex;
  - Documentation when docs are mentioned.

Every role states why it is there. The team has at most 6 members, in a fixed order.
Coordinator and Product Owner are not agents: ATLAS and the user hold those roles.

`allocateProvider` chooses a provider and an account for each member:

- **Provider:** Claude Code when it is installed. Otherwise another installed provider, with
  a visible substitution notice that the approval accepts.
- **Account:** the visible account with the lowest known subscription use, skipping limited
  ones. With no known use, the CLI's default account is kept. Capacity is never invented.

### Preview and approval (FR-005, FR-006)

**Execute with ATLAS** is the first action of an open task: a button, plus an entry in the
More actions and right-click menus. Choosing **ATLAS team** in Execute… leads to the same
preview. The preview shows:

- the assessment;
- each member with its reason, responsibility, deliverables, provider and account (all
  editable: members can be removed, added, or have their provider and account changed);
- whether to advance automatically;
- the optional Preflight profile, with its checks that need authorization;
- the risks.

Cost is not estimated. **Reject proposal** and **Cancel** close the preview without saving
or running anything.

**Approve and run** sends the plan (`ai.approveTeamPlan`). The Engine checks it again:

- the task is open;
- no team or run of the task is active;
- each provider is installed;
- each account belongs to its provider;
- roles are unique;
- the Preflight profile belongs to the project.

The approved plan is stored with a unique request id (migration v22, `team_executions`).
Only then does the first member start. The team never grows, and providers never change,
without a new approval.

### Execution lifecycle (FR-007 to FR-011)

```text
approve → member 1 (task execution, new terminal) ── settles ──► next member … ──► Preflight? ──► REVIEW_REQUIRED
                      │ failed / interrupted / untracked / could not start
                      └──► PAUSED (notification) ── Retry member | Skip member | Member finished | Cancel team
```

How the members run:

- Each member is a task execution with:
  - its role's context bundle;
  - an objective that names its role, its place in the team, its deliverables, and the
    handoff (commits and changed files since each earlier member's session started).
- The tracker's settle hook drives the team:
  - success starts the next member, or pauses in manual mode;
  - anything else pauses.
- Pauses explain the decision needed, and the user's choice resumes the team. Nothing is
  rerun, skipped or continued without the user.
- An untracked member (no wrapper) cannot report its end. The user confirms it finished.
- Members' own notifications are not sent. The team sends one when it needs a decision and
  one when it finishes.
- Cancelling sends Ctrl+C to the running member, like Execute…. Members that have not
  started are cancelled.

### Results and review (FR-012, FR-014, FR-015)

When the last member ends, the team records:

- the changed files and commits Git shows since the first member started;
- the Preflight result, when one was requested;
- the subscription use (a percentage) of the accounts the team used, never converted to
  money.

Measured cost per member is not linked: Claude Code session costs appear in the Usage view.
Codex reports none in terminals.

The team becomes **review required** and the task stays open. **Mark reviewed** also reviews
each member's run and terminal.

The task shows its last three teams: members, statuses, terminals, pauses and summaries.
Teams follow their task when a project is removed.

### Failure and recovery (FR-013)

| Failure                        | Behavior                                                         |
| ------------------------------ | ---------------------------------------------------------------- |
| Provider not installed         | Not offered; approval refuses it                                 |
| Member cannot start            | Paused (`launch-failed`) with the reason                         |
| Member fails / is interrupted  | Paused; Retry member starts a new run of the same role           |
| Member untracked               | Paused until the user confirms it finished                       |
| Preflight fails                | Recorded as failed; the team still asks for review               |
| Preflight checks changed       | Recorded as "needs a new authorization"; run it from Preflight   |
| User cancels                   | Team cancelled; running member interrupted with Ctrl+C           |
| ATLAS quits                    | After restart, active teams are paused; nothing reruns           |
| Conflicting file modifications | Prevented by running one member at a time; no merge logic exists |

### Known limitations

- Not real multi-agent orchestration: members run one after another, interactively, in
  their own terminals. The user exits each CLI to finish its member.
- Handoffs carry only what Git shows. What a member concluded or decided is captured only
  if it records it in shared context (SDD-005 A2 does not exist).
- With automatic advance, the next member may change files before the user reviews the
  previous one.
- The recommendation is a heuristic. It can be edited, and it explains each role.
- No parallel members, no worktrees, no conflict resolution.
- Tasks created from audits do not exist yet (Task 01 Milestone C). The action works for any
  open shared-context task.
- Opening the proposal of a project registers it in Preflight, as opening the Preflight view
  does, so that its profiles can be listed.
- Tested with a fake CLI only. A manual check with real Claude Code and Codex is pending.

### Tests

- **Unit, `packages/context`:** assessment, roles, allocation, risks and the stage objective.
- **Persistence:** v22, the unique request, history, ownership moves.
- **Engine:** proposal, no run before approval, repeated approval, active task, provider and
  account validation, automatic and manual advance, handoff, failure, retry, skip,
  untracked, launch failure, cancellation, Preflight passed/failed/needs authorization,
  restart, review.
- **E2E** (`tests/e2e/team-execution.spec.ts`, Linux and Xvfb):
  - proposal and editing, nothing before approval, two members in order with a handoff,
    one notification, review;
  - simple single-member proposal, rejection runs nothing, failure pause and retry.
