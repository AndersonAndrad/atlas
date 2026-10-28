import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type {
  AuditFileInspector,
  AuditPathInspection,
  AuditScopePathKind,
  AuditWorkspace,
  AuditWorkspaceSnapshot,
} from '@atlas/audit';
import { AUDIT_PATH_MAX, auditPlainText } from '@atlas/contracts';
import { DEFAULT_IGNORED_NAMES } from '@atlas/editor';
import type { GitExecutor } from '@atlas/git';

/** Larger files are checked for existence only, not read. */
const MAX_INSPECTED_BYTES = 2 * 1024 * 1024;
/** Changed paths whose size and time are compared; beyond it only the Git status is. */
const MAX_STATTED_ENTRIES = 5000;
const GIT_TIMEOUT_MS = 15_000;
const OUTSIDE = '(outside the project)';

const isInside = (root: string, target: string) =>
  target === root || target.startsWith(root + path.sep);

const toPosix = (value: string) => value.split(path.sep).join('/');

/** One entry of `git status --porcelain=v1 -z`: its status and path (repository-relative). */
export function parsePorcelain(output: string): { status: string; path: string }[] {
  const tokens = output.split('\0');
  const entries: { status: string; path: string }[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.length < 4) continue;
    const status = token.slice(0, 2);
    entries.push({ status, path: token.slice(3) });
    // Renames and copies are followed by their original path.
    if (/[RC]/.test(status)) index += 1;
  }
  return entries;
}

/**
 * Read-only access to a project folder for audits (SDD-026 FR-003, FR-008): paths are
 * resolved with their symbolic links and refused when they leave the folder; Git's
 * ignore rules apply, or ATLAS's default list outside a repository.
 */
export class GitAuditWorkspace implements AuditWorkspace {
  constructor(private readonly git: GitExecutor) {}

  async scopePath(root: string, relativePath: string): Promise<AuditScopePathKind> {
    const resolved = await this.resolve(root, relativePath);
    if (resolved.kind !== 'inside') return resolved.kind;
    const info = await stat(resolved.absolute).catch(() => null);
    if (info === null) return 'missing';
    if (await this.ignored(root, resolved.relative)) return 'ignored';
    if (info.isFile()) return 'file';
    return info.isDirectory() ? 'directory' : 'missing';
  }

  async changedFiles(root: string): Promise<string[] | null> {
    const status = await this.status(root);
    if (status === null) return null;
    // Deleted files cannot be read; they are not part of the scope.
    return status.filter((entry) => !entry.status.includes('D')).map((entry) => entry.path);
  }

  async snapshot(root: string): Promise<AuditWorkspaceSnapshot | null> {
    const status = await this.status(root);
    if (status === null) return null;
    const head = await this.git(['rev-parse', '--verify', '--quiet', 'HEAD'], {
      cwd: root,
      timeoutMs: GIT_TIMEOUT_MS,
      okExitCodes: [0, 1, 128],
    });
    const entries = new Map<string, string>();
    for (const [index, entry] of status.entries()) {
      // Size and time catch further edits of a file that was already changed.
      const info =
        index < MAX_STATTED_ENTRIES
          ? await lstat(path.join(root, ...entry.path.split('/'))).catch(() => null)
          : null;
      entries.set(
        entry.path,
        info === null ? entry.status : `${entry.status}:${info.size}:${info.mtimeMs}`,
      );
    }
    return { head: head.exitCode === 0 ? head.stdout.trim() : null, entries };
  }

  inspector(root: string): AuditFileInspector {
    return { inspect: (reported) => this.inspect(root, reported) };
  }

  private async inspect(root: string, reported: string): Promise<AuditPathInspection> {
    const resolved = await this.resolve(root, reported);
    if (resolved.kind === 'outside-project') return { status: 'outside-project', path: OUTSIDE };
    const display = auditPlainText(resolved.relative, AUDIT_PATH_MAX) || OUTSIDE;
    if (resolved.kind === 'missing') return { status: 'missing', path: display };
    const info = await stat(resolved.absolute).catch(() => null);
    if (info === null) return { status: 'missing', path: display };
    if (!info.isFile()) return { status: 'not-a-file', path: display };
    if (await this.ignored(root, resolved.relative)) return { status: 'ignored', path: display };
    if (info.size > MAX_INSPECTED_BYTES) {
      return { status: 'file', path: display, lineCount: null, content: null };
    }
    const buffer = await readFile(resolved.absolute).catch(() => null);
    if (buffer === null || buffer.subarray(0, 8000).includes(0)) {
      return { status: 'file', path: display, lineCount: null, content: null };
    }
    const content = buffer.toString('utf8');
    const lines = content.split('\n');
    const lineCount = lines.at(-1) === '' ? lines.length - 1 : lines.length;
    return { status: 'file', path: display, lineCount, content };
  }

  /**
   * A reported or chosen path, relative to the project folder or absolute inside it.
   * `missing` keeps the normalized relative path for display.
   */
  private async resolve(
    root: string,
    reported: string,
  ): Promise<
    | { kind: 'inside'; absolute: string; relative: string }
    | { kind: 'missing'; relative: string }
    | { kind: 'outside-project' }
  > {
    const realRoot = await realpath(root);
    const cleaned = reported.trim().replace(/\\/g, '/');
    const candidate = path.isAbsolute(cleaned)
      ? path.resolve(cleaned)
      : path.resolve(realRoot, ...cleaned.split('/'));
    // Lexically first: an absolute path under the folder as registered is inside it, too.
    const lexicalRoot = isInside(realRoot, candidate) ? realRoot : path.resolve(root);
    if (!isInside(lexicalRoot, candidate)) return { kind: 'outside-project' };
    const relative = toPosix(path.relative(lexicalRoot, candidate));
    const absolute = await realpath(candidate).catch(() => null);
    if (absolute === null) return { kind: 'missing', relative };
    // Symbolic links are followed: their target must be inside the folder too.
    if (!isInside(realRoot, absolute)) return { kind: 'outside-project' };
    return { kind: 'inside', absolute, relative: toPosix(path.relative(realRoot, absolute)) };
  }

  private async ignored(root: string, relative: string): Promise<boolean> {
    if (relative === '') return false;
    const result = await this.git(['check-ignore', '--quiet', '--', relative], {
      cwd: root,
      timeoutMs: GIT_TIMEOUT_MS,
      okExitCodes: [0, 1, 128],
    });
    if (result.exitCode === 128) {
      return relative.split('/').some((segment) => DEFAULT_IGNORED_NAMES.has(segment));
    }
    return result.exitCode === 0;
  }

  /** Changed paths relative to the project folder; null outside a Git repository. */
  private async status(root: string): Promise<{ status: string; path: string }[] | null> {
    const prefix = await this.git(['rev-parse', '--show-prefix'], {
      cwd: root,
      timeoutMs: GIT_TIMEOUT_MS,
      okExitCodes: [0, 128],
    });
    if (prefix.exitCode === 128) return null;
    const result = await this.git(
      ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.'],
      {
        cwd: root,
        timeoutMs: GIT_TIMEOUT_MS,
        okExitCodes: [0, 128],
        maxOutputBytes: 8 * 1024 * 1024,
      },
    );
    if (result.exitCode === 128) return null;
    const base = prefix.stdout.trim();
    return parsePorcelain(result.stdout)
      .filter((entry) => entry.path.startsWith(base))
      .map((entry) => ({ status: entry.status, path: entry.path.slice(base.length) }));
  }
}
