import type {
  AuditFindingLocation,
  AuditFindingValidation,
  AuditLocationStatus,
  AuditReportFinding,
} from '@atlas/contracts';

/** What ATLAS found at a path the provider reported. */
export type AuditPathInspection =
  | {
      status: 'file';
      /** Relative to the project folder, `/` separators. */
      path: string;
      /** Null when the file is too large or not text. */
      lineCount: number | null;
      content: string | null;
    }
  | {
      status: Exclude<AuditLocationStatus, 'located' | 'line-out-of-range'>;
      /** Relative when inside the project; a placeholder otherwise. */
      path: string;
    };

/** Reads the project only: paths outside it are reported as such, never opened. */
export interface AuditFileInspector {
  inspect(reportedPath: string): Promise<AuditPathInspection>;
}

export interface ValidatedFinding {
  locations: AuditFindingLocation[];
  validation: AuditFindingValidation;
  validationNotes: string[];
  containsCommands: boolean;
}

/**
 * Shell commands in text: fenced shell blocks, prompt lines, pipes into a shell, and
 * commands that change the system. Heuristic on purpose: it only decides how text is
 * labelled, ATLAS never runs any of it.
 */
const COMMAND_PATTERNS: readonly RegExp[] = [
  /```[ \t]*(?:sh|bash|zsh|shell|console|powershell|ps1|cmd)\b/i,
  /^[ \t]*(?:\$|PS>)[ \t]+\S+/m,
  /\|\s*(?:sh|bash|zsh|iex|pwsh|powershell)\b/i,
  /(?:^|[\s;&|`(])(?:sudo\s|rm\s+-\S*[rRf]|mkfs\b|dd\s+if=)/,
  /\$\([^)]*\)/,
];

export function containsShellCommands(text: string): boolean {
  return COMMAND_PATTERNS.some((pattern) => pattern.test(text));
}

/** Fields that name things: a command there is never legitimate metadata. */
const metadataFields = (finding: AuditReportFinding) => [
  finding.title,
  finding.suggestedTaskTitle,
  ...finding.locations.map((location) => location.symbol ?? ''),
];

const collapse = (value: string) => value.replace(/\s+/g, ' ').trim();

/** Line-number gutters providers add to quotes, e.g. "12 | code" or "12: code". */
const withoutGutters = (value: string) =>
  value
    .split('\n')
    .map((line) => line.replace(/^\s*\d+\s*(?:[|│:]|->)\s?/, ''))
    .join('\n');

/**
 * Whether the quoted excerpt appears in `content`, ignoring whitespace differences and
 * line-number gutters. An excerpt shortened with "..." matches when every part appears.
 */
export function excerptMatches(excerpt: string, content: string): boolean {
  const haystack = collapse(content);
  return [excerpt, withoutGutters(excerpt)].some((candidate) => {
    const parts = candidate
      .split(/\.\.\.|…/)
      .map(collapse)
      .filter((part) => part.length >= 3);
    return parts.length > 0 && parts.every((part) => haystack.includes(part));
  });
}

const DESCRIBE: Record<Exclude<AuditLocationStatus, 'located' | 'line-out-of-range'>, string> = {
  missing: 'was not found in the project',
  'outside-project': 'is outside the project folder',
  ignored: "is excluded by the project's ignore rules",
  'not-a-file': 'is not a file',
};

/**
 * Checks a finding against the project's files (FR-008): the paths exist inside the
 * project, the lines are within the files, and the quoted excerpt is in them. A finding
 * that cannot be checked is kept and marked for manual review; it is invalid only when
 * none of its files exist.
 */
export async function validateFinding(
  finding: AuditReportFinding,
  inspector: AuditFileInspector,
): Promise<ValidatedFinding> {
  const notes: string[] = [];
  const locations: AuditFindingLocation[] = [];
  const contents: string[] = [];
  let existing = 0;
  let unreadable = false;
  for (const reported of finding.locations) {
    const inspection = await inspector.inspect(reported.path);
    let startLine = reported.startLine;
    let endLine = reported.endLine;
    if (startLine !== null && endLine !== null && endLine < startLine) endLine = null;
    if (endLine !== null && startLine === null) startLine = endLine;
    if (inspection.status !== 'file') {
      notes.push(`"${inspection.path}" ${DESCRIBE[inspection.status]}.`);
      locations.push({
        path: inspection.path,
        startLine,
        endLine,
        symbol: reported.symbol,
        status: inspection.status,
      });
      continue;
    }
    existing += 1;
    if (inspection.content === null) unreadable = true;
    else contents.push(inspection.content);
    const lastLine = endLine ?? startLine;
    const outOfRange =
      inspection.lineCount !== null && lastLine !== null && lastLine > inspection.lineCount;
    if (outOfRange) {
      notes.push(
        `Line ${lastLine} is past the end of "${inspection.path}" (${inspection.lineCount} lines); the code may have changed.`,
      );
    }
    locations.push({
      path: inspection.path,
      startLine,
      endLine,
      symbol: reported.symbol,
      status: outOfRange ? 'line-out-of-range' : 'located',
    });
  }

  if (finding.locations.length === 0) notes.push('No file location was reported.');
  if (existing > 0) {
    if (finding.excerpt === null) {
      notes.push('No code excerpt was quoted, so the evidence could not be compared.');
    } else if (!contents.some((content) => excerptMatches(finding.excerpt!, content))) {
      notes.push(
        unreadable && contents.length === 0
          ? 'The reported files are too large or not text, so the excerpt could not be compared.'
          : 'The quoted excerpt was not found in the reported files; the code may have changed.',
      );
    }
  }
  if (metadataFields(finding).some(containsShellCommands)) {
    notes.push('The title or a symbol name contains a shell command.');
  }

  const containsCommands = [
    ...metadataFields(finding),
    finding.description,
    finding.evidence,
    finding.recommendation,
    ...finding.acceptanceCriteria,
  ].some(containsShellCommands);

  const validation: AuditFindingValidation =
    finding.locations.length > 0 && existing === 0
      ? 'invalid'
      : notes.length > 0
        ? 'needs-review'
        : 'evidence-located';
  return { locations, validation, validationNotes: notes, containsCommands };
}
