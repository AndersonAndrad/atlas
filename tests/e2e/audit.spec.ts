import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, projectActions, test } from './fixtures';

const CLAUDE_HELP =
  '--restricted --tools --allowedTools --permission-mode dontAsk --strict-mcp-config --no-session-persistence --output-format --json-schema';
const CODEX_HELP = '--sandbox read-only --ephemeral --json --output-schema --output-last-message';

const REPORT = {
  summary: 'Two issues found.',
  findings: [
    {
      title: 'Token compared without constant time',
      category: 'security',
      severity: 'HIGH',
      confidence: 'MEDIUM',
      kind: 'observation',
      description: 'The token is compared with ===.',
      evidence: 'The comparison is in check().',
      excerpt: 'return token === secret;',
      locations: [{ path: 'src/auth.ts', startLine: 2, endLine: 2, symbol: 'check' }],
      impact: 'Timing differences may leak the secret.',
      recommendation: 'Use a constant-time comparison.',
      suggestedTaskTitle: 'Compare tokens in constant time',
      acceptanceCriteria: ['Tokens are compared with timingSafeEqual'],
      effort: 'small',
    },
    {
      title: 'Missing retry policy',
      category: 'reliability',
      severity: 'LOW',
      confidence: 'LOW',
      kind: 'hypothesis',
      description: 'Network calls may fail without retry.',
      evidence: 'No retry wrapper was seen.',
      excerpt: null,
      locations: [{ path: 'src/missing.ts', startLine: 10, endLine: null, symbol: null }],
      impact: 'Transient failures.',
      recommendation: 'Add retries.',
      suggestedTaskTitle: 'Add retries',
      acceptanceCriteria: [],
      effort: null,
    },
  ],
};

/**
 * A fake `claude` for audits: answers `--help` with the read-only options and, when run,
 * records its arguments and standard input, then prints `result` (a Claude Code JSON
 * result) or exits with `exitCode`.
 */
function fakeClaude(binDir: string, root: string, result: object | null, exitCode = 0) {
  const args = path.join(root, 'claude-args.txt');
  const stdin = path.join(root, 'claude-stdin.txt');
  const file = path.join(binDir, 'claude');
  writeFileSync(
    file,
    `#!/bin/sh
case "$*" in "--help") printf '%s\\n' '${CLAUDE_HELP}'; exit 0 ;; esac
printf '%s\\n' "$@" > "${args}"
cat > "${stdin}"
${result === null ? '' : `printf '%s' '${JSON.stringify(result)}'`}
exit ${exitCode}
`,
  );
  chmodSync(file, 0o755);
  return { args, stdin };
}

function fakeCodex(binDir: string) {
  const file = path.join(binDir, 'codex');
  writeFileSync(
    file,
    `#!/bin/sh
case "$*" in "exec --help") printf '%s\\n' '${CODEX_HELP}'; exit 0 ;; esac
exit 1
`,
  );
  chmodSync(file, 0o755);
}

function project(atlas: { workspace(name: string): string; cli(...args: string[]): string }) {
  const dir = atlas.workspace('shop');
  mkdirSync(path.join(dir, 'src'));
  writeFileSync(
    path.join(dir, 'src', 'auth.ts'),
    'export function check(token: string, secret: string) {\n  return token === secret;\n}\n',
  );
  atlas.cli('project', 'add', dir);
  return dir;
}

