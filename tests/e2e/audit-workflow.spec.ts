import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, projectActions, test } from './fixtures';

const CLAUDE_HELP =
  '--restricted --tools --allowedTools --permission-mode dontAsk --strict-mcp-config --no-session-persistence --output-format --json-schema';

const finding = (overrides: Record<string, unknown>) => ({
  category: 'security',
  severity: 'HIGH',
  confidence: 'MEDIUM',
  kind: 'observation',
  evidence: 'See the function.',
  locations: [{ path: 'src/auth.ts', startLine: 2, endLine: 2, symbol: 'check' }],
  impact: 'Impact.',
  acceptanceCriteria: ['Tokens are compared in constant time'],
  effort: 'small',
  ...overrides,
});

const REPORT = {
  summary: 'Two issues.',
  findings: [
    finding({
      title: 'Token compared without constant time',
      description: 'The token is compared with ===.',
      excerpt: 'return token === secret;',
      recommendation: 'Use timingSafeEqual.',
      suggestedTaskTitle: 'Compare tokens in constant time',
    }),
    finding({
      title: 'Secret read from a constant',
      severity: 'LOW',
      description: 'The secret is not configurable.',
      excerpt: 'export function check(token: string, secret: string) {',
      recommendation: 'Read it from configuration.',
      suggestedTaskTitle: 'Make the secret configurable',
    }),
  ],
};

/**
 * One fake `claude` for both uses: `-p` is the read-only audit (it prints the report);
 * anything else is a team member in a terminal (it records its prompt and exits 0).
 */
function fakeClaude(binDir: string, root: string) {
  const prompts = path.join(root, 'member-prompts.txt');
  const file = path.join(binDir, 'claude');
  const result = JSON.stringify({ subtype: 'success', structured_output: REPORT });
  writeFileSync(
    file,
    `#!/bin/sh
case "$*" in "--help") printf '%s\\n' '${CLAUDE_HELP}'; exit 0 ;; esac
if [ "$1" = "-p" ]; then cat > /dev/null; printf '%s' '${result}'; exit 0; fi
printf '%s\\n---\\n' "$@" >> "${prompts}"
echo "FAKE TEAM MEMBER"
exit 0
`,
  );
  chmodSync(file, 0o755);
  return { prompts };
}

async function analyze(page: Page) {
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Terminals', exact: true })
    .click();
  const actions = await projectActions(page, 'shop');
  await actions.getByRole('button', { name: 'Analyze project…' }).click();
  const dialog = page.getByTestId('analyze-project-dialog');
  await dialog.getByRole('button', { name: 'Start audit' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('audit-status')).toHaveText(/Completed/, { timeout: 20_000 });
}

test('analyze, turn a finding into a task, execute it with ATLAS and watch the team', async ({
  atlas,
}) => {
  const dir = atlas.workspace('shop');
  mkdirSync(path.join(dir, 'src'));
  writeFileSync(
    path.join(dir, 'src', 'auth.ts'),
    'export function check(token: string, secret: string) {\n  return token === secret;\n}\n',
  );
  atlas.cli('project', 'add', dir);
  const { prompts } = fakeClaude(atlas.binDir, atlas.root);
  const { page } = await atlas.launch();
  await analyze(page);

  // The steps say what comes next: two findings to review.
  const steps = page.getByTestId('workflow-step');
  await expect(steps.nth(1)).toContainText('2 to review');
  await expect(steps.nth(1)).toHaveAttribute('aria-current', 'step');

  // Reject the low one with a note; it leaves the list.
  const findings = page.getByTestId('audit-finding');
  await expect(findings).toHaveCount(2);
  await findings
    .filter({ hasText: 'Secret read from a constant' })
    .getByTestId('finding-reject')
    .click();
  const note = page.getByTestId('decision-note-dialog');
  await note.getByLabel('Note (optional)').fill('Configured at deploy time');
  await note.getByRole('button', { name: 'Reject' }).click();
  await expect(findings).toHaveCount(1);

  // Turn the other into a task and execute it with ATLAS right away.
  await findings.first().getByTestId('finding-create-task').click();
  await expect(page.getByTestId('findings-created')).toContainText('1 task(s) created');
  await expect(steps.nth(1)).toContainText('All reviewed');
  expect(existsSync(prompts)).toBe(false);
  await page.getByTestId('findings-execute').click();
  await expect(page.getByTestId('hub-tasks')).toBeVisible();
  const proposal = page.getByTestId('team-proposal-dialog');
  await expect(proposal).toContainText('Compare tokens in constant time');
  await expect(proposal.getByTestId('team-stage').first()).toBeVisible();
  await proposal.getByRole('button', { name: 'Approve and run' }).click();
  await expect(proposal).toBeHidden();

  // The members work in their own terminal group, named after the task.
  await expect(page.getByText('ATLAS · Compare tokens in constant time').first()).toBeVisible({
    timeout: 20_000,
  });
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Project Hub', exact: true })
    .click();
  // The Hub comes back where it was: the project's Tasks.
  await expect(page.getByTestId('hub-tasks')).toBeVisible();
  const task = page
    .getByTestId('context-task')
    .filter({ hasText: 'Compare tokens in constant time' });
  await expect(task.getByTestId('team-status')).toHaveText('Team finished · review required', {
    timeout: 30_000,
  });
  await expect(task.getByTestId('team-watch')).toBeVisible();
  expect(readFileSync(prompts, 'utf8')).toContain('Source: ATLAS audit');
  await expect(steps.nth(4)).toContainText('1 result(s) to review');

  // A second audit remembers the decisions: nothing new to review.
  await page.getByRole('button', { name: 'Audits', exact: true }).click();
  await page.getByTestId('hub-analyze-project').click();
  await page
    .getByTestId('analyze-project-dialog')
    .getByRole('button', { name: 'Start audit' })
    .click();
  await expect(page.getByTestId('audit-history-item')).toHaveCount(2, { timeout: 20_000 });
  await expect(page.getByTestId('audit-status')).toHaveText(/Completed/, { timeout: 20_000 });
  await expect(page.getByTestId('audit-finding')).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Show findings' }).click();
  await page.getByRole('option', { name: 'All findings' }).click();
  await expect(page.getByTestId('finding-state')).toHaveText(['Has a task', 'Rejected']);
});
