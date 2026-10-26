# SDD-011 — Code Editor & IDE Workspace

**Status:** Milestone A (file explorer and editor foundation) implemented (PLAN-033,
v0.25.0, no schema change) — awaiting approval. Milestones B (Git, diff and development
tools) and C (AI-assisted editing and workspace continuity) not started; each needs its own
plan after the previous milestone is validated.
**Priority:** High.
**Dependencies:** Project Registry, Terminal Manager, Git services, SQLite settings, Shared
Context, Preflight, Notification Service.

Core principle: ATLAS is a terminal-first development environment with optional integrated
code editing, not a mandatory full IDE. The editor uses the official Monaco Editor package;
VS Code itself, its branding, icon themes and Microsoft extensions are not included.

## Part I — Milestone A as implemented (PLAN-033)

### Decisions taken with the developer (2026-10-25)

PLAN-033 revision 1 was approved by Anderson Andrade (Git `user.name`) in the conversation:
"pode seguir, q1 ok, q2 recomendado, q3 recomendado, q4 ok, q5 ok, perfeito se conseguir
trazer a parte de externsões é uma boa se não deixa pra segundo plao". Risks R1–R8 were
presented with the plan; they were not acknowledged by ID.

| Question | Decision                                                                                 |
| -------- | ---------------------------------------------------------------------------------------- |
| Q1       | A new **Editor** view in the sidebar (below Terminals) with a terminal panel underneath. |
| Q2       | Deleting moves files and folders to the **system Trash** (reversible).                   |
| Q3       | The editor + ATLAS Session split moves to Milestone C, with the AI context work.         |
| Q4       | Files up to **5 MB** open in the editor; larger or binary files offer "Reveal" instead.  |
| Q5       | Unmodified tabs **reload by themselves** when their file changes on disk (a preference). |

Extensions (VS Code marketplace compatibility) stay out of scope (§16) and can be evaluated
in a future specification.

### Architecture

```text
 Editor view (renderer, lazy Monaco)
   │  atlas.projectFiles / atlas.editor (preload)          files: { projectId, relative path }
   ▼
 main IPC ── Trash and file manager: absolute path only from the Engine (`files.absolutePath`)
   │         watch: subscriber id added by the main process
   ▼
 Engine `files.*` / `editor.*`  (not offered to the CLI)
   ├─ ProjectFiles (packages/editor) ── realpath boundary, safe writes, versions (sha256)
   │     ├─ ignore rules: `git check-ignore --stdin`, else a default list
   │     └─ quick open: `git ls-files`, else a bounded folder walk
   ├─ FileWatchHub ── non-recursive fs.watch of shown folders ─► event { type: 'files' }
   └─ EditorSettings ── application_settings: `editor.preferences`, `editor.layout.<project>`
```

- The editor works on registered projects only (the project registry is the authorization
  source; no new registry). Paths are relative to the project folder.
- The renderer never receives an absolute path or unrestricted filesystem access.
- After ATLAS saves, creates or moves a file, the Engine publishes the existing `git`
  event so the Git view and terminal badges refresh (Scenario A).

### Monaco integration (FR-1104, §11)

- `monaco-editor` 0.57.0 (exact, MIT). It is imported directly (not through
  `@monaco-editor/react`, whose loader uses a CDN the Content-Security-Policy blocks).
- Loaded with a dynamic `import()` the first time the Editor view is shown; the entry bundle
  only contains the loader. Terminal-only use never loads Monaco or its workers (Scenario D,
  verified by an end-to-end test).
- Workers (`editor`, `typescript`, `json`, `css`, `html`) are bundled by Vite as separate
  files and created through `MonacoEnvironment.getWorker`; nothing is fetched from the
  network. The production CSP is unchanged (`script-src 'self'` covers the workers).
- The TypeScript worker sees one file at a time and cannot resolve imports, so semantic
  validation is off; syntax errors are shown. Real diagnostics come with language servers
  (Milestone B).
- Monaco's link opening is disabled: nothing leaves the app from a click in code.
- Build output (macOS arm64): Monaco chunk ≈ 4.1 MB, workers ≈ 9.4 MB (TypeScript 6.7 MB),
  codicon font 150 KB, Monaco CSS 175 KB — all loaded on demand.

### Filesystem security (§10)

- Relative paths are validated in the contract (`RelativeFilePathSchema`): no absolute
  paths, no empty, `.` or `..` segments, no NUL, names up to 255 bytes.
- Every access resolves the project folder and the target with `realpath` and requires the
  target inside the folder (`FILE_OUTSIDE_WORKSPACE` otherwise). New entries resolve their
  parent folder the same way. Symbolic links inside the project work; links leading outside
  are listed as such and cannot be opened, written or expanded.
