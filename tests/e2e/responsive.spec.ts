import { expect, test } from './fixtures';

const VIEWPORTS = [
  { width: 380, height: 700 },
  { width: 760, height: 800 },
  { width: 1000, height: 800 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
];

test('layout has no horizontal overflow across window sizes', async ({ atlas }) => {
  atlas.cli(
    'project',
    'add',
    atlas.workspace('a-project-with-a-rather-long-directory-name-to-test-wrapping', {
      git: 'main',
    }),
    '--description',
    'A long description '.repeat(10),
  );
  const { app, page } = await atlas.launch();
  await page.getByTestId('project-card').click();

  for (const size of VIEWPORTS) {
    await app.evaluate(({ BrowserWindow }, s) => {
      BrowserWindow.getAllWindows()[0]!.setContentSize(s.width, s.height);
    }, size);
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(size.width);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `horizontal overflow at ${size.width}px`).toBeLessThanOrEqual(0);
    await expect(page.getByTestId('project-details')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add project' })).toBeVisible();
  }
});
