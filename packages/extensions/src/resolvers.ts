import type {
  ColorThemeBase,
  GrammarSource,
  ResolvedColorTheme,
  ResolvedIconTheme,
  ResolvedSnippet,
  ResolvedSnippets,
  TokenColorRule,
} from '@atlas/contracts';
import { AtlasError } from '@atlas/shared';
import { folderOf, parseJsonWithComments, safeRelativePath } from './manifest.js';

/** Reads a file of one installed extension by relative path, at most `maxBytes`. */
export type ExtensionFileReader = (relativePath: string, maxBytes: number) => Promise<Uint8Array>;

export const THEME_FILE_MAX_BYTES = 2 * 1024 * 1024;
export const GRAMMAR_FILE_MAX_BYTES = 8 * 1024 * 1024;
export const SNIPPETS_FILE_MAX_BYTES = 2 * 1024 * 1024;
export const LANGUAGE_CONFIGURATION_MAX_BYTES = 512 * 1024;
export const ICON_THEME_FILE_MAX_BYTES = 4 * 1024 * 1024;
export const ICON_FILE_MAX_BYTES = 256 * 1024;

const THEME_INCLUDE_DEPTH = 5;
const COLORS_MAX = 3000;
const TOKEN_RULES_MAX = 5000;
const SNIPPETS_MAX = 5000;
const SNIPPET_BODY_MAX = 20_000;
const ICON_MAP_MAX = 20_000;

const decoder = new TextDecoder('utf-8', { fatal: false });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

function invalid(message: string): AtlasError {
  return new AtlasError('EXTENSION_CONTRIBUTION_UNAVAILABLE', message);
}

async function readJson(read: ExtensionFileReader, path: string, max: number): Promise<unknown> {
  const content = decoder.decode(await read(path, max));
  try {
    return parseJsonWithComments(content);
  } catch {
    throw invalid(`Invalid JSON in ${path}.`);
  }
}

function tokenRule(entry: unknown): TokenColorRule | null {
  if (!isRecord(entry) || !isRecord(entry.settings)) return null;
  const scopes = (Array.isArray(entry.scope) ? entry.scope : [entry.scope ?? ''])
    .filter((scope): scope is string => typeof scope === 'string')
    .flatMap((scope) => scope.split(','))
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0 && scope.length <= 300)
    .slice(0, 200);
  const color = (value: unknown) =>
    typeof value === 'string' && COLOR.test(value) ? value.toLowerCase() : null;
  const fontStyle =
    typeof entry.settings.fontStyle === 'string' && /^[a-z ]{0,60}$/i.test(entry.settings.fontStyle)
      ? entry.settings.fontStyle.trim()
      : null;
  const rule = {
    scopes,
    foreground: color(entry.settings.foreground),
    background: color(entry.settings.background),
    fontStyle,
  };
  return rule.foreground === null && rule.background === null && rule.fontStyle === null
    ? null
    : rule;
}

interface ThemeParts {
  colors: Record<string, string>;
  tokenColors: TokenColorRule[];
  unsupported: Set<string>;
}

async function themeParts(
  read: ExtensionFileReader,
  path: string,
  depth: number,
): Promise<ThemeParts> {
  if (depth > THEME_INCLUDE_DEPTH) throw invalid('The theme includes too many other themes.');
  if (/\.(tmTheme|plist|xml)$/i.test(path)) {
    throw invalid('Themes in TextMate (plist) format are not supported.');
  }
  const raw = await readJson(read, path, THEME_FILE_MAX_BYTES);
  if (!isRecord(raw)) throw invalid('The theme file is not a JSON object.');
  const parts: ThemeParts = { colors: {}, tokenColors: [], unsupported: new Set() };
  if (raw.include !== undefined) {
    const included = safeRelativePath(raw.include, folderOf(path));
    if (included === null) throw invalid('The theme includes a file outside the extension.');
    const base = await themeParts(read, included, depth + 1);
    Object.assign(parts.colors, base.colors);
    parts.tokenColors.push(...base.tokenColors);
    for (const item of base.unsupported) parts.unsupported.add(item);
  }
  if (isRecord(raw.colors)) {
    for (const [key, value] of Object.entries(raw.colors)) {
      if (Object.keys(parts.colors).length >= COLORS_MAX) break;
      if (/^[A-Za-z0-9.]{1,100}$/.test(key) && typeof value === 'string' && COLOR.test(value)) {
        parts.colors[key] = value.toLowerCase();
      }
    }
  }
  if (Array.isArray(raw.tokenColors)) {
    for (const entry of raw.tokenColors) {
      if (parts.tokenColors.length >= TOKEN_RULES_MAX) break;
      const rule = tokenRule(entry);
      if (rule !== null) parts.tokenColors.push(rule);
    }
  } else if (typeof raw.tokenColors === 'string') {
    parts.unsupported.add('Token colors in a separate TextMate file');
  }
  if (raw.semanticHighlighting === true || raw.semanticTokenColors !== undefined) {
    parts.unsupported.add('Semantic token colors');
  }
  return parts;
}

