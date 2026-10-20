import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Creates an isolated temporary directory (symlink-resolved) and returns it with
 * a cleanup function. Tests must only create files below these directories.
 */
export function createTempDir(prefix = 'atlas-test-'): { dir: string; cleanup: () => void } {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
