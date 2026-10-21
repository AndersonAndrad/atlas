import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

async function navigate(page: Page, name: string) {
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name, exact: true })
    .click();
}

test('imports a reviewed skill, applies it to context and synchronizes it to Codex (SDD-006 B)', async ({
  atlas,
}) => {
  const home = path.join(atlas.root, 'home');
  const skill = path.join(home, '.claude', 'skills', 'review-helper');
  mkdirSync(path.join(skill, 'scripts'), { recursive: true });
  writeFileSync(
    path.join(skill, 'SKILL.md'),
    '---\nname: review-helper\ndescription: Reviews diffs before commits.\nallowed-tools: Bash(git diff *)\n---\n# Review helper\n',
  );
  writeFileSync(path.join(skill, 'scripts', 'check.sh'), '#!/bin/sh\necho checked\n');
  chmodSync(path.join(skill, 'scripts', 'check.sh'), 0o755);
  const dir = atlas.workspace('api');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  atlas.cli('project', 'add', dir);

  const { app, page } = await atlas.launch();
  await navigate(page, 'Skills');
  await expect(page.getByTestId('skills-empty')).toBeVisible();

  // Nothing is read until the folder is added as a source.
  await page.getByRole('tab', { name: 'Available' }).click();
  await expect(page.getByTestId('skill-discovered')).toHaveCount(0);
  await page
    .getByTestId('skill-suggestion')
    .filter({ hasText: path.join(home, '.claude', 'skills') })
    .getByRole('button', { name: 'Add' })
    .click();
  const found = page.getByTestId('skill-discovered');
  await expect(found).toHaveAttribute('data-status', 'new');
  await found.getByRole('button', { name: 'Review' }).click();

  const review = page.getByTestId('skill-import-dialog');
  await expect(review.getByTestId('skill-import-name')).toContainText('review-helper');
  await expect(review.getByTestId('skill-import-scripts')).toContainText('scripts/check.sh');
  await expect(review.getByTestId('skill-import-permissions')).toContainText('Bash(git diff *)');
  await expect(review.getByRole('button', { name: 'Import' })).toBeDisabled();
  await review.getByTestId('skill-import-reviewed').click();
  await review.getByRole('button', { name: 'Import' }).click();
  await expect(review).toBeHidden();

  const details = page.getByTestId('skill-details');
  await expect(details).toContainText('review-helper');
  await expect(details).toContainText('Codex: partial');
  await details.getByTestId('skill-enabled').click();
  await expect(page.getByTestId('skill-item').first()).toContainText('Enabled');
  // The original folder is untouched.
  expect(readFileSync(path.join(skill, 'SKILL.md'), 'utf8')).toContain('# Review helper');

  // Enabled skills appear in the context preview, listed by file path.
  await navigate(page, 'Context');
  await page.getByRole('button', { name: 'Preview context' }).click();
  await expect(page.getByTestId('context-skill')).toContainText('review-helper');
  await page.keyboard.press('Escape');

  // Synchronize to Codex's documented user folder, then roll back.
  await navigate(page, 'Skills');
  await page.getByRole('tab', { name: 'Sync' }).click();
  const codex = page.getByTestId('skill-sync-codex');
  const target = path.join(home, '.agents', 'skills');
  await codex.getByRole('combobox', { name: 'Codex skills folder' }).click();
  await page
    .getByRole('option', { name: new RegExp(target.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')) })
    .click();
  await codex.getByRole('button', { name: 'Preview' }).click();
  await expect(codex.getByTestId('skill-sync-item')).toHaveAttribute('data-action', 'create');
  await codex.getByRole('button', { name: /Apply/ }).click();
  await expect(page.getByTestId('skill-sync-notice')).toContainText('1 change(s) written to Codex');
  const written = path.join(target, 'review-helper');
  expect(readFileSync(path.join(written, 'SKILL.md'), 'utf8')).toContain('# Review helper');
  expect(JSON.parse(readFileSync(path.join(written, '.atlas-managed.json'), 'utf8'))).toMatchObject(
    {
      managedBy: 'atlas',
    },
  );
  await codex.getByRole('button', { name: /Roll back last sync/ }).click();
  await expect(page.getByTestId('skill-sync-notice')).toContainText('Rolled back 1 folder(s)');
  expect(existsSync(written)).toBe(false);

  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]!.setContentSize(380, 700);
  });
  await page.getByRole('tab', { name: 'Installed' }).click();
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(380);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, 'skills view overflow at 380px').toBeLessThanOrEqual(0);
});
