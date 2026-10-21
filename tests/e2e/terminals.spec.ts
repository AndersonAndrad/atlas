import type { Locator, Page } from '@playwright/test';
import type { TerminalSession } from '@atlas/contracts';
import { expect, test, openProjectTerminal } from './fixtures';

// Only harmless commands run here (echo, printf, sleep, stty, read), always in
// temporary workspaces with an empty HOME.

const panes = (page: Page) => page.getByTestId('terminal-pane');
const tabs = (page: Page) => page.getByTestId('terminal-tab');
const screenText = (pane: Locator) => pane.locator('.xterm-rows').innerText();
/** Screen text without line breaks: long paths wrap across rows (e.g. after a long prompt). */
const unwrappedText = async (pane: Locator) => (await screenText(pane)).replace(/\n/g, '');

/** Opens the Terminals view and selects a workspace (default: Ungrouped). */
async function openTerminals(page: Page, workspace = 'Ungrouped') {
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Terminals' })
    .click();
  await page.getByTestId('workspace-button').filter({ hasText: workspace }).click();
  await expect(page.getByTestId('terminal-workspace')).toBeVisible();
}

/** Opens a terminal in a registered project, or in the default directory without one. */
async function newTerminal(page: Page, projectName?: string) {
  const before = await tabs(page).count();
  if (projectName === undefined) {
    await page.getByRole('button', { name: 'New terminal', exact: true }).first().click();
  } else {
    await openProjectTerminal(page, projectName);
  }
  await expect(tabs(page)).toHaveCount(before + 1);
}

async function createGroup(page: Page, name: string) {
  await page.getByRole('button', { name: 'New group' }).click();
  await page.getByTestId('name-dialog').getByLabel('Name').fill(name);
  await page.getByRole('button', { name: 'Create group' }).click();
  await expect(page.getByTestId('terminal-group').filter({ hasText: name })).toBeVisible();
}

/** Types a command into a pane and waits for the shell prompt to be ready first. */
async function run(page: Page, pane: Locator, command: string) {
  await expect.poll(() => screenText(pane), { timeout: 15_000 }).toMatch(/\$\s*$/m);
  await pane.locator('.xterm-screen').click();
  await page.keyboard.type(command);
  await page.keyboard.press('Enter');
}

/** Waits until the shell of `pane` runs `program` in the foreground. */
async function waitForForeground(page: Page, pane: Locator, program: string) {
  const id = (await pane.getAttribute('data-session-id'))!;
  await expect
    .poll(
      () =>
        page.evaluate(
          async (sessionId) =>
            (
              (await (
                window as unknown as {
                  atlas: { terminals: { closeInfo(id: string): Promise<unknown> } };
                }
              ).atlas.terminals.closeInfo(sessionId)) as { data?: { processName?: string } }
            ).data?.processName,
          id,
        ),
      { timeout: 10_000 },
    )
    .toBe(program);
}

function terminalList(cli: (...args: string[]) => string): TerminalSession[] {
  return JSON.parse(cli('terminal', 'list', '--json')) as TerminalSession[];
}

