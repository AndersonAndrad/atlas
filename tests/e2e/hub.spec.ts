import type { Page } from '@playwright/test';
import { expect, openProjectTerminal, test } from './fixtures';

const openHub = (page: Page) =>
  page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Project Hub' })
    .click();

const notesTab = (page: Page) =>
  page.getByRole('navigation', { name: 'Project Hub sections' }).getByRole('button', {
    name: 'Notes',
  });

async function createNote(page: Page, title: string, content: string) {
  await page.getByTestId('notes-panel').getByRole('button', { name: 'New note' }).click();
  const editor = page.getByTestId('note-editor');
  // The new note replaces the open one; wait for it before typing.
  await expect(editor.getByLabel('Note title')).toHaveValue('Untitled note');
  await editor.getByLabel('Note title').fill(title);
  await editor.getByLabel('Note content (Markdown)').fill(content);
  await editor.getByRole('button', { name: 'Save' }).click();
  await expect(editor.getByRole('button', { name: 'Saved' })).toBeDisabled();
}

test('keeps project notes after a restart (SDD-010 Scenario A)', async ({ atlas }) => {
  atlas.cli('project', 'add', atlas.workspace('payments'));
  const first = await atlas.launch();
  let page = first.page;
  await page.getByTestId('project-card').filter({ hasText: 'payments' }).click();

  await openHub(page);
  await expect(page.getByRole('combobox', { name: 'Project' })).toHaveText('payments');
  await notesTab(page).click();
  await createNote(
    page,
    'Implementation decisions',
    '# Tariff engine\n\n- [x] Use SQLite FTS5\n- [ ] Review rules\n\n| Rule | Owner |\n| - | - |\n| Fees | Ana |\n\n<script>window.hacked = true</script>\n\n[bad](javascript:alert(1))',
  );
  const preview = page.getByTestId('note-preview');
  await expect(preview.getByRole('heading', { name: 'Tariff engine' })).toBeVisible();
  await expect(preview.getByRole('table')).toBeVisible();
  await expect(preview.locator('script, a[href^="javascript"]')).toHaveCount(0);
  expect(await page.evaluate(() => (window as { hacked?: boolean }).hacked)).toBeUndefined();
  await first.app.close();

  page = (await atlas.launch()).page;
  await openHub(page);
  await expect(page.getByTestId('hub-notes-count')).toContainText('1');
  await page
    .getByRole('region', { name: 'Recent notes' })
    .getByRole('button', { name: /Implementation decisions/ })
    .click();
  await expect(page.getByTestId('note-editor').getByLabel('Note title')).toHaveValue(
    'Implementation decisions',
  );
  await expect(page.getByTestId('note-editor').getByLabel('Note content (Markdown)')).toHaveValue(
    /Use SQLite FTS5/,
  );
});

test('searches, pins, archives and keeps global notes apart', async ({ atlas }) => {
  atlas.cli('project', 'add', atlas.workspace('billing'));
  const { page } = await atlas.launch();
  await page.getByTestId('project-card').filter({ hasText: 'billing' }).click();
  await openHub(page);
  await notesTab(page).click();
  await createNote(page, 'FitBank integration', 'Webhook retries and idempotency keys');
  await createNote(page, 'Security review', 'Checklist for the release');

  const list = page.getByTestId('note-list');
  await page.getByLabel('Search notes').fill('webhook');
  await expect(list.getByRole('button')).toHaveCount(1);
  await expect(list).toContainText('FitBank integration');
  await page.getByLabel('Search notes').fill('');
  await expect(list.getByRole('button')).toHaveCount(2);

  // Pin the open note (Security review), then archive it.
  const editor = page.getByTestId('note-editor');
  await editor.getByRole('button', { name: 'Pin note' }).click();
  await expect(editor.getByRole('button', { name: 'Unpin note' })).toBeVisible();
  await page
    .getByRole('group', { name: 'Show' })
    .getByRole('button', { name: /Pinned/ })
    .click();
  await expect(list.getByRole('button')).toHaveCount(1);
  await editor.getByRole('button', { name: 'More note actions' }).click();
  await page.getByRole('menuitem', { name: 'Archive' }).click();
  await expect(list.getByRole('button')).toHaveCount(0);
  await page
    .getByRole('group', { name: 'Show' })
    .getByRole('button', { name: /Archived/ })
    .click();
  await expect(list).toContainText('Security review');

  // Global notes are separate from the project's.
  await page.getByRole('combobox', { name: 'Project' }).click();
  await page.getByRole('option', { name: 'Global notes' }).click();
  await notesTab(page).click();
  await expect(page.getByTestId('note-list')).toContainText('No notes yet');
  await createNote(page, 'Shell shortcuts', 'Ctrl+R');
  await page.getByRole('combobox', { name: 'Project' }).click();
  await page.getByRole('option', { name: 'All notes' }).click();
  await notesTab(page).click();
  await expect(page.getByTestId('note-list').getByRole('button')).toHaveCount(2);
});