/** "Analyze project…" from the Projects drawer opens the dialog in the Hub's Audits. */
async function openAnalyzeDialog(page: Page) {
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Terminals', exact: true })
    .click();
  const actions = await projectActions(page, 'shop');
  await actions.getByRole('button', { name: 'Analyze project…' }).click();
  const dialog = page.getByTestId('analyze-project-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('hub-audits')).toBeVisible();
  return dialog;
}

test('audits a project read-only and shows validated findings', async ({ atlas }) => {
  const dir = project(atlas);
  const fake = fakeClaude(atlas.binDir, atlas.root, {
    type: 'result',
    subtype: 'success',
    is_error: false,
    structured_output: REPORT,
    total_cost_usd: 0.04,
    usage: { input_tokens: 1200, output_tokens: 300 },
  });
  const before = readFileSync(path.join(dir, 'src', 'auth.ts'), 'utf8');
  const { page } = await atlas.launch();
  const dialog = await openAnalyzeDialog(page);

  // Codex is not installed; Claude Code is chosen with the default categories.
  const providers = dialog.getByTestId('audit-provider');
  await expect(providers.filter({ hasText: 'Codex' }).getByRole('radio')).toBeDisabled();
  await expect(providers.filter({ hasText: 'Claude Code' }).getByRole('radio')).toBeChecked();
  await expect(
    dialog.getByRole('checkbox', { name: 'Security and potential vulnerabilities' }),
  ).toBeChecked();
  await expect(
    dialog.getByRole('checkbox', { name: 'Performance and resource usage' }),
  ).not.toBeChecked();
  await expect(dialog.getByTestId('audit-read-only')).toContainText('no commands');
  // Nothing ran before the confirmation.
  expect(existsSync(fake.stdin)).toBe(false);
  await dialog.getByRole('button', { name: 'Start audit' }).click();
  await expect(dialog).toBeHidden();

  const details = page.getByTestId('audit-details');
  await expect(details.getByTestId('audit-status')).toHaveText('Completed · 2 finding(s)', {
    timeout: 20_000,
  });
  await expect(details.getByTestId('audit-summary')).toHaveText('Two issues found.');
  await expect(details.getByTestId('audit-metrics')).toContainText('input tokens');
  await expect(details.getByTestId('audit-metrics')).toContainText('provider estimate');
  const findings = details.getByTestId('audit-finding');
  await expect(findings).toHaveCount(2);
  // Ordered by severity; the evidence of the first exists, the second points at nothing.
  await expect(findings.nth(0).getByTestId('audit-finding-validation')).toHaveText(
    'Evidence located',
  );
  await expect(findings.nth(1).getByTestId('audit-finding-validation')).toHaveText(
    'Evidence not found',
  );
  await findings.nth(1).locator('summary').click();
  await expect(findings.nth(1)).toContainText('Hypothesis (not confirmed)');
  await expect(findings.nth(1)).toContainText('"src/missing.ts" was not found in the project.');

  // The CLI ran restricted, with the prompt on standard input; no file changed.
  const args = readFileSync(fake.args, 'utf8').split('\n');
  expect(args).toEqual(expect.arrayContaining(['-p', '--restricted', 'Read,Grep,Glob', 'dontAsk']));
  expect(readFileSync(fake.stdin, 'utf8')).toContain('read-only code audit of the project "shop"');
  expect(readFileSync(path.join(dir, 'src', 'auth.ts'), 'utf8')).toBe(before);
  await expect(page.getByTestId('audit-workspace-check')).toContainText('Not a Git repository');

  // The evidence opens in the code editor.
  await findings.nth(0).locator('summary').click();
  await findings.nth(0).getByTestId('audit-finding-open').click();
  await expect(page.locator('[data-testid="editor-tab"][data-tab-path="src/auth.ts"]')).toBeVisible(
    {
      timeout: 20_000,
    },
  );
});

test('asks to acknowledge the Codex warning and reports provider failures', async ({ atlas }) => {
  project(atlas);
  fakeCodex(atlas.binDir);
  fakeClaude(atlas.binDir, atlas.root, null, 2);
  const { page } = await atlas.launch();
  const dialog = await openAnalyzeDialog(page);

  await dialog
    .getByTestId('audit-provider')
    .filter({ hasText: 'Codex' })
    .getByRole('radio')
    .check();
  await expect(dialog.getByTestId('audit-warnings')).toContainText('may run commands');
  const start = dialog.getByRole('button', { name: 'Start audit' });
  await expect(start).toBeDisabled();
  await dialog.getByTestId('audit-warnings').getByRole('checkbox').check();
  await expect(start).toBeEnabled();

  // Back to Claude Code, whose CLI fails.
  await dialog
    .getByTestId('audit-provider')
    .filter({ hasText: 'Claude Code' })
    .getByRole('radio')
    .check();
  await expect(dialog.getByTestId('audit-warnings')).toBeHidden();
  await start.click();
  await expect(page.getByTestId('audit-error')).toHaveText('Claude Code exited with code 2.', {
    timeout: 20_000,
  });
  await expect(page.getByTestId('audit-status')).toHaveText('Failed');
  await expect(page.getByTestId('audit-history-item')).toHaveCount(1);
});
