import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

/** A repository with one commit, one modified and one untracked file (no upstream). */
function dirtyRepository(dir: string, home: string) {
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: home };
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, env });
  git('init', '-q', '-b', 'main');
  git('-c', 'user.name=Ana Dev', '-c', 'user.email=ana@example.com', 'add', '.');
  git('-c', 'user.name=Ana Dev', '-c', 'user.email=ana@example.com', 'commit', '-qm', 'init');
  writeFileSync(path.join(dir, 'README.md'), '# changed\n');
  writeFileSync(path.join(dir, 'notes.txt'), 'new\n');
}

const sidebarBadge = (page: Page, name: string) =>
  page.getByTestId('sidebar-project').filter({ hasText: name }).getByTestId('project-git-badge');

async function openTerminals(page: Page) {
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Terminals' })
    .click();
}

test('project badges follow monitoring, paused projects keep a cached status and refresh on request', async ({
  atlas,
}) => {
  const repo = atlas.workspace('repo');
  dirtyRepository(repo, path.join(atlas.root, 'home'));
  atlas.cli('project', 'add', repo);
  atlas.cli('project', 'add', atlas.workspace('plain'));
  const first = await atlas.launch();
  let { page } = first;

  // Monitored by default (migration and new-project default): live attention badge.
  const card = page.getByTestId('project-card').filter({ hasText: 'repo' });
  const cardBadge = card.getByTestId('project-git-badge');
  await expect(cardBadge).toHaveAttribute('data-state', 'attention', { timeout: 15_000 });
  await expect(cardBadge).toHaveAttribute('data-freshness', 'live');
  await expect(cardBadge.getByTestId('git-changes-count')).toHaveText('2');
  await expect(cardBadge).toHaveAccessibleName(/Needs attention: 2 changed files to commit/);
  await expect(
    page.getByTestId('project-card').filter({ hasText: 'plain' }).getByTestId('project-git-badge'),
  ).toHaveAttribute('data-state', 'unknown', { timeout: 15_000 });

  // Pausing keeps the last status, marked as cached.
  await card.click();
  const details = page.getByTestId('git-details');
  await expect(details.getByTestId('git-freshness')).toHaveText('Live');
  await details.getByRole('checkbox', { name: 'Monitor Git status automatically' }).click();
  await expect(details.getByTestId('git-freshness')).toHaveText('Cached');
  await expect(cardBadge).toHaveAttribute('data-freshness', 'cached');
  await expect(cardBadge.getByTestId('git-changes-count')).toHaveText('2');
  await expect(cardBadge).toHaveAccessibleName(/Cached, updated .* Monitoring paused\./);

  // No background check while paused: a new file is not seen until an explicit refresh.
  writeFileSync(path.join(repo, 'more.txt'), 'more\n');
  await openTerminals(page);
  const badge = sidebarBadge(page, 'repo');
  await expect(badge).toHaveAttribute('data-freshness', 'cached');
  await page.waitForTimeout(2_000);
  await expect(badge.getByTestId('git-changes-count')).toHaveText('2');

  await page.getByRole('button', { name: 'Project actions for repo' }).click();
  const menu = page.getByTestId('project-actions-menu');
  await menu.getByRole('menuitem', { name: 'Refresh Git status' }).click();
  await expect(badge.getByTestId('git-changes-count')).toHaveText('3');
  // The preference did not change.
  await expect(menu.getByRole('menuitem', { name: 'Resume Git monitoring' })).toBeVisible();
  await expect(badge).toHaveAttribute('data-freshness', 'cached');
  await page.keyboard.press('Escape');

  // The snapshot survives a restart without any Git check for the paused project.
  await first.app.close();
  ({ page } = await atlas.launch());
  await openTerminals(page);
  const restored = sidebarBadge(page, 'repo');
  await expect(restored).toHaveAttribute('data-freshness', 'cached', { timeout: 15_000 });
  await expect(restored.getByTestId('git-changes-count')).toHaveText('3');

  // Resuming from the menu makes it live again.
  await page.getByRole('button', { name: 'Project actions for repo' }).click();
  await page
    .getByTestId('project-actions-menu')
    .getByRole('menuitem', { name: 'Resume Git monitoring' })
    .click();
  await expect(restored).toHaveAttribute('data-freshness', 'live', { timeout: 15_000 });
});

test('the new-project default can turn monitoring off for projects registered later', async ({
  atlas,
}) => {
  const { page } = await atlas.launch();
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Settings' })
    .click();
  const option = page.getByRole('checkbox', {
    name: 'Monitor the Git status of new projects automatically',
  });
  await expect(option).toBeChecked();
  await option.click();
  await expect(page.getByTestId('git-preferences-status')).toHaveText('Saved.');

  const later = atlas.workspace('later');
  dirtyRepository(later, path.join(atlas.root, 'home'));
  atlas.cli('project', 'add', later);
  await page.reload();
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Projects' })
    .click();
  await page.getByTestId('project-card').filter({ hasText: 'later' }).click();
  const details = page.getByTestId('git-details');
  await expect(
    details.getByRole('checkbox', { name: 'Monitor Git status automatically' }),
  ).not.toBeChecked();
  await expect(details.getByTestId('git-freshness')).toHaveText('No data yet');
  await expect(details.getByTestId('git-last-refresh')).toHaveText('Never refreshed');

  await details.getByRole('button', { name: 'Refresh Git status' }).click();
  await expect(details.getByTestId('git-freshness')).toHaveText('Cached');
  await expect(details.getByTestId('git-changes')).toContainText('Untracked: 1');
});
