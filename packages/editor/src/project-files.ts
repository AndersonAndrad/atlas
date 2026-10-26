import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import {
  CreateEntrySchema,
  FILE_EDITABLE_MAX_BYTES,
  FILE_FIND_LIMIT_MAX,
  FILE_LIST_MAX,
  FileRefSchema,
  FileVersionsSchema,
  FindFilesSchema,
  ListDirectorySchema,
  MoveEntrySchema,
  WatchFilesSchema,
  WriteFileSchema,
  parseInput,
  type CreateEntryInput,
  type DirectoryListing,
  type FileContent,
  type FileEntry,
  type FileRef,
  type FileVersionInfo,
  type FileVersionsInput,
  type FindFilesInput,
  type FoundFiles,
  type ListDirectoryInput,
  type MoveEntryInput,
  type WatchFilesInput,
  type WriteFileInput,
  type WrittenFile,
} from '@atlas/contracts';
import { AtlasError, describeError, type Logger } from '@atlas/shared';
import { bestMatches } from './fuzzy.js';
import type { EditorWorkspaces, ProjectIgnoreRules } from './ports.js';
import { contentVersion, decodeText, encodeText } from './text.js';
import type { FileWatchHub } from './watch-hub.js';

/** Hidden in folders outside Git repositories (FR-1103); `.git` is always hidden. */
export const DEFAULT_IGNORED_NAMES: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.cache',
  '.next',
  '.nuxt',
  '.turbo',
  '.parcel-cache',
  '.vite',
  '__pycache__',
  '.pytest_cache',
  '.venv',
  '.gradle',
]);
const ALWAYS_IGNORED = '.git';
/** Temporary files of safe writes; never reported as changes. */
export const TEMP_FILE_PATTERN = /^\..+\.atlas-[0-9a-f]{12}\.tmp$/;

/** Files searched by quick open in folders that are not repositories. */
const WALK_MAX_FILES = 50_000;
const WALK_DEADLINE_MS = 3000;
/** Quick open reuses the project's file list for this long. */
const FILE_LIST_TTL_MS = 5000;

export interface ProjectFilesOptions {
  workspaces: EditorWorkspaces;
  ignore: ProjectIgnoreRules;
  watcher: FileWatchHub;
  logger: Logger;
  /** Called after ATLAS changed files of a project, e.g. to refresh its Git status. */
  onChanged?: (projectRoot: string) => void;
  now?: () => number;
}

/** Where an entry is: its folder resolved through symbolic links, and its own name. */
interface Located {
  root: string;
  /** `parent/name`, with `parent` resolved; `name` itself is not followed. */
  absolute: string;
}

/**
 * Files of registered projects (SDD-011 Milestone A). Every path is relative to the
 * project folder and checked after resolving symbolic links, so nothing outside the
 * folder is read, written or listed. Writes never replace content the user did not see.
 */
export class ProjectFiles {
  private readonly fileLists = new Map<
    string,
    { at: number; result: Promise<{ paths: string[]; truncated: boolean }> }
  >();

  constructor(private readonly options: ProjectFilesOptions) {}

