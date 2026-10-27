# SDD-015 — VS Code Extension Compatibility & Extensions Hub

**Status:** Milestone A (Extensions Hub and declarative contributions) implemented
(PLAN-043, v0.30.0, schema v15). It is waiting for validation. Milestones B (Extension
Host and VS Code API compatibility) and C (updates, rollback, project profiles, language
tooling, Background Operations and notifications) have not started. Each needs its own
plan after the previous milestone is validated.
**Priority:** High.
**Dependencies:** Monaco (SDD-011), Electron, Engine, SQLite, Project Registry.
Milestone C adds Background Operations (SDD-012) and notifications (SDD-009).

Core principle: deliver real, tested extension compatibility without claiming full VS Code
API equivalence. Monaco is not VS Code: installing a VS Code extension does not make its
code run.

## Part I — Milestone A as implemented (PLAN-043)

### Decisions taken with the developer (2026-10-27)

- Approved by Anderson Andrade (Git `user.name`): "pode seguir com o plan, e q1 a q6 pode
  seguir com o recomendado sem problema" for PLAN-043 revision 1. The plan had five
  questions (Q1–Q5); all take the recommended option. Risks R1–R12 were presented with the
  plan; they were not acknowledged by ID.
- **Q1:** TextMate grammars use `vscode-textmate` 9.3.2 with the Oniguruma regex engine
  (`vscode-oniguruma` 2.0.1, WebAssembly), as in VS Code.
  - The renderer CSP adds `'wasm-unsafe-eval'` to `script-src`. This allows compiling
    WebAssembly, not `eval()` of JavaScript.
  - The WASM is bundled inline and loaded only when an enabled extension contributes a
    grammar.
- **Q2:** color themes change the Monaco editors only, not the rest of ATLAS.
- **Q3:** file icon themes show SVG and PNG icons. Font icons fall back to ATLAS's icons.
- **Q4:** SUPPORTED comes only from a tested compatibility matrix, filled by an opt-in
  test against the real Open VSX (see "Tested compatibility matrix").
- **Q5:** dependencies are installed only after the user confirms the list. Extension packs
  are shown; their members are installed one by one.

### Architecture

```text
 Extensions view (lazy) ─► atlas.extensions (preload) ─► main IPC (forwards; only https
      homepage links open) ─► Engine `extensions.*` (not offered to the CLI)
          ExtensionsService (packages/extensions): manifest checks, compatibility,
            lifecycle, per-project enablement, contribution resolution, diagnostics
          OpenVsxRegistry (Engine adapter): node:http(s), bounded JSON, 5-minute cache
          FileExtensionPackages (Engine adapter): yauzl extraction, staging, atomic commit
          SqliteExtensionRepository (migration v15)

 Monaco (Editor and API Workbench) ◄─ extension runtime (renderer):
      languages · language configuration · snippets · TextMate grammars · color themes
 File explorer ◄─ file icon theme (data: URIs of SVG/PNG icons)
```

- **Nothing runs.** Neither the Engine nor the window loads extension code. A package's
  `main` or `browser` entry point is reported as unsupported.
- **Contributions cross the bridge as data.** The window asks for a theme, grammar,
  snippets file, language configuration or icon by extension id and contribution key,
  never by path. The Engine resolves the file from the stored manifest and reads it
  only if it stays inside the extension folder (`realpath` check). Sizes are bounded:
  - theme files: 2 MB;
  - grammars: 8 MB;
  - snippets: 2 MB;
  - language configuration: 512 KB;
  - icon theme: 4 MB;
  - one icon: 256 KB.
- **Terminal-only use is unaffected.** The view and the TextMate engine load on first use.
  Without extensions, the editor keeps its own tokenizers and themes. A failing
  contribution is reported as a diagnostic and skipped.

### Open VSX (FR-1501, FR-1502)

- **Endpoints used:**
  - `/api/-/search`: text and category;
  - `/api/-/query?namespaceName=`: publisher;
  - `/api/{namespace}/{name}[/{platform}][/{version}]`: details.
  - A version's published `package.json` and `.sha256` are fetched through the links in
    `files`.
- **Answers are checked before use.** JSON is limited to 4 MB and validated with zod.
  Strings are trimmed, and only `https` links are kept (plain `http` only when the
  configured registry itself is `http`, as in tests). Download redirects (Open VSX sends
  packages from `openvsx.eclipsecontent.org`) are followed up to 5 times.
- **What the details show:**
  - name, publisher, verified publisher, description, version and published date;
  - every available version (up to 100);
  - license, categories and platforms;
  - dependencies and extension pack members, each with its installed state;
  - the compatibility report.
  - Ratings and download counts are not shown.
