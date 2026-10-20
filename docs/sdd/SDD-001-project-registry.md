# ATLAS — SDD-001: Project Registry

**Project:** ATLAS — Autonomous Task Leadership & Agent System  
**Specification:** SDD-001  
**Feature:** Project Registry & Workspace Management  
**Priority:** Critical  
**Status:** Implemented — awaiting validation approval (see [Approved changes](#approved-changes-and-clarifications) and `docs/STATUS.md`)  
**Methodology:** Spec-Driven Development

---

## 1. Objective

Implement the initial foundation of ATLAS and its Project Registry.

ATLAS is a local-first, Electron-based development environment designed to manage multiple projects, terminal sessions, and autonomous AI agent teams.

This specification covers the foundation and the first functional feature: managing local software projects.

The implementation must establish reusable architectural patterns for future development.

Do not implement AI orchestration, terminal management, or provider integrations in this phase.

## 2. Architecture Principles

The project must follow these principles:

- Modular monorepo architecture.
- TypeScript across all applications.
- Separation between Electron UI and the Headless Engine.
- Domain-driven module boundaries.
- Strong typing and runtime validation.
- Persistent local state.
- Secure Electron IPC.
- Testable business logic.
- Dependency inversion.
- No unnecessary abstractions.
- No premature microservices.

### Recommended stack

- Electron
- React
- TypeScript
- Vite
- Node.js
- pnpm workspaces
- SQLite
- Zod
- Vitest
- Playwright for relevant E2E tests

Use a lightweight modular Node.js Engine rather than introducing NestJS immediately.

The Engine must be capable of running independently from Electron.

## 3. Initial Monorepo Structure

```text
atlas/
├── apps/
│   ├── desktop/
│   │   ├── src/
│   │   │   ├── main/
│   │   │   ├── preload/
│   │   │   └── renderer/
│   │   └── package.json
│   │
│   ├── engine/
│   │   ├── src/
│   │   │   ├── bootstrap/
│   │   │   ├── modules/
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   └── cli/
│       └── package.json
│
├── packages/
│   ├── contracts/
│   ├── projects/
│   ├── persistence/
│   └── shared/
│
├── docs/
│   ├── architecture/
│   ├── decisions/
│   └── sdd/
│
├── tests/
├── package.json
├── pnpm-workspace.yaml
└── README.md
```

Only create directories and modules needed for this specification.

Do not generate dozens of empty placeholder modules for future features.

## 4. Functional Requirements

### FR-001 — Register Project

The user must be able to register a local project.

Required information:

- Project name.
- Local directory path.

Optional information:

- Description.
- Tags.

The application should detect:

- Whether the directory exists.
- Whether it is accessible.
- Whether it contains a Git repository.
- Git repository root, when applicable.
- Current Git branch, when available.

Do not require Git to register a project.

### FR-002 — Native Directory Selection

The Electron interface must provide a native directory picker.

The user must not be required to type filesystem paths manually.

The selected directory must be validated by the Engine before registration.

### FR-003 — Project Listing

Display all registered projects.

Each project card should show:

- Name.
- Directory path.
- Git repository status.
- Last opened date, when available.
- Availability status.

The interface should support selecting a project and viewing its details.

### FR-004 — Edit Project

Allow editing:

- Name.
- Description.
- Tags.
- Local directory path.

Changing the directory must trigger validation.

### FR-005 — Remove Project

Allow removing a project from the ATLAS Registry.

Removing a project must never delete its directory, Git repository, or source files.

Require confirmation before removing the registry entry.

### FR-006 — Persistent Storage

Projects must remain registered after closing and reopening ATLAS.

Use SQLite with a dedicated repository abstraction.

The database must be stored in an appropriate application data directory, not inside the ATLAS source repository.

### FR-007 — Duplicate Detection

Prevent registering the same normalized directory twice on the same machine.

Handle filesystem path normalization according to the operating system.

Do not assume Windows, macOS, and Linux have identical path semantics.

### FR-008 — Multiple Projects

Allow multiple projects to be registered simultaneously.

Selecting one project must not remove or modify the others.

Persist the last selected project and restore it when reopening the application, if it remains available.

### FR-009 — Project Availability

If a previously registered directory becomes unavailable:

- Keep the project registered.
- Display an unavailable status.
- Allow the user to update the path.
- Do not crash or silently delete the project.

### FR-010 — CLI Access

Expose basic project operations through the headless Engine and CLI.

Minimum CLI operations:

```bash
atlas project list
atlas project add <path>
atlas project show <id>
atlas project remove <id>
```

The CLI and Electron application must use the same domain services and persistence layer.

The CLI must not require the Electron interface to be open.

## 5. Domain Model

Define a Project entity with at least:

```typescript
interface Project {
  id: string;
  name: string;
  description?: string;
  tags: string[];

  workspacePath: string;

  git: {
    isRepository: boolean;
    repositoryRoot?: string;
  };

  createdAt: string;
  updatedAt: string;
  lastOpenedAt?: string;
}
```

The persisted model should contain stable metadata.

Dynamic information, such as current Git branch and filesystem availability, should be retrieved when needed rather than treated as permanently accurate.

Create separate contracts for:

- CreateProjectInput
- UpdateProjectInput
- ProjectDetails
- ProjectAvailability
- ProjectRepository

Use Zod for input validation.

## 6. Application Services

Implement the following operations:

```typescript
interface ProjectService {
  create(input: CreateProjectInput): Promise<Project>;

  findAll(): Promise<Project[]>;

  findById(id: string): Promise<Project | null>;

  update(id: string, input: UpdateProjectInput): Promise<Project>;

  remove(id: string): Promise<void>;

  inspectPath(path: string): Promise<ProjectPathInspection>;

  selectProject(id: string): Promise<void>;

  getSelectedProject(): Promise<Project | null>;
}
```

Keep application services independent of Electron.

Filesystem inspection and persistence must be accessed through explicit abstractions.

## 7. Electron Application

Implement the initial ATLAS Control interface.

### Layout

Provide:

- Main application window.
- Persistent sidebar.
- Project listing.
- Project details view.
- Add project dialog.
- Edit project dialog.
- Remove confirmation dialog.
- Empty state for new installations.

### Sidebar

Prepare navigation entries for:

- Projects
- Sessions
- Agents
- Skills
- Accounts
- Usage
- Settings

Only Projects must be functional in SDD-001.

Future sections should be visibly unavailable rather than presenting fake working functionality.

### Visual Identity

Use a modern, technical interface inspired by developer tools such as Warp and VS Code.

Design direction:

- Dark-first theme.
- Minimal visual noise.
- Compact navigation.
- Clear status indicators.
- Responsive panels.
- Consistent spacing and typography.

Avoid unnecessary animations and decorative dashboards.

### Security

Electron must use:

- Context isolation enabled.
- Node integration disabled in the renderer.
- A narrowly scoped preload API.
- Validated IPC payloads.
- No arbitrary filesystem access from React.
- No direct database access from React.

The renderer must never receive unrestricted Node.js execution capabilities.

## 8. Headless Engine

The Engine must own project business logic.

Electron should act as a client.

For SDD-001, an embedded local Engine process or equivalent independent application service is acceptable, provided the Engine remains executable and testable without Electron.

Avoid introducing an unnecessary public HTTP server.

Design communication boundaries so a local API can be added later without rewriting the domain layer.

The CLI must reuse the same application services.

## 9. Database

Implement SQLite persistence with versioned migrations.

Initial tables:

### projects

- id
- name
- description
- workspace_path
- tags
- git_repository_root
- is_git_repository
- created_at
- updated_at
- last_opened_at

### application_settings

- key
- value

Store the selected project identifier in application settings.

Use parameterized queries and appropriate database constraints.

## 10. Error Handling

Define structured application errors.

Examples:

- PROJECT_NOT_FOUND
- PROJECT_ALREADY_EXISTS
- PROJECT_PATH_INVALID
- PROJECT_PATH_UNAVAILABLE
- PROJECT_PERMISSION_DENIED
- PROJECT_PERSISTENCE_ERROR

The UI should display understandable messages.

Technical details must remain available in internal logs.

Do not expose unnecessary filesystem or internal implementation details through user-facing error messages.

## 11. Automated Tests

### Unit Tests

Cover:

- Project creation.
- Project updates.
- Project removal.
- Duplicate detection.
- Input validation.
- Project selection.
- Path normalization.
- Unavailable directories.

### Integration Tests

Cover:

- SQLite persistence.
- Database migrations.
- Repository operations.
- Filesystem inspection.
- Git detection.
- Restart persistence.

### UI Tests

Cover:

- Adding a project through the native picker.
- Listing projects.
- Editing project metadata.
- Removing a project.
- Restoring the last selected project.
- Displaying unavailable directories.

Use isolated temporary directories and databases.

Tests must never modify real user projects.

## 12. Acceptance Criteria

SDD-001 is complete only when:

- [ ] The monorepo installs and builds successfully.
- [ ] Electron launches successfully.
- [ ] The Headless Engine runs independently.
- [ ] The CLI works without Electron.
- [ ] A user can register a project using a native directory picker.
- [ ] Registered projects appear in the interface.
- [ ] Project metadata can be edited.
- [ ] Registry entries can be removed without deleting files.
- [ ] Duplicate directories are rejected.
- [ ] Projects persist after restarting the application.
- [ ] The selected project is restored after restart.
- [ ] Unavailable directories are handled gracefully.
- [ ] Git repository information is detected correctly.
- [ ] Renderer processes cannot access unrestricted Node.js APIs.
- [ ] Unit and integration tests pass.
- [ ] Relevant UI tests pass.
- [ ] TypeScript checks pass.
- [ ] The application builds without errors.
- [ ] Documentation reflects the actual implementation.

Do not declare completion based only on code generation.

Provide test evidence and identify any unverified criteria.

> The checklist above is preserved as written. Its verification status and evidence are
> tracked in `docs/STATUS.md`.

## 13. Required Documentation

Create and maintain:

```text
docs/
├── ARCHITECTURE.md
├── ROADMAP.md
├── STATUS.md
├── DECISIONS.md
└── sdd/
    └── SDD-001-project-registry.md
```

### ARCHITECTURE.md

Document module boundaries, communication mechanisms, persistence, and relevant technical decisions.

### ROADMAP.md

Record planned development milestones.

### STATUS.md

Record implemented functionality, known limitations, pending work, and validation results.

### DECISIONS.md

Record significant architectural decisions and their justifications.

### SDD-001-project-registry.md

Preserve this specification and document any approved changes.

## 14. Implementation Workflow

Follow Spec-Driven Development.

### Step 1 — Analyze

Review the specification and identify ambiguities, dependencies, and risks.

### Step 2 — Plan

Create an implementation plan with small, verifiable tasks.

### Step 3 — Implement

Build the minimum complete vertical slice.

Prioritize working functionality over premature abstraction.

### Step 4 — Validate

Run type checking, tests, builds, and available application-level verification.

### Step 5 — Document

Update the architecture, decisions, roadmap, and status documents.

### Step 6 — Report

Provide a concise implementation report containing:

- Completed functionality.
- Files and modules created.
- Tests executed and results.
- Known limitations.
- Remaining issues.
- Commands to run the application.

## 15. Strict Scope

Do not implement the following during SDD-001:

- AI providers.
- Claude or Codex integration.
- Multi-agent orchestration.
- Skills Hub.
- Context Engine.
- Token usage dashboards.
- Terminal management.
- Remote workers.
- Automatic self-development.
- Production deployment systems.

These belong to future specifications.

However, do not introduce architectural decisions that unnecessarily prevent their integration.

## 16. Final Instruction

Implement SDD-001 completely before proposing SDD-002.

Do not simulate successful functionality.

Do not create fake dashboards or placeholder business logic.

Favor clean architecture, functional behavior, automated verification, and accurate documentation.

The result must be a working ATLAS desktop application capable of managing multiple local projects, supported by an independent headless Engine and CLI.

**Do not begin SDD-002 until SDD-001 has been validated and explicitly approved.**

---

## Approved changes and clarifications

Approved by Anderson Andrade (identity basis: Git `user.name`) on 2026-10-19 as
**PLAN-001 revision 1**, with risks R1–R8 acknowledged. Approval quote (original
language): _"Aprovo PLAN-001 rev 1, ciente de R1–R8, pode fazer git init, r2 -> usa o lts, r4 -> lembra do mac"_.

| ID  | Topic                                  | Clarification / change                                                                                                                                                                                    |
| --- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | `atlas project add <path>` has no name | Name defaults to the directory name; `--name`, `--description`, `--tag` (repeatable) are available. `remove` asks for confirmation interactively and requires `--yes` when not interactive.               |
| D2  | Registering a non-existent path        | Rejected on create and on path change (`PROJECT_PATH_UNAVAILABLE`, `PROJECT_PATH_INVALID`, `PROJECT_PERMISSION_DENIED`). Already-registered projects whose directory disappears stay registered (FR-009). |
| D3  | Meaning of "last opened"               | Set when a project is selected (`selectProject`).                                                                                                                                                         |
| D4  | Engine "runs independently"            | Library with composition root `createEngine()`, embedded in Electron main and in the CLI, plus the standalone `atlas-engine status` / `atlas-engine migrate` binary.                                      |
| D5  | Shared database                        | Same per-user data directory for desktop and CLI; `ATLAS_DATA_DIR` override.                                                                                                                              |
| D6  | Path normalization                     | Adds a `path_key` UNIQUE column (not in §9's list). macOS/Windows case-insensitive keys, Linux exact.                                                                                                     |
| D7  | Git detection                          | Reads `.git` metadata directly; no `git` executable required.                                                                                                                                             |
| D8  | "Application builds"                   | `electron-vite build` + `tsc -b`. Installers/signing are out of scope (§15, production deployment).                                                                                                       |
| D9  | Tags                                   | JSON array column; up to 20 tags of up to 32 characters; case-insensitive de-duplication.                                                                                                                 |
| R2  | Dependency versions                    | Developer instruction "use LTS": Node 24 LTS and stable, ≥ 2-week-old release lines (see ADR-007).                                                                                                        |
| R4  | Platform verification                  | Developer instruction "remember the Mac": macOS is the verified platform; Windows/Linux path semantics are covered by unit tests only.                                                                    |

Additional interpretation recorded during implementation (no behavior beyond the spec):

- **FR-008 "if it remains available"**: the selection is restored while the project is
  still registered; when the directory is unavailable the project is restored with an
  unavailable status so the path can be fixed (ADR-006).
