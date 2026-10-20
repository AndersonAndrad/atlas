# ATLAS Roadmap

| Milestone | Specification | Scope                                                                       | Status                                |
| --------- | ------------- | --------------------------------------------------------------------------- | ------------------------------------- |
| M1        | SDD-001       | Monorepo foundation, headless Engine, CLI, Electron shell, Project Registry | Approved (committed by the developer) |
| M2        | SDD-002       | Multi-project terminal manager, Engine host process, CLI socket, shadcn/ui  | Implemented — awaiting approval       |
| M3        | TBD           | Provider accounts (Claude, Codex) and usage tracking                        | Not started                           |
| M4        | TBD           | Agents and multi-agent orchestration                                        | Not started                           |
| M5        | TBD           | Skills Hub and Context Engine                                               | Not started                           |
| M6        | TBD           | Packaging, signing, auto-update, release pipeline                           | Not started                           |

Notes:

- Sidebar entries for Sessions, Agents, Skills, Accounts, Usage and Settings exist only as
  disabled placeholders until their specifications are implemented.
- Per SDD-002 §15, SDD-003 will not begin until SDD-002 is validated and explicitly approved.
- Candidate follow-ups: live project refresh when the CLI changes the database, Windows and
  Linux CI (real PTYs), a direct MessagePort for terminal output, terminal survival across
  app restarts (a detached daemon), configurable shortcuts, light theme.
