import { execFile } from 'node:child_process';
import { readlink } from 'node:fs/promises';
import type { ProcessCwdResolver } from '@atlas/terminal';

const LSOF = '/usr/sbin/lsof';

/**
 * Reads a process's current directory from the operating system:
 * Linux `/proc/<pid>/cwd`, macOS `lsof` (absolute path, no shell). Windows offers
 * no reliable equivalent, so it reports null and callers keep the initial directory.
 */
export class OsProcessCwdResolver implements ProcessCwdResolver {
  constructor(private readonly platform: NodeJS.Platform = process.platform) {}

  async currentDirectory(pid: number): Promise<string | null> {
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    switch (this.platform) {
      case 'linux':
        return readlink(`/proc/${pid}/cwd`).catch(() => null);
      case 'darwin':
        return lsofCwd(pid);
      default:
        return null;
    }
  }
}

function lsofCwd(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      LSOF,
      ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'],
      { timeout: 2000, encoding: 'utf8' },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        const line = stdout.split('\n').find((entry) => entry.startsWith('n/'));
        resolve(line ? line.slice(1) : null);
      },
    );
  });
}
