# ATLAS — SDD-002: Terminal Manager

**Project:** ATLAS — Autonomous Task Leadership & Agent System  
**Specification:** SDD-002  
**Feature:** Multi-Project Terminal Manager  
**Priority:** Critical  
**Depends on:** SDD-001 — Project Registry  
**Status:** Implemented — awaiting validation approval (see `docs/STATUS.md`)

Part I documents the implementation. Part II preserves the specification as received.

---

# Part I — Implementation

## Approved plan and deviations

PLAN-002 revision 1 was approved with "pode implementar" together with a new requirement
to use shadcn/ui, which produced revision 2. Revision 2 was approved with the option
"App inteiro (Recommended)", acknowledging risks R1–R12 (approval given in the
conversation by the developer, Git `user.name`: Anderson Andrade; recorded 2026-10-19).

| ID  | Decision / deviation                                                                                     | Reference |
| --- | -------------------------------------------------------------------------------------------------------- | --------- |
| D1  | The whole Engine runs in an Electron `utilityProcess` (Engine host); main is a validating broker         | ADR-009   |
| D2  | Reattachment uses a headless xterm mirror + serialize addon with sequence numbers                        | ADR-010   |
| D3  | shadcn/ui (Tailwind v4, Radix) for the entire app; SDD-001 screens migrated                              | ADR-011   |
| D4  | CLI ↔ Engine over an authenticated local socket; `atlas terminal …` requires ATLAS Control to be running | ADR-012   |
| D5  | Terminal processes do not survive quitting ATLAS (quit asks first)                                       | ADR-013   |
| D6  | Tab close confirmation based on the foreground process (always on Windows)                               | ADR-014   |
| D7  | Limits: 6 visible panes per project, 32 live / 64 total sessions                                         | —         |
| D8  | Verified on macOS only; Windows/Linux logic covered by unit tests                                        | —         |
| D9  | Custom shells configured in `<data dir>/shells.json`                                                     | —         |

Risks acknowledged with the plan: R1 node-pty in the utility process (resolved by the spike
and a postinstall fix), R2 snapshot fidelity, R3 SDD-001 regression, R4 socket path/pipe
permissions, R5 inline styles in the CSP, R6 Windows/Linux unverified, R7 background jobs
not detected, R8 Engine crash loses terminals, R9 CLI project removal race, R10 output
relayed by main, R11 SDD-001 UI migration, R12 new UI dependencies.

## PTY architecture

`TerminalService` (`packages/terminal`) owns sessions and depends only on ports:
`PtySpawner`, `ScreenMirrorFactory`, `ShellProvider`, `WorkspaceResolver`,
`TerminalSessionRepository`, `EnvironmentProvider`. Adapters live in `apps/engine`:
`NodePtySpawner` (node-pty 1.1.0), `HeadlessScreenMirrorFactory` (`@xterm/headless` 6.0.0 +
`@xterm/addon-serialize` 0.14.0), `SystemShellProvider`, `ShellEnvironment`. The
renderer renders with `@xterm/xterm` 6.0.0, `@xterm/addon-fit` and `@xterm/addon-search`.
Details: `docs/ARCHITECTURE.md` → "Terminal subsystem".

## Engine communication

| Path               | Transport                                         | Validation                                   |
| ------------------ | ------------------------------------------------- | -------------------------------------------- |
| Renderer → main    | `ipcRenderer.invoke` / `send` through the preload | Trusted sender + Zod tuples in main          |
| Main → Engine host | `utilityProcess` `postMessage` (request ids)      | `EngineDispatcher` (Zod), scope `desktop`    |
| CLI → Engine host  | NDJSON over Unix socket / named pipe, token auth  | `EngineDispatcher`, scope `cli` (allow-list) |
| Engine → renderer  | `event` messages → main → `webContents.send`      | Output routed only to the attached view      |

Operations: create, list, get, write (raw PTY input), resize, rename, terminate, restart,
dismiss, closeInfo, clear, attach/detach/ack (views), shells, preferences, layouts,
lifecycle events (`session`, `removed`) and ordered `output` events (`seq` per session).
Output is batched (8 ms / 32 KiB), bounded by flow control (pause above 1 MiB
unacknowledged per view) and never persisted.

## Supported shells

macOS: `$SHELL`, zsh, bash (login shells). Linux: `$SHELL`, bash, zsh. Windows: PowerShell
7, Windows PowerShell, cmd. Only executables that exist are offered; nothing assumes Git
Bash, WSL or zsh. Additional shells — including an explicit WSL launcher, which is listed
as a custom shell rather than native Windows support — come from `shells.json`
(see ARCHITECTURE). The default follows the user preference, then the OS.

