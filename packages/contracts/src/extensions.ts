import { z } from 'zod';
import { ProjectIdSchema } from './project.js';

// ---------------------------------------------------------------------------
// VS Code extension compatibility & Extensions Hub (SDD-015 Milestone A, PLAN-043)
// ---------------------------------------------------------------------------

/**
 * What ATLAS can honestly say about an extension (§3.4). SUPPORTED only comes from the
 * tested compatibility matrix, never from a manifest alone.
 */
export const EXTENSION_COMPATIBILITY_LEVELS = [
  'SUPPORTED',
  'PARTIALLY_SUPPORTED',
  'UNSUPPORTED',
  'UNTESTED',
] as const;
export type ExtensionCompatibilityLevel = (typeof EXTENSION_COMPATIBILITY_LEVELS)[number];

/** Open VSX categories (the registry's fixed list). */
export const EXTENSION_CATEGORIES = [
  'Programming Languages',
  'Snippets',
  'Linters',
  'Themes',
  'Debuggers',
  'Formatters',
  'Keymaps',
  'SCM Providers',
  'Other',
  'Extension Packs',
  'Language Packs',
  'Data Science',
  'Machine Learning',
  'Visualization',
  'Notebooks',
  'Education',
  'Testing',
] as const;
export type ExtensionCategory = (typeof EXTENSION_CATEGORIES)[number];

const NamePart = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'Use letters, digits, "-" or "_".');

/** `publisher.name`, compared without case like VS Code does. */
export const ExtensionIdSchema = z
  .string()
  .max(257)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9_-]*\.[A-Za-z0-9][A-Za-z0-9_-]*$/,
    'Use the extension identifier: publisher.name.',
  );

export const ExtensionVersionSchema = z
  .string()
  .max(64)
  .regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/, 'Use a version such as 1.2.3.');

export function extensionKey(id: string): string {
  return id.toLowerCase();
}

export const ExtensionSearchSchema = z.strictObject({
  query: z.string().trim().max(200).default(''),
  category: z.enum(EXTENSION_CATEGORIES).nullable().default(null),
  /** Only this publisher's (namespace's) extensions. */
  publisher: NamePart.nullable().default(null),
  offset: z.int().min(0).max(1000).default(0),
  size: z.int().min(1).max(50).default(20),
});
export type ExtensionSearchInput = z.input<typeof ExtensionSearchSchema>;

export const ExtensionDetailsSchema = z.strictObject({
  id: ExtensionIdSchema,
  /** Null for the latest version. */
  version: ExtensionVersionSchema.nullable().default(null),
});
export type ExtensionDetailsInput = z.input<typeof ExtensionDetailsSchema>;

export const InstallExtensionSchema = ExtensionDetailsSchema;
export type InstallExtensionInput = z.input<typeof InstallExtensionSchema>;

export const ListExtensionsSchema = z.strictObject({
  /** Reports whether each extension is enabled in this project. */
  projectId: ProjectIdSchema.nullable(),
});
export type ListExtensionsInput = z.input<typeof ListExtensionsSchema>;

/**
 * Global switch (projectId null) or a project override. A null `enabled` removes the
 * override, so the project follows the global switch again (FR-1514).
 */
export const SetExtensionEnabledSchema = z
  .strictObject({
    id: ExtensionIdSchema,
    projectId: ProjectIdSchema.nullable(),
    enabled: z.boolean().nullable(),
  })
  .refine((input) => input.projectId !== null || input.enabled !== null, {
    message: 'Choose enabled or disabled.',
    path: ['enabled'],
  });
export type SetExtensionEnabledInput = z.input<typeof SetExtensionEnabledSchema>;

export const ContributionsQuerySchema = z.strictObject({ projectId: ProjectIdSchema.nullable() });
export type ContributionsQuery = z.input<typeof ContributionsQuerySchema>;

/** `<extension id>/<theme id>`: a color or file icon theme contributed by an extension. */
export const ExtensionThemeKeySchema = z
  .string()
  .min(3)
  .max(400)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*\.[A-Za-z0-9][A-Za-z0-9_-]*\/[^\0\r\n]+$/);

export const GrammarRefSchema = z.strictObject({
  extensionId: ExtensionIdSchema,
  scopeName: z.string().min(1).max(200),
});
export type GrammarRef = z.input<typeof GrammarRefSchema>;

export const SnippetsRefSchema = z.strictObject({
  extensionId: ExtensionIdSchema,
  /** Position of the file in the manifest's `contributes.snippets`. */
  index: z.int().min(0).max(1000),
});
export type SnippetsRef = z.input<typeof SnippetsRefSchema>;

export const LanguageConfigurationRefSchema = z.strictObject({
  extensionId: ExtensionIdSchema,
  language: z.string().min(1).max(100),
});
export type LanguageConfigurationRef = z.input<typeof LanguageConfigurationRefSchema>;

export const IconRefSchema = z.strictObject({
  theme: ExtensionThemeKeySchema,
  iconId: z.string().min(1).max(300),
});
export type IconRef = z.input<typeof IconRefSchema>;

export const EXTENSION_PROBLEM_CODES = [
  'GRAMMAR_FAILED',
  'THEME_FAILED',
  'SNIPPETS_FAILED',
  'LANGUAGE_CONFIGURATION_FAILED',
  'ICON_THEME_FAILED',
] as const;

/** A contribution the editor could not apply, reported by the window (FR-1515). */
export const ReportExtensionProblemSchema = z.strictObject({
  extensionId: ExtensionIdSchema,
  code: z.enum(EXTENSION_PROBLEM_CODES),
  message: z.string().max(300),
});
export type ReportExtensionProblemInput = z.input<typeof ReportExtensionProblemSchema>;

// --- Results ---------------------------------------------------------------