test('opens a real interactive shell in the project directory', async ({ atlas }) => {
  const dir = atlas.workspace('nova');
  atlas.cli('project', 'add', dir);
  const { page } = await atlas.launch();
  await openTerminals(page);
  await expect(page.getByTestId('terminal-empty-state')).toBeVisible();
  await newTerminal(page, 'nova');

  const pane = panes(page).first();
  await expect(pane.getByTestId('terminal-status')).toHaveAttribute('data-status', 'RUNNING');
  await run(page, pane, 'pwd; printf "\\033[31m%s\\033[0m\\n" "red-$((20 + 1))"');
  await expect.poll(() => screenText(pane)).toContain('red-21');
  expect(await unwrappedText(pane)).toContain(dir);
  // ANSI colors are rendered, not printed as escape codes.
  await expect(pane.locator('.xterm-rows span', { hasText: 'red-21' })).toHaveClass(/xterm-fg-1/);

  // Interactive input.
  await run(page, pane, 'read -r answer; echo "got-$answer"');
  await page.keyboard.type('yes');
  await page.keyboard.press('Enter');
  await expect.poll(() => screenText(pane)).toContain('got-yes');

  // Full-screen programs use the alternate screen buffer.
  await run(
    page,
    pane,
    'printf "\\033[?1049h\\033[HALT-$((2 * 4))"; read -r _; printf "\\033[?1049l"',
  );
  await expect.poll(() => screenText(pane)).toContain('ALT-8');
  expect(await screenText(pane)).not.toContain('got-yes');
  await page.keyboard.press('Enter');
  await expect.poll(() => screenText(pane)).toContain('got-yes');

  // Ctrl+C interrupts the foreground program.
  await run(page, pane, 'sleep 30');
  await waitForForeground(page, pane, 'sleep');
  await page.keyboard.press('Control+C');
  await run(page, pane, 'echo "rc=$?"');
  await expect.poll(() => screenText(pane)).toContain('rc=130');

  // Exits are detected and shown.
  await run(page, pane, 'exit 4');
  await expect(pane.getByTestId('terminal-ended')).toContainText('Process exited with code 4');
  await expect(pane.getByTestId('terminal-status')).toHaveAttribute('data-status', 'EXITED');
});

test('manages tabs: create, rename, select and close safely', async ({ atlas }) => {
  atlas.cli('project', 'add', atlas.workspace('nova'));
  const { app, page } = await atlas.launch();
  await openTerminals(page);
  await newTerminal(page, 'nova');
  await atlas.menu(app, 'terminal.new');
  await expect(tabs(page)).toHaveCount(2);
  await expect(tabs(page).nth(1).getByRole('tab')).toHaveAttribute('aria-selected', 'true');

  // Rename by double-click.
  await tabs(page).nth(0).getByRole('tab').dblclick();
  const field = page.getByRole('textbox', { name: 'Terminal name' });
  await field.fill('Dev server');
  await field.press('Enter');
  await expect(tabs(page).nth(0)).toContainText('Dev server');

  // Select the first tab: it replaces the hidden one in the single pane.
  await tabs(page).nth(0).getByRole('tab').click();
  await expect(tabs(page).nth(0).getByRole('tab')).toHaveAttribute('aria-selected', 'true');
  await expect(panes(page)).toHaveCount(1);
  await expect(panes(page).first().getByTestId('pane-title')).toHaveText('Dev server');

  // Shortcut navigation between tabs.
  await atlas.menu(app, 'terminal.next');
  await expect(tabs(page).nth(1).getByRole('tab')).toHaveAttribute('aria-selected', 'true');
  await atlas.menu(app, 'terminal.previous');
  await expect(tabs(page).nth(0).getByRole('tab')).toHaveAttribute('aria-selected', 'true');

  // Closing a tab with a running program asks first; cancelling keeps it running.
  await run(page, panes(page).first(), 'sleep 120');
  await waitForForeground(page, panes(page).first(), 'sleep');
  await page.getByRole('button', { name: 'Close Dev server' }).click();
  const dialog = page.getByTestId('close-terminal-dialog');
  await expect(dialog).toContainText('sleep');
  await dialog.getByRole('button', { name: 'Keep running' }).click();
  await expect(tabs(page)).toHaveCount(2);
  expect(terminalList(atlas.cli).filter((s) => s.status === 'RUNNING')).toHaveLength(2);

  await page.getByRole('button', { name: 'Close Dev server' }).click();
  await dialog.getByRole('button', { name: 'Terminate' }).click();
  await expect(tabs(page)).toHaveCount(1);
  // The remaining terminal was opened in the default directory (home): automatic name "~".
  expect(terminalList(atlas.cli).map((s) => s.title)).toEqual(['~']);

  // An idle shell closes without confirmation.
  await atlas.menu(app, 'terminal.close');
  await expect(tabs(page)).toHaveCount(0);
  await expect(page.getByTestId('terminal-empty-state')).toBeVisible();
});

