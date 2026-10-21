import { createHash } from 'node:crypto';
import type {
  AiProvider,
  SkillCompatibility,
  SkillDependencyCheck,
  SkillFile,
  SkillIssue,
  SkillValidation,
} from '@atlas/contracts';
import { redactCredentials } from '@atlas/git';
import { asList, asString, parseSkillFile, parseYamlDocument } from './frontmatter.js';

/** Limits for one skill folder (FR-623). */
export const MAX_SKILL_FILES = 500;
export const MAX_SKILL_BYTES = 5 * 1024 * 1024;

/** A skill folder as read from disk, before analysis. */
export interface SkillFolderSnapshot {
  dirName: string;
  files: {
    path: string;
    size: number;
    hash: string;
    /** File mode bits (0 when unknown, e.g. on Windows). */
    mode: number;
    /** First bytes as text, to detect a shebang. */
    head: string;
  }[];
  /** Text of SKILL.md; null when missing. */
  skillMd: string | null;
  /** Text of agents/openai.yaml (Codex), when present. */
  openaiYaml: string | null;
  /** Small text files, for the credential check of non-metadata content. */
  texts: { path: string; content: string }[];
  /** Problems found while reading (symlinks leaving the folder, limits). */
  problems: SkillIssue[];
}

export interface AnalysisEnvironment {
  /** Whether an executable is on PATH; never runs it. */
  hasExecutable(name: string): boolean | null;
  /** Names of registered skills, for skill dependencies. */
  skillNames: ReadonlySet<string>;
  now: Date;
}

export interface SkillAnalysis {
  name: string;
  description: string;
  version: string;
  /** Folder name usable by both providers. */
  dirName: string;
  contentHash: string;
  files: SkillFile[];
  totalSize: number;
  validation: SkillValidation;
}

/** Frontmatter fields Claude Code documents for SKILL.md. */
const CLAUDE_FIELDS = new Set([
  'name',
  'description',
  'when_to_use',
  'argument-hint',
  'arguments',
  'disable-model-invocation',
  'user-invocable',
  'allowed-tools',
  'disallowed-tools',
  'model',
  'effort',
  'context',
  'agent',
  'background',
  'hooks',
  'paths',
  'shell',
  'metadata',
  'license',
  'compatibility',
]);
/** Fields Codex documents (plus `metadata`, used by its bundled skills). */
const CODEX_FIELDS = new Set(['name', 'description', 'metadata']);
const CLAUDE_DESCRIPTION_LIMIT = 1536;
const SCRIPT_EXTENSIONS =
  /\.(sh|bash|zsh|fish|py|js|mjs|cjs|ts|rb|pl|php|lua|ps1|psm1|bat|cmd|exe|com|jar)$/i;
const RESERVED_CLAUDE_NAME = /^anthropic-skills(?::|$)/;
/** Characters Claude Code refuses in names (control, bidi, zero-width, private use, < >). */
const INVALID_CLAUDE_NAME = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}<>]|[^\S ]/u;

const issue = (level: SkillIssue['level'], code: string, message: string): SkillIssue => ({
  level,
  code,
  message,
});

/** A name both providers accept as a folder: lowercase words separated by hyphens. */
export function toDirName(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '');
  return slug === '' ? 'skill' : slug;
}

export function contentHash(files: { path: string; hash: string }[]): string {
  const hash = createHash('sha256');
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(`${file.path}\0${file.hash}\n`);
  }
  return hash.digest('hex');
}

const isScript = (file: SkillFolderSnapshot['files'][number]) =>
  (file.mode & 0o111) !== 0 || file.head.startsWith('#!') || SCRIPT_EXTENSIONS.test(file.path);

