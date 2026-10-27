import { extensionKey } from '@atlas/contracts';
import { AtlasError } from '@atlas/shared';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';

/** Contribution points ATLAS applies in Milestone A (FR-1507–FR-1511). */
export const SUPPORTED_CONTRIBUTION_POINTS = [
  'languages',
  'grammars',
  'themes',
  'iconThemes',
  'snippets',
] as const;
type SupportedPoint = (typeof SUPPORTED_CONTRIBUTION_POINTS)[number];

const MANIFEST_MAX_BYTES = 2 * 1024 * 1024;
const LIST_MAX = 1000;
const TEXT_MAX = 2000;

/** The parts of a `package.json` ATLAS reads, already bounded and checked. */
export interface ExtensionManifest {
  publisher: string;
  name: string;
  version: string;
  displayName: string;
  description: string;
  /** Code entry points: when present, the extension runs code. */
  main: string | null;
  browser: string | null;
  categories: string[];
  extensionDependencies: string[];
  extensionPack: string[];
  license: string | null;
  /** Every contribution point the manifest declares, supported or not. */
  contributionKeys: string[];
  /** Only the supported contribution points, as declared. */
  contributes: Partial<Record<SupportedPoint, unknown>>;
}

export function manifestKey(manifest: Pick<ExtensionManifest, 'publisher' | 'name'>): string {
  return extensionKey(`${manifest.publisher}.${manifest.name}`);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function text(value: unknown, max = TEXT_MAX): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function textOrNull(value: unknown, max = TEXT_MAX): string | null {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, max) : null;
}

function textList(value: unknown, max = 200): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string' && item.length > 0)
    .slice(0, LIST_MAX)
    .map((item) => item.slice(0, max));
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*\.[A-Za-z0-9][A-Za-z0-9_-]*$/;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/** JSON with comments and trailing commas, as VS Code accepts in contribution files. */
export function parseJsonWithComments(content: string): unknown {
  const errors: ParseError[] = [];
  const value: unknown = parseJsonc(content, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0) {
    throw new AtlasError('EXTENSION_PACKAGE_INVALID', 'Invalid JSON in an extension file.', {
      details: { offset: errors[0]?.offset, error: errors[0]?.error },
    });
  }
  return value;
}

/**
 * Reads an extension `package.json`. Rejects manifests without a valid identity; every
 * other field is optional and trimmed to safe sizes.
 */
export function parseManifest(content: string): ExtensionManifest {
  if (content.length > MANIFEST_MAX_BYTES) {
    throw new AtlasError('EXTENSION_PACKAGE_INVALID', 'The extension manifest is too large.');
  }
  const raw = parseJsonWithComments(content);
  if (!isRecord(raw)) {
    throw new AtlasError('EXTENSION_PACKAGE_INVALID', 'The extension manifest is not an object.');
  }
  const publisher = text(raw.publisher, 200);
  const name = text(raw.name, 200);
  const version = text(raw.version, 64);
  if (!NAME_PATTERN.test(publisher) || !NAME_PATTERN.test(name) || !VERSION_PATTERN.test(version)) {
    throw new AtlasError(
      'EXTENSION_PACKAGE_INVALID',
      'The extension manifest has no valid identity.',
    );
  }
  const contributes = isRecord(raw.contributes) ? raw.contributes : {};
  const supported: Partial<Record<SupportedPoint, unknown>> = {};
  for (const point of SUPPORTED_CONTRIBUTION_POINTS) {
    if (point in contributes) supported[point] = contributes[point];
  }
  const license = isRecord(raw.license) ? text(raw.license.type, 200) : text(raw.license, 200);
  return {
    publisher,
    name,
    version,
    displayName: text(raw.displayName, 200) || name,
    description: text(raw.description),
    main: textOrNull(raw.main, 500),
    browser: textOrNull(raw.browser, 500),
    categories: textList(raw.categories, 100),
    extensionDependencies: textList(raw.extensionDependencies).filter((id) => ID_PATTERN.test(id)),
    extensionPack: textList(raw.extensionPack).filter((id) => ID_PATTERN.test(id)),
    license: license || null,
    contributionKeys: Object.keys(contributes)
      .slice(0, 200)
      .map((key) => key.slice(0, 100)),
    contributes: supported,
  };
}

/**
 * A path inside the extension as POSIX text without `..`, or null. Extension files are
 * read only through such paths; the store also checks the real path on disk.
 */
export function safeRelativePath(value: unknown, base = ''): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1000) return null;
  if (value.includes('\0') || value.includes('\\')) return null;
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) return null;
  const segments: string[] = base === '' ? [] : base.split('/');
  for (const segment of value.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) return null;
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return segments.length === 0 ? null : segments.join('/');
}

/** Folder of a relative file path ('' at the root). */
export function folderOf(relativePath: string): string {
  const index = relativePath.lastIndexOf('/');
  return index < 0 ? '' : relativePath.slice(0, index);
}
