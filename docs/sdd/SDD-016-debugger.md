# SDD-016 — Debugger (Debug Adapter Protocol)

**Status:** Task 01 (debugger foundation) implemented (PLAN-044, v0.31.0). It is waiting
for validation. There is no debugger UI yet. Later tasks (breakpoints, call stack,
variables, debug console, launch configurations, Monaco integration) have not started;
each needs its own plan.
**Priority:** Medium.
**Dependencies:** Engine, process trees (`process-tree.ts`), Project Registry. The UI tasks
will add Monaco (SDD-011) and IPC.

## Task 01 — Debugger foundation, as implemented (PLAN-044)

### Decisions taken with the developer (2026-10-27)

- Approved by Anderson Andrade (Git `user.name`): "pode seguir, q1 a q4 recomendado" for
  PLAN-044 revision 1. Risks R1–R5 were presented; they were not acknowledged by ID.
- **Q1:** debugging is not exposed to the window yet. The Engine has desktop-only `debug.*`
  methods, but there is no preload API and no IPC channel. A session can only be started by
  code calling `debug.start`; the UI tasks add the user action.
- **Q2:** the official DAP types, `@vscode/debugprotocol` 1.68.0 (MIT, no dependencies,
  types only), with ATLAS's own framing and request correlation. `@vscode/debugadapter`
  is for writing adapters; `vscode-jsonrpc` frames JSON-RPC, not DAP.
- **Q3:** sessions live in memory only. There is no database migration.
- **Q4:** one active session at a time (`DEBUG_BUSY`).

### Architecture

```text
 Engine `debug.*` (desktop only; the main process sets the owner)
   DebugSessionManager (packages/debugger)
     adapter registry (Engine code only; empty in this task)
     sessions: owner, configuration, status machine, capabilities, failure
     DapConnection: seq numbering, request/response by request_seq, timeouts, events,
                    adapter-to-client requests refused
     DapMessageReader: Content-Length framing, size limits
   ProcessTreeAdapterLauncher (Engine adapter): process-tree with stdin piped, no shell,
     own process group, SIGTERM then SIGKILL of the whole tree
   NodeDebugFileSystem (Engine adapter): real paths of executables and folders
 Events ─► Engine event bus `{ type: 'debug', ownerId, event }`
```

### Contracts (`packages/contracts/src/debug.ts`)

- **`DebugSessionStatus`:** CREATED, STARTING, RUNNING, PAUSED, TERMINATING, TERMINATED,
  FAILED. TERMINATED and FAILED are final.
- **`DebugConfiguration`** (zod):
  - name, adapter id, `launch` or `attach`, project;
  - `cwd` relative to the project, with no `.` or `..`;
  - program, args (at most 256), the debuggee's env (at most 100 variables);
  - `stopOnEntry`;
  - adapter-specific `options` as JSON (at most 64 keys and 64 KB). These options cannot
    replace the fields ATLAS sets.
- **`DebugAdapter`:** id, label, absolute command, args, languages.
- **`DebugSession`:** id, name, adapter, project, request, status, capabilities, failure
  (code, fixed message, trimmed adapter message), timestamps.
- **`DebugEvent`:**
  - `status`;
  - `stopped` (reason, thread, description);
  - `output` (category, text up to 8 KB);
  - `adapter-event` (any other DAP event; a body over 64 KB is dropped).

### Session lifecycle

| From        | To                                                                    |
| ----------- | --------------------------------------------------------------------- |
| CREATED     | STARTING, TERMINATED (stopped before start), FAILED (could not start) |
| STARTING    | RUNNING, PAUSED, TERMINATING, FAILED                                  |
| RUNNING     | PAUSED, TERMINATING, FAILED                                           |
| PAUSED      | RUNNING, TERMINATING, FAILED                                          |
| TERMINATING | TERMINATED, FAILED                                                    |

1. **`create`** validates the configuration, the adapter id and the project, and records a
   CREATED session. Nothing runs.
2. **`start`:**
   - **Checks first:** the adapter's command must resolve (real path) to an executable
     regular file, and the working folder must resolve to a folder inside the project
     (symbolic links included). Otherwise the session is FAILED and nothing runs.
   - **Launch:** the adapter starts without a shell, in its own process group. Its
     environment is the Engine's without `ELECTRON_*` and `ATLAS_*` variables; the
     debuggee's environment goes in the `launch` request.
   - **Handshake:**
     - `initialize` (10 s); capabilities are recorded.
     - `launch` or `attach` is sent, then ATLAS waits for the `initialized` event
       (30 s). A refused launch ends the wait at once.
     - `configurationDone` when supported.
     - Then the launch response is awaited, because some adapters answer it only after
       `configurationDone`.
   - The session becomes RUNNING, or stays PAUSED if the adapter already stopped on entry.
     The call returns the session, also when it failed.