- Trash and "Reveal in file manager" go through the main process with a path the Engine
  resolved; the link itself (not its target) goes to the Trash.
- Opening a file never executes anything; Markdown is shown as text.
- Error responses use user-safe messages (`FILE_*` codes); paths stay in the logs.
- `files.*` and `editor.*` are not in `CLI_ENGINE_METHODS`, so the CLI socket cannot read or
  write project files.

### Saving and concurrent changes (FR-1106, FR-1107)

- Every read returns a version (sha256 of the bytes). A save names the version it edited;
  the Engine compares it with the file on disk and fails with `FILE_CONFLICT` when it
  differs or the file was deleted. "Save my version" and Save As over an existing file
  write only after an explicit choice (`overwrite`).
- Writes go to a temporary file in the same folder (`.<name>.atlas-<random>.tmp`), are
  synced and renamed over the target, keeping its permission bits. An interrupted save
  never truncates the file. Consequences (PLAN-033 R4): hard links are replaced by a new
  file and extended attributes or ACLs are not copied. New files are created with `wx`
  (never replacing a file created in the meantime).
- Create, rename and move never replace an existing entry (`FILE_ALREADY_EXISTS`); a
  case-only rename is allowed. Between the existence check and the rename there is a short
  window (R5).
- Encodings: UTF-8 (with or without BOM) and UTF-16 LE/BE with BOM are read and written
  back unchanged. Other encodings and binary files (NUL bytes) are not opened. Line endings
  are detected and kept; files mixing LF and CRLF show a notice because saving uses the
  dominant one for every line (R8).
- The Engine watches, without recursion, the folders the editor shows (project folder,
  expanded folders, folders of open files; at most 200 per window, 8 windows), debounced
  150 ms. The renderer compares versions on every event, after (re)starting to watch, when
  the window gains focus and after an Engine restart (watching is best effort, R6).
- Unmodified tabs reload (preference, default on) and show "Reloaded"; modified tabs show
  a conflict banner: Reload (discard my edits), Save my version, Keep editing. Deleted files
  show "Save to recreate it" or "Close tab".
- An edit typed during a save stays modified: the buffer is marked saved at the version
  that was written.

### Tabs and unsaved changes (FR-1105)

- Each tab tracks path, name (with the folder when names repeat), modified, active and its
  Monaco view state (cursor, selection, scroll).
- Closing a modified tab, switching project or quitting asks first: Save / Don't save /
  Cancel. The buffer (not the rendered state) decides, so a key typed just before Cmd+W
  counts. The Editor view stays mounted while hidden so switching views keeps the buffers.
- The renderer tells the main process how many tabs are unsaved; quitting and (on macOS)
  closing the window ask before discarding them. A renderer reload resets that count and
  turns the terminal shortcuts back on.
- Removing a project from the registry while it has unsaved tabs keeps them visible with a
  warning (they cannot be saved without the registration) until the user switches project
  and chooses what to do.

### Preferences and layout (FR-1108, FR-1110)

- Preferences (theme dark/light/high contrast, font size, tab size, spaces or tabs, word
  wrap, minimap, auto save off/after a delay/on focus change, auto reload, hidden and
  ignored files) are stored in `application_settings` (`editor.preferences`) and shown in
  Settings → Editor.
- Per project (`editor.layout.<projectId>`): open file paths with cursor and scroll, active
  file, explorer and terminal visibility and sizes, expanded folders. The last project is
  `editor.lastProject`. File contents are never stored.
- Restoring checks that each file still exists inside the project before showing it; only
  the active tab is read immediately.

### Interface (FR-1101–FR-1103, FR-1109, FR-1111)

- Header: project, toggle explorer, open file (quick open), toggle terminal, Save.
- Explorer: virtualized tree (fixed row height), lazy folder listing, filter by name,
  generic icons per file type (lucide), context menu (open, new file/folder, rename, copy
  relative path, reveal, move to Trash), drag and drop to move, keyboard navigation
  (arrows, Enter, F2), "Show ignored files" and a count of hidden ignored entries.
- Ignore rules: inside a Git repository the project's own rules (`.gitignore`, info/exclude,
  global excludes); outside, a default list (`node_modules`, `dist`, `build`, `out`,
  `coverage`, caches…). `.git` is always hidden. Ignored files can still be shown and
  edited.
- Terminal panel: one of the project's Engine terminals in the same pane as the Terminals
  view, or a new one; hiding it never stops it.