- **Caching:** registry answers are cached for 5 minutes in memory. Installs and update
  checks ask the registry again, so the user never installs a stale "latest".
- **Outages:** errors map to `EXTENSION_REGISTRY_UNAVAILABLE` (network, timeout, 429,
  5xx), `EXTENSION_REGISTRY_INVALID_RESPONSE` and `EXTENSION_NOT_FOUND`. While the
  registry is down, search shows a status line, and installed extensions and their
  contributions keep working.
- **Registry address:** `ATLAS_EXTENSIONS_REGISTRY_URL` replaces `https://open-vsx.org`.
  The tests use it; an invalid value falls back to Open VSX.

### Package installation (FR-1503, FR-1504, FR-1506)

1. **Pick the package.** The platform is this machine's Open VSX name (`darwin-arm64`,
   `linux-x64`, `win32-x64`…), else `universal`. Without either, the install fails with
   `EXTENSION_PLATFORM_UNSUPPORTED`.
2. **Check the published manifest.** An extension ATLAS could not use at all
   (UNSUPPORTED) is not downloaded.
3. **Download the package** to `<data>/extensions/.staging/` (file mode 0600; at most
   100 MB).
4. **Compare checksums.** The download's SHA-256 is compared with the registry's `.sha256`
   (`EXTENSION_CHECKSUM_MISMATCH`). A missing checksum is allowed and recorded as a warning
   diagnostic. The checksum comes from the same registry, so it proves integrity in
   transit, not authorship; signature checks are Milestone C.
5. **Extract only `extension/`** with `yauzl`, which also validates entry sizes. The
   whole package is refused (`EXTENSION_PACKAGE_INVALID`, or `EXTENSION_PACKAGE_TOO_LARGE`)
   when it has:
   - absolute paths, `..`, backslashes, NUL or drive letters;
   - symbolic links or encrypted entries;
   - two entries naming the same file (files are opened with `wx`);
   - more than 20,000 entries, more than 256 MB in total, or a file over 64 MB;
   - an entry over 1 MB compressed more than 100:1 (zip bomb).
     Folders are 0700 and files 0600.
6. **Check the identity.** The packaged `package.json` must name the requested
   `publisher.name` and version (`EXTENSION_IDENTITY_MISMATCH`). Compatibility is computed
   again from it.
7. **Commit.** The staging folder is renamed to `<data>/extensions/<id>/<version>/`
   (replacing that version, with restore on failure), and then the row is saved. The
   previous version's folder is removed only after that.

At start-up the Engine removes `.staging` and folders that no installed version refers to.
An installed version whose files disappeared is marked `broken`; none of its
contributions are used.

**Lifecycle:**

- install, reinstall, install another version (update or downgrade), enable or disable,
  uninstall.
- One change at a time per extension (`EXTENSION_BUSY`).
- Uninstalling an extension that another installed extension depends on is refused
  (`EXTENSION_REQUIRED_BY_OTHERS`, with the dependents' names).
- Failed installs leave nothing on disk and record an error diagnostic.

### Compatibility (FR-1512, §3.4)

The report lists:

- what works ("Color theme: Dracula", "Syntax highlighting: apache"…);
- what is not supported:
  - extension code;
  - commands, keybindings, settings, views, debuggers, tasks, semantic highlighting,
    product icons…;
  - unknown contribution points by name;
- notes (code does not run yet; themes change the editor only; icon formats; packs;
  dependencies);
- the test record, when there is one.

The level is computed from what the manifest declares:

| Level               | When                                                                     |
| ------------------- | ------------------------------------------------------------------------ |
| SUPPORTED           | This exact id, version and platform is in the tested matrix              |
| PARTIALLY_SUPPORTED | Some contributions work; others, or extension code, do not               |
| UNTESTED            | Every declared contribution is supported, but the version was not tested |
| UNSUPPORTED         | Nothing ATLAS supports; installation is refused                          |

### Declarative contributions (FR-1507–FR-1511)

- **Languages:** ids, aliases, extensions, file names, patterns, first line and MIME types
  are registered with Monaco. Monaco cannot unregister a language, so an association stays
  until restart after disabling. The grammar, configuration and snippets go at once.
- **Language configuration:**
  - mapped: comments, brackets, colorized bracket pairs, auto-closing and surrounding
    pairs, `autoCloseBefore`, folding markers and off-side, word pattern, indentation rules
    and on-enter rules.
  - The global regex flag is dropped, as in VS Code.
  - An invalid pattern skips the file and records a diagnostic.
- **TextMate grammars:**
  - One lazy tokens provider per language; the grammar loads when a file of that language
    is first shown.
  - Embedded languages, token types and injections are honored.
  - A line may take 50 ms; after that the rest of the line stays uncolored (PLAN-043 R3).
  - **Coloring:** vscode-textmate resolves each token's color from the active theme, and
    the editor uses Monaco theme rules generated from that color map (`tm.f<color>` and
    `tm.f<color>.s<style>`). Only public Monaco APIs are used. Changing theme
    re-tokenizes.
  - ATLAS's own themes have TextMate token colors close to VS Code's Dark+ and Light+.
- **Color themes:**
  - `include` chains (at most 5 levels) are merged. JSON with comments is accepted.
  - Editor colors with valid hex values are passed to Monaco.
  - `tokenColors` drive TextMate-colored languages. Monaco's built-in tokenizers (TypeScript,
    JSON…) get the color of the closest TextMate scope for each of their token kinds, an
    approximation (PLAN-043 R5).
  - **Not supported:** TextMate (plist) themes, semantic token colors, token colors in a
    separate file. Enabling or installing never changes the theme: the user picks it in
    the extension details or Settings (`colorTheme` editor preference). If its extension is
    disabled for a project, ATLAS's own theme applies there.