  async list(input: ListDirectoryInput): Promise<DirectoryListing> {
    const parsed = parseInput(ListDirectorySchema, input);
    const root = await this.root(parsed.projectId);
    const directory = await this.existing(root, parsed.path);
    let dirents;
    try {
      dirents = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      throw fileError(error, { operation: 'list' });
    }
    const showHidden = parsed.showHidden ?? true;
    const visible = dirents.filter((entry) => showHidden || !entry.name.startsWith('.'));
    const names = visible.map((entry) => entry.name);
    const ignoredByRules = await this.ignoredNames(directory, names);
    const entries: FileEntry[] = [];
    let hiddenIgnored = 0;
    for (const dirent of visible) {
      if (TEMP_FILE_PATTERN.test(dirent.name)) continue;
      const ignored = dirent.name === ALWAYS_IGNORED || ignoredByRules(dirent.name);
      if (ignored && parsed.showIgnored !== true) {
        hiddenIgnored += 1;
        continue;
      }
      const relative = parsed.path === '' ? dirent.name : `${parsed.path}/${dirent.name}`;
      const entry: FileEntry = {
        name: dirent.name,
        path: relative,
        kind: dirent.isDirectory() ? 'directory' : dirent.isFile() ? 'file' : 'other',
        symlink: dirent.isSymbolicLink(),
        outside: false,
        ignored,
      };
      if (entry.symlink) {
        const target = path.join(directory, dirent.name);
        try {
          const resolved = await realpath(target);
          const info = await stat(resolved);
          entry.kind = info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other';
          entry.outside = !isInside(root, resolved);
        } catch {
          entry.kind = 'other';
        }
      }
      entries.push(entry);
    }
    entries.sort(
      (a, b) =>
        Number(b.kind === 'directory') - Number(a.kind === 'directory') ||
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }),
    );
    return {
      path: parsed.path,
      entries: entries.slice(0, FILE_LIST_MAX),
      truncated: entries.length > FILE_LIST_MAX,
      hiddenIgnored,
    };
  }

  async read(ref: FileRef): Promise<FileContent> {
    const parsed = parseInput(FileRefSchema, ref);
    const root = await this.root(parsed.projectId);
    const target = await this.existing(root, parsed.path);
    const bytes = await readRegularFile(target, parsed.path);
    const decoded = decodeText(bytes);
    if (decoded === null) {
      throw new AtlasError('FILE_UNSUPPORTED', undefined, { details: { reason: 'encoding' } });
    }
    let readOnly = false;
    try {
      await access(target, constants.W_OK);
    } catch {
      readOnly = true;
    }
    return {
      path: parsed.path,
      ...decoded,
      version: contentVersion(bytes),
      size: bytes.length,
      readOnly,
    };
  }

  /**
   * Saves only over the version the user edited (FR-1107), through a temporary file in
   * the same folder renamed over the original, so an interrupted save never leaves a
   * truncated file. Symbolic links are kept: their target is written.
   */
  async write(input: WriteFileInput): Promise<WrittenFile> {
    const parsed = parseInput(WriteFileSchema, input);
    const root = await this.root(parsed.projectId);
    const bytes = encodeText(parsed.content, parsed.encoding);
    if (bytes.length > FILE_EDITABLE_MAX_BYTES) {
      throw new AtlasError('FILE_TOO_LARGE', undefined, { details: { size: bytes.length } });
    }
    const located = await this.locate(root, parsed.path);
    const current = await lstatOrNull(located.absolute);
    if (current === null) {
      if (parsed.expectedVersion !== null && parsed.overwrite !== true) {
        // Deleted on disk after the user opened it.
        throw new AtlasError('FILE_CONFLICT', undefined, { details: { reason: 'deleted' } });
      }
      await writeNewFile(located.absolute, bytes);
    } else {
      if (parsed.expectedVersion === null && parsed.overwrite !== true) {
        throw new AtlasError('FILE_ALREADY_EXISTS');
      }
      const target = await this.existing(root, parsed.path);
      const existing = await readRegularFile(target, parsed.path);
      if (parsed.overwrite !== true && contentVersion(existing) !== parsed.expectedVersion) {
        throw new AtlasError('FILE_CONFLICT', undefined, { details: { reason: 'changed' } });
      }
      await replaceFile(target, bytes);
    }
    this.changed(root);
    return { path: parsed.path, version: contentVersion(bytes), size: bytes.length };
  }

  async create(input: CreateEntryInput): Promise<void> {
    const parsed = parseInput(CreateEntrySchema, input);
    const root = await this.root(parsed.projectId);
    const located = await this.locate(root, parsed.path);
    try {
      if (parsed.kind === 'directory') {
        await mkdir(located.absolute);
      } else {
        await (await open(located.absolute, 'wx')).close();
      }
    } catch (error) {
      throw fileError(error, { operation: 'create' });
    }
    this.changed(root);
  }

  /** Renames or moves without replacing anything at `to`. */
  async move(input: MoveEntryInput): Promise<void> {
    const parsed = parseInput(MoveEntrySchema, input);
    if (parsed.to === parsed.from || parsed.to.startsWith(`${parsed.from}/`)) {
      throw new AtlasError('VALIDATION_FAILED', 'A folder cannot be moved into itself.', {
        issues: [{ field: 'to', message: 'Choose a destination outside the folder.' }],
      });
    }
    const root = await this.root(parsed.projectId);
    const from = await this.locate(root, parsed.from);
    const to = await this.locate(root, parsed.to);
    const source = await lstatOrNull(from.absolute);
    if (source === null) throw new AtlasError('FILE_NOT_FOUND');
    const destination = await lstatOrNull(to.absolute);
    // A case-only rename on a case-insensitive volume finds the source itself.
    const sameEntry =
      destination !== null && destination.ino === source.ino && destination.dev === source.dev;
    if (destination !== null && !sameEntry) throw new AtlasError('FILE_ALREADY_EXISTS');
    try {
      await rename(from.absolute, to.absolute);
    } catch (error) {
      throw fileError(error, { operation: 'move' });
    }
    this.changed(root);
  }

  async versions(input: FileVersionsInput): Promise<FileVersionInfo[]> {
    const parsed = parseInput(FileVersionsSchema, input);
    const root = await this.root(parsed.projectId);
    const results: FileVersionInfo[] = [];
    for (const relative of new Set(parsed.paths)) {
      try {
        const target = await this.existing(root, relative);
        const bytes = await readRegularFile(target, relative);
        results.push({ path: relative, exists: true, version: contentVersion(bytes) });
      } catch (error) {
        const missing = error instanceof AtlasError && error.code === 'FILE_NOT_FOUND';
        results.push({ path: relative, exists: !missing, version: null });
      }
    }
    return results;
  }

  /** Quick open (FR-1101): file names of the project matching `query`. */
  async find(input: FindFilesInput): Promise<FoundFiles> {
    const parsed = parseInput(FindFilesSchema, input);
    const root = await this.root(parsed.projectId);
    const { paths, truncated } = await this.fileList(root);
    const limit = parsed.limit ?? FILE_FIND_LIMIT_MAX;
    return {
      paths:
        parsed.query === ''
          ? [...paths].sort((a, b) => a.length - b.length || a.localeCompare(b)).slice(0, limit)
          : bestMatches(parsed.query, paths, limit),
      truncated,
    };
  }

  /** Absolute path of an existing entry, for the main process (Trash, reveal). */
  async absolutePath(ref: FileRef): Promise<string> {
    const parsed = parseInput(FileRefSchema, ref);
    const located = await this.locate(await this.root(parsed.projectId), parsed.path);
    if ((await lstatOrNull(located.absolute)) === null) throw new AtlasError('FILE_NOT_FOUND');
    return located.absolute;
  }

  /** Replaces the folders `subscriber` watches; folders that are not available are skipped. */
  async watch(subscriber: string, input: WatchFilesInput): Promise<void> {
    const parsed = parseInput(WatchFilesSchema, input);
    if (parsed.projectId === null) {
      this.options.watcher.set(subscriber, null);
      return;
    }
    const root = await this.root(parsed.projectId);
    const directories: { relative: string; absolute: string }[] = [];
    for (const relative of new Set(parsed.directories)) {
      try {
        directories.push({ relative, absolute: await this.existing(root, relative) });
      } catch {
        // Deleted or moved since the client listed it.
      }
    }
    this.options.watcher.set(subscriber, { projectId: parsed.projectId, directories });
  }

  private async root(projectId: string): Promise<string> {
    const folder = await this.options.workspaces.projectRoot(projectId);
    try {
      return await realpath(folder);
    } catch (error) {
      throw new AtlasError('PROJECT_PATH_UNAVAILABLE', undefined, { cause: error });
    }
  }

  /** An existing entry, resolved through symbolic links, inside the project folder. */
  private async existing(root: string, relative: string): Promise<string> {
    let resolved: string;
    try {
      resolved = await realpath(path.join(root, ...relative.split('/').filter(Boolean)));
    } catch (error) {
      throw fileError(error, { operation: 'resolve' });
    }
    if (!isInside(root, resolved)) throw new AtlasError('FILE_OUTSIDE_WORKSPACE');
    return resolved;
  }

  /** An entry that may not exist yet: its folder must exist inside the project folder. */
  private async locate(root: string, relative: string): Promise<Located> {
    const segments = relative.split('/');
    const name = segments.pop()!;
    const parent = await this.existing(root, segments.join('/'));
    return { root, absolute: path.join(parent, name) };
  }

  private async ignoredNames(
    directory: string,
    names: string[],
  ): Promise<(name: string) => boolean> {
    let rules: ReadonlySet<string> | null = null;
    try {
      rules = names.length === 0 ? new Set() : await this.options.ignore.ignored(directory, names);
    } catch (error) {
      this.options.logger.info('Ignore rules unavailable; using the default list', {
        error: describeError(error),
      });
    }
    return rules === null ? (name) => DEFAULT_IGNORED_NAMES.has(name) : (name) => rules.has(name);
  }

  private fileList(root: string): Promise<{ paths: string[]; truncated: boolean }> {
    const now = this.options.now?.() ?? Date.now();
    const cached = this.fileLists.get(root);
    if (cached !== undefined && now - cached.at < FILE_LIST_TTL_MS) return cached.result;
    const result = this.options.ignore
      .files(root)
      .catch((error: unknown) => {
        this.options.logger.info('Repository file list unavailable', {
          error: describeError(error),
        });
        return null;
      })
      .then((files) => files ?? walk(root, now));
    this.fileLists.set(root, { at: now, result });
    result.catch(() => this.fileLists.delete(root));
    return result;
  }

  private changed(root: string): void {
    this.fileLists.delete(root);
    try {
      this.options.onChanged?.(root);
    } catch (error) {
      this.options.logger.warn('File change listener failed', { error: describeError(error) });
    }
  }
}

