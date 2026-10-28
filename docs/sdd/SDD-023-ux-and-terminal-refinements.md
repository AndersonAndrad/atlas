# SDD-023 — UX & Terminal Refinements

Status: Task A02 implemented (PLAN-050 revision 1). Task A03 implemented (PLAN-052
revision 1). Task A04 (terminal Actions menu) implemented (PLAN-057 revision 1). Task A01 (split terminals keep their context) was PLAN-045. Other tasks need
their own plans.

## Task A04 — Terminal Actions menu

Implemented by PLAN-057 revision 1. Approved 2026-10-28 by Anderson Andrade ("pode seguir q1 a
q4 pode ir para o recomendado"). The specification calls this task "A03"; that id was already
used by the project palette and Projects drawer (PLAN-052), so it is recorded as **A04**.
Version 0.43.0, no schema change.

Decisions:

- **Q1:** the Actions menu replaces the pane's former "Git actions" menu.
- **Q2:** Commit opens the Git view with its commit dialog.
- **Q3:** Restart is offered only for ended terminals.
- **Q4:** the task is recorded as A04.

### The menu

Every terminal pane has an **Actions** button in its header. It keeps the former Git button's
indicators:

- a dot for pending work;
- a spinner while a Git operation runs;
- a red dot for an unseen failure.

| Section  | Actions                                                                       | Uses                                                                                                |
| -------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Git      | Switch branch…, View Git status, Fetch, Pull…, Push…, Commit…, Git operations | Branches, Pull and Push dialogs; GIT jobs; the Git view and its commit dialog; the operations panel |
| Project  | Project details, Open in editor, Open tasks, Refresh project info             | Project details; the editor; the Project Hub's Tasks tab; the project Git refresh                   |
| Terminal | Rename…, Split right, Split down, Duplicate, Clear output, Restart, Close…    | Tab rename; split with the terminal's context; a new tab continuing it; restart; the close flow     |

### Context and safety rules

- **Pinned target.** Each pane has its own menu. The repository and project are read from that
  pane's terminal when an action is chosen. A dialog opened from it keeps its repository,
  even if another tab becomes active.
- **Nothing runs on opening.** Fetch starts only when chosen, and shows its job as started in
  the background. Pull and Push go through their usual dialogs, with the same checks. Commit
  goes through the Git view's commit flow, with its pre-commit steps and background commit.
- **Branch switching.** It is the Branches dialog, which warns about uncommitted changes. Git
  carries them along or refuses. Nothing is stashed, reset or discarded.
- **Close.** A terminal still running a program asks for confirmation first.
- **Disabled actions.** They stay visible, with the reason under them, so keyboard and
  screen-reader users read it too:

| Situation                                          | Reason shown                                         |
| -------------------------------------------------- | ---------------------------------------------------- |
| Not in a Git repository                            | Not a Git repository.                                |
| Ended terminal (Git actions)                       | The terminal ended. Restart it to use Git here.      |
| Another change running in the repository           | Another Git operation is running in this repository. |
| Fetch already running                              | Fetching…                                            |
| No project                                         | This terminal is not in a registered project.        |
| Project folder missing                             | The project folder is missing.                       |
| No room for another pane                           | There is no room for another pane.                   |
| Running terminal (Restart)                         | Restart is available after the process ends.         |
| Editor's terminal panel (rename, split, duplicate) | Available in the Terminals view.                     |

**Errors.** Errors of an action show in the pane and can be dismissed. Job outcomes keep using
Operations and the notification center.

**Keyboard.** The menu opens with Enter or Space on the focused first action. The arrows move
between actions, and Escape closes the menu. Focus moves to what an action opened: a dialog,
the tab's name field, a new pane.

The pane's right-click menu (copy, paste, shared context, Preflight) is unchanged.

### Limitations

- Restarting a running terminal is not offered: it would need to stop its process first.
- Rename starts a moment after the menu closes, so the name field keeps the focus.
- Opening the editor without a file only switches the editor to the project.

### Tests

- **Unit:** every availability rule (`apps/desktop/tests/terminal-actions.test.ts`).
- **E2E** (`tests/e2e/terminal-actions.spec.ts`, Linux and Xvfb):
  - **Git project:**
    - keyboard navigation;
    - Restart disabled with its reason;
    - nothing runs on opening;
    - switching branch with an uncommitted change keeps the change;
    - Push through its dialog;
    - Commit opening the Git view's commit dialog.
  - **Without Git, without a project, busy and ended terminals:**
    - the reasons shown;
    - closing a busy terminal asks first;
    - Restart works once the terminal ended.
  - **Split, duplicate and rename.**
- The Git and context E2E use the new menu.

## Task A03 — Project palette and Projects drawer

Approved 2026-10-27 by Anderson Andrade ("opde seguir, q1 vai para gaveta também, q2
recomendado, q3 servem porém também preciso de um ícone para fazer isso, sempre vai ser
comando + manual action nunca somente atalho"). R1–R5 were presented but not acknowledged by
ID. Version 0.38.0, no schema change.

The Terminals sidebar lists only terminal groups and open terminals, so sharing the screen
does not show every registered project. Projects are reached on demand:

- **Projects drawer** (right side, overlay): every project as an accordion. The header shows
  availability, name, Git status badge and commits to push/pull. Expanded, it lists the
  project actions: Open terminal, Project details, Refresh Git status, Pause/Resume Git
  monitoring and the project's quick commands (read from the Engine on each expansion). A
  filter field narrows the list. **Pending push** (SDD-024 Task 02) moved here (Q1).
- **Project palette** (floating): search a project, then one of its actions. Arrow keys move,
  Enter chooses; Escape, or Backspace in an empty search, goes back from the actions to the
  projects; Escape on the projects closes it. With an empty search it shows **Recently
  opened** projects (opened a terminal or ran a quick command), kept in memory only (Q2):
  the list is empty after a restart.
- Search ignores case and accents; names starting with the query come first.
- Every shortcut also has a button (Q3): the search and panel icons in the sidebar header
  (and next to the group selector in narrow windows).

| Action          | macOS | Windows / Linux  |
| --------------- | ----- | ---------------- |
| Search projects | ⌘P    | Ctrl+Shift+P     |
| Projects panel  | ⇧⌘P   | Ctrl+Alt+Shift+P |

From another view, either shortcut switches to Terminals first. Actions that open a terminal
or a sheet run after the drawer or palette closed, so the new terminal keeps the keyboard.
The former per-project "…" menu of the sidebar was replaced by the drawer and the palette;
both use one `useProjectActions` hook.

### Tests

- `apps/desktop/tests/project-navigation.test.ts`: filtering (case, accents, order, literal
  text) and the recently opened list (order, duplicates, limit).
- `tests/e2e/project-navigation.spec.ts`: the sidebar does not list projects; palette by
  button and shortcut, keyboard only, back navigation, recently opened; drawer by shortcut
  from another view, filter, Escape, Project details.
- Updated for the drawer: `quick-commands`, `git-monitoring`, `workspace` and `pending-push`
  E2E specs, and the `openProjectTerminal` fixture.

### Known limitations

- Recently opened projects are not persisted (Q2).
- Ctrl+Shift+P on Windows/Linux is taken by the application menu, so a terminal program
  that binds it does not receive it.

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
