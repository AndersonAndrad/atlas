# SDD-014 — HTTP Client & API Workbench

**Status:** Milestone A (HTTP client foundation) implemented (PLAN-042, v0.29.0, schema
v14). It is waiting for validation. Milestones B (environments, authentication,
import/export, code generation) and C (assertions, runner, background runs, Docker, Project
Hub and AI integration) have not started; each needs its own plan after the previous
milestone is validated.
**Priority:** High.
**Dependencies:** Engine, SQLite, Project Registry, Monaco (SDD-011), Electron IPC.
Milestone C adds Background Operations (SDD-012), notifications (SDD-009) and Docker
(SDD-013).

Core principle: API development stays local-first, project-aware and secure, and does not
depend on AI providers, cloud accounts or the internet when the target is reachable
locally.

## Part I — Milestone A as implemented (PLAN-042)

### Decisions taken with the developer (2026-10-26)

- Approved by Anderson Andrade (Git `user.name`): "pode seguir, q1 recomendado, q2
  recomendado, q3 recomendado, q4 recomendado, q5 feito o commit pode seguir" for PLAN-042
  revision 1. Risks R1–R12 were presented with the plan; they were not acknowledged by ID.
- Q1: ATLAS has no secure credential store yet. Values of rows marked secret, and of
  rows whose names usually carry credentials, are never written to SQLite; they live only
  in the open request tab. The store (Electron `safeStorage` brokered by the main process)
  comes with environments and authentication in Milestone B.
- Q2: the cookie jar uses `tough-cookie` 6.0.2 (exact version; it brings `tldts` for the
  public suffix list).
- Q3: `{{name}}` placeholders block sending until environments resolve them (Milestone B).
  A placeholder is never sent literally.
- Q4: the view is named **API** (title "API Workbench").
- Q5: the previous milestone (PLAN-041) was committed before this work started.

### HTTP execution architecture (§2.1, FR-1407, FR-1408)

```text
 API view (lazy, kept mounted) ─► atlas.http (preload) ─► main IPC
        (adds the window id and the files picked in its dialogs; download paths come
         from the save dialog) ─► Engine `http.*` (not offered to the CLI)
             HttpWorkbenchService (packages/api-workbench): validation, secret stripping,
               redirects, cookies per collection, history, saved responses
             NodeHttpTransport (Engine adapter): node:http/https, one connection per
               exchange, measured phases, decompression, size limit, cancellation
             MemoryCookieJars (tough-cookie) · FileHttpResponses (private body files)
             SqliteHttpWorkbenchRepository (migration v14)
```

- Requests run in the Engine, never in the window, so no browser CORS applies and the
  window never reaches the network.
- **One exchange per hop.** The service follows redirects itself (at most 10 by default,
  configurable 0–20, or off).
  - 303 becomes GET. 301 and 302 after POST become GET. 307 and 308 keep the method and
    the body, which is rebuilt from its definition.
  - `Authorization`, `Proxy-Authorization`, `Cookie` and every secret header are removed
    when a redirect goes to another origin (scheme, host or port) or from HTTPS to HTTP.
    They stay removed for later hops. The response lists each hop and whether credentials
    were removed.
  - Redirects to other schemes are refused.
- **Timeouts and cancellation.**
  - One deadline per send (default 30 s, 1 s–10 min), covering every redirect.
  - Cancel aborts the socket at once.
  - Transport failures have their own codes and are never shown as a response:
    `HTTP_DNS_FAILED`, `HTTP_CONNECTION_FAILED`, `HTTP_TLS_FAILED`, `HTTP_TIMEOUT`,
    `HTTP_CANCELLED`, `HTTP_TOO_MANY_REDIRECTS` and `HTTP_TRANSPORT_FAILED`. A 404 or 500
    is a response.
- **TLS.** Certificates are verified unless one request turns verification off. That
  setting shows a warning and applies only to that request; nothing is turned off
  globally.
- **Size limit.** The default is 50 MB (1 KB–1 GB per request), counted on the decoded
  body, so a compressed bomb stops too. Over the limit, ATLAS keeps the beginning, marks
  the response truncated and stops reading.
