import type { ExtensionCompatibility, ExtensionTestRecord } from '@atlas/contracts';
import { declarationsOf } from './declarations.js';
import { SUPPORTED_CONTRIBUTION_POINTS, manifestKey, type ExtensionManifest } from './manifest.js';

/** An extension version checked by hand or by the opt-in registry test (FR-1547). */
export interface TestedExtension extends ExtensionTestRecord {
  id: string;
  limitations: string[];
}

const LIST_MAX = 40;

const CONTRIBUTION_LABELS: Record<string, string> = {
  commands: 'Commands',
  keybindings: 'Keyboard shortcuts',
  menus: 'Menus',
  submenus: 'Menus',
  configuration: 'Settings',
  configurationDefaults: 'Default settings',
  views: 'Views',
  viewsContainers: 'Views',
  viewsWelcome: 'Views',
  debuggers: 'Debuggers',
  breakpoints: 'Debuggers',
  taskDefinitions: 'Tasks',
  problemMatchers: 'Problem matchers',
  problemPatterns: 'Problem matchers',
  jsonValidation: 'JSON schema validation',
  productIconThemes: 'Product icon themes',
  colors: 'Custom colors',
  semanticTokenTypes: 'Semantic highlighting',
  semanticTokenModifiers: 'Semantic highlighting',
  semanticTokenScopes: 'Semantic highlighting',
  customEditors: 'Custom editors',
  walkthroughs: 'Walkthroughs',
  notebooks: 'Notebooks',
  notebookRenderer: 'Notebooks',
  terminal: 'Terminal profiles',
  localizations: 'Translations (language packs)',
  authentication: 'Authentication providers',
  resourceLabelFormatters: 'Resource labels',
  typescriptServerPlugins: 'TypeScript server plugins',
  icons: 'Product icons',
  iconFonts: 'Product icons',
};

function capped(items: string[]): string[] {
  const unique = [...new Set(items)];
  if (unique.length <= LIST_MAX) return unique;
  return [...unique.slice(0, LIST_MAX), `and ${unique.length - LIST_MAX} more`];
}

/**
 * What ATLAS can use from a manifest, before or after installing (FR-1512). The level is
 * SUPPORTED only for a version in the tested matrix: a manifest that parses proves
 * nothing about how well it works.
 */
export function evaluateCompatibility(
  manifest: ExtensionManifest,
  tested: readonly TestedExtension[],
  platform: string,
): ExtensionCompatibility {
  const declared = declarationsOf(manifest);
  const working: string[] = [];
  const unsupported: string[] = [];
  const notes: string[] = [];

  for (const theme of declared.themes) {
    if (/\.(tmTheme|plist|xml)$/i.test(theme.path)) {
      unsupported.push(`Color theme in TextMate format: ${theme.label}`);
    } else {
      working.push(`Color theme: ${theme.label}`);
    }
  }
  for (const theme of declared.iconThemes) working.push(`File icon theme: ${theme.label}`);
  for (const grammar of declared.grammars) {
    working.push(
      grammar.language === null
        ? `Syntax highlighting injected into other languages (${grammar.scopeName})`
        : `Syntax highlighting: ${grammar.language}`,
    );
  }
  for (const language of declared.languages) {
    const name = language.aliases[0] ?? language.id;
    working.push(
      language.configuration === null
        ? `Language: ${name}`
        : `Language: ${name} (comments, brackets and indentation)`,
    );
  }
  for (const file of declared.snippets) {
    working.push(`Snippets: ${file.language ?? 'all languages'}`);
  }

  const supported = new Set<string>(SUPPORTED_CONTRIBUTION_POINTS);
  for (const key of manifest.contributionKeys) {
    if (!supported.has(key)) unsupported.push(CONTRIBUTION_LABELS[key] ?? `Contribution "${key}"`);
  }
  const executable = manifest.main !== null || manifest.browser !== null;
  if (executable) {
    unsupported.unshift('Extension code (commands, language features and anything it runs)');
    notes.push('ATLAS does not run extension code yet. Only the parts listed as working are used.');
  }
  if (declared.iconThemes.length > 0) {
    notes.push('File icon themes show SVG and PNG icons; font icons use the ATLAS icons.');
  }
  if (declared.themes.length > 0) {
    notes.push('Color themes change the code editor only, not the rest of ATLAS.');
  }
  if (manifest.extensionPack.length > 0) {
    notes.push('This is an extension pack: install the extensions it lists one by one.');
  }
  if (manifest.extensionDependencies.length > 0) {
    notes.push(`Needs: ${manifest.extensionDependencies.slice(0, 20).join(', ')}.`);
  }

  const key = manifestKey(manifest);
  const record =
    tested.find(
      (entry) =>
        entry.id.toLowerCase() === key &&
        entry.extensionVersion === manifest.version &&
        (entry.platform === 'universal' || entry.platform === platform),
    ) ?? null;
  if (record !== null) notes.push(...record.limitations);

  const level =
    working.length === 0
      ? 'UNSUPPORTED'
      : record !== null
        ? 'SUPPORTED'
        : unsupported.length > 0
          ? 'PARTIALLY_SUPPORTED'
          : 'UNTESTED';
  return {
    level,
    executable,
    working: capped(working),
    unsupported: capped(unsupported),
    notes,
    tested:
      record === null
        ? null
        : {
            extensionVersion: record.extensionVersion,
            platform: record.platform,
            atlasVersion: record.atlasVersion,
            testedAt: record.testedAt,
          },
  };
}
