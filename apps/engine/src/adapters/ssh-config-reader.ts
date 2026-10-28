import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { globMatch, includePatterns, type SshConfigSource } from '@atlas/hosting';

const FILE_MAX_BYTES = 256 * 1024;
const MAX_FILES = 32;
const MAX_DEPTH = 4;

/**
 * Reads `~/.ssh/config` and inlines its `Include` files where they appear, as ssh does
 * (SDD-024 Task 04, FR-001). Files are only read, never executed; wildcards are supported
 * in the file name only, with limits on size, depth and count.
 */
export class FileSshConfigSource implements SshConfigSource {
  constructor(private readonly homeDirectory: string) {}

  async read(): Promise<string | null> {
    const sshDir = path.join(this.homeDirectory, '.ssh');
    const budget = { files: 0 };
    return this.load(path.join(sshDir, 'config'), sshDir, 0, budget);
  }

  private async load(
    file: string,
    sshDir: string,
    depth: number,
    budget: { files: number },
  ): Promise<string | null> {
    if (budget.files >= MAX_FILES) return null;
    const info = await stat(file).catch(() => null);
    if (info === null || !info.isFile() || info.size > FILE_MAX_BYTES) return null;
    budget.files += 1;
    const text = await readFile(file, 'utf8').catch(() => null);
    if (text === null) return null;
    const lines: string[] = [];
    for (const line of text.split(/\r?\n/)) {
      const patterns = includePatterns(line);
      if (patterns === null) {
        lines.push(line);
        continue;
      }
      if (depth >= MAX_DEPTH) continue;
      for (const pattern of patterns) {
        for (const included of await this.expand(pattern, sshDir)) {
          const content = await this.load(included, sshDir, depth + 1, budget);
          if (content !== null) lines.push(content);
        }
      }
    }
    return lines.join('\n');
  }

  /** `~/x`, absolute, or relative to ~/.ssh; `*` and `?` only in the last segment. */
  private async expand(pattern: string, sshDir: string): Promise<string[]> {
    const resolved = pattern.startsWith('~/')
      ? path.join(this.homeDirectory, pattern.slice(2))
      : path.isAbsolute(pattern)
        ? pattern
        : path.join(sshDir, pattern);
    const directory = path.dirname(resolved);
    const name = path.basename(resolved);
    if (/[*?]/.test(directory)) return [];
    if (!/[*?]/.test(name)) return [resolved];
    const entries = await readdir(directory).catch(() => [] as string[]);
    // File names match case-sensitively, as ssh's glob does on Unix.
    return entries
      .filter((entry) => globMatch(name, entry, false))
      .sort()
      .map((entry) => path.join(directory, entry));
  }
}
