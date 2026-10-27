# SDD-013 — Docker & Container Manager

**Status:** Milestone A (Docker connection and container management) implemented (PLAN-041,
v0.28.0). There is no schema change. It is waiting for validation. Milestones B (images,
networks and volumes) and C (Compose and project integration) have not started; each needs
its own plan after the previous milestone is validated.
**Priority:** High.
**Dependencies:** Engine, Terminal Manager, settings (SQLite), Electron IPC. Milestone B
adds the Background Operations Manager (SDD-012) and notifications (SDD-009).

Core principle: a convenient, safe interface to existing Docker capabilities, without
hiding the operational consequences of container management. ATLAS never installs,
starts or reconfigures Docker, and starts normally without it.

## Part I — Milestone A as implemented (PLAN-041)

### Decisions taken with the developer (2026-10-26)

- Approved by Anderson Andrade (Git `user.name`): "pode seguir, q1 ok, q2 ok, q3 ok, q4 ok"
  for PLAN-041 revision 1. Risks R1–R8 were presented with the plan; they were not
  acknowledged by ID.
- Q1: containers are created only from local images (`--pull never`). Pulling with
  progress comes with image management and background jobs (Milestone B).
- Q2: mutations are audited in the Engine log; there is no audit table yet.
- Q3: real Docker tests may create and remove disposable containers on the developer's
  Docker Desktop. They are opt-in (`ATLAS_DOCKER_TESTS=1`), use unique `atlas-test-<uuid>`
  names and a local image (`redis:7`), and touch nothing else.
- Q4: the view is named **Containers**.

### Integration strategy (§3.2, §3.3)

- The Docker CLI (23 or newer), with `--format json` and argument lists, never a shell. The
  CLI already handles contexts, Docker Desktop, WSL, SSH and TLS contexts, and credential
  helpers, so no client library or socket code was added.
- Every request names its context, and every command gets `--context <name>`. ATLAS keeps
  its own context choice (`docker.context` setting, null = follow Docker's current
  context) and never runs `docker context use`: Docker outside ATLAS is unchanged.
  Switching requires an explicit selection in the header.
- Contexts are listed with name, description, endpoint type (unix, npipe, tcp, ssh), a
  local or remote label and the host. Users, ports, TLS material and context metadata are
  never read or shown. tcp to localhost is local; ssh and other tcp hosts are remote.
- The CLI runs with a minimal environment: PATH, HOME, DOCKER_* variables, SSH_AUTH_SOCK
  and the platform basics, plus `DOCKER_CLI_HINTS=false`. Each call has a timeout (10–60
  s) and stops its whole process tree.

### Connection (FR-1301, FR-1303)

| State              | Detected by                                                   |
| ------------------ | ------------------------------------------------------------- |
| CLI_MISSING        | no `docker` executable on the Engine or login-shell PATH      |
| ENGINE_UNAVAILABLE | `docker version` without a server, or "cannot connect" errors |
| PERMISSION_DENIED  | "permission denied" from the daemon socket                    |
| CONNECTION_ERROR   | anything else, including timeouts                             |
| CONNECTED          | `docker version` reports a server                             |

The view checks again every 10 s while Docker cannot be used, and when the events stream
ends; containers are read again every 15 s while the view is visible. No restart is needed.

### Containers (FR-1304–FR-1306, FR-1310)

- The list (`docker ps -a --no-trunc`) shows name, image, state, health (Docker's
  `HealthStatus`, or the status text on older CLIs), published ports and the Compose
  project label. It can be searched and filtered (all, running, stopped).
- Actions follow the state. created: start, rename, remove. running: stop, restart, pause,
  rename, shell. paused: resume, stop, rename. restarting: stop, rename. exited: start,
  restart, rename, remove. dead: remove. The Engine checks the state again before acting
  (`DOCKER_ACTION_INVALID`).
- Remove asks for confirmation, applies only to stopped containers, and never removes
  volumes (`docker rm` without `-v` or `-f`).
- Details come from `docker inspect`, mapped in the Engine: identity, image, entrypoint and
  command (redacted), user and root warning, privileged flag, restart policy, ports, mounts,
  networks, health check and recent results, limits, times, and environment **names**.
  Values never leave the Engine.
- Creation uses local images only, with name, command (split without expansion),
  entrypoint, ports, environment, bind mounts, named volumes, network and restart policy.
  - Ports default to 127.0.0.1.
  - Privileged mode is not offered.
  - Some options need an explicit confirmation of the reasons the Engine reports: the host
    network, the Docker socket, broad host folders (/, /Users, /home, the home folder),
    system folders and anything inside them (/etc, /var, /root…), credential folders in
    the home folder (.ssh, .aws, .kube, .docker, .gnupg, .config…), and ports open to the
    network.
  - Environment values go through a private `--env-file` (folder 0700, file 0600, deleted
    right after). They never reach the command line or the CLI's own environment, where a
    variable such as `DOCKER_HOST` could redirect the CLI.
  - `--` separates the image from options.

### Logs and usage (FR-1307, FR-1309)

- Logs: `docker logs --follow --timestamps --tail 500` per opened panel. Preflight's bounded,
  redacted line buffer keeps stdout and stderr apart. The log viewer adds search, an
  errors-only filter, copy, and follows the end while scrolled to it.
- Sessions belong to the window: at most 8 at once, closed when the panel closes, when the
  window goes away, or after 60 s without reads. Nothing is stored.
