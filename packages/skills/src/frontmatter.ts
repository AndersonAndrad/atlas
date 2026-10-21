import { parse as parseYaml } from 'yaml';

export interface ParsedSkillFile {
  /** Frontmatter fields; empty when there is none or it is invalid. */
  fields: Record<string, unknown>;
  /** Markdown after the frontmatter. */
  body: string;
  /** The YAML text between the --- lines. */
  rawFrontmatter: string;
  hasFrontmatter: boolean;
  /** Why the frontmatter could not be read, if it could not. */
  error: string | null;
}

/** Bounds YAML work on untrusted input (aliases are expanded at most this many times). */
const MAX_ALIAS_COUNT = 50;

/**
 * Splits SKILL.md into its YAML frontmatter and body. The frontmatter must start
 * on the first line with `---` (as Claude Code requires) and end with a `---` line.
 * YAML is parsed as data only: no custom tags, bounded aliases.
 */
export function parseSkillFile(text: string): ParsedSkillFile {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (!normalized.startsWith('---\n')) {
    return { fields: {}, body: normalized, rawFrontmatter: '', hasFrontmatter: false, error: null };
  }
  const end = normalized.indexOf('\n---', 3);
  const lineEnd = end === -1 ? -1 : normalized.indexOf('\n', end + 4);
  const closing = end === -1 ? '' : normalized.slice(end + 1, lineEnd === -1 ? undefined : lineEnd);
  if (end === -1 || closing.trim() !== '---') {
    return {
      fields: {},
      body: normalized,
      rawFrontmatter: normalized.slice(4),
      hasFrontmatter: true,
      error: 'The frontmatter has no closing --- line.',
    };
  }
  const yaml = normalized.slice(4, end + 1);
  const body = lineEnd === -1 ? '' : normalized.slice(lineEnd + 1);
  try {
    const value: unknown = parseYaml(yaml, { maxAliasCount: MAX_ALIAS_COUNT, prettyErrors: false });
    if (value === null || value === undefined) {
      return { fields: {}, body, rawFrontmatter: yaml, hasFrontmatter: true, error: null };
    }
    if (typeof value !== 'object' || Array.isArray(value)) {
      return {
        fields: {},
        body,
        rawFrontmatter: yaml,
        hasFrontmatter: true,
        error: 'The frontmatter is not a mapping.',
      };
    }
    return {
      fields: value as Record<string, unknown>,
      body,
      rawFrontmatter: yaml,
      hasFrontmatter: true,
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message.split('\n')[0] : 'invalid YAML';
    return {
      fields: {},
      body,
      rawFrontmatter: yaml,
      hasFrontmatter: true,
      error: `The frontmatter is not valid YAML: ${message}`,
    };
  }
}

/** Parses `agents/openai.yaml` (Codex); null when absent or unreadable. */
export function parseYamlDocument(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = parseYaml(text, { maxAliasCount: MAX_ALIAS_COUNT, prettyErrors: false });
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export const asString = (value: unknown): string | null =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : null;

/** A string list given as a YAML list or a space/comma separated string. */
export function asList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(asString).filter((item): item is string => !!item);
  const text = asString(value);
  if (text === null) return [];
  // Tool patterns may contain spaces inside parentheses: "Bash(git add *) Read".
  return (text.match(/[^\s,()]+(?:\([^)]*\))?/g) ?? []).map((item) => item.trim());
}