test('splits panes, resizes the PTY and hides panes without killing processes', async ({
  atlas,
}) => {
  atlas.cli('project', 'add', atlas.workspace('nova'));
  const { app, page } = await atlas.launch();
  await openTerminals(page);
  await newTerminal(page, 'nova');

  await page.getByRole('button', { name: 'Split right' }).click();
  await expect(panes(page)).toHaveCount(2);
  await atlas.menu(app, 'terminal.splitDown');
  await expect(panes(page)).toHaveCount(3);
  await expect(page.getByTestId('terminal-split').first()).toHaveAttribute('data-direction', 'row');
  await expect(page.locator('[data-testid="terminal-split"][data-direction="column"]')).toHaveCount(
    1,
  );
  await expect(panes(page).nth(2)).toHaveAttribute('data-active', 'true');

  // Focus cycling.
  await atlas.menu(app, 'terminal.focusNextPane');
  await expect(panes(page).nth(0)).toHaveAttribute('data-active', 'true');

  // Dragging the divider changes the dimensions seen by the shell.
  const first = panes(page).nth(0);
  await run(page, first, 'stty size');
  await expect.poll(() => screenText(first)).toMatch(/\d+ \d+/);
  const before = /(\d+) (\d+)/.exec(await screenText(first))!;
  const handle = page.locator('[data-slot="resizable-handle"]').first();
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x - 200, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  await run(page, first, 'clear; stty size');
  await expect
    .poll(async () => Number(/(\d+) (\d+)/.exec(await screenText(first))?.[2] ?? before[2]))
    .toBeLessThan(Number(before[2]));

  // Hiding a pane keeps its process: the tab remains and is still running.
  const hiddenId = await panes(page).nth(1).getAttribute('data-session-id');
  await panes(page).nth(1).getByRole('button', { name: 'Hide pane' }).click();
  await expect(panes(page)).toHaveCount(2);
  await expect(
    page.locator(`[data-testid="terminal-tab"][data-session-id="${hiddenId}"]`),
  ).toHaveAttribute('data-visible', 'false');
  expect(terminalList(atlas.cli).find((s) => s.id === hiddenId)?.status).toBe('RUNNING');

  await page.getByRole('button', { name: 'Single pane' }).click();
  await expect(panes(page)).toHaveCount(1);
  expect(terminalList(atlas.cli).filter((s) => s.status === 'RUNNING')).toHaveLength(3);
});

test('keeps processes running across group switches and renderer reloads', async ({ atlas }) => {
  atlas.cli('project', 'add', atlas.workspace('nova'));
  atlas.cli('project', 'add', atlas.workspace('wii'));
  const { page } = await atlas.launch();

  await openTerminals(page);
  await createGroup(page, 'Desenvolvimento');
  await newTerminal(page, 'nova');
  const counter = panes(page).first();
  await run(page, counter, 'for i in $(seq 1 400); do echo "tick-$i"; sleep 0.1; done');
  await expect.poll(() => screenText(counter)).toContain('tick-3');

  await openTerminals(page, 'Ungrouped');
  await newTerminal(page, 'wii');
  await run(page, panes(page).first(), 'echo "wii-$((7 * 6))"');
  await expect.poll(() => screenText(panes(page).first())).toContain('wii-42');

  await openTerminals(page, 'Desenvolvimento');
  // The loop kept running while its group was hidden.
  await expect
    .poll(() => screenText(panes(page).first()), { timeout: 10_000 })
    .toMatch(/tick-(1\d|[2-9]\d)/);
  expect(await screenText(panes(page).first())).not.toContain('wii-42');

  const sessionsBefore = terminalList(atlas.cli);
  expect(sessionsBefore).toHaveLength(2);

  await page.reload();
  await openTerminals(page, 'Desenvolvimento');
  await expect(panes(page)).toHaveCount(1);
  await expect.poll(() => screenText(panes(page).first())).toMatch(/tick-\d+/);
  // Reloading reattached the existing PTYs instead of starting new ones.
  const sessionsAfter = terminalList(atlas.cli);
  expect(sessionsAfter.map((s) => [s.id, s.pid, s.status])).toEqual(
    sessionsBefore.map((s) => [s.id, s.pid, 'RUNNING']),
  );
});