export function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

async function lstatOrNull(target: string) {
  try {
    return await lstat(target);
  } catch (error) {
    if (isCode(error, 'ENOENT')) return null;
    throw fileError(error, { operation: 'stat' });
  }
}

async function readRegularFile(target: string, relative: string): Promise<Buffer> {
  let info;
  try {
    info = await stat(target);
  } catch (error) {
    throw fileError(error, { operation: 'read' });
  }
  if (!info.isFile()) {
    throw new AtlasError('FILE_UNSUPPORTED', undefined, { details: { reason: 'not-a-file' } });
  }
  if (info.size > FILE_EDITABLE_MAX_BYTES) {
    throw new AtlasError('FILE_TOO_LARGE', undefined, { details: { size: info.size, relative } });
  }
  try {
    const bytes = await readFile(target);
    // It may have grown between the check and the read.
    if (bytes.length > FILE_EDITABLE_MAX_BYTES) {
      throw new AtlasError('FILE_TOO_LARGE', undefined, { details: { size: bytes.length } });
    }
    return bytes;
  } catch (error) {
    throw fileError(error, { operation: 'read' });
  }
}

/** Creates the file; never replaces one created in the meantime. */
async function writeNewFile(target: string, bytes: Uint8Array): Promise<void> {
  try {
    const handle = await open(target, 'wx');
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    throw fileError(error, { operation: 'write' });
  }
}

