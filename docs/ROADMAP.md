# ATLAS Roadmap

| Milestone | Specification | Scope                                                                       | Status                                    |
| --------- | ------------- | --------------------------------------------------------------------------- | ----------------------------------------- |
| M1        | SDD-001       | Monorepo foundation, headless Engine, CLI, Electron shell, Project Registry | Implemented — awaiting approval           |
| M2        | SDD-002 (TBD) | Terminal sessions per project                                               | Not started (blocked on SDD-001 approval) |
| M3        | TBD           | Provider accounts (Claude, Codex) and usage tracking                        | Not started                               |
| M4        | TBD           | Agents and multi-agent orchestration                                        | Not started                               |
| M5        | TBD           | Skills Hub and Context Engine                                               | Not started                               |
| M6        | TBD           | Packaging, signing, auto-update, release pipeline                           | Not started                               |

Notes:

- Sidebar entries for Sessions, Agents, Skills, Accounts, Usage and Settings exist only as
  disabled placeholders until their specifications are implemented.
- Per SDD-001 §16, SDD-002 will not begin until SDD-001 is validated and explicitly approved.
- Candidate follow-ups for the registry itself: live refresh when the CLI changes the
  database (instead of refresh-on-focus), Engine in a `utilityProcess`, Windows/Linux CI.