- **Bodies.**
  - Responses are decoded (gzip, deflate, br).
  - `Accept-Encoding`, `Accept: */*` and `User-Agent: ATLAS/<version>` are added only when
    the request does not set them.
  - The body's `Content-Type` is added the same way. Multipart always uses ATLAS's
    boundary.
- **Running at once.** At most 6 requests per window. Each window keeps its last 20
  responses; the oldest body file goes first.
- **No proxy** in this milestone: connections are direct.

### Request model (FR-1401–FR-1406)

- **Method:** any RFC 9110 token. Standard methods are suggested. CONNECT is refused. The
  method is sent as typed.
- **URL.** The URL text is the source of truth and is sent as written.
  - There is no dot-segment removal, re-encoding or `+` rewriting. Only characters a request
    line cannot carry (spaces, controls, non-ASCII, `"<>\^``{|}`) are percent-encoded, and
    the sent URL is shown.
  - URLs with a user name or password are refused; an `Authorization` header is the way.
- **Query parameters** are the editable view of the URL query, written as typed.
  - `a` (no value) and `a=` (empty value) stay different. Duplicates and order are kept.
  - Disabled parameters are kept beside the URL.
- **Headers.**
  - Names are tokens, and values cannot contain CR, LF or NUL (no request splitting).
  - Repeated headers are sent as separate lines.
  - The window and the Engine both validate.
