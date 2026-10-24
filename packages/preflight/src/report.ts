import type { PreflightOutputLine, PreflightRun } from '@atlas/contracts';

const EXCERPT_LINES = 40;

/** A backtick run longer than any in `text` (at least `min`), so `text` cannot close it. */
function ticks(text: string, min: number): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  return '`'.repeat(Math.max(min, longest + 1));
}

const cell = (value: string) => value.replace(/\|/g, '\\|').replace(/\s+/g, ' ');

function duration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms} ms`;
  const seconds = Math.round(ms / 100) / 10;
  return seconds < 60
    ? `${seconds} s`
    : `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`;
}

/**
 * A Markdown report of a run (FR-717): what ran, where, against which code state, and
 * the end of the output of every check that did not pass. Logs are already redacted.
 */
export function runReport(
  run: PreflightRun,
  logs: ReadonlyMap<number, readonly PreflightOutputLine[]>,
): string {
  const lines = [
    `# Preflight report — ${run.profileName}`,
    '',
    `- Workspace: ${run.workspacePath}`,
    `- Status: ${run.status} (required checks: ${run.requiredOutcome})`,
    `- Started: ${run.startedAt}${run.finishedAt ? ` — finished: ${run.finishedAt}` : ''}`,
    `- Branch: ${run.branch ?? '—'} · Revision: ${run.sourceRevision ?? '—'}`,
    `- Code state fingerprint: ${run.sourceStateFingerprint ?? 'not a Git repository'}`,
  ];
  if (run.sourceChangedDuringRun) {
    lines.push('- Warning: the code changed while the run was in progress.');
  }
  lines.push(
    '- Executed locally by ATLAS; this is not a GitHub-hosted CI result.',
    '',
    '| Check | Type | Required | Status | Duration | Environment | Detail |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  );
  for (const result of run.results) {
    lines.push(
      `| ${cell(result.name)} | ${result.type} | ${result.required ? 'yes' : 'no'} | ${result.status} | ${duration(result.durationMs)} | ${cell(result.environment)} | ${cell(result.detail ?? '')} |`,
    );
  }
  for (const result of run.results) {
    if (result.status === 'PASSED') continue;
    const output = logs.get(result.position) ?? [];
    const inline = ticks(result.reference, 1);
    lines.push(
      '',
      `## ${cell(result.name)} — ${result.status}`,
      '',
      `Reproduce: ${inline} ${result.reference} ${inline}`,
    );
    if (result.detail) lines.push('', `Detail: ${result.detail}`);
    if (output.length > 0) {
      const excerpt = output.slice(-EXCERPT_LINES).map((line) => line.text);
      const block = ticks(excerpt.join('\n'), 3);
      lines.push('', `${block}text`, ...excerpt, block);
    }
  }
  return `${lines.join('\n')}\n`;
}
