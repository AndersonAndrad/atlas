# SDD-023 — UX & Terminal Refinements

Status: Task A02 implemented (PLAN-050 revision 1). Task A01 (split terminals keep their
context) was PLAN-045. Other tasks need their own plans.

## Task A02 — Intelligent terminal tab status

Approved 2026-10-27 by Anderson Andrade ("aprovo PLAN-050 rev 1, q1–q3 recomendado, ciente
R1–R5"). Version 0.36.0, schema v19.

### Decisions (Q1–Q3)

- **Q1:** no Claude Code hooks. "Attention" for AI means "finished, review pending".
  Detecting a permission prompt mid-run is a future task.
- **Q2:** shell commands and quick commands are not tracked. Their exit status is not
  reported reliably, and nothing is inferred from terminal output.
- **Q3:** "Mark as reviewed" is available in three places:
  - the tab's context menu (right-click or the context-menu key);
  - the terminal's menu in the sidebar;
  - a button in the pane header while a result is pending.

### Status model

Connection and activity are separate.

- **Connection** comes from the PTY lifecycle (`TerminalStatus`): a final status or
  TERMINATING is disconnected; anything else is connected.
- **Activities** (`TerminalActivity`) are tracked operations of a terminal. Each one has:
  - `kind: 'ai'`, a provider and its own `ref` (the wrapper run);
  - a state: `RUNNING`, `ATTENTION_REQUIRED` (finished successfully, review pending),
    `FAILED` (exit code other than 0, or unknown) or `INTERRUPTED` (its terminal or ATLAS
    stopped first);
  - its times and exit code;
  - `acknowledgedAt`, set only by an explicit review.

The tab shows one indicator, decided by precedence (`terminalIndicator`, FR-005):

| Precedence | Indicator            | When                                          | Look                   |
| ---------- | -------------------- | --------------------------------------------- | ---------------------- |
| 1          | `DISCONNECTED`       | the PTY ended                                 | grey unplug icon       |
| 2          | `FAILED`             | any unreviewed failed activity                | red ✕ icon             |
| 3          | `ATTENTION_REQUIRED` | any unreviewed finished or interrupted result | yellow ! icon          |
| 4          | `AI_RUNNING`         | any running activity                          | blue sparkles, pulsing |
| 5          | `REVIEWED`           | the newest activity was explicitly reviewed   | green ✓ icon           |
| 6          | `IDLE`               | nothing tracked                               | neutral dot            |

- A disconnected tab still marks unreviewed results with a small yellow corner dot
  (`hasPendingReview`).
- A live shell alone is neutral: green never means "the process exited well".
- Each activity keeps its own state. One run finishing never clears another running in the
  same terminal.
- The indicator has an icon, a tooltip and a screen-reader text, so color is never the only
  signal. Examples: "Needs attention · Claude finished 3 min ago, review pending" and
  "Failed · Claude failed (exit 1)".
- Pulsing stops with `prefers-reduced-motion`.
- Colors are theme tokens: destructive, warning, success and muted. AI uses the blue the
  pane header already uses for running work.

### Event sources (FR-003)

- **Claude Code / Codex wrappers** (PLAN-021) write `start` and `end` events with the
  terminal id and the exit code. The LLM session tracker now passes every valid event to
  the activity service, whether or not the project keeps shared context. The service
  receives them after the tracker handled them, so the context session can be linked.
  - Delivery reuses the existing watch of the events folder, with its 5-second fallback
    scan. There is no new polling.
- **Terminal lifecycle:**
  - A session reaching a final status interrupts its running activities.
  - Removing a terminal forgets them; the database cascades.
- **Not tracked:** shell commands, quick commands and background jobs (not tied to
  terminals).

### Ordering and stale events

- A finished activity never runs again. A start that arrives after its end, a repeated end,
  or an end after the terminal interrupted the run changes nothing.
- An end without a start creates the activity already finished.
- Events for terminals unknown to the database, and wrappers run outside ATLAS terminals,
  are ignored.

### Persistence (migration v19)

- `terminal_activities` has one row per terminal and run, linked to `terminal_sessions`
  with `ON DELETE CASCADE`.
- Rows that are kept:
  - running activities;
  - unreviewed results;
  - the latest reviewed result (older reviewed rows are deleted on review).
- RUNNING is never trusted after a restart. When the Engine starts, it records stored RUNNING
  rows as INTERRUPTED: terminals do not survive ATLAS (ADR-013).
- Unreviewed results therefore stay visible on the restored, ended tab until reviewed.
- Rolling back to 0.35.x needs a database copy taken before 0.36.0 first ran.

### Review lifecycle (FR-004)

- Success → `ATTENTION_REQUIRED`; failure → `FAILED`; interruption → `INTERRUPTED` (shown as
  attention). Nothing is acknowledged automatically.
- **Mark as reviewed** acknowledges every finished, unreviewed result of the terminal.
  Running activities are left alone. The tab turns green (`REVIEWED`) until the next
  activity.
- **Open AI session** appears in the pane header next to Mark as reviewed when the result
  was recorded as a shared-context session. It opens the terminal's session in the Context
  view.

### Contracts

- `TerminalActivity`, `TerminalActivitySummary`, `terminalIndicator`, `hasPendingReview`
  (`packages/contracts/src/terminal-activity.ts`).
- Engine methods `terminals.activities` and `terminals.markReviewed`; window bridge
  `terminals.activities()` and `terminals.markReviewed(id)`.
- Event `{ type: 'terminal-activity', summary }`.
- `TerminalActivityService` (`packages/terminal/src/activity.ts`) and
  `SqliteTerminalActivityRepository`.
- The renderer keeps one shared store (`terminal/state/terminal-activity.ts`). Each
  indicator subscribes to its own terminal only.

### Tests

- `packages/terminal/tests/activity.test.ts` (9):
  - precedence;
  - green only after review;
  - start, end and review;
  - failure with and without an exit code;
  - two runs on one terminal;
  - stale and late events;
  - terminal ended during a run;
  - restart (stored RUNNING → INTERRUPTED);
  - unknown and removed terminals;
  - only the latest reviewed result kept.
- `packages/persistence/tests/sqlite.test.ts`: upsert, unknown terminal, prune and cascade.
- `apps/engine/tests/terminal-activity.test.ts` (4), with real wrapper event files:
  - idle → AI running → attention → reviewed;
  - failure, and pending results across an Engine restart;
  - terminal terminated during a run, then dismissed;
  - wrappers outside terminals and unknown terminals.
- `tests/e2e/terminal-status.spec.ts`:
  - a live shell is neutral;
  - running, attention, review from the tab context menu (green);
  - failed with the pane header button;
  - restart showing a disconnected tab with a pending review;
  - review from the pane header.
- `tests/e2e/security.spec.ts`: the bridge keys `activities` and `markReviewed`.

### Known limitations

- Only AI runs started through the ATLAS wrappers are tracked. A Claude Code or Codex binary
  called by full path, bypassing the wrapper, is not.
- An AI waiting for a permission or an answer is shown as running, not attention (Q1).
- Logs, Retry and Operations links do not apply to AI runs in terminals. Background jobs are
  not tied to terminals.
- The AI indicator blue is not a theme token yet. It matches the existing running-work color
  of the pane header.