export interface ExtensionTestRecord {
  extensionVersion: string;
  platform: string;
  atlasVersion: string;
  testedAt: string;
}

export interface ExtensionCompatibility {
  level: ExtensionCompatibilityLevel;
  /** The package runs code (`main` or `browser`), which ATLAS does not run yet. */
  executable: boolean;
  /** What works in ATLAS, e.g. "Color theme: Dracula". */
  working: string[];
  /** What the extension provides that ATLAS does not support. */
  unsupported: string[];
  notes: string[];
  /** Set only when this exact version is in the tested matrix. */
  tested: ExtensionTestRecord | null;
}

export interface RegistryExtensionSummary {
  id: string;
  namespace: string;
  name: string;
  displayName: string;
  description: string;
  version: string;
  verified: boolean;
  deprecated: boolean;
  publishedAt: string | null;
}

export interface ExtensionSearchResult {
  extensions: RegistryExtensionSummary[];
  total: number;
  offset: number;
}

export interface ExtensionDependency {
  id: string;
  installed: boolean;
}

export interface RegistryExtensionDetails extends RegistryExtensionSummary {
  /** Newest first, at most 100. */
  versions: string[];
  categories: string[];
  license: string | null;
  homepage: string | null;
  repository: string | null;
  /** Platforms with a package; `universal` means one package for every system. */
  platforms: string[];
  /** The package for this system, or null when there is none. */
  platform: string | null;
  dependencies: ExtensionDependency[];
  /** Extensions an extension pack lists; they are installed one by one. */
  packMembers: ExtensionDependency[];
  preRelease: boolean;
  compatibility: ExtensionCompatibility;
  installed: { version: string; enabled: boolean } | null;
}

export interface ExtensionContributionCounts {
  themes: number;
  iconThemes: number;
  grammars: number;
  languages: number;
  snippets: number;
}

export interface InstalledExtension {
  id: string;
  namespace: string;
  name: string;
  displayName: string;
  description: string;
  version: string;
  platform: string;
  license: string | null;
  compatibility: ExtensionCompatibility;
  /** The global switch. */
  enabled: boolean;
  /** Project overrides. */
  projects: { projectId: string; enabled: boolean }[];
  /** Whether it is active in the project of the query (or globally without one). */
  activeHere: boolean;
  contributes: ExtensionContributionCounts;
  dependencies: string[];
  /** Dependencies that are not installed. */
  missingDependencies: string[];
  /** Installed files are missing or unreadable; nothing it contributes is used. */
  broken: boolean;
  problems: number;
  installedAt: string;
  updatedAt: string;
}

export interface ExtensionUpdate {
  id: string;
  installedVersion: string;
  latestVersion: string;
  compatibility: ExtensionCompatibility;
}

export interface ExtensionUpdateCheck {
  updates: ExtensionUpdate[];
  /** Extensions the registry could not answer for. */
  failed: string[];
  checkedAt: string;
}

export interface ContributedLanguage {
  extensionId: string;
  id: string;
  aliases: string[];
  extensions: string[];
  filenames: string[];
  filenamePatterns: string[];
  firstLine: string | null;
  mimetypes: string[];
  hasConfiguration: boolean;
}

export interface ContributedGrammar {
  extensionId: string;
  language: string | null;
  scopeName: string;
  embeddedLanguages: Record<string, string>;
  tokenTypes: Record<string, string>;
  injectTo: string[];
}

export type ColorThemeBase = 'vs' | 'vs-dark' | 'hc-black' | 'hc-light';

export interface ContributedTheme {
  key: string;
  extensionId: string;
  label: string;
  base: ColorThemeBase;
}

export interface ContributedIconTheme {
  key: string;
  extensionId: string;
  label: string;
}

export interface ContributedSnippets {
  extensionId: string;
  index: number;
  /** Null: every language. */
  language: string | null;
}

/** What the enabled extensions of a project add to the editor (FR-1507–FR-1511). */
export interface ExtensionContributions {
  /** Changes whenever the set of contributions changes. */
  revision: string;
  languages: ContributedLanguage[];
  grammars: ContributedGrammar[];
  themes: ContributedTheme[];
  iconThemes: ContributedIconTheme[];
  snippets: ContributedSnippets[];
}

export interface GrammarSource {
  format: 'json' | 'plist';
  content: string;
}

export interface TokenColorRule {
  scopes: string[];
  foreground: string | null;
  background: string | null;
  fontStyle: string | null;
}

export interface ResolvedColorTheme {
  key: string;
  label: string;
  base: ColorThemeBase;
  colors: Record<string, string>;
  tokenColors: TokenColorRule[];
  /** Theme features ATLAS ignores, e.g. "semantic token colors". */
  unsupported: string[];
}

export interface ResolvedSnippet {
  name: string;
  prefixes: string[];
  body: string;
  description: string | null;
  /** Languages from the snippet's own `scope`, or null. */
  scopes: string[] | null;
}

export interface ResolvedSnippets {
  language: string | null;
  snippets: ResolvedSnippet[];
  /** Snippets left out because their syntax is not supported. */
  skipped: number;
}

export interface ResolvedIconTheme {
  key: string;
  label: string;
  file: string | null;
  folder: string | null;
  folderExpanded: string | null;
  rootFolder: string | null;
  rootFolderExpanded: string | null;
  fileExtensions: Record<string, string>;
  fileNames: Record<string, string>;
  folderNames: Record<string, string>;
  folderNamesExpanded: Record<string, string>;
  languageIds: Record<string, string>;
  /** Icons drawn from SVG or PNG files; others (fonts) fall back to ATLAS icons. */
  images: string[];
  unsupported: string[];
}

export interface ExtensionDiagnostic {
  id: number;
  extensionId: string;
  level: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  createdAt: string;
}
