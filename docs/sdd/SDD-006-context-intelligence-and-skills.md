# ATLAS — SDD-006: Context Intelligence & Skills Hub

**Project:** ATLAS — Autonomous Task Leadership & Agent System  
**Specification:** SDD-006  
**Dependencies:** SDD-001 through SDD-005  
**Status:** Milestone A (intelligent context retrieval, PLAN-015 revision 1) and Milestone B
(Skills Hub, PLAN-017 revision 1) implemented and validated with automated tests — awaiting
the developer's approval. Milestone C depends on SDD-004 Milestone B (provider execution)
and SDD-005 Milestone B (multi-agent orchestration), neither of which exists yet.

Part I documents the implementation. Part II preserves the specification as received.

---

# Part I — Milestone A

## Scope and sequencing (PLAN-015)

Milestone A extends the SDD-005 Shared Context (`SharedContextService`, migration v5, FTS5)
instead of adding a parallel service. Requirements whose concepts do not exist yet are
handled explicitly:

- **Task dependencies (FR-601):** tasks have no dependency model until the SDD-005
  Milestone B task graph; retrieval uses the task, its objective and its records.
- **Compaction (FR-610):** SDD-005 had no compaction (it belonged to its Milestone C).
  Compaction here happens only when a bundle is built; stored history is never changed.
- **Execution profiles (FR-603):** the ATLAS Sessions profiles (`ECONOMY`, `BALANCED`,
  `MAXIMUM`) can carry a context budget.
- **Context Health (FR-608)** also covers SDD-005 FR-538; **structured compaction (FR-610)**
  covers the bundle-time part of SDD-005 FR-539.

## Retrieval strategy (FR-601)

A bundle request may carry an `objective`, an `agentRole`, an `executionProfile`, `files`,
`keywords`, `excludeIds` and a `detail` level, besides the task, provider and budget of
SDD-005. All are optional: a request without them behaves like SDD-005.

Candidates (hybrid, no embeddings or vector database):

1. Structured filter: active entries of the authorized owner (newest 500) and of the task
   when one is chosen, active decisions, and global entries the user shared.
2. SQLite FTS5: the objective and keywords become plain terms (lowercase, without
   diacritics, camelCase split, English and Portuguese stopwords removed); entries matching
   **any** term are fetched ranked by `bm25` (up to 200 per owner), so older relevant
   records outside the newest 500 are still found. Terms are quoted, never parsed as FTS
   syntax.
3. Keyword matching and scoring of every candidate (below).

## Relevance scoring (FR-602)

Each record gets a score that is the sum of listed factors (`ContextReference.factors`), so
it is explainable and testable:

| Factor         | Points                                                              |
| -------------- | ------------------------------------------------------------------- |
| `text`         | up to 30 × share of query terms found in title and body             |
| `search-rank`  | 10 − FTS position (minimum 1) when FTS matched                      |
| `scope`        | +10 when the record belongs to the requested task                   |
| `files`        | +20 per requested file referenced or named, +8 same folder (max 25) |
| `category`     | 0–15, by role (e.g. QA favours test results, security constraints)  |
| `decision`     | +20 for an active decision                                          |
| `verification` | verified +10, by user +6, unverified 0                              |
| `recency`      | 0–5, halving every 30 days                                          |
| `stale`        | −20 when referenced files or commits changed                        |
| `branch`       | −5 when the referenced files were described on another branch       |

Recency is deliberately small: a newer note never outranks an active decision of similar
relevance (unit test "never lets recency outrank a verified decision").

## Bundle sections and prioritization (FR-604, FR-605)

The objective (the request's, else the task's) and **required** entries are always
included. Then sections in this priority order, each sorted by score:

1. Constraints (category `constraint` and required entries)
2. Active decisions
3. Relevant files (records about the requested files)
4. Current task state (progress, commits, changed files, next actions, pending decisions)
5. Validations (test results)
6. Blockers and known failures
7. Project knowledge (overview, architecture, conventions, commands)
8. History and notes (session summaries, notes, provider references)
9. Shared conventions (global)

`ContextBundle` keeps the SDD-005 fields (`markdown`, `tokenEstimate`, `omitted`,
`freshness`…) and adds `objective`, `role`, `budgetSource`, `estimatedTokens`,
`tokenEstimateMethod`, `overBudget`, `instructions` (the mandatory untrusted-data notice),
`included` and `excluded` references, the spec's `decisions`, `relevantFiles`,
`completedWork`, `pendingWork`, `validations` and `blockers`, `warnings` and `cache`.
Every reference keeps its provenance: source kind, reference and recorder, files, commit,
verification and the ids of collapsed duplicates.

Nothing is dropped silently: every candidate is either included or listed in `excluded`
with a reason — `budget`, `user`, `duplicate`, `compacted`, `not-relevant` or
`progressive`. When the objective and required records alone exceed the budget, they are
kept, `overBudget` is set and an `over-budget` warning is added.

An **explicit** objective, keywords or files also leave out history and completed-work
records that match none of them (`not-relevant`); a task's own objective only ranks, so
handoffs and bundles without a request keep their SDD-005 content.

## Token estimation and budgets (FR-603)

ATLAS holds no provider credentials and never measures tokens. Every count is an estimate,
`TOKEN_ESTIMATE_METHOD = "approximation: characters / 4"`, and is labelled as such in the
API, the UI and the CLI. Estimates can be off by a third or more for code and non-English
text.

