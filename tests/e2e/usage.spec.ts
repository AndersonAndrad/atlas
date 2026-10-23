import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';

// Provider CLIs are fakes on the app's PATH; no real account is contacted.

const localDate = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

/** A fake `codex app-server` answering the three account requests ATLAS makes. */
function fakeCodex(binDir: string) {
  const inTwoHours = Math.floor(Date.now() / 1000) + 2 * 3600;
  const inFiveDays = Math.floor(Date.now() / 1000) + 5 * 86400;
  writeFileSync(
    path.join(binDir, 'codex'),
    `#!/usr/bin/env node
const rl = require('node:readline').createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
rl.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') send({ id: m.id, result: {} });
  if (m.method === 'account/read') send({ id: m.id, result: { account: { type: 'chatgpt', planType: 'plus' } } });
  if (m.method === 'account/rateLimits/read') send({ id: m.id, result: { rateLimits: {
    primary: { usedPercent: 22, windowDurationMins: 300, resetsAt: ${inTwoHours} },
    secondary: { usedPercent: 61, windowDurationMins: 10080, resetsAt: ${inFiveDays} } } } });
  if (m.method === 'account/usage/read') send({ id: m.id, result: { dailyUsageBuckets: [
    { startDate: '${localDate(new Date(Date.now() - 86400000))}', tokens: 1200000 },
    { startDate: '${localDate(new Date())}', tokens: 300000 }] } });
});
`,
  );
  chmodSync(path.join(binDir, 'codex'), 0o755);
  writeFileSync(
    path.join(binDir, 'claude'),
    `#!/bin/sh\nprintf '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}'\n`,
  );
  chmodSync(path.join(binDir, 'claude'), 0o755);
}

/** What the ATLAS status line saves during a Claude Code session in an ATLAS terminal. */
function claudeSession(dataDir: string, configDir: string) {
  const run = path.join(dataDir, 'usage', 'claude', '20261023T120000-42');
  mkdirSync(run, { recursive: true });
  writeFileSync(path.join(run, 'config-dir'), `${configDir}\n`);
  const now = Math.floor(Date.now() / 1000);
  writeFileSync(
    path.join(run, 'status.json'),
    JSON.stringify({
      session_id: 'e2e',
      cwd: '/private/path',
      cost: { total_cost_usd: 0.42, total_api_duration_ms: 12 * 60_000 },
      rate_limits: {
        five_hour: { used_percentage: 31, resets_at: now + 3600 },
        seven_day: { used_percentage: 72, resets_at: now + 3 * 86400 },
      },
    }),
  );
}

async function openUsage(page: Page) {
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Usage' })
    .click();
  await expect(page.getByTestId('usage-view')).toBeVisible();
}

const card = (page: Page, name: string) =>
  page.getByTestId('usage-profile').filter({
    has: page.getByTestId('usage-profile-name').getByText(name, { exact: true }),
  });
const meter = (profile: Locator, label: string) =>
  profile.getByTestId('limit-meter').filter({ hasText: label });

test('shows the session and weekly limits of each account side by side', async ({ atlas }) => {
  const home = path.join(atlas.root, 'home');
  mkdirSync(path.join(home, '.claude-my'), { recursive: true });
  mkdirSync(path.join(home, '.codex-work'), { recursive: true });
  fakeCodex(atlas.binDir);
  claudeSession(atlas.dataDir, path.join(home, '.claude-my'));

  const { app, page } = await atlas.launch();
  await openUsage(page);

  const claude = card(page, 'my');
  await expect(meter(claude, 'Current session (5h)').getByTestId('limit-value')).toHaveText('31%');
  await expect(meter(claude, 'Weekly').getByTestId('limit-value')).toHaveText('72%');
  // 72% is high: an icon and a label accompany the color.
  await expect(meter(claude, 'Weekly')).toContainText('High');
  await expect(claude).toContainText('activity counts only sessions started in ATLAS');
  await expect(claude.getByRole('meter', { name: 'Weekly used' })).toHaveAttribute(
    'aria-valuenow',
    '72',
  );

  const codex = card(page, 'work');
  await expect(meter(codex, 'Current session (5h)').getByTestId('limit-value')).toHaveText('22%');
  await expect(meter(codex, 'Weekly').getByTestId('limit-value')).toHaveText('61%');
  await expect(codex).toContainText('plus');
  await expect(meter(codex, 'Weekly')).toContainText('Provider-reported');

  const history = page.getByTestId('usage-history').filter({ hasText: 'whole account' });
  await expect(history.getByTestId('daily-usage-bar')).toHaveCount(2);
  await expect(history.getByTestId('usage-weekly')).toContainText('tokens');
  const claudeHistory = page
    .getByTestId('usage-history')
    .filter({ hasText: 'ATLAS sessions only' });
  await expect(claudeHistory.getByTestId('usage-weekly')).toContainText('Estimated');

  // Rename and hide a profile.
  await codex.getByRole('button', { name: 'Actions for work' }).click();
  await page.getByRole('menuitem', { name: 'Rename…' }).click();
  await page.getByRole('dialog').getByLabel('Name').fill('Codex Work');
  await page.getByRole('button', { name: 'Save' }).click();
  const renamed = card(page, 'Codex Work');
  await expect(renamed).toBeVisible();
  await renamed.getByRole('button', { name: 'Actions for Codex Work' }).click();
  await page.getByRole('menuitem', { name: 'Hide' }).click();
  await expect(renamed).toHaveCount(0);
  await page.getByRole('button', { name: 'Show hidden (1)' }).click();
  await expect(renamed).toBeVisible();

  // Add a configuration folder chosen in the picker; it has no limits yet.
  const team = atlas.workspace('team-config');
  await atlas.stubDirectoryPicker(app, team);
  await page.getByRole('button', { name: 'Add profile' }).click();
  await page.getByRole('menuitem', { name: 'Claude Code configuration folder…' }).click();
  const added = card(page, 'team-config');
  await expect(added.getByTestId('usage-no-limits')).toContainText('N/A');
  await expect(added.getByTestId('usage-no-limits')).toContainText('first answer');

  // Removing an added profile asks first; its provider folder stays.
  await added.getByRole('button', { name: 'Actions for team-config' }).click();
  await page.getByRole('menuitem', { name: 'Remove from ATLAS' }).click();
  await expect(page.getByRole('alertdialog')).toContainText('are not touched');
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(added).toHaveCount(0);
});

test('explains where profiles come from when there are none', async ({ atlas }) => {
  const { page } = await atlas.launch();
  await openUsage(page);
  await expect(page.getByTestId('usage-empty')).toContainText('~/.claude-work');
});
