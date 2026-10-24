import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { PreflightOutputLine } from '@atlas/contracts';
import type { PreflightLogStore, WorkspaceFileAccess, WorkspaceFiles } from '@atlas/preflight';

const RUN_ID = /^[0-9a-f-]{36}$/;

/** True when `target` is `root` or inside it. */
function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Read-only files of a workspace. Paths are resolved inside the folder and symbolic links
 * leading outside of it are refused, so discovery never reads files elsewhere.
 */
export class NodeWorkspaceFileAccess implements WorkspaceFileAccess {
  files(root: string): WorkspaceFiles {
    const resolve = async (relative: string): Promise<string | null> => {
      const target = path.resolve(root, relative);
      if (!isInside(root, target)) return null;
      try {
        const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(target)]);
        return isInside(realRoot, realTarget) ? realTarget : null;
      } catch {
        return null;
      }
    };
    return {
      readText: async (relative, maxBytes) => {
        const file = await resolve(relative);
        if (file === null) return null;
        const info = await stat(file).catch(() => null);
        if (!info?.isFile() || info.size > maxBytes) return null;
        return readFile(file, 'utf8').catch(() => null);
      },
      list: async (relative) => {
        const folder = await resolve(relative);
        if (folder === null) return [];
        const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
        return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
      },
      exists: async (relative) => (await resolve(relative)) !== null,
    };
  }

  async isDirectory(folder: string): Promise<boolean> {
    return (await stat(folder).catch(() => null))?.isDirectory() ?? false;
  }

  async folderInside(root: string, relative: string): Promise<string | null> {
    const target = path.resolve(root, relative);
    if (!isInside(root, target)) return null;
    try {
      const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(target)]);
      if (!isInside(realRoot, realTarget)) return null;
      return (await stat(realTarget)).isDirectory() ? realTarget : null;
    } catch {
      return null;
    }
  }
}

/** Output of finished checks: `<dir>/<runId>/<position>.json`, private to the user. */
export class FilePreflightLogStore implements PreflightLogStore {
  constructor(private readonly directory: string) {}

  private folder(runId: string): string {
    if (!RUN_ID.test(runId)) throw new Error('invalid run id');
    return path.join(this.directory, runId);
  }

  async write(
    runId: string,
    position: number,
    log: { firstSeq: number; lines: PreflightOutputLine[] },
  ): Promise<void> {
    const folder = this.folder(runId);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const file = path.join(folder, `${Math.trunc(position)}.json`);
    await writeFile(`${file}.tmp`, JSON.stringify(log), { mode: 0o600 });
    await rename(`${file}.tmp`, file);
  }

  async read(runId: string, position: number) {
    const file = path.join(this.folder(runId), `${Math.trunc(position)}.json`);
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    const value = JSON.parse(text) as { firstSeq: number; lines: PreflightOutputLine[] };
    if (typeof value.firstSeq !== 'number' || !Array.isArray(value.lines)) return null;
    return value;
  }

  async remove(runId: string): Promise<void> {
    await rm(this.folder(runId), { recursive: true, force: true });
  }
}
