# SDD-008 — Multi-Account Manager & Intelligence Router

**Status:** Milestone B implemented (PLAN-027, v0.20.0, schema v9) — awaiting approval.
Milestones A and C not started.
**Dependencies:** SDD-001 through SDD-006.

The developer asked to start with the limits (Milestone B). It ships with a minimal profile
registry (provider + configuration folder + name) that Milestone A will extend with
authentication, permissions and account selection.

## Part I — Milestone B as implemented (PLAN-027)

### Provider capabilities (verified 2026-10-23: Claude Code 2.1.309, codex-cli 0.156.1)

| Capability                    | Claude Code                                                                | Codex CLI                                                         |
| ----------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Profile isolation             | `CLAUDE_CONFIG_DIR` (unset for `~/.claude`: `.claude.json` stays in HOME)  | `CODEX_HOME` (unset for `~/.codex`)                               |
| Sign-in state and plan        | `claude auth status --json` (`loggedIn`, `subscriptionType`)               | `app-server` `account/read` (`account`, `planType`)               |
| Limit windows and reset times | Status line input `rate_limits.five_hour` / `seven_day` / `spend_limit`    | `app-server` `account/rateLimits/read` (primary/secondary/models) |
| Account-wide usage            | Not available                                                              | `app-server` `account/usage/read` (`dailyUsageBuckets`, tokens)   |
| Measured in ATLAS sessions    | Status line `cost.total_api_duration_ms`; `cost.total_cost_usd` (estimate) | —                                                                 |
| Reads that run a model        | None used                                                                  | None used                                                         |

Claude Code limits appear only for Pro and Max plans (also behind a gateway with a spend
limit), only after the first answer of a session, and only in sessions started in an ATLAS
terminal. A Team plan may not report them. The status line's `context_window` token counts
describe the current context, not usage, so they are not recorded.

### Profiles

- Detected: `~/.claude`, `~/.claude-<name>`, `~/.codex`, `~/.codex-<name>` (the name is the
  suffix; the defaults are "default"), the folders in `CLAUDE_CONFIG_DIR`/`CODEX_HOME`, and
  any Claude folder an ATLAS session used.
- Added: a folder chosen in the native picker (`usage-profile` purpose). The renderer cannot
  name a folder by itself.
- Rename, hide (detected profiles), remove (added profiles; provider files are never
  touched), and turn the ATLAS status line off per Claude profile.
- No credential, e-mail address or organization is read into ATLAS.

### Collection

- Codex: `codex app-server` with the profile's environment; `initialize`, then
  `account/read`, `account/rateLimits/read`, `account/usage/read`; stopped after 20 s.
  Signed-out profiles report "Sign-in required"; an unsupported request leaves that part
  empty; unexpected answers are "unavailable" with a reason.
- Claude Code: the ATLAS wrapper adds `--settings` with `statusLine` =
  `<data>/bin/atlas-statusline` unless the profile (`settings.json`, `settings.local.json`)
  or the project (`.claude/settings*.json`) has a status line, or the user turned it off.
  The script stores the input in `<data>/usage/claude/<run>/status.json` (0700 folder) and
  prints nothing; the wrapper writes the profile folder to `config-dir`. The Engine reads new
  files every 5 s, keeps whitelisted fields, and deletes runs untouched for 24 h.
- Schedule: every profile at most once a minute (manual refresh included); automatic
  collection every N minutes (default 10, 0 = off; 5–1440); the Usage view asks for a
  refresh when opened. Collection never touches running terminals.

### Data model (schema v9)

- `usage_profiles`: id, provider, display name, directory (unique per provider), origin,
  status, plan, status line flag, hidden, timestamps, last error (code + safe message).
- `usage_window_snapshots`: provider snapshots per window key (`five_hour`, `seven_day`,
  `codex:primary`, `codex:secondary`, `codex:<limit>:<slot>`), kind (session, weekly,
  other), percent (0–100), window length, reset time, observation time, source. An
  unchanged window is stored again at most every 5 minutes.
- `usage_daily`: one value per profile, date, metric and source. Provider reports replace
  the day (Codex tokens); ATLAS increments add to it (Claude API time and estimated cost).
- `usage_session_progress`: last cumulative value per session, so repeated status updates
  count once; a lower value (e.g. `/clear`) starts a new count.
- Retention: 90 days by default (7–730).

### Semantics

