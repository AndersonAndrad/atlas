/**
 * Conventional Commits 1.0.0 (https://www.conventionalcommits.org/en/v1.0.0/).
 *
 * The validator implements the specification's grammar rather than a single
 * header regular expression, so valid bodies, footers and breaking-change
 * markers are accepted. Project rules can only add restrictions.
 */

export interface CommitFooter {
  token: string;
  /** `': '` or `' #'`. */
  separator: ': ' | ' #';
  value: string;
}

export interface CommitMessageValidation {
  valid: boolean;
  type?: string;
  scope?: string;
  description?: string;
  body?: string;
  footers: CommitFooter[];
  /** `!` in the header or a `BREAKING CHANGE` / `BREAKING-CHANGE` footer. */
  breaking: boolean;
  errors: string[];
}

/** Optional, stricter project conventions. They never relax the specification. */
export interface CommitMessageRules {
  /** Allowed types (case-insensitive). Empty or absent allows any valid type. */
  types?: readonly string[];
  requireScope?: boolean;
  /** Maximum header length in characters. */
  headerMaxLength?: number;
}

export const RECOMMENDED_COMMIT_TYPES = [
  'feat',
  'fix',
  'docs',
  'style',
  'refactor',
  'perf',
  'test',
  'build',
  'ci',
  'chore',
  'revert',
] as const;

const TYPE = /^[A-Za-z][A-Za-z0-9-]*$/;
const HEADER = /^(?<type>[^():!\s]+)(?:\((?<scope>[^()\r\n]*)\))?(?<bang>!)?: (?<description>.*)$/;
const BREAKING_TOKENS = new Set(['BREAKING CHANGE', 'BREAKING-CHANGE']);
const FOOTER =
  /^(?<token>BREAKING CHANGE|[A-Za-z0-9][A-Za-z0-9-]*)(?<separator>: | #)(?<value>.*)$/;

function parseFooterLine(line: string): CommitFooter | null {
  const match = FOOTER.exec(line);
  if (!match?.groups) return null;
  return {
    token: match.groups.token!,
    separator: match.groups.separator as CommitFooter['separator'],
    value: match.groups.value!,
  };
}

/** Index of the first line of the footer section in `lines`, or `lines.length`. */
function footerStart(lines: string[]): number {
  const paragraphStarts: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index] !== '' && (index === 0 || lines[index - 1] === ''))
      paragraphStarts.push(index);
  }
  // The footer section is the trailing run of paragraphs that all begin with a footer.
  let start = lines.length;
  for (let i = paragraphStarts.length - 1; i >= 0; i -= 1) {
    const index = paragraphStarts[i]!;
    if (parseFooterLine(lines[index]!) === null) break;
    start = index;
  }
  return start;
}

function parseFooters(lines: string[]): CommitFooter[] {
  const footers: CommitFooter[] = [];
  for (const line of lines) {
    const footer = parseFooterLine(line);
    const previous = footers.at(-1);
    if (footer !== null) footers.push(footer);
    // A value may span several lines until the next token/separator pair.
    else if (previous !== undefined) previous.value += `\n${line}`;
  }
  for (const footer of footers) footer.value = footer.value.trimEnd();
  return footers;
}

export function validateCommitMessage(
  message: string,
  rules: CommitMessageRules = {},
): CommitMessageValidation {
  const errors: string[] = [];
  const result: CommitMessageValidation = { valid: false, footers: [], breaking: false, errors };
  const lines = message.replace(/\r\n?/g, '\n').split('\n');
  while (lines.length > 0 && lines.at(-1)!.trim() === '') lines.pop();

  const header = lines[0] ?? '';
  if (header.trim() === '') {
    errors.push('The commit message is empty.');
    return result;
  }
  if (/^\s/.test(header)) errors.push('The header must not start with whitespace.');

  const match = HEADER.exec(header.trimStart());
  if (!match?.groups) {
    errors.push('The header must follow "<type>[optional scope][!]: <description>".');
    return result;
  }
  const { type, scope, bang, description } = match.groups as {
    type: string;
    scope?: string;
    bang?: string;
    description: string;
  };
  result.type = type;
  if (!TYPE.test(type)) errors.push('The type must be a single word, such as "feat" or "fix".');
  if (scope !== undefined) {
    result.scope = scope;
    if (scope.trim() === '') errors.push('The scope must not be empty; remove the parentheses.');
    else if (scope !== scope.trim()) errors.push('The scope must not start or end with spaces.');
  }
  result.description = description;
  if (description.trim() === '') errors.push('A description must follow ": ".');
  else if (/^\s/.test(description)) errors.push('Use a single space after the colon.');

  let breaking = bang === '!';
  if (lines.length > 1) {
    if (lines[1]!.trim() !== '') errors.push('Leave a blank line between the header and the body.');
    const rest = lines.slice(2);
    const start = footerStart(rest);
    const body = rest.slice(0, start).join('\n').trim();
    if (body !== '') result.body = body;
    result.footers = parseFooters(rest.slice(start));
    for (const footer of result.footers) {
      if (BREAKING_TOKENS.has(footer.token)) {
        breaking = true;
        if (footer.separator !== ': ') {
          errors.push(`"${footer.token}" must be followed by ": " and a description.`);
        }
      }
      if (footer.value.trim() === '') errors.push(`The footer "${footer.token}" has no value.`);
    }
  }
  result.breaking = breaking;

  const allowed = rules.types?.filter((value) => value.trim() !== '') ?? [];
  if (
    allowed.length > 0 &&
    TYPE.test(type) &&
    !allowed.some((value) => value.toLowerCase() === type.toLowerCase())
  ) {
    errors.push(`The type "${type}" is not allowed in this project. Use: ${allowed.join(', ')}.`);
  }
  if (rules.requireScope && scope === undefined) errors.push('This project requires a scope.');
  if (rules.headerMaxLength !== undefined && header.length > rules.headerMaxLength) {
    errors.push(`The header must have at most ${rules.headerMaxLength} characters.`);
  }

  result.valid = errors.length === 0;
  return result;
}