- Usage: `docker stats --no-stream` every 3 s, only while the Usage tab of a running
  container is shown and the window is visible. Values Docker does not report are shown as
  "Not reported".

### Terminals (FR-1308)

- "Open shell" checks for a shell in the container (`/bin/bash`, `/bin/ash`, `/bin/sh`,
  `/busybox/sh`, in order) and reports when none exists.
- When the container would run the shell as root (an empty user, `root` or uid 0), the user
  confirms root or chooses another user.
- ATLAS then opens a normal terminal named "<container> (container)" and types
  `docker --context <ctx> exec -it [--user <u>] <full id> <shell>` (validated tokens, no
  quoting needed). Resizing, input and closing work as in any ATLAS terminal.
  - The command stays in the shell history.
  - Exiting the container shell returns to the host shell.

### Live updates (FR-1312)

`docker events --format json --filter type=container` runs only while a window shows the
view, for the context in use.

- **Coalescing:** events arriving within 300 ms become one change, and they are published as
  `docker` events.
- **Reconnection:** when the stream ends on its own, the change is reported, then the stream
  is retried after 2, 5, 10 and 30 s.
- **Reconciliation:** periodic reads correct any missed events.
- **Cleanup:** closing the window detaches its watch and log sessions.

### Security boundaries (§3.4, §16)

- The renderer has no socket, API, command or path access; only typed operations
  validated in the main process and again in the Engine. The CLI cannot use them.
- Every mutation is audited in the Engine log: action, context, short id and outcome, never
  values.
- Docker access equals administrator access on the host or remote machine. Docker is not a
  sandbox; ATLAS makes risky options explicit but cannot make them safe.

### Test evidence

- Unit (`packages/docker/tests`, 21): output parsing with captured Docker 29.6 fixtures,
  connection classification, contexts without secrets, sensitive and credential folders, ports and ranges, actions per state,
  details without environment values, stats without invented values, events, creation
  risks, command splitting, and the service: status states, context selection without
  `docker context use`, unknown contexts, audited lifecycle, stopped-only removal without
  volumes, safe errors, the private env file and its argument list, shell detection and
  root confirmation, log sessions, and the events watch with coalescing and reconnection.
- Runner (`apps/engine/tests/docker.test.ts`, 6): argument lists without a shell, the minimal
  environment, failures, timeout of the process tree, private files removed, streams,
  missing CLI.
- Real Docker (same file, opt-in, 2): Docker Desktop 4.81 / Engine 29.6.1, 2026-10-26.
  Covered: create with env and a port, details without values, list, followed logs with
  timestamps, stats, shell detection, refused removal while running, pause, resume, rename,
  stop, remove, and container events. No test container remained; the developer's
  containers were untouched.
- IPC (`apps/desktop/tests/ipc.test.ts`): validation before any Docker command, and no
  subscriber spoofing.
- End-to-end (`tests/e2e/containers.spec.ts`, fake CLI, Linux Docker with Xvfb):
  - Scenario A: list, stop, start, details without secrets, logs, usage.
  - The root-confirmed shell in an ATLAS terminal.
  - Scenario F: removal cancelled, then confirmed.
  - Scenario E: without Docker, then reconnecting by itself.
  - Risky creation warnings.
  - Scenarios B, C and D belong to Milestones B and C.

### Known limitations

- Images, networks, volumes, Compose, project association and AI diagnostics are not
  implemented (Milestones B and C).
- Containers are created only from local images.
- Requires Docker CLI 23 or newer (JSON output). Older CLIs are reported as a connection
  error.
- The container shell is typed into a host shell, so it stays in that shell's history.
- Log follow/unfollow is by scrolling; there is no pause button.

## Part II — Specification (summary)

### Milestone A — Docker connection & container management

FR-1301 availability detection · FR-1302 context selector · FR-1303 connection recovery
· FR-1304 container list · FR-1305 container actions · FR-1306 container details ·
FR-1307 container logs · FR-1308 container terminal · FR-1309 resource monitoring ·
FR-1310 container creation · FR-1311 Containers dashboard · FR-1312 live state updates.

### Milestone B — Images, networks & volumes

FR-1313 image list · FR-1314 image pull through background operations · FR-1315 image
build · FR-1316 image management · FR-1317 image updates without silently replacing
containers · FR-1318 network list · FR-1319 network creation · FR-1320 connecting
containers to networks · FR-1321 network compatibility · FR-1322 network safety ·
FR-1323 topology view · FR-1324 volume list · FR-1325 volume actions · FR-1326 volume
safety (no bulk pruning).

### Milestone C — Docker Compose & project integration

FR-1327 Compose discovery · FR-1328 registration · FR-1329 services · FR-1330 actions ·
FR-1331 down safety · FR-1332 build and pull as background jobs · FR-1333 validation ·
FR-1334 environment selection · FR-1335 networking · FR-1336 project container overview
· FR-1337 open application · FR-1338 explicit project startup · FR-1339 project
shutdown · FR-1340 Operations Manager · FR-1341 cancellation · FR-1342 notifications ·
FR-1343–FR-1345 optional, explicitly requested AI diagnostics without destructive
authority.

### Out of scope

Docker installation, Docker Desktop replacement, Kubernetes, Swarm, registry hosting,
remote daemon provisioning, production deployment, vulnerability remediation, unattended
volume pruning, Portainer parity, and a new background execution engine.
