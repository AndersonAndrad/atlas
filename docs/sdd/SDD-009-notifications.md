# SDD-009 — Notification Center & Background Events

**Status:** Milestone A implemented (PLAN-030, v0.22.0, schema v11), together with the Git
and Preflight event sources of FR-915 — awaiting approval. Milestones B (native
notifications, deduplication, priorities, agent events) and C (preferences, Quiet Mode)
not started.
**Dependencies:** SDD-004 Milestone A (Git), SDD-007 Milestone A (Preflight).

Core principle: users should not need to watch terminals or dialogs to know when an
operation finishes, fails or needs attention. Notifications need no AI provider and no
network.

## Part I — Milestone A as implemented (PLAN-030)

### Decisions taken with the developer (2026-10-23)

- Approved by Anderson Andrade (Git `user.name`): "pode seguir, q1 ok, 12, q2 ok, q3 ok".
- Q1: the bell lives in a thin application bar at the top of the main area, at the right,
  on every view.
- Q2: the Git and Preflight event sources (FR-915, nominally Milestone B) are included, so
  the center reports real work from the start. No agent events: agents do not exist yet
  (SDD-004 B) and no event is invented.
- Q3: the flaky timing test of credential redaction (PLAN-029) is fixed in the same change.
- R1 acknowledged: quitting ATLAS stops the Engine and with it running commits and
  Preflight runs. At the developer's request, quitting now asks first when Git operations
  or Preflight runs are in progress (as it already did for running terminals).
- Commits run in the background: the commit dialog closes as soon as the Engine started the
  commit and the Git operations panel shows its steps; the outcome is notified.

### Architecture

```text
 GitOperationCoordinator.onChange ─┐  (finished operations; once per operation id)
 PreflightService.onRunFinished ───┤
                                   ▼
             gitOperationNotification / preflightRunNotification (packages/notifications)
                                   ▼
             NotificationService.publish ─► SqliteNotificationRepository (migration v11)
                                   │
                                   └─► terminals.publish({ type: 'notifications', created })
                                         ─► main ─► renderer (bell, panel, toasts)
```

- `packages/notifications` holds the service, the repository port and the event mappings;
  it depends only on contracts and shared. The Engine host (the process that owns
  terminals and runs Git and Preflight work) is the only publisher; the CLI's own Engine
  does not notify.
- Delivery reuses the existing Engine → main → renderer lifecycle event channel; there is
  no polling. The renderer reloads the list on every change event and after an Engine
  restart, so a reloaded window shows the stored history.
- `publish` never throws: a notification that cannot be validated or stored is logged
  (category and error only) and dropped, so the reported operation is never affected
  (FR-922). Listener failures are logged too.

### Model and storage

- `AtlasNotification`: `id`, `type` (INFO, SUCCESS, WARNING, ERROR, ACTION_REQUIRED),
  `category` (SYSTEM, PROJECT, TERMINAL, GIT, PREFLIGHT, AGENT, SESSION, BACKGROUND_TASK),
  `title`, `message`, `projectId`, `sourceName` (project, workspace or repository name),
  `sessionId`, `taskId` (Git operation or Preflight run id), `action`, `read`,
  `createdAt`, `readAt`.
- Dismissing deletes the notification (the developer asked for deletion); there is no
  separate `dismissed` state.
- `action` is a validated internal destination, never a command or a URL:
  `{ type: 'git-operation', repositoryRoot, operationId }` or
  `{ type: 'preflight-run', workspaceId, runId }`.
- Title (≤ 120) and message (≤ 500) are single-line plain text: control characters are
  removed and whitespace collapsed; the renderer shows them as text only. Messages are
  short summaries; Git output and check logs are never copied into a notification.
- SQLite table `notifications` (migration v11, additive, `STRICT`, checks on type, lengths
  and JSON action). History lives in the application data directory, never in a project.
- Retention (FR-905), applied after each publication: read notifications are removed 30
  days after they were read; beyond 1,000 stored, the oldest read ones go first, then the
  oldest unread ones. Unread ACTION_REQUIRED notifications are never removed by retention.
  The limits are constants until Milestone C adds settings.

### Event sources (FR-915, Git and Preflight)

| Source                                                                  | Notification                                                |
| ----------------------------------------------------------------------- | ----------------------------------------------------------- |
| Commit, push, pull, cherry-pick succeeded                               | SUCCESS, e.g. "Commit created", with Git's short summary    |
| Those operations or a merge failed                                      | ERROR with the short error message                          |
| Those operations or a merge stopped on conflicts                        | ACTION_REQUIRED "… resolve the conflicts"                   |
| Fetch failed                                                            | ERROR (successful fetches are not reported)                 |
| Staging, branches, aborts, merges ready to commit; cancelled operations | none                                                        |
| Preflight run PASSED / FAILED / INCOMPLETE                              | SUCCESS / ERROR / WARNING with check counts and the profile |
| Preflight run cancelled by the user                                     | none                                                        |

Git notifications name the repository's project (from the last repository discovery, no Git
command runs) or the repository folder.

### Interface

- Bell with the unread count at the top right of every view; its panel lists notifications
  newest first with severity icon, title, relative time, message, category and source,
  read state, All/Unread tabs, mark as read, mark all read, delete and clear all.
- Clicking a notification marks it read and opens its destination after checking it still
  exists: the repository in the Git view with the operations panel open, or the Preflight
  run. A missing destination shows a message in the application bar instead.
- Toasts at the bottom right (so they never cover view header actions): success and
  information close after 5 s, warnings and errors after 10 s, action required stays until
  closed. Closing a toast keeps the notification.
- Commit dialog: once the Engine started the commit, the dialog closes, the operations panel
  opens on the running commit and its steps, and the user can keep working. Refusals before
  the commit started (invalid message, missing destination) stay in the dialog. A failed
  commit offers "Edit commit" in the panel, which reopens the dialog with the same message
  (kept in memory until the window reloads).
- Quitting while Git operations or Preflight runs are in progress asks first, naming what
  stops. On macOS closing the window does not quit; the Engine keeps running and work
  continues.

### Validation (2026-10-23, macOS arm64, Node 24.18.0)

- Unit and integration: notification service (plain text, invalid destinations dropped,
  storage failures never thrown, listener failures, read/all read/delete/clear), event
  mappings, SQLite repository (order, filters, retention rules, constraints), Engine (commit
  success and hook failure notified once with project, event delivered, restored after a
  restart; Preflight failed run notified, cancelled run not, background work counted), quit
  warning text.
- End-to-end: the mandatory scenario with a real commit whose step waits — dialog closes,
  panel shows the running step, the user switches views, the toast and unread count appear,
  the notification opens the operation and is read, history survives a restart, delete and
  clear; a Preflight run notified while on another view opens its result; the panel fits 380
  and 1440 px without horizontal overflow.
- Not verified: Linux and Windows E2E.

### Known limitations

- No native notifications, deduplication windows or priorities yet (Milestone B); one
  notification per finished operation is guaranteed by operation id.
- No preferences, project overrides or Quiet Mode yet (Milestone C).
- Quitting stops background work (R1); the quit dialog warns first.
- Only the Engine host publishes; operations started by the CLI's own Engine are not
  notified.

## Part II — Remaining milestones

Milestone B: Electron native notifications (focus and restore on click, permissions),
background task event contract, agent events once SDD-004 B exists, deduplication keys and
aggregation windows, priorities. Milestone C: global and per-project preferences, Quiet
Mode, configurable retention, permission-denied and persistence-failure handling in the
UI. Each needs its own plan after the previous milestone is validated.
