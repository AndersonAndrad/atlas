import { spawn } from 'node:child_process';
import { createHash, type Hash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import type { SourceState, SourceStateReader } from '@atlas/preflight';
import { gitEnvironment } from '../git/git-runner.js';

const GIT_TIMEOUT_MS = 60_000;
/** Untracked files hashed by content; beyond this only their names and sizes count. */
const MAX_HASHED_UNTRACKED = 5000;
const MAX_HASHED_BYTES = 50 * 1024 * 1024;
const SAFE_PREFIX = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.quotepath=off',
  '--no-optional-locks',
];

/** Runs git, feeding standard output into `hash` (or collecting it when no hash is given). */
function git(
  args: string[],
  cwd: string,
  env: Record<string, string>,
  hash?: Hash,
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...SAFE_PREFIX, ...args], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => child.kill('SIGKILL'), GIT_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      if (hash) {
        hash.update(chunk);
      } else if (size < 16 * 1024 * 1024) {
        chunks.push(chunk);
        size += chunk.length;
      }
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(chunks).toString('utf8') });
    });
  });
}

function hashFile(file: string, hash: Hash): Promise<void> {
  return new Promise((resolve, reject) => {
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', resolve);
  });
}

/**
 * The code state of a workspace's repository (SDD-007 FR-713): HEAD, the staged and
 * unstaged changes and the untracked files that are not ignored. Ignored files, build
 * output, the environment and dependencies outside the repository are not covered.
 * Only read-only Git commands run, without optional locks.
 */
export class GitSourceStateReader implements SourceStateReader {
  private readonly env: Record<string, string>;

  constructor(env: Record<string, string | undefined>) {
    this.env = gitEnvironment(env);
  }

  async read(workspacePath: string): Promise<SourceState | null> {
    const top = await git(['rev-parse', '--show-toplevel'], workspacePath, this.env);
    if (top.code !== 0) return null;
    const root = top.stdout.trim();
    const head = await git(['rev-parse', '--verify', '-q', 'HEAD'], root, this.env);
    const branch = await git(['symbolic-ref', '--short', '-q', 'HEAD'], root, this.env);
    const revision = head.code === 0 ? head.stdout.trim() : null;

    const hash = createHash('sha256');
    hash.update(`head:${revision ?? 'none'}\n`);
    hash.update('staged:\n');
    const staged = await git(
      ['diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv', '--no-color'],
      root,
      this.env,
      hash,
    );
    hash.update('\nunstaged:\n');
    const unstaged = await git(
      ['diff', '--binary', '--no-ext-diff', '--no-textconv', '--no-color'],
      root,
      this.env,
      hash,
    );
    const untracked = await git(
      ['ls-files', '--others', '--exclude-standard', '-z'],
      root,
      this.env,
    );
    if (staged.code !== 0 || unstaged.code !== 0 || untracked.code !== 0) {
      throw new Error('git could not describe the working tree');
    }
    hash.update('\nuntracked:\n');
    const files = untracked.stdout.split('\0').filter(Boolean).sort();
    for (const [index, file] of files.entries()) {
      const absolute = path.join(root, file);
      const info = await lstat(absolute).catch(() => null);
      hash.update(`${file}\0${info?.size ?? -1}\0`);
      if (info?.isFile() && index < MAX_HASHED_UNTRACKED && info.size <= MAX_HASHED_BYTES) {
        await hashFile(absolute, hash).catch(() => hash.update('unreadable'));
      }
      hash.update('\0');
    }
    return {
      revision,
      branch: branch.code === 0 ? branch.stdout.trim() || null : null,
      fingerprint: hash.digest('hex'),
    };
  }
}
