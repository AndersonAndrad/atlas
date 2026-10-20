export type SuggestedFileChange = 'added' | 'modified' | 'deleted' | 'renamed';

export interface CommitSuggestionFile {
  path: string;
  change: SuggestedFileChange;
}

export interface CommitSuggestionInput {
  files: readonly CommitSuggestionFile[];
}

export interface CommitSuggestion {
  /** A complete message, or a template with `<type>` when the type is not evident. */
  message: string;
  /** Null when the files do not determine a type unambiguously. */
  type: string | null;
  scope: string | null;
  description: string;
  /** Why each part was chosen, shown to the user next to the suggestion. */
  rationale: string[];
}

/**
 * Produces commit message suggestions. Implementations must never commit and
 * their output is always validated and reviewed by the user.
 */
export interface CommitSuggestionProvider {
  readonly id: string;
  suggest(input: CommitSuggestionInput): Promise<CommitSuggestion | null>;
}

export const TYPE_PLACEHOLDER = '<type>';

const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1);

const CATEGORIES: { type: string; label: string; matches: (path: string) => boolean }[] = [
  {
    type: 'docs',
    label: 'documentation files',
    matches: (path) => /\.(md|mdx|rst|adoc)$/i.test(path) || /^docs\//i.test(path),
  },
  {
    type: 'test',
    label: 'test files',
    matches: (path) =>
      /(^|\/)(tests?|__tests__|specs?|e2e)\//i.test(path) ||
      /\.(test|spec)\.[cm]?[jt]sx?$/i.test(path),
  },
  {
    type: 'ci',
    label: 'CI configuration',
    matches: (path) =>
      /^\.github\/workflows\//.test(path) ||
      /^\.circleci\//.test(path) ||
      /^\.gitlab-ci\.ya?ml$/.test(path) ||
      /^azure-pipelines\.ya?ml$/.test(path),
  },
  {
    type: 'build',
    label: 'package manifests and lockfiles',
    matches: (path) =>
      /^(package\.json|package-lock\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|yarn\.lock|npm-shrinkwrap\.json)$/.test(
        basename(path),
      ),
  },
];

/** Package-like folders whose second segment names the scope (`packages/git` → `git`). */
const CONTAINERS = new Set(['packages', 'apps', 'libs', 'services', 'modules']);
const GENERIC_SCOPES = new Set(['src', 'docs', 'tests', 'test', 'lib', '.github']);

function commonScope(paths: readonly string[]): string | null {
  const segments = paths.map((path) => path.split('/'));
  if (segments.some((parts) => parts.length < 2)) return null;
  const [first, second] = segments[0]!;
  if (!segments.every((parts) => parts[0] === first)) return null;
  if (CONTAINERS.has(first!)) {
    return segments.every((parts) => parts.length > 2 && parts[1] === second) ? second! : null;
  }
  return GENERIC_SCOPES.has(first!) ? null : first!;
}

function describe(files: readonly CommitSuggestionFile[]): string {
  const changes = new Set(files.map((file) => file.change));
  const verb =
    changes.size === 1
      ? ({ added: 'add', deleted: 'remove', renamed: 'rename', modified: 'update' } as const)[
          files[0]!.change
        ]
      : 'update';
  const name = basename(files[0]!.path);
  const others = files.length - 1;
  return others === 0
    ? `${verb} ${name}`
    : `${verb} ${name} and ${others} other file${others === 1 ? '' : 's'}`;
}

/**
 * Deterministic strategy (no AI): uses only paths and change types. It names a
 * type only when every file belongs to the same unambiguous category and never
 * claims to know what the change does.
 */
export function suggestCommitMessage(input: CommitSuggestionInput): CommitSuggestion | null {
  const { files } = input;
  if (files.length === 0) return null;
  const rationale: string[] = [];
  const category = CATEGORIES.find((candidate) =>
    files.every((file) => candidate.matches(file.path)),
  );
  const type = category?.type ?? null;
  rationale.push(
    category
      ? `Type "${category.type}": every selected file is one of the ${category.label}.`
      : 'Type not suggested: the selected files do not determine it. Choose one.',
  );
  const scope = commonScope(files.map((file) => file.path));
  if (scope !== null) rationale.push(`Scope "${scope}": every selected file is under it.`);
  const description = describe(files);
  rationale.push('Description: based on file names and change types only. Review it.');
  const prefix = `${type ?? TYPE_PLACEHOLDER}${scope === null ? '' : `(${scope})`}`;
  return { message: `${prefix}: ${description}`, type, scope, description, rationale };
}

export const deterministicSuggestionProvider: CommitSuggestionProvider = {
  id: 'deterministic',
  suggest: async (input) => suggestCommitMessage(input),
};