test('supports copy and paste through the clipboard', async ({ atlas }) => {
  atlas.cli('project', 'add', atlas.workspace('nova'));
  const { app, page } = await atlas.launch();
  const original = await app.evaluate(({ clipboard }) => clipboard.readText());
  try {
    await openTerminals(page);
    await newTerminal(page);
    const pane = panes(page).first();
    await run(page, pane, 'clear; echo "copyme$((100 + 23))"');
    await expect.poll(() => screenText(pane)).toContain('copyme123');

    const row = pane.locator('.xterm-rows > div', { hasText: /^copyme123/ });
    const box = (await row.boundingBox())!;
    await page.mouse.dblclick(box.x + 15, box.y + box.height / 2);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.copy());
    await expect
      .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
      .toBe('copyme123');

    await app.evaluate(({ clipboard }) => clipboard.writeText('echo "pasted-$((5 * 5))"'));
    await pane.locator('.xterm-screen').click();
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.webContents.paste(),
    );
    await page.keyboard.press('Enter');
    await expect.poll(() => screenText(pane)).toContain('pasted-25');
  } finally {
    await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), original);
  }
});

test('searches and clears terminal output', async ({ atlas }) => {
  atlas.cli('project', 'add', atlas.workspace('nova'));
  const { app, page } = await atlas.launch();
  await openTerminals(page);
  await newTerminal(page, 'nova');
  const pane = panes(page).first();
  await run(page, pane, 'echo "needle-$((9 * 9))"');
  await expect.poll(() => screenText(pane)).toContain('needle-81');

  await atlas.menu(app, 'terminal.search');
  const search = page.getByRole('textbox', { name: 'Find in terminal' });
  await expect(search).toBeFocused();
  await search.fill('needle-81');
  await search.press('Enter');
  await expect(page.getByRole('search').getByRole('status')).toHaveText('');
  await search.fill('absent-term');
  await search.press('Enter');
  await expect(page.getByRole('search').getByRole('status')).toHaveText('No matches');
  await search.press('Escape');

  await atlas.menu(app, 'terminal.clear');
  await expect.poll(() => screenText(pane)).not.toContain('needle-81');
});

test('shows terminals opened and closed from the CLI', async ({ atlas }) => {
  const project = JSON.parse(atlas.cli('project', 'add', atlas.workspace('nova'), '--json')) as {
    project: { id: string };
  };
  const { page } = await atlas.launch();
  await openTerminals(page);

  const opened = JSON.parse(
    atlas.cli('terminal', 'open', '--project', project.project.id, '--title', 'From CLI', '--json'),
  ) as TerminalSession;
  await expect(tabs(page)).toHaveCount(1);
  await expect(tabs(page).first()).toContainText('From CLI');

  atlas.cli('terminal', 'close', opened.id, '--yes');
  await expect(tabs(page).first().getByTestId('terminal-status')).toHaveAttribute(
    'data-status',
    'TERMINATED',
  );
});

test('persists preferences, tab titles and layout across restarts', async ({ atlas }) => {
  atlas.cli('project', 'add', atlas.workspace('nova'));
  const first = await atlas.launch();
  let page = first.page;
  await openTerminals(page);
  await newTerminal(page, 'nova');
  await page.getByRole('button', { name: 'Split right' }).click();
  await expect(panes(page)).toHaveCount(2);
  await tabs(page).nth(0).getByRole('tab').dblclick();
  await page.getByRole('textbox', { name: 'Terminal name' }).fill('API');
  await page.keyboard.press('Enter');
  await atlas.menu(first.app, 'terminal.fontIncrease');
  await atlas.menu(first.app, 'terminal.fontIncrease');
  await page.getByRole('button', { name: 'Terminal settings' }).click();
  await expect(page.getByTestId('terminal-settings')).toContainText('Font size: 15px');
  await page.keyboard.press('Escape');
  const pids = terminalList(atlas.cli).map((s) => s.pid!);
  await page.waitForTimeout(500); // let the debounced layout save run
  await first.app.close();

  // Quitting terminated every shell.
  for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();

  const second = await atlas.launch();
  page = second.page;
  await openTerminals(page);
  await expect(tabs(page)).toHaveCount(2);
  await expect(tabs(page).nth(0)).toContainText('API');
  await expect(panes(page)).toHaveCount(2);
  // Previous sessions are shown as ended, never as running.
  await expect(panes(page).first().getByTestId('terminal-ended')).toContainText(
    'ended when ATLAS stopped',
  );
  await expect(page.getByTestId('terminal-status').first()).toHaveAttribute(
    'data-status',
    'TERMINATED',
  );
  await page.getByRole('button', { name: 'Terminal settings' }).click();
  await expect(page.getByTestId('terminal-settings')).toContainText('Font size: 15px');
  await page.keyboard.press('Escape');

  await panes(page).first().getByRole('button', { name: 'Restart' }).click();
  await expect(panes(page).first().getByTestId('terminal-status')).toHaveAttribute(
    'data-status',
    'RUNNING',
  );
  // The restarted terminal takes the place of the one it replaces.
  await expect(tabs(page).nth(0)).toContainText('API');
});