## Process lifecycle

`CREATED → STARTING → RUNNING → EXITED | TERMINATING → TERMINATED`, `FAILED` on startup
errors. Handled: successful exit, nonzero exit codes, signals, startup failure (shown with
a user-safe message), user termination (SIGHUP, SIGKILL after 3 s), Engine shutdown
(`engine-shutdown`), Engine crash (`engine-lost` on next start; the main process restarts
the Engine host). The Engine never reports a session as RUNNING after its process exited.

## Close behavior

| Action                                     | Effect                                                                  |
| ------------------------------------------ | ----------------------------------------------------------------------- |
| Hide pane (× in the pane header)           | View detached; process keeps running; tab stays                         |
| Switch tab / project, reload renderer      | Views detached and later reattached from the mirror; processes continue |
| Close tab (× on the tab, ⌘W)               | Terminates the process — confirmation if a program is in the foreground |
| `atlas terminal close <id>`                | Terminates; requires `--yes` when non-interactive                       |
| Remove project                             | Desktop: dialog warns, terminals terminated. CLI: refused while running |
| Close window (macOS)                       | App and terminals keep running; reopening reattaches                    |
| Quit ATLAS (⌘Q; window close on Win/Linux) | Confirmation when terminals run, then every process is terminated       |

## Terminal persistence and its limits

Persisted: preferences (font size, font family, scrollback, default shell), tab titles,
project association and session metadata (`terminal_sessions`), per-project layouts.
Not persisted: processes, output, input or command history. After a restart previous
sessions are shown as ended and can be restarted (new process, same title and shell); they
are never reported as running. Reattach replay is limited to the mirror's 1,000 lines of
scrollback.

## Keyboard shortcuts

Shortcuts are application-menu accelerators (visible in the menu bar).