test('Project Hub leaves terminals working', async ({ atlas }) => {
  atlas.cli('project', 'add', atlas.workspace('shell-check'));
  const { page } = await atlas.launch();
  await openHub(page);
  await expect(page.getByTestId('hub-overview')).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Terminals' })
    .click();
  await openProjectTerminal(page, 'shell-check');
  const pane = page.getByTestId('terminal-pane');
  await expect
    .poll(() => pane.locator('.xterm-rows').innerText(), { timeout: 15_000 })
    .toMatch(/\$\s*$/m);
  await pane.locator('.xterm-screen').click();
  await page.keyboard.type('echo hub-$((20+22))');
  await page.keyboard.press('Enter');
  await expect(pane.locator('.xterm-rows')).toContainText('hub-42');
});

test('never overwrites a note changed elsewhere without asking (FR-1008)', async ({ atlas }) => {
  const { page } = await atlas.launch();
  await openHub(page);
  await notesTab(page).click();
  await createNote(page, 'Shared', 'first');
  const editor = page.getByTestId('note-editor');
  await editor.getByLabel('Note content (Markdown)').fill('mine');

  // Another client saves the same note.
  await page.evaluate(async () => {
    const notes = (
      window as unknown as {
        atlas: {
          notes: {
            list(q: unknown): Promise<{ data: { notes: { id: string; revision: number }[] } }>;
            update(id: string, input: unknown): Promise<unknown>;
          };
        };
      }
    ).atlas.notes;
    const [note] = (await notes.list({ scope: { kind: 'all' } })).data.notes;
    await notes.update(note!.id, { expectedRevision: note!.revision, content: 'theirs' });
  });
  await expect(page.getByTestId('note-conflict')).toContainText('changed elsewhere');
  await editor.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('note-conflict')).toContainText('Your edits are not saved');

  await page.getByRole('button', { name: 'Reload (discard my edits)' }).click();
  await expect(editor.getByLabel('Note content (Markdown)')).toHaveValue('theirs');
  await expect(page.getByTestId('note-conflict')).toBeHidden();
});

test('Project Hub fits narrow and wide windows', async ({ atlas }) => {
  atlas.cli('project', 'add', atlas.workspace('a-project-with-a-rather-long-directory-name'));
  const { app, page } = await atlas.launch();
  await openHub(page);
  await notesTab(page).click();
  await createNote(
    page,
    `A long title ${'x'.repeat(150)}`,
    `| ${'wide '.repeat(60)} |\n| - |\n| y |`,
  );

  for (const width of [380, 760, 1000, 1440]) {
    await app.evaluate(({ BrowserWindow }, w) => {
      BrowserWindow.getAllWindows()[0]!.setContentSize(w, 800);
    }, width);
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `horizontal overflow at ${width}px`).toBeLessThanOrEqual(0);
    await expect(page.getByTestId('note-editor').getByLabel('Note title')).toBeVisible();
  }
  // Narrow windows show the editor alone; Back returns to the list.
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]!.setContentSize(380, 800);
  });
  await page.getByRole('button', { name: 'Back to notes' }).click();
  await expect(page.getByTestId('note-list')).toBeVisible();
  await expect(page.getByTestId('note-editor')).toBeHidden();
});