Budgets (500–32,000 estimated tokens) are resolved from the most specific source:
request (`--budget`, API) → task override (`context_tasks.budget_tokens`) → execution
profile → agent role → provider → global default (6,000). They are stored as JSON under
`context.budgets` in `application_settings`; `context.budgets` / `context.setBudgets`
(desktop only) read and change them. The project `context.md` (PLAN-014) keeps its fixed
12,000-token request budget; snapshots keep 32,000.

## Freshness and consistency (FR-606, FR-607)

Before every bundle (also on a cache hit) the SDD-005 checks run against Git: changed or
removed files and commits no longer on the branch. Added:

- **Changed branches:** entries with file references record the branch checked out
  (`refs.branch`); a different branch now adds a `branch` penalty and a `branch-changed`
  warning. Tasks record their `base_branch`.
- **Conflicts:** active decisions answering the same normalized question differently, and
  entries with the same category and title whose bodies share less than half their words.
  They are warnings; nothing is resolved automatically.
- **Completed tasks still marked pending:** next actions and pending decisions of a task
  that is done or abandoned.
- **Superseded decisions** are excluded from bundles and counted in Context Health.
- **Duplicates:** identical normalized text, or word overlap (Jaccard) ≥ 0.85 for texts of
  four or more words (pairwise only up to 600 records). The kept record is the required,
  best verified, newest one; the others are listed as its `duplicates` and excluded from
  the bundle. A required entry is only collapsed into another required entry. Stored
  records are never changed.
- **Structured compaction (FR-610):** only the three latest session summaries are repeated
  (`compacted`); obsolete entries and superseded decisions are not loaded.

## Context Health (FR-608)

`context.health` (read-only) reports totals (active, required, obsolete entries; active and
superseded decisions; open tasks), the estimated size of everything a generic bundle could
include, stale references, conflicts, duplicate groups, pending items of closed tasks,
factual records without a source (architecture, progress, files changed, commits, test
results and known failures with no file, commit or source reference), whether Git checks
stopped at their bound (100) and the last reconciliation. `context.reconcile` (desktop
only) runs the same checks and records the run in `context_reconciliations` (latest 20 per
owner). There is no overall score: the signals are heuristics, not a measure of
correctness.

## Context preview (FR-609)

Context → Overview → **Preview context**, and the **Start Claude Code / Codex** dialog,
show the objective, role and detail inputs, included records by section (score with its
factors on hover, verification, source, files, estimated tokens), records left out with
their reason, warnings, applicable Skills (none until Milestone B) and the exact text.
Optional records can be excluded and included again; required records are locked and the
mandatory instructions are not removable. The Start dialog sends exactly the previewed
selection (`ai.start` accepts the same fields).

## Progressive loading (FR-611)

`detail: "essential"` sends the objective, constraints, decisions, relevant files, task
state, validations and blockers; project knowledge, history and global conventions are
listed as `progressive` and the bundle says they are available on request. On-demand
retrieval is what ATLAS actually supports: the user (or an LLM allowed to run commands)
runs `atlas context retrieve` / `atlas context bundle` with an objective or files. ATLAS
does **not** inject context into a running Claude Code or Codex session.

## Context cache (FR-612)

A bounded LRU (32 entries) in `SharedContextService` keeps the stored records of a bundle
(task, entries, decisions, global entries, FTS ranks). The key contains the owner, the
inspected directory, the task, the query terms and a context revision: `PRAGMA
data_version` (changes on commits by other connections, e.g. the CLI) plus a counter of
writes through this connection. Any context write invalidates every cached bundle.
Freshness, scoring, budgets and formatting are always computed again, so a cache hit never
hides repository changes. `bundle.cache` reports `hit` or `miss`.

## Context isolation (FR-613)

Unchanged from SDD-005: every request names a target the Engine resolves and authorizes;
the service only reads records of that owner, plus global entries the user explicitly
created as global. The cache key includes the owner and directory. Retrieved content is
never trusted: it is wrapped as reference data, required entries stay data (not
instructions), and nothing in a bundle changes ATLAS policies.

## Storage (migration v6)

Additive: `context_entries.required` (0/1, default 0; changing it adds a revision whose
reason records the change), `context_tasks.base_branch`,
`context_tasks.budget_tokens` (500–32,000 or null) and the table
`context_reconciliations`. A database migrated to v6 cannot be opened by ATLAS 0.9.0 or
older ("created by a newer version"); rolling back requires a copy of the database taken
before the upgrade.

## API, IPC and CLI

| Engine method        | Clients      | Purpose                                         |
| -------------------- | ------------ | ----------------------------------------------- |
| `context.bundle`     | desktop, CLI | Extended request; returns the extended bundle   |
| `context.health`     | desktop, CLI | Context Health report                           |
| `context.reconcile`  | desktop      | Health checks recorded as a reconciliation      |
| `context.budgets`    | desktop      | Read budgets                                    |
| `context.setBudgets` | desktop      | Change budgets                                  |
| `ai.start`           | desktop, CLI | Accepts the same selection fields as the bundle |

```bash
atlas context bundle   --project <id> [--objective <text>] [--role <role>] [--profile <p>] \
                       [--file <path>]… [--keyword <word>]… [--exclude <id>]… \
                       [--detail essential|full] [--budget <tokens>] [--provider …] [--json]
atlas context retrieve --project <id> --objective <text> [same options]   # ranked list with scores
atlas context health   --project <id> [--json]
```