- **Bodies.**
  - None, text, JSON and XML (edited in the editor's own Monaco).
  - Form URL-encoded.
  - Multipart: text parts and file parts, streamed from disk.
  - Binary file: streamed, with an optional content type.
- **Files to upload.**
  - They come from the native picker. The Engine reads a file only when it was picked in a
    window of this run or is already part of a saved request.
  - It must be a regular file and must exist.
- **Tabs.**
  - Several requests stay open, with a mark for unsaved changes.
  - Actions: Save (Ctrl/Cmd+S), Save as, Duplicate, Close (asks when changed), Move to,
    and Send without saving (Ctrl/Cmd+Enter).
  - The view stays mounted when another view is shown, so drafts and secret values typed
    in this session survive switching views. They do not survive a restart.

### Secrets (§2.3, FR-1409, PLAN-042 Q1)

- **Which values are secret.** A row is secret when the user marks it, or when its name
  usually carries a credential. Those names are:
  - `Authorization`, `Proxy-Authorization`, `Cookie` and `Set-Cookie`;
  - `key`, `sig`, `auth` and `sid`;
  - anything containing `token`, `secret`, `passw`, `pwd`, `api-key`/`api_key`,
    `access-key`, `private-key`, `credential`, `session` or `signature`.
- **On save**, the values of secret headers, query parameters (in the table and in the
  URL), form fields and multipart text parts are emptied. Their rows stay marked secret.
- **Sending a stored request** whose secret values were not entered again fails with
  `HTTP_SECRET_MISSING` and names the rows.
- **History, the sent-request view and saved responses** show `[secret]` in place of secret
  query values and of credential headers. Saved responses also hide every `Set-Cookie`.
- **Logs** never contain URLs, headers or bodies; a failure logs only its error code.
- **Raw bodies** (text, JSON, XML) are saved as written: ATLAS cannot tell a password
  inside free text. Saved requests and saved responses are plain SQLite records on this
  computer.

### Responses (FR-1410–FR-1415)

- **Metadata.** Status and status text, HTTP version and content type.
- **Time.**
  - Total time covers all redirects.
  - The measured phases are DNS lookup, connection, TLS handshake, waiting for the first
    byte, and download.
  - A phase that did not happen is shown as such. A new connection per exchange keeps the
    phases real.
- **Size and URL.** The decoded size, plus the received size when compressed. The final URL
  and the redirect chain.
- **Body.**
  - The body is kept in a private file (folder 0700, file 0600) in the data folder and read
    by the window in 2 MB pages that end on whole characters ("Load more").
  - Formats: pretty or raw JSON, XML, text, and HTML as source; nothing returned is ever
    run. A binary body shows only its metadata.
  - Search uses Monaco's find.
  - Download copies the file to a path the user chose in the save dialog.
  - Body files are removed when the tab closes or the window goes away, at shutdown, and at
    start-up.
- **Headers** keep their order and repeats. A **Sent** tab shows what ATLAS sent, with
  secrets hidden.
- **Cookies.**
  - The tab shows the cookies this response set and the collection's jar.
  - Each collection has its own jar, held in memory. It is scoped by domain, path, Secure
    and expiry, and public suffixes are refused.
  - Requests outside a collection keep no cookies. The jar can be cleared or turned off,
    which clears it.
- **Saved responses.**
  - Saving is an explicit action, with a warning that the body may hold sensitive data.
    Credential headers and cookies are hidden.
  - The body is kept up to 2 MB of text; at most 100 responses are saved in all.
  - Comparison shows the status change and diffs of headers and body in Monaco's diff
    editor.

### Collections and persistence (FR-1416–FR-1419)

Migration v14 (additive). Its tables:

| Table                      | Holds                                                                                                                              |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `http_collections`         | name, description, scope (`global`, `project` or `shared`), `project_id`, `cookie_jar`, timestamps                                 |
| `http_collection_projects` | the projects a shared collection is shown in                                                                                       |
| `http_folders`             | nested folders (`parent_id`), with a position                                                                                      |
| `http_requests`            | name, position, method, URL and the definition as JSON, without secret values                                                      |
| `http_history`             | request, collection, method, redacted URL, status, duration, response size and error summary; the newest 1,000 are kept; no bodies |
| `http_snapshots`           | saved responses (status, redacted headers, content type, body up to 2 MB); they are kept when their request is deleted             |

- **Visibility.**
  - A project collection shows only with its project. A shared collection shows with the
    projects chosen for it. A global collection shows everywhere.
  - "All" lists every collection with its scope. That is the only place a collection whose
    project was removed appears (`project_id` becomes NULL).
- **Operations.**
  - Collections: create, edit (name, description, scope, cookie jar), duplicate (in one
    transaction) and delete (with everything in it, after a confirmation).
  - Folders: nested, renamed, and deleted with their contents.
  - Requests: moved across folders and collections. A folder moves with its subtree, and a
    folder cannot move into itself.
  - Search covers method, name and URL.
- **History** is paginated; it reopens a saved request, or opens the method and URL as a
  new request, and can be cleared. URL suggestions come from history, leaving out URLs
  with hidden secret values.

### Security boundaries (§18)

- **Window and IPC.**
  - The window has no network access for requests, and no file paths: upload files and
    download destinations come only from native dialogs.
  - Every payload is validated by zod in the main process and again in the Engine.
- **Engine.** `http.*` methods are not offered to the CLI. The Engine accepts upload paths
  only when picked in a window during this run or already stored in a saved request.
- **The Engine is a client with the user's network reach.** A compromised window could use
  it to make requests, but not to read files. It does not render HTML.

### Test evidence

- Unit tests (`packages/api-workbench/tests`, 19) cover:
  - the URL text, query parsing and rebuilding with absent and empty values, and duplicates;
  - sending the target as written with minimal encoding, and refusing other schemes and
    credentials in URLs;
  - method and header validation (CONNECT refused, no request splitting);
  - placeholders refused, missing secrets, and storage stripping of every secret value;
  - history redaction, header redaction, the redirect plan, body kinds, and UTF-8 page
    boundaries.
- Persistence tests (`packages/persistence/tests/http-workbench.test.ts`, 11) cover:
  - global, project and shared scopes, and collections of removed projects;
  - updates, ordered saves and in-place updates;
  - moves with subtree and cycle refusal, cascading deletes, and tree duplication;
  - stored-file lookup, history retention, paging and suggestions, saved responses, and
    the v13 → v14 migration.
- Integration tests (`apps/engine/tests/http-workbench.test.ts`, 14) run against real HTTP
  and HTTPS servers on 127.0.0.1. HTTPS uses a self-signed certificate made by `openssl`
  at test time. They cover:
  - every method plus a custom one, and HEAD;
  - the path, query and duplicate headers as written;
  - 404 and 500 as responses;
  - JSON, text, XML and form bodies; binary and multipart uploads; unpicked files refused;
  - redirects with credential removal across origins, 303/307 semantics, not following,
    and loops;
  - cookies per collection and path, and turning the jar off;
  - the size limit, gzip, and binary bodies;
  - timeouts, cancellation, and no leftover files;
  - connection refused;
  - TLS refused by default, accepted only per request, and verified again on the next
    request;
  - secrets absent from SQLite; downloads and released responses; saved responses without
    cookies.

  The credential-removal test was checked to fail when the removal is turned off.

- IPC (`apps/desktop/tests/ipc.test.ts`) covers:
  - upload paths accepted only after the picker;
  - the subscriber taken from the window;
  - the download path taken only from the save dialog, and a cancelled save writing
    nothing;
  - header splitting and CONNECT refused before the Engine runs anything.
- End-to-end tests (`tests/e2e/api-workbench.spec.ts`, real local server, Linux Docker with
  Xvfb) cover:
  - Scenario A: collection, GET to localhost, JSON response, measured phases, save, history,
    restart, reopen and send again;
  - secrets not stored and asked for again after a restart, unresolved variables blocking
    Send, and the form body;
  - cancel;
  - binary upload through the picker and download through the save dialog;
  - two saved responses compared.
  - Scenarios B, C, D and F need Milestones B and C. Scenario E needs Milestone C.

### Known limitations

- **No secure store yet:** secret values must be entered again after a restart, and raw
  text bodies are saved as written.
- **Not in Milestone A:** environments, variables, authentication helpers, import and export,
  code generation, assertions and the runner.
- **Connections:** no proxy, no custom CA, HTTP/1.1 only. A new connection per exchange
  means no keep-alive reuse.
- **Multipart** bodies are sent with chunked transfer encoding.
- **Drafts and cookie jars** last only while ATLAS runs.
- **Large bodies:** pretty JSON only applies to a response read completely. Larger bodies are
  shown raw, page by page.

## Part II — Specification (summary)

### Milestone A — HTTP client foundation

FR-1401 methods · FR-1402 URL · FR-1403 query parameters · FR-1404 headers · FR-1405 body
· FR-1406 request tabs · FR-1407 execution · FR-1408 request security · FR-1409
persistence · FR-1410 response metadata · FR-1411 response body · FR-1412 response
headers · FR-1413 cookies · FR-1414 response search · FR-1415 response comparison ·
FR-1416 collection manager · FR-1417 project association · FR-1418 collection metadata ·
FR-1419 request history.

### Milestone B — Environments, authentication & import/export

FR-1420 multiple environments · FR-1421 environment variables (secret flag) · FR-1422
deterministic resolution with cycle detection · FR-1423 environment isolation · FR-1424
protected environments · FR-1425 authentication types · FR-1426 OAuth 2.0 Authorization
Code with PKCE · FR-1427 token refresh · FR-1428 authentication inheritance · FR-1429
secret redaction · FR-1430 Postman v2.1 import · FR-1431 one documented Insomnia format ·
FR-1432 OpenAPI 3.x import · FR-1433 cURL import without execution · FR-1434 export
excluding secrets · FR-1435 import security · FR-1436–FR-1438 code generation with secret
placeholders.

### Milestone C — API testing, runner & ATLAS integration

FR-1439 declarative assertions · FR-1440 JSONPath through a maintained library · FR-1441
test results · FR-1442–FR-1446 sequential collection runner with extraction and sanitized
reports · FR-1447–FR-1449 background runs, schedules and notifications through SDD-012 and
SDD-009 · FR-1450–FR-1452 Docker port discovery, Compose association and startup workflow ·
FR-1453–FR-1456 explicitly requested, sanitized AI assistance · FR-1457–FR-1458 Project
Hub and task links.

### Out of scope

Full Postman parity, cloud sync, team servers, documentation hosting, arbitrary script
execution, SOAP, gRPC, WebSocket, GraphQL explorer, mock servers, load testing, traffic
replay.
