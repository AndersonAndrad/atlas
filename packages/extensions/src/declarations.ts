import type { ColorThemeBase } from '@atlas/contracts';
import { safeRelativePath, type ExtensionManifest } from './manifest.js';

const ENTRIES_MAX = 500;

export interface DeclaredLanguage {
  id: string;
  aliases: string[];
  extensions: string[];
  filenames: string[];
  filenamePatterns: string[];
  firstLine: string | null;
  mimetypes: string[];
  configuration: string | null;
}

export interface DeclaredGrammar {
  language: string | null;
  scopeName: string;
  path: string;
  embeddedLanguages: Record<string, string>;
  tokenTypes: Record<string, string>;
  injectTo: string[];
}

export interface DeclaredTheme {
  id: string;
  label: string;
  base: ColorThemeBase;
  path: string;
}

export interface DeclaredIconTheme {
  id: string;
  label: string;
  path: string;
}

export interface DeclaredSnippets {
  index: number;
  language: string | null;
  path: string;
}

export interface Declarations {
  languages: DeclaredLanguage[];
  grammars: DeclaredGrammar[];
  themes: DeclaredTheme[];
  iconThemes: DeclaredIconTheme[];
  snippets: DeclaredSnippets[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const entries = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter(isRecord).slice(0, ENTRIES_MAX) : [];

const LANGUAGE_ID = /^[A-Za-z0-9][A-Za-z0-9_.+#-]{0,99}$/;
const SCOPE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.+-]{0,199}$/;

function strings(value: unknown, max = 200): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string' && item.length > 0)
    .slice(0, 200)
    .map((item) => item.slice(0, max));
}

function stringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value).slice(0, 200)) {
    if (typeof item === 'string' && key.length <= 200) result[key] = item.slice(0, 200);
  }
  return result;
}

const UI_THEMES: Record<string, ColorThemeBase> = {
  vs: 'vs',
  'vs-dark': 'vs-dark',
  'hc-black': 'hc-black',
  'hc-light': 'hc-light',
};

/**
 * The supported contributions a manifest declares, with paths checked to stay inside the
 * extension. Malformed entries are left out.
 */
export function declarationsOf(manifest: ExtensionManifest): Declarations {
  const { contributes } = manifest;
  const languages: DeclaredLanguage[] = [];
  for (const entry of entries(contributes.languages)) {
    if (typeof entry.id !== 'string' || !LANGUAGE_ID.test(entry.id)) continue;
    languages.push({
      id: entry.id,
      aliases: strings(entry.aliases),
      extensions: strings(entry.extensions, 100),
      filenames: strings(entry.filenames),
      filenamePatterns: strings(entry.filenamePatterns),
      firstLine: typeof entry.firstLine === 'string' ? entry.firstLine.slice(0, 500) : null,
      mimetypes: strings(entry.mimetypes),
      configuration: safeRelativePath(entry.configuration),
    });
  }
  const grammars: DeclaredGrammar[] = [];
  for (const entry of entries(contributes.grammars)) {
    const path = safeRelativePath(entry.path);
    if (path === null || typeof entry.scopeName !== 'string' || !SCOPE_NAME.test(entry.scopeName)) {
      continue;
    }
    grammars.push({
      language:
        typeof entry.language === 'string' && LANGUAGE_ID.test(entry.language)
          ? entry.language
          : null,
      scopeName: entry.scopeName,
      path,
      embeddedLanguages: stringMap(entry.embeddedLanguages),
      tokenTypes: stringMap(entry.tokenTypes),
      injectTo: strings(entry.injectTo).filter((scope) => SCOPE_NAME.test(scope)),
    });
  }
  const themes: DeclaredTheme[] = [];
  for (const entry of entries(contributes.themes)) {
    const path = safeRelativePath(entry.path);
    const label = typeof entry.label === 'string' ? entry.label.slice(0, 200) : '';
    if (path === null || label === '') continue;
    const id = typeof entry.id === 'string' && entry.id.length > 0 ? entry.id.slice(0, 200) : label;
    if (id.includes('\0') || /[\r\n]/.test(id)) continue;
    const base = UI_THEMES[typeof entry.uiTheme === 'string' ? entry.uiTheme : ''] ?? 'vs-dark';
    themes.push({ id, label, base, path });
  }
  const iconThemes: DeclaredIconTheme[] = [];
  for (const entry of entries(contributes.iconThemes)) {
    const path = safeRelativePath(entry.path);
    if (path === null || typeof entry.id !== 'string' || entry.id === '') continue;
    if (/[\0\r\n]/.test(entry.id)) continue;
    const label = typeof entry.label === 'string' && entry.label ? entry.label : entry.id;
    iconThemes.push({ id: entry.id.slice(0, 200), label: label.slice(0, 200), path });
  }
  const snippets: DeclaredSnippets[] = [];
  entries(contributes.snippets).forEach((entry, index) => {
    const path = safeRelativePath(entry.path);
    if (path === null) return;
    const language =
      typeof entry.language === 'string' && LANGUAGE_ID.test(entry.language)
        ? entry.language
        : null;
    snippets.push({ index, language, path });
  });
  return { languages, grammars, themes, iconThemes, snippets };
}
