import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { GitInspection } from '@atlas/contracts';

const MAX_PARENT_DEPTH = 256;
const MAX_GIT_FILE_BYTES = 4096;

/**
 * Detects the Git repository containing `directory` by reading `.git` metadata
 * directly, without requiring the `git` executable. Supports regular repositories,
 * worktrees and submodules (`.git` file with a `gitdir:` pointer).
 */
export async function inspectGit(directory: string): Promise<GitInspection> {
  let current = directory;
  for (let depth = 0; depth < MAX_PARENT_DEPTH; depth += 1) {
    const gitDir = await resolveGitDir(current);
    if (gitDir !== null) {
      const head = await readHead(gitDir);
      return {
        isRepository: true,
        repositoryRoot: current,
        ...(head.branch !== undefined ? { branch: head.branch } : {}),
        ...(head.detached ? { detached: true } : {}),
      };
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return { isRepository: false };
}

async function resolveGitDir(directory: string): Promise<string | null> {
  const dotGit = path.join(directory, '.git');
  const info = await stat(dotGit).catch(() => null);
  if (info === null) return null;

  let gitDir: string;
  if (info.isDirectory()) {
    gitDir = dotGit;
  } else if (info.isFile() && info.size <= MAX_GIT_FILE_BYTES) {
    const content = await readFile(dotGit, 'utf8').catch(() => '');
    const match = /^gitdir:\s*(.+?)\s*$/m.exec(content);
    if (!match?.[1]) return null;
    gitDir = path.resolve(directory, match[1]);
  } else {
    return null;
  }

  const headInfo = await stat(path.join(gitDir, 'HEAD')).catch(() => null);
  return headInfo?.isFile() ? gitDir : null;
}

async function readHead(gitDir: string): Promise<{ branch?: string; detached: boolean }> {
  const content = await readFile(path.join(gitDir, 'HEAD'), 'utf8').catch(() => null);
  if (content === null) return { detached: false };
  const ref = /^ref:\s*refs\/heads\/(.+?)\s*$/m.exec(content);
  if (ref?.[1]) return { branch: ref[1], detached: false };
  if (/^[0-9a-f]{40,64}\s*$/i.test(content)) return { detached: true };
  return { detached: false };
}
