# ATLAS Roadmap

| Milestone | Specification | Scope                                                                                           | Status                                |
| --------- | ------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------- |
| M1        | SDD-001       | Monorepo foundation, headless Engine, CLI, Electron shell, Project Registry                     | Approved (committed by the developer) |
| M2        | SDD-002       | Multi-project terminal manager, Engine host process, CLI socket, shadcn/ui                      | Approved (committed by the developer) |
| M3        | SDD-003 A     | Standalone terminals, names, groups, Git details, version display                               | Approved                              |
| M3b       | SDD-003 B     | ATLAS Sessions: lifecycle, tasks, events, execution profiles                                    | Implemented — awaiting approval       |
| M4a       | SDD-004 A     | Git workflow: Git view, staging, diff, Conventional Commits, push/pull/fetch, branches          | Implemented — awaiting approval       |
| M4b       | SDD-004 B     | Claude Code and Codex execution through ATLAS Sessions                                          | Not started (needs its own plan)      |
| M5a       | SDD-005 A1    | Shared Context: memory, tasks, decisions, handoffs, managed Claude/Codex sessions in terminals  | Implemented — awaiting approval       |
| M5b       | SDD-005 A2–C  | Automatic capture (after SDD-004 B), multi-agent teams, continuity and recovery                 | Not started                           |
| M6a       | SDD-006 A     | Context retrieval: ranking, budgets, freshness, deduplication, cache, health, preview           | Implemented — awaiting approval       |
| M6b       | SDD-006 B     | Skills Hub: registry, discovery, compatibility, activation, versioning, UI                      | Implemented — awaiting approval       |
| M6c       | SDD-006 C     | Execution packages, role-specific preparation, provider switching (after SDD-004 B, SDD-005 B)  | Not started (blocked)                 |
| M7a       | SDD-007 A     | Preflight: local checks, package scripts, GitHub Actions through act, history, authorization    | Implemented — awaiting approval       |
| M7b       | SDD-007 B     | Quality gates: commit/push/merge policies, fingerprints, stale results, overrides, hooks        | Not started (after A is validated)    |
| M7c       | SDD-007 C     | AI-assisted correction loop, budgets, isolated worktrees, delivery reports                      | Not started (after B)                 |
| M8a       | SDD-008 A     | Multi-account management: authentication, permissions, selection per session and agent          | Not started (minimal profiles in B)   |
| M8b       | SDD-008 B     | Usage and limits: provider limit windows, daily and weekly history, account profiles            | Implemented — awaiting approval       |
| M8c       | SDD-008 C     | Intelligence Router: policies, limit-aware routing, authorized fallback                         | Not started (after A and B)           |
| M9a       | SDD-009 A     | Notification center: bell, history, toasts, Git and Preflight events, background commits        | Implemented — awaiting approval       |
| M9b       | SDD-009 B     | Native notifications, background task events, agent events, deduplication, priorities           | Not started (after A is validated)    |
| M9c       | SDD-009 C     | Notification preferences, per-project overrides, Quiet Mode, configurable retention             | Not started (after B)                 |
| M10a      | SDD-010 A     | Project Hub: Markdown notes per project, folder or global; search, pin, archive, links          | Implemented — awaiting approval       |
| M10b      | SDD-010 B     | Local task manager: TODO lists, board, checklists, sessions, Git links, AI delegation           | Not started (after A is validated)    |
| M10c      | SDD-010 C     | Multiple Jira Cloud connections, mappings, read-only sync, issues as session objectives         | Not started (after B)                 |
| M11a      | SDD-011 A     | Code editor: Monaco, explorer, tabs, safe saves, external changes, layout, terminal             | Implemented — awaiting approval       |
| M11b      | SDD-011 B     | Git decorations, diff, conflicts, search, command palette, language servers                     | Not started (after A is validated)    |
| M11c      | SDD-011 C     | Editor context for AI, AI change preview, Preflight from the editor, handoff                    | Not started (after B)                 |
| M12a      | SDD-012 A     | Background jobs: SQLite queue, limits, cancel, progress, logs, Operations Center, indicator     | Implemented — awaiting approval       |
| M12b      | SDD-012 B     | Scheduling: once, delay, interval; missed-run and overlap policies; recovery; retry policies    | Not started (after A is validated)    |
| M12c      | SDD-012 C     | Preflight, Git, agent, account, Hub and Shared Context integrations; extension point            | Not started (after B)                 |
| M13a      | SDD-013 A     | Container Manager: Docker detection, contexts, containers, logs, usage, shell, creation         | Implemented — awaiting approval       |
| M13b      | SDD-013 B     | Images (pull, build, update), networks and topology, volumes; background jobs and notifications | Not started (after A is validated)    |
| M13c      | SDD-013 C     | Compose discovery and lifecycle, project integration, startup and shutdown, AI diagnostics      | Not started (after B)                 |
| M4        | TBD           | Agents and multi-agent orchestration                                                            | Not started                           |
| M5        | TBD           | Skills Hub and Context Engine                                                                   | Not started                           |
| M6        | PLAN-024      | Packaging and CI release pipeline (done); signing, notarization, auto-update (not started)      | Partially implemented                 |

Notes:

- Sidebar entries for Agents and Accounts exist only as disabled placeholders until their
  specifications are implemented.
- SDD-009 Milestone A includes the Git and Preflight event sources (FR-915, nominally
  Milestone B) at the developer's request (PLAN-030 Q2), so the center reports real work.
- SDD-008 Milestone B was implemented before Milestone A at the developer's request
  (PLAN-027): it brings only a minimal profile registry that Milestone A extends.
- Per SDD-003 §11, Milestone B will not begin until Milestone A is validated and approved.
- Per SDD-004 §15, Milestone B (provider execution) begins only after Milestone A is
  validated and approved, with its own plan. Candidate Git follow-ups: hunk staging, syntax
  highlighting, `pushRemote` support, AI-assisted commit suggestions (after Milestone B).
- Candidate follow-ups: live project refresh when the CLI changes the database, Windows and
  Linux CI (real PTYs), a direct MessagePort for terminal output, terminal survival across
  app restarts (a detached daemon), configurable shortcuts, light theme.