Desktop: Memory (category Constraint, "Always include in context"), Tasks (context budget
per task), Context → Health, Preview context, Start dialog, Settings → Context budgets.

## Tests

- `packages/context/tests/retrieval.test.ts`: normalization and stopwords, term matching,
  fingerprints, explainable scores, recency never outranking decisions, role and file
  factors, penalties, budget precedence and storage, duplicates (required never collapsed
  into optional), conflicts, pending of closed tasks, missing sources, LRU eviction.
- `packages/context/tests/bundle.test.ts`: ranking by objective with `not-relevant`
  exclusions and full accounting of candidates, required records beyond the budget,
  user exclusions and locked required records, duplicates and compaction, essential
  detail, relevant files and contract arrays, branch / conflict / closed-task warnings,
  plus the SDD-005 bundle and handoff tests unchanged in expectations.
- `apps/engine/tests/context-retrieval.test.ts` (SQLite and Git): FTS ranking and project
  isolation, cache hit / miss with invalidation by the Engine and by another database
  connection, freshness on cache hits, budgets from settings and task overrides across
  restarts, required entries, Context Health and persisted reconciliations, `ai.start`
  sending exactly the previewed selection.
- `packages/persistence/tests/sqlite.test.ts`: v5 → v6 migration keeps context rows.
- `apps/desktop/tests/ipc.test.ts`: health, reconcile, budgets and bundle validation.
- `apps/cli/tests/cli.test.ts`: `retrieve`, `health`, `--budget` and role validation.
- `tests/e2e/context.spec.ts`: required entry, preview with objective, exclusions, locked
  required record, Health reconciliation, Settings budget applied to the preview, no
  horizontal overflow of the preview at 380 px.
- The SDD-005 handoff and managed-session tests pass unchanged.

**Not verified:** the real Claude Code and Codex CLIs (fake executables in tests), and the
quality of the ranking on real project histories — there is no objective relevance
measure; the factors and weights are heuristics documented above.

## Known limitations

- Relevance is lexical: synonyms or paraphrases without shared words are not found.
- Token counts are approximations (characters / 4).
- Conflict and duplicate detection are heuristics with false positives and negatives.
- Any context write invalidates every cached bundle (per-owner invalidation was not worth
  its cost); the cache only saves database work, Git checks always run.
- Branches are recorded only for entries with file references; entries written before
  0.10.0 have no branch.
- Freshness checks stop after 100 Git calls; Context Health says when that happened.
- Task dependencies are not modelled (SDD-005 Milestone B).
- Context is never injected into a running provider session; progressive loading means
  on-demand retrieval through ATLAS.
- Skills appear in bundles since Milestone B (see Part I-B).

---

# Part I-B — Milestone B (Skills Hub, PLAN-017)

## Formats and provider facts

Verified on 2026-10-20 against the providers' documentation and this machine:

| Provider    | Skill folders (documented)                                                    | SKILL.md frontmatter                                                                                           |
| ----------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Claude Code | `~/.claude/skills/<name>/`, project `.claude/skills/`, `--add-dir`, plugins   | All optional; `name` defaults to the folder; Claude-only fields (`allowed-tools`, `hooks`, …); unknown ignored |
| Codex       | `~/.agents/skills`, repo `.agents/skills` up to the root, `/etc/codex/skills` | `name` and `description` required; optional `agents/openai.yaml` (UI, invocation, `dependencies.tools`)        |

Unknowns: whether `CLAUDE_CONFIG_DIR` moves Claude Code's skills folder (it is suggested
with "verify it"), and `~/.codex/skills` (present here with Codex's bundled `.system`
skills, not documented for user skills). Folders are therefore suggestions; the user
chooses what is read and where synchronization writes.

## Registry and storage (FR-614, FR-618)

`packages/skills` holds the parser (YAML via `yaml` 2.8.4, bounded aliases), the provider
adapters, the safety checks, the activation rules, the diff and the templates;
`SkillsHub` (service + synchronization) runs in the Engine. Migration v8 adds `skills`,
`skill_versions`, `skill_assignments`, `skill_sources`, `skill_sync_batches` and
`skill_sync_changes`.

Importing copies the reviewed files into `<data>/skills/<skill id>/<sequence>/`; versions
are immutable. The source folder is never changed or deleted, and removing a skill deletes
only ATLAS's copies. The version label is `metadata.version` or a 12-character content
hash (SHA-256 over file paths and hashes); edits that keep `metadata.version` get
`+<hash>` appended. A changed source is shown as **update available** and is only
imported again after review. Versions can be compared (SKILL.md line diff, files added,
removed or changed).

## Discovery and import (FR-616, FR-623)

Only folders the user authorized are read: sources added in Skills → Available (Engine
suggestions or folders chosen in the native picker), a folder chosen in the picker, or a
path given to the CLI. The desktop main process tells the Engine whether a path was
picked; the renderer cannot claim it. Discovery lists direct sub-folders with SKILL.md
(hidden folders skipped) as new, imported, update available or invalid.

The import review shows metadata, files and size, provider compatibility, issues,
executable files, requested permissions and dependencies; when there are scripts or
permissions the user must tick "I reviewed …". The import is refused if the folder changed
after the review (content hash) or validation reports an error. New skills are disabled.

A folder that holds skills instead of being one (PLAN-021) opens a collection review: every
skill with its status, scripts and permissions, all valid new ones ticked, one "I reviewed
…" confirmation and an option (on by default) to enable the imported skills for every
project. The folder becomes a source; each skill is imported with its reviewed hash and
failures are listed per skill without undoing the others (at most 200 per import). The CLI
does the same with `atlas skills import <folder> --yes [--enable]`.