- **Snippets:**
  - completions with VS Code snippet syntax: placeholders, Tab navigation, choices and
    variables;
  - per language, per the snippet's own `scope`, or for every language;
  - a body whose `${` placeholders do not close is skipped and counted.
- **File icon themes:**
  - file names, compound extensions (`d.ts` before `ts`), default file, folder names and
    expanded folders;
  - SVG must look like SVG and PNG must have the PNG signature;
  - SVG is shown through `<img>`, so its scripts cannot run;
  - not supported: font icons, `light` and `highContrast` variants, language-id icons.

### Project enablement (FR-1514)

Each extension has a global switch, and each project can override it (enabled, disabled,
or follow the global switch). There is one installation per extension. The editor applies
the contributions of the project it shows, and the Extensions view's project selector
edits that project's override. Removing a project drops its overrides.

### Diagnostics (FR-1515)

Install and update failures (error), missing checksums (warning), and contributions the
editor could not apply (warning, reported by the window with a fixed code and at most 300
characters, control characters removed, an immediate repeat dropped) are kept per
extension. Only the newest 50 are kept, and error messages are the fixed user messages of
their codes. The details view lists and clears them, and the Installed list counts
problems. Logs keep the extension id and error code only.

### Tested compatibility matrix (FR-1547, PLAN-043 Q4)

How it was tested:

- `ATLAS_LIVE_OPEN_VSX=1 pnpm vitest run apps/desktop/tests/extensions-live.test.ts`.
- Each extension is installed from the real Open VSX through the same service and
  adapters ATLAS uses; then each contribution is resolved.
- The grammar is tokenized with vscode-textmate and Oniguruma, as in the editor.
- Run on 2026-10-27, ATLAS 0.30.0, macOS arm64; all packages are `universal`.

| Extension                   | Version | Result                                  | Working                                           | Limitations                                                             |
| --------------------------- | ------- | --------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------- |
| dracula-theme.theme-dracula | 2.25.1  | SUPPORTED                               | Color themes Dracula Theme and Dracula Theme Soft | Semantic token colors ignored                                           |
| xabikos.JavaScriptSnippets  | 1.8.0   | SUPPORTED                               | 264 snippets in 6 files, none skipped             | —                                                                       |
| mrmlnc.vscode-apache        | 1.2.0   | SUPPORTED                               | Apache language and TextMate grammar              | —                                                                       |
| PKief.material-icon-theme   | 5.40.0  | PARTIALLY_SUPPORTED (not in the matrix) | File icons (SVG)                                  | Extension code, commands and settings; light and high-contrast variants |

Other versions of these extensions are not assumed to work; they show UNTESTED or
PARTIALLY_SUPPORTED until tested.

### Security boundaries

- **No extension code runs** in Milestone A: not in main, not in the Engine, not in the
  window.
- **Package files:** they live in the application data folder. Their paths never cross
  the bridge, and every read is checked against the extension folder.
- **Untrusted inputs:** registry JSON, manifests, theme, grammar, snippet and icon files
  are bounded and validated, and invalid entries are skipped.
- **Content that could act:**
  - SVG icons are `data:` images, so their scripts cannot run.
  - Snippets are inserted as text.
  - Regexes from grammars run in Oniguruma with a time limit per line. Regexes from
    language configurations run in JavaScript without a time limit (PLAN-043 R3 residual).