async function replaceFile(target: string, bytes: Uint8Array): Promise<void> {
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.atlas-${randomBytes(6).toString('hex')}.tmp`,
  );
  try {
    const mode = (await stat(target)).mode & 0o7777;
    const handle = await open(temporary, 'wx', mode);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    // `open` applies the umask; the file keeps exactly its previous permissions.
    await chmod(temporary, mode);
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw fileError(error, { operation: 'write' });
  }
}

/** Files under `root` outside the default ignored folders, within limits. */
async function walk(
  root: string,
  startedAt: number,
): Promise<{ paths: string[]; truncated: boolean }> {
  const paths: string[] = [];
  const pending = [''];
  const deadline = startedAt + WALK_DEADLINE_MS;
  while (pending.length > 0) {
    if (paths.length >= WALK_MAX_FILES || Date.now() > deadline) {
      return { paths, truncated: true };
    }
    const relative = pending.shift()!;
    let entries;
    try {
      entries = await readdir(path.join(root, relative), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
      // Symbolic links are not followed: they could lead outside the folder or loop.
      if (entry.isDirectory()) {
        if (entry.name !== ALWAYS_IGNORED && !DEFAULT_IGNORED_NAMES.has(entry.name)) {
          pending.push(child);
        }
      } else if (entry.isFile() && !TEMP_FILE_PATTERN.test(entry.name)) {
        paths.push(child);
      }
    }
  }
  return { paths, truncated: false };
}

function isCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === code;
}

/** Filesystem failures as user-safe errors; paths stay in the logs only. */
export function fileError(error: unknown, details: Record<string, unknown>): AtlasError {
  if (error instanceof AtlasError) return error;
  const code = (error as NodeJS.ErrnoException | null)?.code;
  const options = { cause: error, details: { ...details, code } };
  switch (code) {
    case 'ENOENT':
    case 'ENOTDIR':
      return new AtlasError('FILE_NOT_FOUND', undefined, options);
    case 'EEXIST':
    case 'ENOTEMPTY':
      return new AtlasError('FILE_ALREADY_EXISTS', undefined, options);
    case 'EACCES':
    case 'EPERM':
    case 'EROFS':
      return new AtlasError('FILE_PERMISSION_DENIED', undefined, options);
    case 'EISDIR':
      return new AtlasError('FILE_UNSUPPORTED', undefined, options);
    default:
      return new AtlasError('INTERNAL_ERROR', undefined, options);
  }
}