| Action                    | macOS        | Windows / Linux             |
| ------------------------- | ------------ | --------------------------- |
| New terminal              | ⌘T           | Ctrl+Shift+T                |
| Close terminal (tab)      | ⌘W           | Ctrl+Shift+W                |
| Next terminal             | ⇧⌘]          | Ctrl+PageDown               |
| Previous terminal         | ⇧⌘[          | Ctrl+PageUp                 |
| Split right               | ⌘D           | Ctrl+Shift+D                |
| Split down                | ⇧⌘D          | Ctrl+Shift+E                |
| Focus next pane           | ⌘]           | Ctrl+Shift+]                |
| Focus previous pane       | ⌘[           | Ctrl+Shift+[                |
| Find in terminal          | ⌘F           | Ctrl+Shift+F                |
| Clear terminal            | ⌘K           | Ctrl+Shift+K                |
| Font size + / − / reset   | ⌘= / ⌘- / ⌘0 | Ctrl+= / Ctrl+- / Ctrl+0    |
| Copy / Paste              | ⌘C / ⌘V      | Ctrl+Shift+C / Ctrl+Shift+V |
| Projects / Terminals view | ⌘1 / ⌘2      | Ctrl+Shift+1 / Ctrl+Shift+2 |
| Close window              | ⇧⌘W          | (closing quits)             |

Rename a tab by double-clicking it or pressing F2. On Windows/Linux, Ctrl+C, Ctrl+D,
Ctrl+W, Ctrl+R, etc. are left to the shell.

## Known platform limitations

- Verified on macOS (arm64) only. Windows (ConPTY) and Linux run the same code paths but
  were not executed; on Linux node-pty compiles during installation (requires build tools).
- Windows cannot report the foreground process, so closing a running tab always asks.
- Background jobs are not detected by the close confirmation.
- The snapshot may not restore every terminal mode (e.g. mouse tracking); full-screen
  programs may need a redraw (Ctrl+L) after reattaching.
- Terminal output is relayed through the Electron main process (batched).

---

# Part II — Specification as received

## 1. Objective

Implement a fully functional integrated terminal system in ATLAS Control.

Users must be able to manage multiple terminal sessions across multiple registered projects, similar to modern development terminals such as Warp.

The Terminal Manager must support real shell processes, interactive commands, concurrent execution, terminal tabs, split panes, resizing, and safe process lifecycle management.

The implementation must establish the execution infrastructure required by future AI agents and orchestration sessions.

**Core principle: A terminal is an execution resource managed by the ATLAS Engine, not by the Electron renderer.**

## 2. Prerequisites

Before implementation:

1. Inspect the existing ATLAS repository.
2. Review SDD-001 implementation and architecture.
3. Identify the actual desktop, Engine, IPC, persistence, and testing structures.
4. Reuse existing abstractions and conventions.
5. Avoid unnecessary restructuring.
6. Preserve all existing Project Registry functionality.

Do not assume the repository structure exactly matches the original specification.

Document any significant architectural changes.

## 3. Functional Requirements

### FR-001 — Create Terminal Session

Users must be able to create terminal sessions associated with registered projects.

Each terminal must have:

- Unique session identifier.
- Associated project identifier.
- Working directory.
- Shell executable.
- Process identifier when available.
- Creation timestamp.
- Runtime status.
- Exit code when applicable.

The initial working directory must be the selected project's registered workspace path.

Validate project availability before creating the terminal.

### FR-002 — Real Interactive Shell

Use a real pseudoterminal implementation.

Recommended technologies:

- node-pty for PTY processes.
- xterm.js for terminal rendering.
- FitAddon for automatic terminal resizing.

Support:

- Standard input and output.
- Interactive commands.
- ANSI colors.
- Terminal cursor movement.
- Full-screen terminal applications.
- Shell prompts.
- Keyboard shortcuts.
- Terminal resizing.
- Ctrl+C and other supported terminal control sequences.

Do not implement a fake terminal using child_process.exec or a text input that executes individual commands.

### FR-003 — Multiple Terminals

Allow multiple terminal sessions within the same project.

Example:

NOVA:

- Terminal 1 — Development server.
- Terminal 2 — Tests.
- Terminal 3 — Git operations.

Sessions must run independently.

Closing one terminal must not terminate unrelated sessions.

### FR-004 — Multiple Projects

Allow terminal sessions across multiple projects simultaneously.

Example:

- NOVA — Terminal 1.
- WiiAscend — Terminal 1.
- ATLAS — Terminal 1.

Switching projects must not interrupt running terminal processes.

Project isolation must be maintained.

### FR-005 — Terminal Tabs

Implement terminal tabs.

Users must be able to:

- Create a tab.
- Select a tab.
- Rename a tab.
- Close a tab.
- Identify the active tab.
- View terminal status.

Terminal tabs must remain associated with their corresponding project.

### FR-006 — Split Terminal Views

Support splitting the terminal workspace into multiple panes.

Minimum functionality:

- Horizontal split.
- Vertical split.
- Independent terminal sessions per pane.
- Resizable panes.
- Close individual panes.
- Restore a single-pane layout.

Use a stable layout model.

A split pane must reference a terminal session rather than duplicate its underlying process.

### FR-007 — Shell Detection

Detect available shells.

Supported targets:

macOS:

- zsh
- bash

Linux:

- bash
- zsh

Windows:

- PowerShell
- Windows PowerShell
- cmd

Support additional shells through configuration.

WSL support may be implemented through an explicitly configured launcher, but must not be falsely represented as native Windows shell support.

The default shell should respect the operating system and user configuration.

Do not assume every machine has Git Bash, WSL, or zsh installed.

### FR-008 — Terminal Input and Output

Implement bidirectional communication between renderer and Engine.

Required operations:

- Create terminal.
- Send input.
- Receive output.
- Resize terminal.
- Retrieve terminal metadata.
- Close terminal.
- Subscribe to lifecycle events.

Use validated contracts.

Output delivery must preserve terminal escape sequences and ordering.

Avoid unnecessarily persisting every byte of terminal output.

### FR-009 — Terminal Lifecycle

Support these states:

- CREATED
- STARTING
- RUNNING
- EXITED
- FAILED
- TERMINATING
- TERMINATED

Handle:

- Successful process exit.
- Nonzero exit codes.
- Shell startup failure.
- User termination.
- Engine shutdown.
- Unexpected process termination.

Never report a process as running after it has exited.

### FR-010 — Close Behavior

Closing a terminal tab containing a running process must require confirmation when termination is expected.

Provide a clear distinction between:

- Hiding or detaching a terminal view.
- Terminating the underlying process.

Do not silently terminate a running development server when the user switches projects or closes a pane.

For SDD-002, define and document the supported behavior when the entire desktop application closes.

Do not claim that terminal processes survive Engine termination unless that capability is implemented and tested.

### FR-011 — Terminal Resizing

Terminal dimensions must adapt to the visible pane.

Propagate column and row changes to the PTY.

Avoid excessive resize events.

Ensure interactive applications receive the updated dimensions.

### FR-012 — Terminal Appearance

Support:

- Dark terminal theme.
- Monospaced font.
- Adjustable font size.
- Copy and paste.
- Scrollback.
- Search within terminal output.
- Clear visible terminal.
- Focus management.

Terminal settings should be persisted locally.

### FR-013 — Session Listing

The Engine must provide a list of active terminal sessions.

The UI must be able to reconstruct its terminal views from Engine state.

If the renderer reloads while the Engine remains alive, existing PTY processes must not be automatically duplicated.

Provide an appropriate bounded output replay mechanism for reattaching a terminal view.

Do not assume that a new xterm.js instance can recover an application's full interactive screen state without additional handling.

### FR-014 — CLI Management

Extend the ATLAS CLI with terminal operations.

Minimum commands:

```bash
atlas terminal list
atlas terminal open --project <project-id>
atlas terminal show <terminal-id>
atlas terminal close <terminal-id>
```

The CLI must communicate with the running Engine through an authenticated local transport or an equivalent safe mechanism.

Do not create an unrelated Engine instance for each CLI command when managing shared terminal processes.

### FR-015 — Keyboard Shortcuts

Implement configurable or documented shortcuts for:

- New terminal.
- Close terminal.
- Next terminal.
- Previous terminal.
- Horizontal split.
- Vertical split.
- Focus next pane.
- Search terminal.

Avoid conflicting with critical OS and shell shortcuts.

## 4. Architecture

Follow the existing modular architecture.

Suggested modules:

```text
packages/
  terminal/
    domain/
    application/
    infrastructure/
    contracts/

apps/
  desktop/
    terminal/
      components/
      hooks/
      state/

apps/
  engine/
    terminal/

apps/
  cli/
    commands/
      terminal/
```

Adapt these locations to the actual repository.

### Terminal Domain

Define:

- TerminalSession
- TerminalStatus
- TerminalConfiguration
- TerminalMetadata
- TerminalLifecycleEvent

### Terminal Application Service

Suggested interface:

```typescript
interface TerminalService {
  create(input: CreateTerminalInput): Promise<TerminalSession>;

  list(projectId?: string): Promise<TerminalSession[]>;

  getById(id: string): Promise<TerminalSession | null>;

  write(id: string, data: string): Promise<void>;

  resize(id: string, columns: number, rows: number): Promise<void>;

  terminate(id: string): Promise<void>;
}
```

Streaming subscriptions should use a separate event interface.

### PTY Adapter

Define an abstraction around node-pty.

Example responsibilities:

- Spawn process.
- Write input.
- Resize.
- Listen for output.
- Listen for exit.
- Terminate process.
- Release resources.

The domain layer must not depend directly on node-pty.

### Terminal Layout

Terminal layouts belong to the desktop presentation layer.

The Engine owns processes and execution state.

A terminal session may be represented in one visible pane at a time; multiple simultaneous views of the same PTY require explicit focus and resize ownership rules.

## 5. Engine Communication

Use the existing Engine communication mechanism where possible.

Requirements:

- Typed request/response contracts.
- Ordered terminal output events per session.
- Session identifiers on all events.
- Safe subscription cleanup.
- Output buffering and backpressure.
- Bounded replay buffers.
- Correct behavior after renderer reload.

Do not expose arbitrary PTY creation to untrusted renderer content.

The Engine must validate that the requested project and working directory are authorized.

## 6. Security Requirements

Terminal execution is inherently privileged.

Implement the following protections:

1. Only registered and authorized project workspaces may be selected through project terminal operations.
2. The renderer must not have unrestricted Node.js access.
3. Shell executable paths must be validated.
4. Terminal input must be delivered as raw PTY input, not interpolated into shell command strings.
5. Do not automatically execute AI-generated commands.
6. Do not expose terminal output from one project to unrelated sessions.
7. Do not log credentials or terminal input indiscriminately.
8. Never store terminal command history containing secrets without an explicit retention policy.
9. Validate IPC requests and terminal session ownership.
10. Preserve Electron context isolation and preload boundaries.

Project-level terminal permissions are not an operating-system security sandbox.

Do not claim filesystem isolation merely because a terminal starts in a specific directory.

## 7. Persistence

Persist:

- Terminal preferences.
- Terminal tab labels.
- Project associations.
- Workspace layout, where appropriate.

Runtime process handles must remain in memory.

Do not attempt to serialize PTY processes.

After an Engine restart, previous sessions must not appear as running unless an actual process recovery mechanism exists.

Mark stale session metadata appropriately.

## 8. User Interface

Create a Terminal Workspace integrated with the existing Project Registry.

### Main Layout

- Project sidebar.
- Terminal tab bar.
- Terminal content area.
- Split pane controls.
- Terminal status indicator.
- Shell selector.
- New terminal action.

### Terminal Status

Show:

- Running.
- Exited.
- Failed.
- Terminating.

Provide useful errors when a shell cannot be started.

### Empty State

When no terminal exists, show an action to create one for the selected project.

### Multi-Project Navigation

Allow switching between project workspaces without terminating active terminal processes.

## 9. Automated Tests

### Unit Tests

Test:

- Terminal session lifecycle.
- State transitions.
- Session lookup.
- Project association.
- Shell selection.
- Configuration validation.
- Termination logic.
- Layout operations.

### Integration Tests

Test with real PTY processes:

- Interactive command execution.
- Input/output streaming.
- Process exit.
- Nonzero exit codes.
- Ctrl+C handling.
- Terminal resizing.
- Concurrent terminals.
- Multiple projects.
- Engine session listing.
- Cleanup after termination.

### Desktop Tests

Validate:

- Creating terminal tabs.
- Switching terminals.
- Splitting panes.
- Closing panes.
- Copy and paste.
- Terminal resizing.
- Project switching.
- Renderer reload and reattachment.

Use temporary projects and safe test commands.

Tests must never execute destructive commands against user repositories.

## 10. Performance Requirements

The system must support at least 10 concurrent terminal sessions in a reasonable development environment.

Avoid unnecessary React rerenders for every output chunk.

Use buffered terminal output and bounded memory consumption.

Terminal output must remain responsive during sustained command output.

Do not block the Electron main thread with PTY processing or expensive rendering operations.

Measure and document any significant limitations.

## 11. Acceptance Criteria

SDD-002 is complete when:

- [ ] A terminal can be created from a registered project.
- [ ] The terminal starts in the correct project directory.
- [ ] Real interactive shell commands work.
- [ ] ANSI colors and interactive applications render correctly.
- [ ] Multiple terminals can run simultaneously.
- [ ] Multiple projects can maintain active terminals.
- [ ] Terminal tabs can be created, renamed, selected, and closed.
- [ ] Horizontal and vertical split panes work.
- [ ] Pane resizing updates PTY dimensions.
- [ ] Terminal input and output are streamed correctly.
- [ ] Process exits are detected and displayed.
- [ ] Closing a terminal handles running processes safely.
- [ ] Renderer reload does not duplicate active PTYs.
- [ ] CLI terminal operations communicate with the shared Engine.
- [ ] Terminal settings persist across restarts.
- [ ] Unauthorized project paths are rejected.
- [ ] Existing SDD-001 functionality remains operational.
- [ ] Unit tests pass.
- [ ] Integration tests pass.
- [ ] Relevant desktop tests pass.
- [ ] Type checking and builds pass.
- [ ] Documentation is updated.

(Status of each criterion: `docs/STATUS.md`.)

## 12. Documentation

Update `docs/ARCHITECTURE.md`, `docs/ROADMAP.md`, `docs/STATUS.md`, `docs/DECISIONS.md`.
Create `docs/sdd/SDD-002-terminal-manager.md`. Document PTY architecture, Engine
communication, supported shells, process lifecycle, terminal persistence limitations,
keyboard shortcuts and known platform limitations.

## 13. Implementation Process

Follow Spec-Driven Development: (1) repository analysis, (2) technical plan (PTY adapter,
Engine terminal services, IPC/event contracts, terminal UI, layout state, test strategy),
(3) incremental implementation — PTY abstraction; terminal domain and services; Engine
communication; single functional terminal; multiple terminal tabs; multi-project terminal
management; split panes; CLI integration; persistence and recovery behavior; tests and
documentation — (4) verification including real interactive terminal verification, and
(5) a delivery report with implemented features, files and modules changed, test
commands and results, platform compatibility, known limitations and manual verification
instructions.

## 14. Out of Scope

Do not implement: Claude Code integration, Codex integration, AI orchestration, agent
teams, Skills Hub, Context Engine, account dashboards, remote execution, self-development.
These will be addressed in subsequent specifications.

## 15. Final Instruction

Implement a functional terminal system, not a visual simulation.

Preserve the existing architecture and SDD-001 behavior.

Do not declare completion without test evidence.

Do not start SDD-003 until SDD-002 has been validated and approved.

**Expected result:** ATLAS Control must function as a multi-project terminal environment with real, independent, interactive shell sessions.