/** A color theme with its `include` chain merged (FR-1507). */
export async function resolveColorTheme(
  read: ExtensionFileReader,
  theme: { key: string; label: string; base: ColorThemeBase; path: string },
): Promise<ResolvedColorTheme> {
  const parts = await themeParts(read, theme.path, 0);
  return {
    key: theme.key,
    label: theme.label,
    base: theme.base,
    colors: parts.colors,
    tokenColors: parts.tokenColors,
    unsupported: [...parts.unsupported],
  };
}

/** A TextMate grammar as text; the editor's tokenizer parses it (FR-1509). */
export async function readGrammar(read: ExtensionFileReader, path: string): Promise<GrammarSource> {
  const content = decoder.decode(await read(path, GRAMMAR_FILE_MAX_BYTES));
  if (/\.json$/i.test(path)) {
    try {
      JSON.parse(content);
    } catch {
      throw invalid(`Invalid JSON in ${path}.`);
    }
    return { format: 'json', content };
  }
  if (!content.trimStart().startsWith('<')) throw invalid(`${path} is not a TextMate grammar.`);
  return { format: 'plist', content };
}

/**
 * Whether ATLAS's editor can insert a snippet body: its `${` placeholders must close.
 * Other syntax (choices, variables, transforms) is understood by the editor.
 */
export function isSupportedSnippetBody(body: string): boolean {
  let depth = 0;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === '\\') {
      index += 1;
    } else if (char === '$' && body[index + 1] === '{') {
      depth += 1;
      index += 1;
    } else if (char === '}' && depth > 0) {
      depth -= 1;
    }
  }
  return depth === 0;
}

const joinText = (value: unknown): string | null =>
  typeof value === 'string'
    ? value
    : Array.isArray(value) && value.every((item) => typeof item === 'string')
      ? value.join('\n')
      : null;

/** A snippets file (FR-1510); unsupported entries are counted, not loaded. */
export async function resolveSnippets(
  read: ExtensionFileReader,
  file: { path: string; language: string | null },
): Promise<ResolvedSnippets> {
  const raw = await readJson(read, file.path, SNIPPETS_FILE_MAX_BYTES);
  if (!isRecord(raw)) throw invalid('The snippets file is not a JSON object.');
  const snippets: ResolvedSnippet[] = [];
  let skipped = 0;
  for (const [name, entry] of Object.entries(raw)) {
    if (snippets.length >= SNIPPETS_MAX) {
      skipped += 1;
      continue;
    }
    if (!isRecord(entry)) {
      skipped += 1;
      continue;
    }
    const prefixes = (Array.isArray(entry.prefix) ? entry.prefix : [entry.prefix])
      .filter((prefix): prefix is string => typeof prefix === 'string')
      .map((prefix) => prefix.trim())
      .filter((prefix) => prefix.length > 0 && prefix.length <= 100)
      .slice(0, 20);
    const body = joinText(entry.body);
    if (
      prefixes.length === 0 ||
      body === null ||
      body.length > SNIPPET_BODY_MAX ||
      !isSupportedSnippetBody(body)
    ) {
      skipped += 1;
      continue;
    }
    const description = joinText(entry.description);
    const scopes =
      typeof entry.scope === 'string' && entry.scope.trim() !== ''
        ? entry.scope
            .split(',')
            .map((scope) => scope.trim())
            .filter(Boolean)
            .slice(0, 50)
        : null;
    snippets.push({
      name: name.slice(0, 200),
      prefixes,
      body,
      description: description === null ? null : description.slice(0, 1000),
      scopes,
    });
  }
  return { language: file.language, snippets, skipped };
}

const LANGUAGE_CONFIGURATION_KEYS = [
  'comments',
  'brackets',
  'colorizedBracketPairs',
  'autoClosingPairs',
  'autoCloseBefore',
  'surroundingPairs',
  'folding',
  'wordPattern',
  'indentationRules',
  'onEnterRules',
] as const;