- Narrow windows (< 768 px) show the explorer over the editor.
- Shortcuts while the Editor is shown: Cmd/Ctrl+P open file, Cmd/Ctrl+S save,
  Cmd/Ctrl+Alt+S save all, Cmd/Ctrl+Shift+S save as, Cmd/Ctrl+W close tab, Cmd/Ctrl+B
  toggle explorer, Ctrl+` toggle terminal; find (also from outside the code) and replace are Monaco's (Cmd+F,
  Cmd+Alt+F on macOS; Ctrl+F, Ctrl+H elsewhere). The terminal menu shortcuts (Close
  Terminal, Find, Split, Clear, font size, pane focus) are disabled while the Editor is
  shown so these keys reach the editor (R1); New Terminal stays enabled.

### Test evidence (2026-10-25, macOS arm64)

- `packages/editor/tests/project-files.test.ts` (33): path validation, traversal, symbolic
  links inside and outside, binary/encoding/size limits, read-only files, conflict on
  changed and deleted files, overwrite only on request, Save As without replacing, the four
  encodings, permissions kept, no temporary file left, create/rename/move without
  replacing, case-only rename, ignore rules and fallback, quick open (repository list and
  walk), versions, watch hub debounce and sharing, settings validation (no contents).
- `apps/engine/tests/files.test.ts` (4): real Git repository — `check-ignore` rules, quick
  open with `ls-files`, save through the dispatcher refreshing the Git status, not offered
  to the CLI, real `fs.watch` events.
- `apps/desktop/tests/ipc.test.ts` (+2): read/write/conflict through IPC, traversal
  rejected, Trash and reveal receive Engine-resolved paths only, watch subscriber comes
  from the main process, unsaved count and menu shortcuts.
- `apps/desktop/tests/editor-tabs.test.ts` (7) and `quit-warning.test.ts` (+1).
- `tests/e2e/editor.spec.ts` (9): Scenario A without AI (edit, save with Cmd+S, Git status
  and Git view), Scenario B (automatic reload, conflict, no silent overwrite, reload and
  "Save my version"), unsaved close prompt, create/rename/Save As/Trash, restore after
  restart skipping a deleted file, Scenario D (terminal-only never loads Monaco), editor and
  terminal panel together (a shell command rewrites the open file, menu shortcuts disabled
  only while the editor is shown), 380–1440 px without horizontal overflow, unsaved tabs
  kept when their project is removed. `tests/e2e/security.spec.ts` lists the new bridge keys.
- Totals at validation: unit 842/842 (68 files); end-to-end in the final report.

### Known limitations

- No diff editor, Git decorations, workspace text search, command palette, language
  servers or real diagnostics (Milestone B). No AI actions or editor context for AI
  sessions (Milestone C).
- Scenario A's Preflight and commit steps use the existing views; they are not started from
  the editor yet (Milestone C, FR-1127).
- Encodings other than UTF-8/UTF-16 with BOM are not supported; files over 5 MB do not
  open.
- Atomic saves replace hard links and drop extended attributes/ACLs (R4).
- The real keyboard path of menu accelerators cannot be driven by Playwright (it sends keys
  to the page); the end-to-end test checks that the menu items are disabled while the
  Editor is shown; pressing the real keys in the running app is a pending manual check
  (R1).
- Folder watching can miss events on some volumes; focus and pre-save checks still prevent
  silent overwrites (R6).
- Editor layouts of removed projects stay in settings until the project is registered again.
- `monaco-editor` 0.57.0 bundles its own copy of DOMPurify 3.4.15 (the npm `dompurify`
  dependency it declares is not imported by the ESM build). `pnpm audit` reports advisories
  for that version (up to critical); they concern `SAFE_FOR_TEMPLATES`, `IN_PLACE` and the
  XHTML parser mode, which Monaco does not use (it sanitizes hover and Markdown content with
  `RETURN_DOM_FRAGMENT` and hooks). An override of the npm package would not change the
  bundled copy; the fix is a Monaco release with a newer DOMPurify. `pnpm audit --prod`
  (CI) does not include it because the renderer dependencies are bundled dev dependencies.

## Part II — Specification

### Mission

Implement an integrated code editor inside ATLAS using Monaco Editor. It coexists with the
Warp-like terminal experience and optional AI orchestration. Users browse, open, edit,
save, compare and navigate project files without leaving ATLAS and without installing VS
Code. AI functionality remains optional.

### Architectural decisions (§2)

- Monaco Editor (official package); no embedded VS Code, no copied proprietary features,
  branding or Microsoft extensions.
- Optional editor: terminal-only, editor-only, editor + terminal, editor + ATLAS Session.
- Shared workspace: editor, terminals, Git, Preflight and AI sessions use the same explicitly
  selected project; no duplicate project registry.
- Engine-owned filesystem; no unrestricted filesystem access in the renderer.
- SQLite for editor preferences and layout metadata; source files stay where they are.

### Milestone A — File explorer & editor foundation

- FR-1101 Workspace explorer (expand/collapse, open, refresh, reveal current file, icons,
  filename search, hidden-file preference; workspace boundaries).
- FR-1102 File operations (create, rename, delete, move; confirmation for destructive
  actions; never overwrite silently).
- FR-1103 Ignore rules (common directories, project rules, explicit reveal, editing ignored
  files allowed).
- FR-1104 Monaco integration (syntax highlighting, line numbers, folding, find/replace,
  multiple cursors, minimap, word wrap, bracket matching, basic completion).
- FR-1105 Multiple files with tabs (path, name, dirty, active, view state; save/discard/cancel
  on close).
- FR-1106 Save, Save As, Save All, shortcuts; keep encoding and line endings; safe writes.
- FR-1107 External changes (agents, Git, terminal commands): reload or offer to reload
  unmodified tabs; conflict warning for modified ones; never overwrite silently.
- FR-1108 Editor preferences (theme, font size, tab size, indentation, word wrap, minimap,
  auto save) in the existing settings.
- FR-1109 Layout (explorer, tabs, terminal panel, resizable panes, editor/terminal split).
- FR-1110 Workspace restoration (open files, active file, layout, split proportions, last
  workspace; only accessible files; no contents before validating access).
- FR-1111 Shortcuts (open, save, save all, close tab, find, replace, toggle terminal and
  explorer) without conflicting with terminal shortcuts.

### Milestone B — Git, diff & development tools

- FR-1112 Git decorations in the explorer through the existing Git services.
- FR-1113 Diff editor (side-by-side and inline): working tree vs HEAD, staged vs HEAD,
  commits, changes produced by an ATLAS agent.
- FR-1114 Change navigation; open the Git panel; no destructive Git operations outside the
  Git services.
- FR-1115 Merge conflict review without automatic resolution.
- FR-1116 Symbol navigation where language tooling exists.
- FR-1117 Provider-independent language service interface; LSP as managed processes;
  TypeScript/JavaScript first; no automatic download or execution of language servers.
- FR-1118 Diagnostics (syntax, type, LSP, lint), distinct from Preflight results.
- FR-1119 Workspace text search (case, safe regular expressions, file filters, navigation)
  without blocking the renderer.
- FR-1120 Lightweight command palette reusing existing actions.

### Milestone C — AI-assisted editing & workspace continuity

- FR-1121 Explicitly attach editor context (file, selection, diff, open files, diagnostics)
  to an AI session within context budgets; never all open files automatically.
- FR-1122 Contextual AI actions only for configured providers.
- FR-1123 Provider/account selection through SDD-008 routing.
- FR-1124 AI change preview: changed files, diffs, context, review, apply authorized
  changes, refresh buffers and Git status; never overwrite unsaved changes.
- FR-1125 Record verified decisions and outcomes in Shared Context, not keystrokes.
- FR-1126 Show the session or agent associated with modifications when known; never infer
  authorship from timestamps.
- FR-1127 Run checks through the existing Preflight Engine.
- FR-1128 Notifications through the existing Notification Service, without duplicates.
- FR-1129 Session restoration without persisting unsaved contents unless a recovery policy
  exists.
- FR-1130 Agent-to-editor handoff (changed files, diff, validation, session link).
- FR-1131 Concurrent modification safety (user, Claude, Codex, Git, agents) with version
  checks, watchers and conflict detection.

### Security and performance (§10, §11)

No unrestricted renderer filesystem access; validate paths against authorized workspaces;
prevent traversal; handle symbolic links safely; never execute code by opening a file;
sanitize rich previews; no automatic language server installation or workspace scripts;
protect unsaved changes; treat AI changes as untrusted until reviewed; respect project and
account isolation. Lazy-load Monaco; no eager repository scans; virtualize large lists;
debounce filesystem events; limit language-server processes; dispose unused models; no
source files in SQLite; stay responsive during large Git operations; handle large and
binary files gracefully.

### Mandatory end-to-end scenarios (§13)

A — manual editing without AI; B — external agent modification; C — Claude-to-Codex
handoff (Milestone C); D — terminal-only mode unchanged.

### Out of scope (§16)

VS Code extension marketplace compatibility, a complete workbench replacement, embedded VS
Code, remote SSH or containers, a full debugger, collaborative editing, cloud IDE hosting
and automatic extension installation.