- **Links:** only `https` homepage and repository links open, through the system browser.
- **CSP:** `'wasm-unsafe-eval'` is the only addition. `unsafe-inline` and `unsafe-eval`
  remain absent from `script-src`, and the security E2E checks this.
- **Errors and logs:** errors reach the window as fixed messages per code. Logs record
  the extension id and code, plus internal error details only for unexpected failures.

### Test evidence

- **Unit:**
  - `packages/extensions/tests/extensions.test.ts`, 43 tests: manifest parsing and
    identity, safe paths, declarations, compatibility levels and matrix matching, theme
    includes and limits, grammar formats, snippet syntax and limits, language
    configuration keys, icon themes and data URIs, version ordering.
  - `apps/desktop/tests/extension-runtime.test.ts`, 14 tests: token names and color rules,
    scope matching, Monaco theme mapping, language configuration mapping, file icon lookup.
- **Persistence:** `packages/persistence/tests/extensions.test.ts`, 6 tests:
  - save, replace and list;
  - lower-case ids;
  - project overrides kept across updates and removed with the extension or the project;
  - diagnostics retention and counts;
  - migration v14 → v15.
- **Integration:** `apps/engine/tests/extensions.test.ts`, 25 tests, against a local Open
  VSX stand-in (`tests/support/vsix.ts`) with VSIX packages built by the test.
  - search by text, category and publisher; details;
  - install, resolve, update (settings kept, old files removed), downgrade and uninstall;
  - global and project enablement; grammars, snippets, language configuration, icons;
  - an unsupported package refused and never run;
  - eight hostile packages refused with nothing left behind: traversal, symbolic link, zip
    bomb, duplicate entry, impostor identity, tampered checksum, no manifest, not a zip;
  - extraction limits;
  - registry outage;
  - dependencies; matrix levels;
  - start-up clean-up and missing files;
  - problem reports; concurrency; https-only links; platform names.
- **IPC:** one test.
  - list and contributions through the bridge;
  - path-like ids refused;
  - only `https` links opened;
  - the CLI cannot call `extensions.*`.
- **Live (opt-in):** the matrix above, 4 tests.
- **E2E** (`tests/e2e/extensions.spec.ts`, Linux Docker with Xvfb, local registry):
  - **Scenario A:** install a theme, use it, editor background changes, icon theme in the
    explorer, both kept after restart.
  - **Scenario B:** grammar coloring with the TextMate engine under the production CSP;
    snippet expansion with placeholder.
  - **Scenario E:** unsupported extension identified and not installable.
  - **Scenario F:** project overrides and a registry outage.
  - The security E2E checks the bridge surface and the CSP.

### Known limitations

- Extension code does not run, so formatters, linters and language servers from
  extensions do not work. They come in Milestone B, with the Extension Host.
- Updates are checked only when the user asks. There is no update notification, no
  rollback to the previous version, and no signature check (Milestone C).
- Installs run in the request, not as Background Operations jobs (Milestone C).
- Themes change the editor only. Semantic highlighting and TextMate (plist) themes are not
  supported.
- Monaco keeps a contributed language's file associations until restart after its
  extension is disabled.
- Regexes in language configurations have no time limit.

## Part II — Specification (summary)

### Milestone A — Extensions Hub & declarative contributions

FR-1501–FR-1515: Open VSX discovery and details, safe installation with validated paths,
sizes and identity, lifecycle in SQLite, dependencies and packs, application-managed
storage, color themes, icon themes, TextMate grammars, snippets, language configuration,
compatibility evaluation before installation, Extensions Hub, project enablement, bounded
diagnostics.

### Milestone B — Extension Host & API compatibility

FR-1516–FR-1534: a managed Extension Host outside the renderer and main process, with
activation events, deactivation, typed RPC, failure isolation and bounded restarts. A
documented subset of the `vscode` API: workspace, window, commands, language providers,
diagnostics and configuration. Unsupported APIs fail predictably. Then a permission and
trust model, workspace trust, secret access, process execution and resource limits. The
plan must evaluate maintained compatibility frameworks first.

### Milestone C — Advanced integration

FR-1535–FR-1549: update detection and installation, rollback, re-evaluation when ATLAS
changes, project extension profiles and recommendations, extension settings, language
server reuse, formatter selection, lint diagnostics, Background Operations and
notifications, and a maintained compatibility matrix and report.

### Out of scope

Full VS Code API parity, Microsoft Marketplace scraping, license bypassing, a workbench
replacement, complete debugger or webview compatibility, remote extension hosts,
automatic execution of untrusted extensions, an extension marketplace.