/** `language-configuration.json` limited to the keys the editor maps (FR-1511). */
export async function resolveLanguageConfiguration(
  read: ExtensionFileReader,
  path: string,
): Promise<Record<string, unknown>> {
  const raw = await readJson(read, path, LANGUAGE_CONFIGURATION_MAX_BYTES);
  if (!isRecord(raw)) throw invalid('The language configuration is not a JSON object.');
  const result: Record<string, unknown> = {};
  for (const key of LANGUAGE_CONFIGURATION_KEYS) {
    if (raw[key] !== undefined) result[key] = raw[key];
  }
  return result;
}

/** A file icon theme with the files behind each image icon (FR-1508, PLAN-043 Q3). */
export interface IconThemeData {
  theme: ResolvedIconTheme;
  /** Icon id → path of its SVG or PNG file inside the extension. */
  imagePaths: Map<string, string>;
}

function iconMap(value: unknown, known: Set<string>, lower: boolean): Record<string, string> {
  if (!isRecord(value)) return {};
  const result: Record<string, string> = {};
  let count = 0;
  for (const [key, id] of Object.entries(value)) {
    if (count >= ICON_MAP_MAX) break;
    if (typeof id !== 'string' || !known.has(id) || key.length === 0 || key.length > 300) continue;
    result[lower ? key.toLowerCase() : key] = id;
    count += 1;
  }
  return result;
}

export async function resolveIconTheme(
  read: ExtensionFileReader,
  theme: { key: string; label: string; path: string },
): Promise<IconThemeData> {
  const raw = await readJson(read, theme.path, ICON_THEME_FILE_MAX_BYTES);
  if (!isRecord(raw)) throw invalid('The icon theme is not a JSON object.');
  const unsupported = new Set<string>();
  const imagePaths = new Map<string, string>();
  const known = new Set<string>();
  const definitions = isRecord(raw.iconDefinitions) ? raw.iconDefinitions : {};
  for (const [id, definition] of Object.entries(definitions)) {
    if (!isRecord(definition) || id.length > 300) continue;
    if (typeof definition.iconPath === 'string') {
      const path = safeRelativePath(definition.iconPath, folderOf(theme.path));
      if (path !== null && /\.(svg|png)$/i.test(path)) {
        imagePaths.set(id, path);
        known.add(id);
        continue;
      }
      unsupported.add('Icons that are not SVG or PNG files');
    } else if (definition.fontCharacter !== undefined) {
      unsupported.add('Font icons');
    }
  }
  if (raw.light !== undefined || raw.highContrast !== undefined) {
    unsupported.add('Light and high contrast icon variants');
  }
  if (raw.fonts !== undefined && imagePaths.size === 0) unsupported.add('Icon fonts');
  const single = (value: unknown) => (typeof value === 'string' && known.has(value) ? value : null);
  return {
    theme: {
      key: theme.key,
      label: theme.label,
      file: single(raw.file),
      folder: single(raw.folder),
      folderExpanded: single(raw.folderExpanded),
      rootFolder: single(raw.rootFolder),
      rootFolderExpanded: single(raw.rootFolderExpanded),
      fileExtensions: iconMap(raw.fileExtensions, known, true),
      fileNames: iconMap(raw.fileNames, known, true),
      folderNames: iconMap(raw.folderNames, known, true),
      folderNamesExpanded: iconMap(raw.folderNamesExpanded, known, true),
      languageIds: iconMap(raw.languageIds, known, false),
      images: [...imagePaths.keys()],
      unsupported: [...unsupported],
    },
    imagePaths,
  };
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * An icon as a `data:` URI. SVG shown through `<img>` cannot run scripts; anything that is
 * not recognizably SVG or PNG is refused.
 */
export function iconDataUri(path: string, bytes: Uint8Array): string {
  const base64 = Buffer.from(bytes).toString('base64');
  if (/\.png$/i.test(path)) {
    if (!PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) {
      throw invalid('The icon is not a PNG image.');
    }
    return `data:image/png;base64,${base64}`;
  }
  const head = decoder.decode(bytes.subarray(0, 4096)).replace(/^\uFEFF/, '');
  if (!/<svg[\s>]/i.test(head)) throw invalid('The icon is not an SVG image.');
  return `data:image/svg+xml;base64,${base64}`;
}
