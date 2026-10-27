import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test, type AtlasHarness } from './fixtures';

// SDD-013 Milestone A: the Container Manager over a fake `docker` CLI on the app's PATH.
// The fake keeps one container's state in files; no real Docker engine is involved.

const ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9';

function fakeDocker(atlas: AtlasHarness): string {
  const state = path.join(atlas.root, 'fake-docker');
  mkdirSync(state, { recursive: true });
  writeFileSync(path.join(state, 'state'), 'running');
  writeFileSync(path.join(state, 'name'), 'backend-api');
  writeFileSync(
    path.join(atlas.binDir, 'docker'),
    `#!/bin/bash
S='${state}'
[ "$1" = --context ] && shift 2
state=$(cat "$S/state"); name=$(cat "$S/name")
down() {
  echo '{"Client":{"Version":"29.6.1"},"Server":null}'
  echo 'failed to connect to the docker API at unix:///var/run/docker.sock; check if the daemon is running' >&2
  exit 1
}
case "$1" in
  context)
    echo '{"Current":true,"Description":"Docker Desktop","DockerEndpoint":"unix:///tmp/docker.sock","Error":"","Name":"desktop-linux"}'
    echo '{"Current":false,"Description":"CI","DockerEndpoint":"ssh://ci@build.example.com","Error":"","Name":"build"}' ;;
  version)
    [ -f "$S/down" ] && down
    echo '{"Client":{"Version":"29.6.1"},"Server":{"Platform":{"Name":"Docker Desktop 4.81.0"},"Version":"29.6.1","ApiVersion":"1.55"}}' ;;
  compose) echo v5.2.0 ;;
  ps)
    [ -f "$S/down" ] && down
    [ -f "$S/removed" ] && exit 0
    case "$state" in running) status='Up 2 minutes';; paused) status='Up 2 minutes (Paused)';; *) status='Exited (0) 1 second ago';; esac
    echo "{\\"ID\\":\\"${ID}\\",\\"Names\\":\\"$name\\",\\"Image\\":\\"node:22-alpine\\",\\"State\\":\\"$state\\",\\"Status\\":\\"$status\\",\\"HealthStatus\\":\\"none\\",\\"Ports\\":\\"0.0.0.0:3000->3000/tcp\\",\\"CreatedAt\\":\\"2026-10-26 10:00:00 +0000 UTC\\",\\"Labels\\":\\"com.docker.compose.project=shop\\"}" ;;
  inspect)
    [ -f "$S/removed" ] && { echo '[]'; echo "Error response from daemon: No such container: x" >&2; exit 1; }
    echo "[{\\"Id\\":\\"${ID}\\",\\"Name\\":\\"/$name\\",\\"Created\\":\\"2026-10-26T10:00:00Z\\",\\"State\\":{\\"Status\\":\\"$state\\",\\"ExitCode\\":0,\\"StartedAt\\":\\"2026-10-26T10:00:01Z\\"},\\"Image\\":\\"sha256:1\\",\\"Config\\":{\\"User\\":\\"\\",\\"Image\\":\\"node:22-alpine\\",\\"Env\\":[\\"API_TOKEN=s3cr3t-value\\",\\"NODE_ENV=production\\"],\\"Cmd\\":[\\"node\\",\\"server.js\\"],\\"ExposedPorts\\":{\\"3000/tcp\\":{}}},\\"HostConfig\\":{\\"NetworkMode\\":\\"bridge\\",\\"RestartPolicy\\":{\\"Name\\":\\"no\\"}},\\"NetworkSettings\\":{\\"Ports\\":{\\"3000/tcp\\":[{\\"HostIp\\":\\"0.0.0.0\\",\\"HostPort\\":\\"3000\\"}]},\\"Networks\\":{\\"bridge\\":{\\"IPAddress\\":\\"172.17.0.2\\"}}},\\"Mounts\\":[]}]" ;;
  start|unpause|restart) echo running > "$S/state"; echo "$2" ;;
  stop) echo exited > "$S/state"; echo "$2" ;;
  pause) echo paused > "$S/state"; echo "$2" ;;
  rename) echo "$3" > "$S/name" ;;
  rm) touch "$S/removed"; echo "$2" ;;
  events) exec sleep 3600 ;;
  logs) echo '2026-10-26T10:00:02Z server listening on 3000'; echo '2026-10-26T10:00:03Z warn: slow request' >&2; exec sleep 3600 ;;
  stats) echo '{"CPUPerc":"1.25%","MemUsage":"42MiB / 7.75GiB","MemPerc":"0.53%","NetIO":"1kB / 2kB","BlockIO":"0B / 0B","PIDs":"7"}' ;;
  exec) case "$*" in *"-it"*) echo "fake shell in $name"; exec bash --norc ;; */bin/bash*|*/bin/ash*) exit 126 ;; *) exit 0 ;; esac ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`,
  );
  chmodSync(path.join(atlas.binDir, 'docker'), 0o755);
  return state;
}

const navigate = (page: Page, name: string) =>
  page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name, exact: true })
    .click();

const row = (page: Page) => page.getByTestId('container-row').first();

