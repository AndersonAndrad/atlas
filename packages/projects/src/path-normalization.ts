import path from 'node:path';

export type PathPlatform = 'win32' | 'darwin' | 'linux';

export function toPathPlatform(platform: NodeJS.Platform): PathPlatform {
  if (platform === 'win32' || platform === 'darwin') return platform;
  // Other POSIX platforms (freebsd, openbsd, ...) follow Linux semantics.
  return 'linux';
}

function pathApi(platform: PathPlatform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}

const WIN32_LONG_PATH_PREFIX = '\\\\?\\';
const WIN32_LONG_UNC_PREFIX = '\\\\?\\UNC\\';

export function isAbsoluteForPlatform(input: string, platform: PathPlatform): boolean {
  return pathApi(platform).isAbsolute(input);
}

/** Normalizes separators, `.`/`..` segments and trailing separators without touching case. */
export function normalizeAbsolutePath(input: string, platform: PathPlatform): string {
  const api = pathApi(platform);
  let value = input;
  if (platform === 'win32') {
    if (value.startsWith(WIN32_LONG_UNC_PREFIX)) {
      value = `\\\\${value.slice(WIN32_LONG_UNC_PREFIX.length)}`;
    } else if (value.startsWith(WIN32_LONG_PATH_PREFIX)) {
      value = value.slice(WIN32_LONG_PATH_PREFIX.length);
    }
  }
  let normalized = api.normalize(value);
  const root = api.parse(normalized).root;
  while (
    normalized.length > root.length &&
    (normalized.endsWith(api.sep) || normalized.endsWith('/'))
  ) {
    normalized = normalized.slice(0, -1);
  }
  if (platform === 'win32' && /^[a-z]:/.test(normalized)) {
    normalized = normalized[0]!.toUpperCase() + normalized.slice(1);
  }
  return normalized;
}

/**
 * Builds the key used to detect duplicate registrations of the same directory.
 *
 * - Windows (NTFS) and macOS (APFS/HFS+ default) are case-insensitive, so keys are case-folded.
 * - macOS file systems are also Unicode-normalization-insensitive, so keys use NFC.
 * - Linux file systems are byte-exact: the key is the normalized path itself.
 *
 * The input is expected to be already symlink-resolved (realpath) by the caller.
 */
export function toPathKey(absolutePath: string, platform: PathPlatform): string {
  const normalized = normalizeAbsolutePath(absolutePath, platform);
  switch (platform) {
    case 'win32':
      return normalized.toLowerCase();
    case 'darwin':
      return normalized.normalize('NFC').toLowerCase();
    case 'linux':
      return normalized;
  }
}

/** Last path segment, used as a default project name. */
export function directoryName(absolutePath: string, platform: PathPlatform): string {
  const normalized = normalizeAbsolutePath(absolutePath, platform);
  return pathApi(platform).basename(normalized) || normalized;
}