/** Executable names from Claude Code tool patterns such as `Bash(git add *)`. */
function executablesFromTools(tools: string[]): string[] {
  const names = tools
    .map((tool) => /^Bash\(\s*([A-Za-z0-9._-]+)/.exec(tool)?.[1])
    .filter((name): name is string => name !== undefined && name !== '*');
  return [...new Set(names)];
}

function claudeCompatibility(
  fields: Record<string, unknown>,
  name: string,
  dirName: string,
  description: string,
  hasOpenaiYaml: boolean,
): SkillCompatibility {
  const issues: SkillIssue[] = [];
  const unsupported: string[] = [];
  if (INVALID_CLAUDE_NAME.test(name) || name !== name.trim()) {
    issues.push(
      issue('error', 'invalid-name', 'Claude Code refuses this name (invalid characters).'),
    );
  }
  if (RESERVED_CLAUDE_NAME.test(name)) {
    issues.push(
      issue('error', 'reserved-name', '"anthropic-skills" names are reserved by Claude Code.'),
    );
  }
  if (dirName.toLowerCase() === 'synced') {
    issues.push(
      issue('error', 'reserved-folder', 'Claude Code reserves the folder name "synced".'),
    );
  }
  if (description === '') {
    issues.push(
      issue(
        'warning',
        'missing-description',
        'Claude Code recommends a description to decide when to use the skill.',
      ),
    );
  }
  const listing = `${description} ${asString(fields.when_to_use) ?? ''}`.trim();
  if (listing.length > CLAUDE_DESCRIPTION_LIMIT) {
    issues.push(
      issue(
        'warning',
        'long-description',
        `Claude Code truncates the description at ${CLAUDE_DESCRIPTION_LIMIT} characters.`,
      ),
    );
  }
  for (const field of Object.keys(fields)) {
    if (!CLAUDE_FIELDS.has(field)) unsupported.push(field);
  }
  if (hasOpenaiYaml) unsupported.push('agents/openai.yaml');
  if (unsupported.length > 0) {
    issues.push(
      issue('info', 'ignored-features', `Ignored by Claude Code: ${unsupported.join(', ')}.`),
    );
  }
  const status = issues.some((item) => item.level === 'error')
    ? 'incompatible'
    : unsupported.length > 0
      ? 'partial'
      : 'compatible';
  return { provider: 'claude', status, issues, unsupportedFeatures: unsupported };
}

function codexCompatibility(fields: Record<string, unknown>): SkillCompatibility {
  const issues: SkillIssue[] = [];
  if (!asString(fields.name)?.trim()) {
    issues.push(issue('error', 'missing-name', 'Codex requires a name in the frontmatter.'));
  }
  if (!asString(fields.description)?.trim()) {
    issues.push(issue('error', 'missing-description', 'Codex requires a description.'));
  }
  const unsupported = Object.keys(fields).filter((field) => !CODEX_FIELDS.has(field));
  if (unsupported.length > 0) {
    issues.push(
      issue(
        'warning',
        'unsupported-features',
        `Not documented for Codex, so not expected to work there: ${unsupported.join(', ')}.`,
      ),
    );
  }
  const status = issues.some((item) => item.level === 'error')
    ? 'incompatible'
    : unsupported.length > 0
      ? 'partial'
      : 'compatible';
  return { provider: 'codex', status, issues, unsupportedFeatures: unsupported };
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/**
 * Validates a skill folder without executing anything (FR-617, FR-620, FR-621):
 * format per provider, scripts, requested permissions, credentials in metadata and
 * declared dependencies. Errors make the skill invalid (not importable or activatable).
 */
export function analyzeSkill(
  snapshot: SkillFolderSnapshot,
  env: AnalysisEnvironment,
): SkillAnalysis {
  const issues: SkillIssue[] = [...snapshot.problems];
  const files: SkillFile[] = snapshot.files.map((file) => ({
    path: file.path,
    size: file.size,
    hash: file.hash,
    script: isScript(file),
  }));
  const totalSize = files.reduce((sum, file) => sum + file.size, 0);
  if (files.length > MAX_SKILL_FILES) {
    issues.push(issue('error', 'too-many-files', `More than ${MAX_SKILL_FILES} files.`));
  }
  if (totalSize > MAX_SKILL_BYTES) {
    issues.push(issue('error', 'too-large', 'The skill folder is larger than 5 MB.'));
  }

  const parsed = snapshot.skillMd === null ? null : parseSkillFile(snapshot.skillMd);
  if (parsed === null) {
    issues.push(issue('error', 'missing-skill-file', 'The folder has no SKILL.md.'));
  } else if (parsed.error) {
    issues.push(issue('error', 'invalid-frontmatter', parsed.error));
  } else if (!parsed.hasFrontmatter) {
    issues.push(
      issue('warning', 'no-frontmatter', 'SKILL.md has no frontmatter; Codex cannot use it.'),
    );
  }
  const fields = parsed?.fields ?? {};
  const declaredName = asString(fields.name)?.trim() ?? '';
  const name = declaredName || snapshot.dirName;
  const description = (asString(fields.description) ?? '').trim();
  const metadata = record(fields.metadata);
  const version = asString(metadata.version)?.trim() || '';
  if (declaredName && declaredName !== snapshot.dirName) {
    issues.push(
      issue(
        'info',
        'name-differs',
        `The folder is "${snapshot.dirName}" but the skill is named "${declaredName}".`,
      ),
    );
  }

  // Credentials must never travel through skill metadata (FR-621).
  const openai = snapshot.openaiYaml === null ? null : parseYamlDocument(snapshot.openaiYaml);
  const frontmatterText = parsed?.rawFrontmatter ?? '';
  for (const [label, text] of [
    ['SKILL.md frontmatter', frontmatterText],
    ['agents/openai.yaml', snapshot.openaiYaml ?? ''],
  ] as const) {
    if (text !== '' && redactCredentials(text) !== text) {
      issues.push(
        issue('error', 'credential-in-metadata', `${label} appears to contain a credential.`),
      );
    }
  }
  for (const text of snapshot.texts) {
    if (redactCredentials(text.content) !== text.content) {
      issues.push(
        issue(
          'warning',
          'possible-credential',
          `${text.path} may contain a credential; review it before sharing.`,
        ),
      );
    }
  }

  const scripts = files.filter((file) => file.script).map((file) => file.path);
  if (scripts.length > 0) {
    issues.push(
      issue(
        'warning',
        'scripts',
        `${scripts.length} file(s) look executable. ATLAS never runs them; an AI provider may when the skill tells it to.`,
      ),
    );
  }
  const allowedTools = asList(fields['allowed-tools']);
  const permissions = allowedTools.map((tool) => `Claude Code pre-approved tool: ${tool}`);
  if (fields.hooks !== undefined) permissions.push('Claude Code hooks (commands run on events)');
  if (/!`[^`]+`/.test(parsed?.body ?? '')) {
    permissions.push('Claude Code runs the `!` shell commands of SKILL.md when invoked');
  }
  const codexTools = Array.isArray(record(openai?.dependencies).tools)
    ? (record(openai?.dependencies).tools as unknown[]).map(record)
    : [];
  for (const tool of codexTools) {
    permissions.push(
      `Codex tool dependency: ${asString(tool.type) ?? 'tool'} ${asString(tool.value) ?? ''}`.trim(),
    );
  }

  // Declared dependencies are checked, never installed (FR-620).
  const requires = record(metadata.requires);
  const dependencies: SkillDependencyCheck[] = [];
  for (const executable of [
    ...new Set([...asList(requires.executables), ...executablesFromTools(allowedTools)]),
  ]) {
    const found = env.hasExecutable(executable);
    dependencies.push({
      kind: 'executable',
      name: executable,
      status: found === null ? 'unknown' : found ? 'available' : 'missing',
      detail: found === false ? 'Not found on PATH.' : null,
    });
  }
  for (const skill of asList(requires.skills)) {
    dependencies.push({
      kind: 'skill',
      name: skill,
      status: env.skillNames.has(skill) ? 'available' : 'missing',
      detail: env.skillNames.has(skill) ? null : 'Not registered in ATLAS.',
    });
  }
  for (const tool of [
    ...asList(requires.tools),
    ...codexTools.map((tool) => asString(tool.value) ?? ''),
  ]) {
    if (tool === '') continue;
    dependencies.push({
      kind: 'tool',
      name: tool,
      status: 'unknown',
      detail: 'Provided by the AI provider; not checked.',
    });
  }

  const compatibility = [
    claudeCompatibility(fields, name, snapshot.dirName, description, snapshot.openaiYaml !== null),
    codexCompatibility(fields),
  ];
  const providers = asList(requires.providers);
  for (const provider of providers) {
    const known = compatibility.find((item) => item.provider === provider);
    dependencies.push({
      kind: 'provider',
      name: provider,
      status:
        known === undefined ? 'unknown' : known.status === 'incompatible' ? 'missing' : 'available',
      detail: known === undefined ? 'Provider not supported by ATLAS.' : null,
    });
  }
  const hash = contentHash(files);
  return {
    name,
    description,
    version: version || hash.slice(0, 12),
    dirName: toDirName(name),
    contentHash: hash,
    files,
    totalSize,
    validation: {
      checkedAt: env.now.toISOString(),
      valid: !issues.some((item) => item.level === 'error'),
      issues,
      compatibility,
      dependencies,
      scripts,
      permissions,
    },
  };
}

/** Whether a provider can use the skill at all. */
export const usableBy = (validation: SkillValidation, provider: AiProvider) =>
  validation.valid &&
  validation.compatibility.some(
    (item) => item.provider === provider && item.status !== 'incompatible',
  );
