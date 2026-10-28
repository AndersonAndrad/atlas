import { AUDIT_CATEGORY_LABELS, type AuditFinding, type ProjectAudit } from '@atlas/contracts';

/** CreateContextTaskSchema's limits. */
export const FINDING_TASK_TITLE_MAX = 200;
export const FINDING_TASK_OBJECTIVE_MAX = 4000;

const fit = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

/** The task title of a finding: the provider's suggestion, else the finding's title. */
export function findingTaskTitle(finding: AuditFinding): string {
  return fit(finding.suggestedTaskTitle.trim() || finding.title, FINDING_TASK_TITLE_MAX);
}

/**
 * The objective of the task a finding becomes (FR-012): what to fix, how, the acceptance
 * criteria as a list (Execute with ATLAS reads them), the files, and where it came from.
 * Plain text; the source line keeps the task traceable to its audit and finding.
 */
export function findingTaskObjective(
  finding: AuditFinding,
  audit: Pick<ProjectAudit, 'id' | 'createdAt'>,
): string {
  const files = finding.locations
    .filter((location) => location.status === 'located' || location.status === 'line-out-of-range')
    .map((location) =>
      location.startLine === null ? location.path : `${location.path}:${location.startLine}`,
    );
  const source =
    `Source: ATLAS audit ${audit.createdAt.slice(0, 10)} (audit ${audit.id}, finding ${finding.id}), ` +
    `${finding.severity} · ${AUDIT_CATEGORY_LABELS[finding.category]}` +
    (finding.kind === 'hypothesis' ? ' · hypothesis, confirm it first' : '') +
    '.';
  const tail = [
    ...(finding.acceptanceCriteria.length > 0
      ? ['', 'Acceptance criteria:', ...finding.acceptanceCriteria.map((item) => `- ${item}`)]
      : []),
    ...(files.length > 0 ? ['', `Files: ${files.join(', ')}`] : []),
    // The text came from an AI reading untrusted repository content.
    ...(finding.containsCommands
      ? ['', 'Note: this finding mentions shell commands; check them before running any.']
      : []),
    '',
    source,
  ].join('\n');
  const head = [finding.description, '', `Recommendation: ${finding.recommendation}`].join('\n');
  // The criteria, files and source are kept; a long description is shortened first.
  const budget = Math.max(200, FINDING_TASK_OBJECTIVE_MAX - tail.length - 1);
  return fit(`${fit(head, budget)}\n${tail}`, FINDING_TASK_OBJECTIVE_MAX);
}