test('asks before quitting while terminals run', async ({ atlas }) => {
  atlas.cli('project', 'add', atlas.workspace('nova'));
  const { app, page } = await atlas.launch();
  await openTerminals(page);
  await newTerminal(page, 'nova');
  await expect(panes(page).first().getByTestId('terminal-status')).toHaveAttribute(
    'data-status',
    'RUNNING',
  );

  await atlas.stubMessageBox(app, 1); // Cancel
  await app.evaluate(({ app: electronApp }) => electronApp.quit());
  await page.waitForTimeout(500);
  expect(terminalList(atlas.cli)[0]?.status).toBe('RUNNING');
  await expect(panes(page)).toHaveCount(1);

  const pid = terminalList(atlas.cli)[0]!.pid!;
  await atlas.stubMessageBox(app, 0); // Quit
  await app.close();
  expect(() => process.kill(pid, 0)).toThrow();
});

test('documents shortcuts in the application menu', async ({ atlas }) => {
  const { app } = await atlas.launch();
  const accelerators = await app.evaluate(({ Menu }) =>
    Object.fromEntries(
      [
        'terminal.new',
        'terminal.close',
        'terminal.next',
        'terminal.previous',
        'terminal.splitRight',
        'terminal.splitDown',
        'terminal.focusNextPane',
        'terminal.search',
      ].map((id) => [id, Menu.getApplicationMenu()?.getMenuItemById(id)?.accelerator]),
    ),
  );
  for (const value of Object.values(accelerators)) expect(value).toBeTruthy();
  if (process.platform === 'darwin') {
    expect(accelerators['terminal.new']).toBe('Cmd+T');
    expect(accelerators['terminal.splitRight']).toBe('Cmd+D');
  }
});

test('closing the window on macOS keeps terminals and reattaches on reopen', async ({ atlas }) => {
  test.skip(process.platform !== 'darwin', 'Closing the last window quits on Windows and Linux.');
  atlas.cli('project', 'add', atlas.workspace('nova'));
  const { app, page } = await atlas.launch();
  await openTerminals(page);
  await newTerminal(page, 'nova');
  await run(page, panes(page).first(), 'echo "before-$((6 + 6))"');
  await expect.poll(() => screenText(panes(page).first())).toContain('before-12');

  // Collect main-process exceptions (regression: reading a destroyed webContents).
  await app.evaluate(() => {
    const errors: string[] = [];
    (globalThis as { __atlasErrors?: string[] }).__atlasErrors = errors;
    process.on('uncaughtException', (error) => errors.push(String(error)));
  });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
  await expect
    .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length))
    .toBe(0);
  expect(terminalList(atlas.cli)[0]?.status).toBe('RUNNING');

  const reopened = app.waitForEvent('window');
  await app.evaluate(({ app: electronApp }) => electronApp.emit('activate'));
  const next = await reopened;
  await openTerminals(next);
  await expect.poll(() => screenText(panes(next).first())).toContain('before-12');
  expect(
    await app.evaluate(() => (globalThis as { __atlasErrors?: string[] }).__atlasErrors),
  ).toEqual([]);
});