## Validation and safety (FR-617, FR-620, FR-621)

- No skill file is ever executed by ATLAS. Executable files are detected by permission
  bits, shebang or extension and listed.
- Permissions: Claude Code `allowed-tools`, `hooks`, and `` !`command` `` lines (run by
  Claude Code when the skill is invoked); Codex `dependencies.tools`.
- Credentials: frontmatter and `agents/openai.yaml` matching the credential patterns block
  the import; other text files only warn.
- Folders: at most 500 files and 5 MB; links pointing outside the folder are refused;
  links inside are not copied; `.git`, `node_modules` and `.DS_Store` are skipped.
- Dependencies (`metadata.requires.executables|skills|tools|providers`, executables named in
  `Bash(...)` tool patterns, Codex tool dependencies) are checked without running anything:
  executables on PATH, registered skills, provider compatibility; provider tools are
  "unknown". Nothing is installed.
- Compatibility per provider: `compatible`, `partial` (features ignored by that provider,
  listed) or `incompatible` (e.g. Codex without name/description; Claude reserved names or
  the `synced` folder). Nothing is converted.

## Activation (FR-615, FR-619)

Scopes: global (the skill's **Enabled for every project** flag), project, provider, role
and session (AI sessions started by ATLAS). Deterministic precedence, first match wins:

1. Security: invalid skills, or a format the provider cannot use, are never active.
2. Project and provider restrictions (`disable`).
3. Session: skills chosen in the Start dialog (stored as session assignments), or a session
   rule.
4. Agent role rule.
5. Project or provider `enable`, then the global flag.

Every result states the deciding layer and reason (`skills.resolve`, `atlas skills
resolve`). Removing a project removes its rules.

## Delivery to AI sessions

Context bundles (Milestone A) list the active skills for the project, role and provider —
name, version, short description and the path of SKILL.md in ATLAS's copy — under "Skills
enabled by the user", with the note that skills never override the user's requests or
ATLAS rules. The skill's text is not copied into the context. The preview and the Start
dialog show them; the Start dialog adds skills for one session.

## Synchronization (FR-624)

Explicit, user-level folders only (approved decision): the user picks the Claude Code and
Codex folders (suggested or chosen in the picker). Only globally enabled skills usable by
the provider and not disabled for it are synchronized. Preview → apply → rollback:

- `create` (folder absent), `update` (ATLAS's folder with older content), `remove`
  (ATLAS's folder for a skill no longer enabled), `unchanged`, `conflict` (a folder with
  that name not created by ATLAS for this skill, or two skills with one folder name).
- Every written folder contains `.atlas-managed.json` (skill, version, content hash,
  batch). Folders without it are never changed. Copies are staged in a hidden folder and
  renamed into place; replaced or removed folders are moved to
  `<data>/skills/.sync-backups/<batch>/`.
- Rollback undoes the latest batch of a provider: created folders are removed, replaced or
  removed ones restored; folders changed since are left alone and reported.
- A synchronized skill cannot be removed from ATLAS until it is synchronized away.

Project, role and session rules are applied by ATLAS's context delivery, not by these
folders (a user-level folder applies to every project).

## Templates (FR-625)

Seven optional templates, version 1.0.0: Conventional Commits, Code Review, Security Review,
Unit Testing, Integration Testing, Documentation, Architecture Analysis. "New from template"
creates an editable skill owned by ATLAS (disabled); each saved edit is a new version.

## UI and CLI (FR-622)

Sidebar → **Skills**: Installed (list; details with compatibility, checks, permissions,
dependencies, rules, files viewer, versions and diff, enable, check again, review update,
edit, remove from ATLAS), Available (sources, suggestions, discovered skills, import
review) and Sync (folders, preview, apply, rollback).

```bash
atlas skills list|show <id>|discover|templates [--json]
atlas skills sources [add <path> --kind claude|codex|path]
atlas skills import <path> [--yes]
atlas skills enable|disable <id>
atlas skills assign|unassign <id> --scope project|provider|role --target <t> [--disable]
atlas skills resolve [--project <id>] [--provider <p>] [--role <r>]
atlas skills remove <id> --yes
atlas skills sync preview|apply --provider claude|codex; sync history; sync rollback <batch>
```

## Tests (Milestone B)

- `packages/skills/tests/analyze.test.ts`: frontmatter edge cases (blank first line, BOM,
  CRLF, missing close, invalid YAML), adapters and unsupported features, reserved names,
  long descriptions, scripts, hooks and `!` commands, credentials, limits, dependencies,
  hashing, the seven templates valid for both providers, diff, the activation precedence.
- `packages/skills/tests/hub.test.ts` (real folders and SQLite): authorization, import with
  content hash, source untouched, update available and new versions, diff, file access
  limited to stored files, removal, links outside and credentials refused, templates and
  edits, rules, synchronization (conflict with a foreign folder, create, unchanged,
  update, remove, rollback order, foreign folder intact).
- `apps/engine/tests/skills.test.ts`: active skills in bundles by project, session skills
  in `ai.start`, project removal clearing rules.
- `apps/desktop/tests/ipc.test.ts`: picker-only authorization, renderer cannot claim a
  pick, import confirmation, sync folders picked or suggested only, rule validation.
- `apps/cli/tests/cli.test.ts`: import review and `--yes`, enable, resolve, remove.
- `tests/e2e/skills.spec.ts`: suggestion → discovery → reviewed import → enable → context
  preview → Codex sync → rollback, no overflow at 380 px.

**Not verified:** that Claude Code and Codex actually load the synchronized skills or
follow the listed skill files (no real CLIs in tests); provider behaviour beyond the
documented formats.

## Known limitations (Milestone B)

- Compatibility is checked on the format only; providers may change formats or folders.
- A skill is untrusted text: ATLAS shows scripts and permissions but cannot stop a provider
  from following a malicious skill once the user enables it.
- Only global skills can be synchronized (user-level folders); narrower scopes work
  through ATLAS context delivery only.
- Claude Code project, plugin and enterprise skill folders, and Codex repository folders,
  are not written by ATLAS (they can be added as read-only sources).
- Skills are copied, not linked: edits at the source need an explicit re-import.
- YAML dependency `yaml` 2.8.4, exact version. The plan approved 2.8.1; the audit found
  GHSA-48c2-rrv3-qjmp (stack overflow on deeply nested YAML, fixed in 2.8.3) and the
  developer approved 2.8.4 on 2026-10-20. Parse errors are caught and reported.

---

# Part II — Specification as received

# 1. Mission

Evolve the Shared Context infrastructure introduced in SDD-005 into an intelligent, efficient, provider-independent knowledge system.

Implement a centralized Skills Hub that allows reusable capabilities and development instructions to be managed across Claude Code, Codex CLI, future LLM providers, and ATLAS multi-agent teams.

The system must:

- Retrieve relevant context intelligently.
- Minimize unnecessary token consumption.
- Preserve development continuity.
- Detect stale or conflicting knowledge.
- Manage reusable Skills.
- Apply Skills according to project and agent roles.
- Support individual AI sessions and multi-agent execution.
- Remain fully optional for traditional terminal usage.

**Core principle: Share knowledge, not unnecessary conversation history.**

---

# 2. Architectural Principles

## 2.1 Provider Independence

Context and Skills must not be owned by any specific AI provider.

Claude Code, Codex CLI, and future providers must access ATLAS-managed knowledge through adapters.

## 2.2 Persistent Knowledge

Knowledge must survive:

- Terminal closure.
- Provider changes.
- Agent termination.
- Session completion.
- Application restarts.

## 2.3 Source of Truth

Current source code and verified execution evidence take precedence over historical AI-generated summaries.

## 2.4 Controlled Context Injection

Do not inject the entire project memory into every prompt.

Context must be selected according to:

- Objective.
- Task.
- Agent role.
- Relevant files.
- Current repository state.
- Token budget.
- Permissions.

## 2.5 Optional Integration

The ATLAS terminal experience must continue working without:

- Context Intelligence.
- Skills Hub.
- AI providers.
- Agent orchestration.

---

# MILESTONE A — INTELLIGENT CONTEXT RETRIEVAL

# 3. Context Retrieval Engine

## FR-601 — Intelligent Retrieval

Extend the Shared Context Service from SDD-005.

Support retrieving relevant knowledge based on:

- Current objective.
- Task description.
- Project.
- Workspace.
- Agent role.
- File paths.
- Technical keywords.
- Recent decisions.
- Task dependencies.

Use a hybrid retrieval strategy.

Initial implementation:

- Structured metadata filtering.
- SQLite full-text search.
- Keyword matching.
- Relevance scoring.
- Recency signals.
- Source verification status.

Do not require embeddings or an external vector database for the first implementation.

## FR-602 — Relevance Scoring

Each retrieved context entry must receive a relevance score.

Suggested factors:

- Task similarity.
- Scope match.
- File relevance.
- Decision importance.
- Freshness.
- Verification status.
- Dependency relevance.

Scoring must be explainable and testable.

Avoid treating recent information as automatically more authoritative than verified architectural decisions.

## FR-603 — Context Budget Manager

Implement configurable context budgets.

Support:

- Global default budget.
- Provider-specific budget.
- Agent-role budget.
- Task-specific override.
- Execution-profile budget.

Budgets should be expressed in estimated tokens.

Use provider-specific token counting when available.

Otherwise, use an explicitly labeled approximation.

Never report estimated token counts as measured provider usage.

## FR-604 — Context Prioritization

When a context bundle exceeds its budget, prioritize:

1. Current task objective.
2. Critical constraints.
3. Active architectural decisions.
4. Relevant source references.
5. Current task state.
6. Verified validation results.
7. Known blockers.
8. Relevant historical context.

Do not silently remove mandatory safety constraints or essential task requirements.

If required context exceeds the budget, report the limitation.

## FR-605 — Context Bundle Builder

Create a provider-independent Context Bundle Builder.

Suggested contract:

```typescript
interface ContextBundleRequest {
  projectId?: string;
  workspacePath?: string;
  taskId?: string;
  sessionId?: string;
  agentRole?: string;
  providerId?: string;
  objective: string;
  maxEstimatedTokens?: number;
}

interface ContextBundle {
  objective: string;
  instructions: string[];
  decisions: ContextReference[];
  relevantFiles: ContextReference[];
  completedWork: ContextReference[];
  pendingWork: ContextReference[];
  validations: ContextReference[];
  blockers: ContextReference[];
  estimatedTokens: number;
  generatedAt: string;
}
```

Every context reference must preserve source provenance.

## FR-606 — Context Freshness

Detect:

- References to deleted files.
- Changed branches.
- Outdated commit references.
- Superseded decisions.
- Completed tasks still marked pending.
- Conflicting implementation notes.

Before presenting historical information as current, reconcile it against the available repository state.

## FR-607 — Context Deduplication

Detect duplicate or substantially equivalent context entries.

Do not repeatedly inject the same decision or implementation summary.

Preserve original source references.

Deduplication must not destroy historical evidence.

## FR-608 — Context Health

Provide a Context Health report.

Indicators:

- Total stored context entries.
- Estimated relevant context size.
- Stale entries.
- Conflicting decisions.
- Missing source references.
- Duplicate records.
- Last successful reconciliation.

Avoid presenting an arbitrary health score as an objective measure of correctness.

## FR-609 — Context Preview

Before starting an AI execution, allow users to inspect the context bundle when requested.

Show:

- Included records.
- Excluded records.
- Estimated token count.
- Source references.
- Warnings.
- Applicable Skills.

Provide controls for excluding optional context entries.

Do not allow removal of mandatory execution policies through this interface.

---

# 4. Context Optimization

## FR-610 — Structured Compaction

Extend the SDD-005 compaction infrastructure.

Compaction must preserve:

- Objectives.
- Verified decisions.
- Current task state.
- Source references.
- Important constraints.
- Validation evidence.
- Pending work.

Reduce:

- Repeated summaries.
- Redundant observations.
- Superseded temporary notes.
- Irrelevant execution output.

Do not overwrite original audit history.

## FR-611 — Progressive Context Loading

Support progressive context retrieval.

Instead of loading everything initially:

1. Load essential task context.
2. Load relevant project context.
3. Retrieve additional details when needed.
4. Expand file-specific context on demand.

Provider adapters must expose this capability only through mechanisms they actually support.

Do not claim dynamic context injection for a provider that cannot receive it.

## FR-612 — Context Cache

Implement bounded caching for context bundles.

Cache keys should account for:

- Project.
- Task.
- Agent role.
- Relevant context revision.
- Repository state.
- Provider formatting.

Invalidate cached bundles when relevant context changes.

Do not reuse stale bundles across incompatible workspaces.

## FR-613 — Context Isolation

Enforce context access permissions.

A session must not retrieve unrelated private project context without authorization.

Prevent global Skills or context records from becoming an unintended cross-project data channel.

---

# 5. Milestone A Acceptance Criteria

- [ ] Relevant context can be retrieved by objective.
- [ ] Retrieval supports project and task filters.
- [ ] Relevance scoring works.
- [ ] Context budgets are enforced.
- [ ] Context bundles preserve source references.
- [ ] Stale context is detected.
- [ ] Duplicate context is reduced.
- [ ] Context Health reports work.
- [ ] Context previews work.
- [ ] Cache invalidation works.
- [ ] Existing SDD-005 handoffs remain functional.
- [ ] Unit and integration tests pass.

**Do not begin Milestone B before validating Milestone A.**

---

# MILESTONE B — CENTRALIZED SKILLS HUB

# 6. Skills Hub

## FR-614 — Skill Registry

Implement a centralized registry for reusable Skills.

Each Skill must have:

- Unique identifier.
- Name.
- Description.
- Version.
- Source.
- Compatibility information.
- Enabled state.
- Applicable scopes.
- Required capabilities.
- Associated files.
- Update timestamp.

Skills must be managed independently of individual provider sessions.

## FR-615 — Skill Scopes

Support:

**Global Skills**

- Available across authorized projects.

**Project Skills**

- Available only within selected projects.

**Agent Skills**

- Assigned to specific agent roles.

**Session Skills**

- Enabled for individual execution sessions.

Project and session policies must determine effective Skill availability.

## FR-616 — Skill Discovery

Support discovering Skills from:

- ATLAS-managed directories.
- Existing Claude Code Skill directories.
- Existing Codex-compatible Skill directories.
- Explicitly configured local paths.

Only inspect paths explicitly authorized by the user.

Do not assume every provider uses identical Skill formats.

## FR-617 — Skill Compatibility

Create provider-specific adapters.

Adapters should support:

- Capability detection.
- Metadata extraction.
- Format validation.
- Compatible Skill activation.
- Clear unsupported-feature reporting.

Do not silently convert incompatible Skills and claim full compatibility.

## FR-618 — Skill Versioning

Support versioned Skills.

Track:

- Version identifier.
- Source.
- Change history.
- Compatibility.
- Installation timestamp.
- Enabled projects.
- Last validation result.

Allow users to inspect differences between versions.

Do not automatically update Skills without authorization.

## FR-619 — Skill Activation

Allow users to enable or disable Skills by:

- Project.
- Provider.
- Agent role.
- Session.

Define deterministic precedence.

Suggested order:

1. Mandatory security policies.
2. Project restrictions.
3. Session configuration.
4. Agent role configuration.
5. Global defaults.

Skills must not override mandatory security policies.

## FR-620 — Skill Dependencies

Support declaring:

- Required tools.
- Required executables.
- Required environment capabilities.
- Compatible providers.
- Other Skill dependencies.

Detect missing dependencies.

Do not execute arbitrary installation scripts automatically.

## FR-621 — Skill Execution Safety

Treat Skills as untrusted executable instructions or resources.

Before activation:

- Inspect metadata.
- Validate required capabilities.
- Identify executable scripts.
- Display requested permissions.
- Apply project policies.

Do not silently execute downloaded or imported scripts.

Never expose provider credentials through Skill metadata.

## FR-622 — Skills Hub UI

Create a Skills interface.

Required views:

- Installed Skills.
- Available local Skills.
- Enabled Skills.
- Project assignments.
- Provider compatibility.
- Skill details.
- Version history.

Required actions:

- Import Skill.
- Enable Skill.
- Disable Skill.
- Assign Skill to project.
- Assign Skill to role.
- Inspect Skill files.
- Remove Skill from registry.

Removing a registry entry must not automatically delete its original source files.

## FR-623 — Skill Import

Support importing a Skill from a local directory.

Requirements:

- Validate directory access.
- Inspect Skill metadata.
- Detect existing installations.
- Identify compatibility.
- Require confirmation.
- Preserve source provenance.

Avoid overwriting existing provider configurations without explicit approval.

## FR-624 — Skill Synchronization

Allow users to synchronize compatible Skills with supported provider environments.

Synchronization must be explicit.

Support:

- Preview changes.
- Detect conflicts.
- Apply compatible updates.
- Report unsupported features.
- Roll back ATLAS-managed changes when feasible.

Do not modify provider-managed files indiscriminately.

## FR-625 — Built-in Skill Templates

Provide optional templates for:

- Conventional Commits.
- Code Review.
- Security Review.
- Unit Testing.
- Integration Testing.
- Documentation.
- Architecture Analysis.

Templates should be versioned and editable.

Do not require users to activate them.

---

# 7. Milestone B Acceptance Criteria

- [ ] Skills can be registered.
- [ ] Skills can be imported from local directories.
- [ ] Skill metadata is validated.
- [ ] Global and project scopes work.
- [ ] Agent role assignments work.
- [ ] Provider compatibility is reported.
- [ ] Skills can be enabled and disabled.
- [ ] Skill version history is available.
- [ ] Dependency validation works.
- [ ] Unsafe Skill execution is prevented within documented limits.
- [ ] Skills Hub UI works.
- [ ] Existing provider configurations are preserved.
- [ ] Unit and integration tests pass.

**Do not begin Milestone C before validating Milestone B.**

---

# MILESTONE C — CONTEXT & SKILL ORCHESTRATION

# 8. Intelligent Execution Preparation

## FR-626 — Execution Preparation Pipeline

Before starting an AI task:

1. Resolve the workspace.
2. Identify the objective.
3. Determine the execution role.
4. Retrieve relevant context.
5. Apply context budgets.
6. Resolve applicable Skills.
7. Validate provider compatibility.
8. Validate permissions.
9. Build the execution package.
10. Start the provider.

Do not begin execution when mandatory requirements cannot be satisfied.

## FR-627 — Execution Package

Define:

```typescript
interface AgentExecutionPackage {
  objective: string;
  context: ContextBundle;
  skills: ResolvedSkill[];
  constraints: string[];
  validationCriteria: string[];
  workspace: string;
  providerId: string;
}
```

The package must contain only authorized information.

## FR-628 — Role-Specific Preparation

Different roles must receive different context and Skills.

Examples:

**Architect**

- Architecture decisions.
- System constraints.
- Architecture Review Skill.

**Developer**

- Relevant source files.
- Task requirements.
- Coding conventions.

**QA**

- Acceptance criteria.
- Test results.
- Testing Skill.

**Security**

- Relevant trust boundaries.
- Security requirements.
- Security Review Skill.

Avoid sending identical context bundles to every agent.

## FR-629 — Context-Aware Handoff

Extend handoffs so that receiving agents obtain:

- Relevant prior decisions.
- Current implementation state.
- Pending tasks.
- Source references.
- Applicable Skills.
- Verification requirements.

Do not require replaying complete previous sessions.

## FR-630 — Context Updates After Execution

After execution:

- Record verified outcomes.
- Update task state.
- Record decisions.
- Store validation evidence.
- Flag unresolved issues.
- Refresh relevant context indexes.
- Invalidate stale bundles.

Do not automatically promote every agent statement to verified project knowledge.

## FR-631 — Provider Switching

Support continuing a task between compatible providers.

Example:

Claude Code → Codex CLI → Claude Code.

The handoff must preserve relevant task knowledge while adapting the execution package to the target provider.

Do not assume provider-specific session identifiers can be transferred directly.

## FR-632 — Skills in Multi-Agent Teams

The orchestrator must resolve Skills per agent.

Example:

- PO receives requirements analysis Skills.
- Developer receives coding Skills.
- QA receives testing Skills.
- Security receives security review Skills.

Do not activate every Skill for every agent.

## FR-633 — Execution Observability

Record:

- Context bundle identifier.
- Context revision.
- Applied Skills.
- Provider.
- Agent role.
- Estimated context tokens.
- Execution outcome.
- Validation evidence.

Separate estimated token consumption from measured provider usage.

## FR-634 — Context Feedback

Allow users to report:

- Missing context.
- Irrelevant context.
- Incorrect context.
- Outdated decisions.
- Unnecessary Skills.

Use feedback to improve future retrieval within the relevant scope.

Do not silently alter critical project decisions based solely on feedback signals.

---

# 9. Milestone C Acceptance Criteria

- [ ] Execution packages are generated.
- [ ] Context is selected by task and role.
- [ ] Applicable Skills are resolved.
- [ ] Provider compatibility is validated.
- [ ] Handoffs include relevant context and Skills.
- [ ] Provider switching preserves task continuity.
- [ ] Context updates after execution.
- [ ] Context cache invalidation works.
- [ ] Execution metadata is auditable.
- [ ] Context feedback works.
- [ ] Normal terminal usage remains unaffected.
- [ ] End-to-end tests pass.

---

# 10. Recommended Architecture

Adapt to the actual repository.

Suggested modules:

```text
packages/
├── context/
│   ├── retrieval/
│   ├── ranking/
│   ├── budgeting/
│   ├── compaction/
│   ├── caching/
│   └── health/
│
├── skills/
│   ├── registry/
│   ├── discovery/
│   ├── compatibility/
│   ├── versioning/
│   ├── activation/
│   └── security/
│
├── execution/
│   ├── preparation/
│   ├── packages/
│   └── observability/
│
└── providers/
    ├── claude/
    ├── codex/
    └── adapters/
```

Reuse existing SDD-005 context and orchestration infrastructure.

Avoid duplicate storage services or parallel context implementations.

## 11. Storage

Use the existing persistence architecture.

Prefer SQLite for:

- Context metadata.
- Search indexes.
- Skill metadata.
- Skill assignments.
- Version history.
- Execution references.

Store large artifacts separately where appropriate.

Do not introduce a vector database unless necessary.

## 12. Security

Requirements:

- Project-level context isolation.
- Explicit authorization for cross-project sharing.
- Skill source validation.
- No arbitrary Skill execution.
- No credential exposure.
- No automatic provider configuration overwrites.
- No unrestricted terminal capture.
- No trust elevation from retrieved context.
- No automatic execution of instructions found in untrusted files.

Context entries and Skill content must not override mandatory ATLAS execution policies.

## 13. Automated Testing

### Context Intelligence

- Retrieval relevance.
- Scope filtering.
- Token budget enforcement.
- Deduplication.
- Freshness detection.
- Cache invalidation.
- Context health.

### Skills Hub

- Import.
- Validation.
- Versioning.
- Scope resolution.
- Compatibility.
- Activation.
- Dependency handling.
- Security restrictions.

### Integration

- Claude Code context preparation.
- Codex CLI context preparation.
- Provider switching.
- Multi-agent role-specific context.
- Skill activation.
- Handoff continuity.
- Context update after execution.

Use mock providers for deterministic tests.

Validate real provider integrations where configured and available.

Do not claim real provider behavior was verified using only mocks.

## 14. Mandatory End-to-End Scenario

1. User opens a normal Claude Code session.
2. ATLAS retrieves relevant project context.
3. Claude implements part of a feature.
4. ATLAS records verified progress.
5. User switches to Codex.
6. Codex receives a compact continuation bundle.
7. Codex continues implementation.
8. User launches an ATLAS multi-agent review.
9. Each agent receives role-specific context and Skills.
10. Agents complete review and validation.
11. ATLAS consolidates verified results.
12. A future session retrieves the updated project knowledge.

The system must demonstrate continuity without copying the full conversation history.

## 15. Implementation Order

### Milestone A

1. Inspect existing Context Engine.
2. Implement retrieval ranking.
3. Implement context budgets.
4. Implement freshness checks.
5. Implement deduplication.
6. Implement context caching.
7. Implement Context Health.
8. Implement context preview.
9. Run tests.

### Milestone B

1. Define Skill contracts.
2. Implement registry.
3. Implement local discovery.
4. Implement compatibility adapters.
5. Implement activation policies.
6. Implement versioning.
7. Implement import and synchronization.
8. Build Skills Hub UI.
9. Run tests.

### Milestone C

1. Implement execution preparation.
2. Implement execution packages.
3. Integrate context retrieval.
4. Integrate Skill resolution.
5. Extend provider handoffs.
6. Integrate multi-agent roles.
7. Implement execution observability.
8. Implement context feedback.
9. Run end-to-end tests.

## 16. Documentation

Create:

`docs/sdd/SDD-006-context-intelligence-and-skills.md`

Update:

- docs/ARCHITECTURE.md
- docs/ROADMAP.md
- docs/STATUS.md
- docs/DECISIONS.md

Document:

- Retrieval strategy.
- Relevance scoring.
- Token estimation.
- Context budgets.
- Skill formats.
- Provider compatibility.
- Security boundaries.
- Test evidence.
- Known limitations.

## 17. Out of Scope

Do not implement:

- Advanced multi-account routing.
- Provider subscription quota discovery.
- Remote distributed workers.
- Shared cloud memory server.
- Automatic production deployment.
- VS Code editor integration.
- Autonomous ATLAS self-updates.

These belong to future specifications.

## 18. Final Instructions for Claude Code

Act as the Principal Software Architect and implementation lead.

Follow Spec-Driven Development.

Inspect the existing repository before implementation.

Reuse the SDD-005 Shared Context architecture.

Do not duplicate existing services.

Implement and validate Milestone A before Milestone B.

Implement and validate Milestone B before Milestone C.

Use Conventional Commits.

Do not bypass tests or security controls.

Do not fabricate token usage, context quality, provider capabilities, or successful execution results.

At the end of each milestone, report:

- Implemented features.
- Architecture changes.
- Files modified.
- Tests executed.
- Test results.
- Known limitations.
- Remaining work.

**Expected result:**

ATLAS must intelligently select and deliver relevant development context and compatible Skills to individual AI sessions and multi-agent teams, preserving continuity while minimizing unnecessary token consumption.