- A window is `current`, `stale` (older than 30 minutes for Claude; three refresh intervals
  for Codex) or `reset` (the provider's reset time passed: no percentage is shown).
- Status `LIMITED` is shown while a window that has not reset is at 100%.
- Daily values use the local calendar; Codex dates are kept as reported. Weekly totals are
  calendar weeks (Monday to Sunday); provider windows keep their own reset times.
- Sources: Provider-reported (`PROVIDER_CLI`), Measured locally (`ATLAS_EXECUTION`),
  Estimated (`LOCAL_ESTIMATE`); unavailable data is "N/A" with its reason.

### Interface

Usage view: one card per profile, grouped by provider, with the current session window and
the weekly window side by side (or only the windows the provider reports), percentage,
reset time, source and age, and an icon + label at 70% (High) and 90% (Almost at the limit);
history per profile with a daily chart (Codex tokens, Claude API time) and weekly totals;
filters for provider, period (7/30/90 days) and source; refresh, automatic refresh interval,
add profile, rename, hide/show, remove, status line toggle.

### Validation (2026-10-23)

- Unit: parsers (fixtures), aggregation, SQLite service (deduplication, rate limiting,
  failures, stale and reset windows, retention, permissions), status inbox, the real
  wrapper with a fake Claude Code, app-server and auth readers against fake CLIs.
- E2E: Usage view with fake CLIs and a recorded status (both bars, labels, history, rename,
  hide, add from the picker, empty state); bridge surface.
- Real CLIs (temporary data folder, read-only calls): Claude profiles `my` (pro) and
  `wiiascend` (team) connected, `default` signed out; Codex `default` (plus) with session and
  weekly windows and daily history. Claude limits need a real session in an ATLAS terminal
  (manual check pending: it uses quota).

### Terminal header (PLAN-031, v0.23.0)

While Claude Code runs in an ATLAS terminal, the pane header shows `<provider>-<name>: N%`
for the session (5h) window of its profile (the name from the Usage view; the default
profile shows only the provider), green below 70%, yellow from 70%, red from 90% (the
rounded value shown decides the color), `—` when the window was reset or nothing was
reported yet. The wrapper writes `terminal-id` (from `ATLAS_TERMINAL_ID`) into the run
folder; the run is open while the process whose id ends the folder name lives (the wrapper,
or Claude Code itself when the wrapper `exec`s it). A run seen ended never reopens, so a
reused process id does not bring it back. The inbox publishes the `llm-usage` lifecycle
event when the open run of a terminal changes or a status arrives; the renderer re-reads
`terminals.llmUsage`. Codex is out of scope (no status line; developer decision Q1).

### Known limitations

- The terminal header updates only when Claude Code refreshes its status line (activity);
  an idle session can show a value a few minutes old (R1, acknowledged), and opening or
  closing Claude Code is noticed within about 5 seconds.
- Claude Code limits only from ATLAS sessions, Pro/Max plans, after the first answer.
- Claude activity outside ATLAS is not counted; a session resumed in ATLAS after running
  elsewhere adds its earlier API time once.
- The Codex `app-server` protocol is marked experimental and may change.
- With a status line configured, Claude Code hides most footer hints (documented behavior);
  the toggle turns it off per profile.
- Codex daily buckets: their time zone is not documented.

## Part II — Specification (as provided)

### 1. Mission

Implement a centralized account management and usage monitoring system for multiple AI
provider accounts on the same machine: multiple independent Claude Code accounts, multiple
independent Codex CLI accounts, and future providers; plus an intelligent, policy-controlled
execution router that selects authorized accounts and providers based on availability, task
requirements, usage limits and user preferences. Normal terminal usage must keep working
without AI integration.

### 2. Core requirements

Register multiple accounts per provider; keep authentication profiles isolated; display
usage per account; daily and weekly history; provider-reported limits and reset times;
distinguish measured usage from estimates; account selection per terminal, AI session and
ATLAS agent; policy-based routing; respect provider authentication and terms; never invent
usage percentages, quotas or costs.

### Milestone A — Multi-account management

- FR-801 Multiple accounts with unique internal ids and user-defined names (never the
  e-mail address as identifier).
- FR-802 Account model: id, providerId, displayName, authenticationMode (SUBSCRIPTION,
  API_KEY, EXTERNAL), profileDirectory, status (CONNECTED, DISCONNECTED, AUTH_REQUIRED,
  LIMITED, UNKNOWN) from verified evidence, createdAt, updatedAt, lastUsedAt.
- FR-803 Isolated authentication profiles through officially supported mechanisms only;
  separate environments; no plaintext credentials; no manipulation of undocumented
  authentication files.
- FR-804 Authentication through the provider's own mechanism; ATLAS never requests,
  intercepts or stores passwords; tokens never in logs; sessions never copied.
- FR-805 Accounts UI: add, rename, inspect, default, assign to projects and providers,
  disable, remove (provider credentials are not deleted).
- FR-806 Explicit account selection per AI terminal, managed Claude/Codex session, ATLAS
  Session, agent and team template; running executions keep their account.
- FR-807 Permissions: global availability, project allow/deny lists, session and agent
  restrictions; no project context through an account meant for another environment.

### Milestone B — Daily and weekly usage dashboard

- FR-808 Usage sources: official APIs, supported CLI interfaces, structured execution
  metadata, locally measured activity, labeled estimates. No private endpoints, credential
  extraction, undocumented authentication, or billable requests to discover limits.
- FR-809 Observation model (account, provider, time, source, metric, value, unit, window,
  estimated flag); incompatible metrics are never combined.
- FR-810 Daily view per account; local activity when quotas are unknown; local totals never
  shown as a percentage of an allowance.
- FR-811 Weekly view: daily breakdown, totals, allowance, used/remaining percentage and
  next reset when reported; calendar weeks and provider windows; no assumed Monday resets.
- FR-812 Independent limit windows (session, weekly, model, spend, credits), each with
  metric, window, reset, source, freshness and availability; never one merged percentage.
- FR-813 Dashboard: account cards, provider grouping, daily, weekly, trends, allowance,
  resets, last synchronization, collection errors; filters for provider, account, project,
  date range, source.
- FR-814 Accuracy classes: provider-reported, locally measured, estimated, unavailable;
  visible source and freshness; stale data marked; coverage stated when only ATLAS
  executions are covered.
- FR-815 Historical persistence, daily/weekly aggregation, comparisons, charts, retention;
  no double counting; cumulative snapshots distinct from incremental events.
- FR-816 Reset detection from provider timestamps only (rolling, fixed, account-specific,
  manual, changed, missing); never from a calendar change.
- FR-817 Manual and background refresh, rate-limited, per provider, cached; no AI
  executions to check limits; no interference with terminals.

### Milestone C — Intelligence Router

- FR-818 Central router choosing an authorized target by provider, capabilities,
  availability, project permissions, reported limits, execution profile, preferences, cost
  policy and concurrency, without assumptions about remaining quota.
- FR-819 Modes: MANUAL, PREFERRED (asks before falling back), AUTOMATIC (opt-in, policy
  based, reason recorded).
- FR-820 Priorities: preferred, secondary, fallbacks, provider priority, per-project policy,
  concurrency limits; work context never sent to a personal account without authorization.
- FR-821 Limit-aware routing with reliable data; conservative behavior and reported
  uncertainty without it.
- FR-822 Authorized fallback: identify, check options and capabilities, hand off context,
  ask when required, start, record; no repeated side effects; no bypassing limits.
- FR-823 Cross-provider continuity through the Shared Context Engine (objective, work done,
  pending tasks, decisions, sources, test results, repository state).
- FR-824 Account assignment per agent, within project permissions and provider policies.
- FR-825 Routing decisions recorded (session, agent, provider, account, requirements, usage
  information, policy, reason, fallback reason); never credentials.
- FR-826 Optional budgets (API cost, duration, attempts, concurrent agents, measurable
  consumption); subscription quotas are not monetary budgets; profiles never override
  restrictions.

### Architecture, adapters and security

Reuse existing provider, context, execution and persistence infrastructure (suggested
packages `accounts`, `usage`, `routing`, `providers`), with optional, verified provider
capabilities (`supportsMultipleProfiles`, `supportsAccountUsage`, `supportsQuotaInspection`,
`supportsResetInformation`, `supportsAccountScopedExecution`). Security: no plaintext
credentials, token copying, undocumented credential extraction, hidden account switching,
cross-project leaks, limit bypassing, automatic purchases or plan changes, unauthorized
billable usage, or bypassing provider permission prompts.

### Tests and acceptance

Deterministic tests with mocks for accounts, usage (aggregation, windows, resets,
deduplication, missing and stale data, failures, estimates) and routing; real verification
on installed provider CLIs; no claims of provider-wide quota reporting without evidence.
Each milestone is implemented and validated before the next.

### Out of scope

Account creation at providers, subscription or credit purchases, rate-limit bypasses, remote
account pools, credential sharing between users, VS Code integration, automatic production
deployment.