3. **Events while running:**
   - `stopped` sets PAUSED and `continued` sets RUNNING.
   - `output` is forwarded.
   - `terminated` stops the session like a user stop.
   - Every other DAP event is forwarded as `adapter-event`.
4. **`stop`:** `disconnect` with `terminateDebuggee` (3 s), then the adapter's whole process
   tree is stopped (SIGTERM, SIGKILL after 2 s). The session is TERMINATED once the tree is
   gone.
5. **Failures:**
   - An adapter that exits on its own fails with `DEBUG_ADAPTER_FAILED`, keeping the last
     500 characters of its stderr.
   - A request that is not answered in time fails with `DEBUG_TIMEOUT`.
   - Invalid framing or JSON fails with `DEBUG_ADAPTER_FAILED`.
   - A refused launch fails with `DEBUG_LAUNCH_FAILED`, with the adapter's message.
   - Each failure stops the process tree.
6. **Ownership:** each session belongs to the client that created it (the window's
   subscriber id, set by the main process). Another owner gets
   `DEBUG_SESSION_NOT_FOUND`, which does not disclose that the session exists.
   - `detach` (window reload or close) stops the owner's sessions and forgets them.
   - Engine shutdown stops every session.
   - The last 20 ended sessions of an owner can still be read.

### Security

- **Never automatic:** ATLAS does not read `launch.json` or any repository file to start a
  debugger. Adapters come only from the Engine's registry, and sessions run only when
  `start` is called. No window or CLI path can call it in this task.
- **Executables and folders:** an adapter command must be absolute and resolve to an
  executable regular file. The working folder must stay inside the registered project
  after resolving links.
- **No shell:** arguments go to `spawn` as an array. A program text such as
  `$(touch x)` is passed literally (tested).
- **No running on the adapter's behalf:** adapter requests to the client (`runInTerminal`,
  `startDebugging`) are refused.
- **Bounded input:** DAP headers are limited to 8 KB and messages to 16 MB. Output, event
  bodies and adapter messages are limited, and control characters are removed from the
  text ATLAS keeps.
- **Logs:** session id, adapter id, PID, exit code and error code only. Never arguments,
  environment or program output.
- **Not a sandbox:** a debug adapter runs with the user's permissions (PLAN-044 R1).

### Test evidence

- **Unit:** `packages/debugger/tests/protocol.test.ts`, 26 tests.
  - framing: byte-by-byte and coalesced chunks, extra headers, byte counts with UTF-8, six
    malformed inputs, size limit;
  - correlation: out of order, timeout with a late answer ignored, events, adapter
    requests refused, protocol errors closing the connection, write failures;
  - the state machine.
- **Integration:** `apps/engine/tests/debugger.test.ts`, 21 tests on POSIX, with a real
  adapter process (`tests/support/fake-debug-adapter.mjs`) in thirteen modes. Covered:
  - create without running, the full handshake, capabilities, output and other events, a
    clean stop;
  - pause on entry; launch answered after `configurationDone`; the `initialized` event in
    the same chunk as the `initialize` response; one-byte writes;
  - refused launch, crash with stderr, hang (timeout), invalid framing, an adapter
    ignoring `disconnect` and SIGTERM;
  - unexpected death with a grandchild process (the whole tree is gone), refused
    `runInTerminal`, the debuggee terminating;
  - no shell interpolation, ownership, busy and invalid-state rules, detach, stopping a
    CREATED session;
  - invalid adapters, projects and configurations; a working folder escaping through a
    link; a non-executable adapter; the adapter environment.
  - After every test, each adapter PID is checked to be gone.
  - Mutation checks: without stopping the tree on failure, three tests fail; waiting for
    `initialized` only after `initialize` answered makes the same-chunk test fail.
- **IPC:** one test. No window channel exists, and the CLI cannot call `debug.*`.

### Known limitations

- There is no UI, no registered adapter and no way for the user to start a session yet.
- Sessions are lost when the Engine restarts. If the Engine crashes hard (it is not shut
  down), adapter process groups can outlive it (PLAN-044 R2).
- One active session at a time. Adapters over TCP (`debugServer`) and attach by process
  picking are not supported.
- Windows is not tested: process trees use `taskkill /t` there, and the integration tests
  are POSIX only.

## Remaining SDD-016 work (not started)

Each needs its own plan:

- registered adapters (Node.js first) and how the user chooses them;
- launch configuration editor;
- breakpoints, including conditional ones, in Monaco;
- call stack, variables and watch expressions;
- debug console, step controls and multiple targets;
- persistence of configurations;
- AI-assisted debugging.
