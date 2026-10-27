import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

/** A clone tracking `origin/main` with `count` local commits not pushed yet. */
function cloneWithPending(root: string, name: string, count: number) {
  const home = path.join(root, 'home');
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: home };
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env });
  const origin = path.join(root, `${name}-origin.git`);
  const clone = path.join(root, 'workspaces', name);
  mkdirSync(path.dirname(clone), { recursive: true });
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'clone', '-q', origin, clone);
  git(clone, 'config', 'user.name', 'Ana Dev');
  git(clone, 'config', 'user.email', 'ana@example.com');
  git(clone, 'commit', '-q', '--allow-empty', '-m', 'chore: initial');
  git(clone, 'push', '-q', 'origin', 'HEAD:main');
  git(clone, 'branch', '-q', '-u', 'origin/main');
  for (let index = 1; index <= count; index += 1) {
    writeFileSync(path.join(clone, `file-${index}.txt`), `${index}\n`);
    git(clone, 'add', '.');
    git(clone, 'commit', '-q', '-m', `feat: change ${index}`);
  }
  return { clone, git };
}

async function openTerminals(page: Page) {
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Terminals' })
    .click();
}

test('pending push lists unpushed commits, shows details and pushes after confirmation', async ({
  atlas,
}) => {
  const { clone, git } = cloneWithPending(atlas.root, 'web', 3);
  atlas.cli('project', 'add', clone);
  const plain = atlas.workspace('local-only');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: plain });
  execFileSync(
    'git',
    [
      '-c',
      'user.name=A',
      '-c',
      'user.email=a@example.com',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'x',
    ],
    { cwd: plain, env: { ...process.env, HOME: path.join(atlas.root, 'home') } },
  );
  atlas.cli('project', 'add', plain);
  const { page } = await atlas.launch();
  await openTerminals(page);

  const section = page.getByTestId('pending-push');
  const web = section.getByTestId('pending-push-project').filter({ hasText: 'web' });
  await expect(web.getByTestId('pending-commit')).toHaveCount(3, { timeout: 15_000 });
  await expect(section.getByTestId('pending-push-total')).toHaveText('3');
  await expect(web.getByTestId('pending-push-route')).toHaveText('main → origin/main');
  await expect(web.getByTestId('pending-commit').first()).toContainText('feat: change 3');
  await expect(web.getByTestId('pending-commit').first()).toContainText('Ana Dev');

  // A repository without upstream is not shown as pushed.
  const local = section.getByTestId('pending-push-project').filter({ hasText: 'local-only' });
  await expect(local).toHaveAttribute('data-state', 'no-upstream');
  await local.getByRole('button', { name: 'local-only: Upstream not configured' }).click();
  await expect(local.getByTestId('pending-push-unknown')).toContainText('Upstream not configured');

  // Commit details reuse the commit files panel.
  await web.getByTestId('pending-commit').first().click();
  const details = page.getByTestId('pending-commit-details');
  await expect(details.getByTestId('git-commit-file')).toHaveCount(1);
  await expect(details.getByTestId('git-commit-file')).toContainText('file-3.txt');
  await page.keyboard.press('Escape');

  // Push asks first and shows the destination.
  await web.getByRole('button', { name: 'Push web' }).click();
  const dialog = page.getByTestId('push-dialog');
  await expect(dialog.getByTestId('git-route')).toContainText('origin/main');
  await expect(dialog.getByTestId('push-ahead')).toHaveText('3 commits to push.');
  await dialog.getByRole('button', { name: 'Push', exact: true }).click();
  await expect(dialog).toHaveCount(0, { timeout: 15_000 });
  await expect(web).toHaveCount(0, { timeout: 15_000 });
  await expect(section.getByTestId('pending-push-up-to-date')).toContainText(
    '1 project up to date',
  );
  expect(git(clone, 'status', '-sb').toString()).not.toContain('ahead');
});
