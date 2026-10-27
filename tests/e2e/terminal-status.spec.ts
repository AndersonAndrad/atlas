import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, openProjectTerminal, test } from './fixtures';

const tabs = (page: Page) => page.getByTestId('terminal-tab');

/** Writes a lifecycle event exactly as the Claude Code wrapper does (PLAN-021). */
function wrapperEvent(
  dataDir: string,
  event: {
    kind: 'start' | 'end';
    run: string;
    terminalId: string;
    projectId: string;
    exitCode?: number | null;
  },
) {
  writeFileSync(
    path.join(dataDir, 'context', 'events', `${event.run}.${event.kind}.json`),
    JSON.stringify({
      event: event.kind,
      provider: 'claude',
      run: event.run,
      terminalId: event.terminalId,
      projectId: event.projectId,
      exitCode: event.kind === 'end' ? (event.exitCode ?? 0) : null,
      head: '',
    }),
  );
}

test('terminal tabs show AI work, keep results pending until reviewed, and survive a restart', async ({
  atlas,
}) => {
  const { project } = JSON.parse(atlas.cli('project', 'add', atlas.workspace('api'), '--json')) as {
    project: { id: string };
  };
  const first = await atlas.launch();
  let page = first.page;
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Terminals' })
    .click();
  await openProjectTerminal(page, 'api');
  await expect(tabs(page)).toHaveCount(1);
  const tab = tabs(page).first();
  const terminalId = (await tab.getAttribute('data-session-id'))!;
  const status = tab.getByTestId('terminal-status');

  // A live shell alone is neutral, never green.
  await expect(status).toHaveAttribute('data-status', 'RUNNING');
  await expect(status).toHaveAttribute('data-indicator', 'IDLE');

  wrapperEvent(atlas.dataDir, {
    kind: 'start',
    run: '20261027T120001-1001',
    terminalId,
    projectId: project.id,
  });
  await expect(status).toHaveAttribute('data-indicator', 'AI_RUNNING', { timeout: 10_000 });
  await expect(status).toContainText('Claude is running');

  wrapperEvent(atlas.dataDir, {
    kind: 'end',
    run: '20261027T120001-1001',
    terminalId,
    projectId: project.id,
  });
  await expect(status).toHaveAttribute('data-indicator', 'ATTENTION_REQUIRED', { timeout: 10_000 });
  await expect(status).toContainText('review pending');

  // Explicit review from the tab's context menu turns it green.
  await tab.getByRole('tab').click({ button: 'right' });
  await page
    .getByTestId('terminal-tab-menu')
    .getByRole('menuitem', { name: /Mark .* as reviewed/ })
    .click();
  await expect(status).toHaveAttribute('data-indicator', 'REVIEWED');

  // A failing run is red, and stays pending across a restart (the shell itself does not survive).
  wrapperEvent(atlas.dataDir, {
    kind: 'start',
    run: '20261027T120002-1002',
    terminalId,
    projectId: project.id,
  });
  wrapperEvent(atlas.dataDir, {
    kind: 'end',
    run: '20261027T120002-1002',
    terminalId,
    projectId: project.id,
    exitCode: 1,
  });
  await expect(status).toHaveAttribute('data-indicator', 'FAILED', { timeout: 10_000 });
  await expect(
    page.getByTestId('terminal-pane').first().getByTestId('mark-reviewed'),
  ).toBeVisible();

  await first.app.close();
  ({ page } = await atlas.launch());
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Terminals' })
    .click();
  const restored = tabs(page).first().getByTestId('terminal-status');
  await expect(restored).toHaveAttribute('data-indicator', 'DISCONNECTED', { timeout: 10_000 });
  await expect(restored).toHaveAttribute('data-pending-review', 'true');
  await expect(restored).toContainText('Claude failed (exit 1)');

  await page.getByTestId('terminal-pane').first().getByTestId('mark-reviewed').click();
  await expect(restored).toHaveAttribute('data-pending-review', 'false');
});
