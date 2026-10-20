import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempDir } from '../../../tests/support/temp.js';
import { inspectGit } from '../src/index.js';

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Creates a minimal `.git` directory structure without the git executable. */
function fakeRepo(root: string, head = 'ref: refs/heads/main\n') {
  mkdirSync(path.join(root, '.git'), { recursive: true });
  writeFileSync(path.join(root, '.git', 'HEAD'), head);
}

describe('inspectGit', () => {
  let temp: ReturnType<typeof createTempDir>;
  beforeEach(() => {
    temp = createTempDir();
  });
  afterEach(() => temp.cleanup());

  it('reports non-repositories', async () => {
    await expect(inspectGit(temp.dir)).resolves.toEqual({ isRepository: false });
  });

  it('detects the root and branch of a repository', async () => {
    fakeRepo(temp.dir, 'ref: refs/heads/feature/registry\n');
    await expect(inspectGit(temp.dir)).resolves.toEqual({
      isRepository: true,
      repositoryRoot: temp.dir,
      branch: 'feature/registry',
    });
  });

  it('finds the repository root from a nested directory', async () => {
    fakeRepo(temp.dir);
    const nested = path.join(temp.dir, 'packages', 'app');
    mkdirSync(nested, { recursive: true });
    await expect(inspectGit(nested)).resolves.toMatchObject({
      isRepository: true,
      repositoryRoot: temp.dir,
      branch: 'main',
    });
  });

  it('reports detached HEAD', async () => {
    fakeRepo(temp.dir, `${'a'.repeat(40)}\n`);
    await expect(inspectGit(temp.dir)).resolves.toEqual({
      isRepository: true,
      repositoryRoot: temp.dir,
      detached: true,
    });
  });

  it('follows gitdir pointers used by worktrees and submodules', async () => {
    const gitDir = path.join(temp.dir, 'storage', 'worktrees', 'wt');
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/wt-branch\n');
    const worktree = path.join(temp.dir, 'wt');
    mkdirSync(worktree);
    writeFileSync(path.join(worktree, '.git'), 'gitdir: ../storage/worktrees/wt\n');
    await expect(inspectGit(worktree)).resolves.toMatchObject({
      isRepository: true,
      repositoryRoot: worktree,
      branch: 'wt-branch',
    });
  });

  it('ignores a .git entry without HEAD', async () => {
    mkdirSync(path.join(temp.dir, '.git'));
    await expect(inspectGit(temp.dir)).resolves.toEqual({ isRepository: false });
  });

  it.runIf(hasGit())('detects a repository created by the git executable', async () => {
    execFileSync('git', ['init', '-q', '-b', 'trunk', temp.dir]);
    await expect(inspectGit(temp.dir)).resolves.toEqual({
      isRepository: true,
      repositoryRoot: temp.dir,
      branch: 'trunk',
    });
  });
});
