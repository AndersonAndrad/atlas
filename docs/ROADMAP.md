# ATLAS Roadmap

| Milestone | Specification | Scope                                                                                          | Status                                |
| --------- | ------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------- |
| M1        | SDD-001       | Monorepo foundation, headless Engine, CLI, Electron shell, Project Registry                    | Approved (committed by the developer) |
| M2        | SDD-002       | Multi-project terminal manager, Engine host process, CLI socket, shadcn/ui                     | Approved (committed by the developer) |
| M3        | SDD-003 A     | Standalone terminals, names, groups, Git details, version display                              | Approved                              |
| M3b       | SDD-003 B     | ATLAS Sessions: lifecycle, tasks, events, execution profiles                                   | Implemented — awaiting approval       |
| M4a       | SDD-004 A     | Git workflow: Git view, staging, diff, Conventional Commits, push/pull/fetch, branches         | Implemented — awaiting approval       |
| M4b       | SDD-004 B     | Claude Code and Codex execution through ATLAS Sessions                                         | Not started (needs its own plan)      |
| M5a       | SDD-005 A1    | Shared Context: memory, tasks, decisions, handoffs, managed Claude/Codex sessions in terminals | Implemented — awaiting approval       |
| M5b       | SDD-005 A2–C  | Automatic capture (after SDD-004 B), multi-agent teams, continuity and recovery                | Not started                           |
| M6a       | SDD-006 A     | Context retrieval: ranking, budgets, freshness, deduplication, cache, health, preview          | Implemented — awaiting approval       |
| M6b       | SDD-006 B     | Skills Hub: registry, discovery, compatibility, activation, versioning, UI                     | Implemented — awaiting approval       |
| M6c       | SDD-006 C     | Execution packages, role-specific preparation, provider switching (after SDD-004 B, SDD-005 B) | Not started (blocked)                 |
| M3c       | TBD           | Provider accounts (Claude, Codex) and usage tracking                                           | Not started                           |
| M4        | TBD           | Agents and multi-agent orchestration                                                           | Not started                           |
| M5        | TBD           | Skills Hub and Context Engine                                                                  | Not started                           |
| M6        | TBD           | Packaging, signing, auto-update, release pipeline                                              | Not started                           |

Notes:

- Sidebar entries for Sessions, Agents, Skills, Accounts, Usage and Settings exist only as
  disabled placeholders until their specifications are implemented.
- Per SDD-003 §11, Milestone B will not begin until Milestone A is validated and approved.
- Per SDD-004 §15, Milestone B (provider execution) begins only after Milestone A is
  validated and approved, with its own plan. Candidate Git follow-ups: hunk staging, syntax
  highlighting, `pushRemote` support, AI-assisted commit suggestions (after Milestone B).
- Candidate follow-ups: live project refresh when the CLI changes the database, Windows and
  Linux CI (real PTYs), a direct MessagePort for terminal output, terminal survival across
  app restarts (a detached daemon), configurable shortcuts, light theme.