test('lists, stops, starts and inspects containers without exposing secrets (Scenario A)', async ({
  atlas,
}) => {
  fakeDocker(atlas);
  const { page } = await atlas.launch();
  await navigate(page, 'Containers');
  const view = page.getByTestId('containers-view');
  await expect(view.getByTestId('docker-status')).toHaveText('Docker connected');
  await expect(view.getByTestId('docker-connection')).toContainText('Engine 29.6.1');
  // Docker's own current context; remote contexts are labelled, without their user.
  await view.getByRole('combobox', { name: 'Docker context' }).click();
  await expect(
    page.getByRole('option', { name: /build · remote \(build\.example\.com\)/ }),
  ).toBeVisible();
  await page.keyboard.press('Escape');

  await expect(row(page)).toContainText('backend-api');
  await expect(row(page)).toContainText('node:22-alpine · 3000→3000/tcp · shop');
  await expect(row(page)).toHaveAttribute('data-state', 'running');

  await row(page).getByRole('button', { name: 'Stop backend-api' }).click();
  await expect(row(page)).toHaveAttribute('data-state', 'exited');
  await expect(row(page).getByTestId('container-state')).toHaveText('Stopped');
  await row(page).getByRole('button', { name: 'Start backend-api' }).click();
  await expect(row(page)).toHaveAttribute('data-state', 'running');

  await row(page).locator('button[aria-pressed]').click();
  const overview = page.getByTestId('container-overview');
  await expect(overview).toContainText('API_TOKEN, NODE_ENV');
  await expect(overview).toContainText('runs as root');
  await expect(page.getByTestId('container-details')).not.toContainText('s3cr3t-value');

  await page.getByTestId('container-details').getByRole('tab', { name: 'Logs' }).click();
  const logs = page.getByTestId('container-logs');
  await expect(logs).toContainText('server listening on 3000');
  await expect(logs).toContainText('warn: slow request');

  await page.getByTestId('container-details').getByRole('tab', { name: 'Usage' }).click();
  await expect(page.getByTestId('container-usage')).toContainText('1.25 %');
  await expect(page.getByTestId('container-usage')).toContainText('42MiB of 7.75GiB');
});

test('opens a shell in a container after confirming root (FR-1308)', async ({ atlas }) => {
  fakeDocker(atlas);
  const { page } = await atlas.launch();
  await navigate(page, 'Containers');
  await row(page).getByRole('button', { name: 'More actions for backend-api' }).click();
  await page.getByRole('menuitem', { name: 'Open shell' }).click();
  const dialog = page.getByTestId('container-terminal');
  await expect(dialog).toContainText('runs as root');
  await dialog.getByRole('button', { name: 'Open as root' }).click();

  // A normal ATLAS terminal, named after the container, running docker exec.
  const pane = page.getByTestId('terminal-pane');
  await expect(pane.locator('.xterm-rows')).toContainText(`exec -it ${ID} /bin/sh`, {
    timeout: 15_000,
  });
  await expect(pane.locator('.xterm-rows')).toContainText('fake shell in backend-api');
  await expect(page.getByText('backend-api (container)').first()).toBeVisible();
});

test('asks before removing and keeps the container when cancelled (Scenario F)', async ({
  atlas,
}) => {
  const state = fakeDocker(atlas);
  writeFileSync(path.join(state, 'state'), 'exited');
  const { page } = await atlas.launch();
  await navigate(page, 'Containers');
  await expect(row(page)).toHaveAttribute('data-state', 'exited');

  await row(page).getByRole('button', { name: 'More actions for backend-api' }).click();
  await page.getByRole('menuitem', { name: 'Remove' }).click();
  const confirm = page.getByTestId('container-remove');
  await expect(confirm).toContainText('Its volumes are kept');
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm).toBeHidden();
  await expect(row(page)).toContainText('backend-api');

  await row(page).getByRole('button', { name: 'More actions for backend-api' }).click();
  await page.getByRole('menuitem', { name: 'Remove' }).click();
  await page
    .getByTestId('container-remove')
    .getByRole('button', { name: 'Remove container' })
    .click();
  await expect(page.getByTestId('containers-view')).toContainText('No containers in this context.');
});

test('works without Docker and reconnects when it starts (Scenario E)', async ({ atlas }) => {
  const state = fakeDocker(atlas);
  writeFileSync(path.join(state, 'down'), '');
  const { page } = await atlas.launch();

  // The rest of ATLAS is unaffected.
  await navigate(page, 'Terminals');
  await expect(page.getByTestId('terminal-workspace')).toBeVisible();
  await navigate(page, 'Containers');
  const view = page.getByTestId('containers-view');
  await expect(view.getByTestId('docker-status')).toHaveText('Docker not running');
  await expect(view.getByTestId('docker-disconnected')).toContainText('Start Docker Desktop');
  await expect(view.getByRole('button', { name: 'New container' })).toBeDisabled();

  // Docker starts: ATLAS notices by itself, without a restart.
  rmSync(path.join(state, 'down'));
  await expect(view.getByTestId('docker-status')).toHaveText('Docker connected', {
    timeout: 20_000,
  });
  await expect(row(page)).toContainText('backend-api');
});

test('warns about risky container options before creating (FR-1310)', async ({ atlas }) => {
  fakeDocker(atlas);
  const { page } = await atlas.launch();
  await navigate(page, 'Containers');
  await page.getByTestId('containers-view').getByRole('button', { name: 'New container' }).click();
  const dialog = page.getByTestId('create-container');
  await dialog.getByLabel('Image').fill('nginx:1');
  await dialog.getByLabel('Network (optional)').fill('host');
  await dialog.getByRole('button', { name: 'Create container' }).click();
  await expect(dialog.getByTestId('container-risks')).toContainText('uses the host network');
  await expect(dialog.getByRole('button', { name: 'Create container' })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
});
