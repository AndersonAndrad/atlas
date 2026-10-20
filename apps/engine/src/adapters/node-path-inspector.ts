import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import type { AvailabilityStatus, ProjectPathInspection } from '@atlas/contracts';
import { directoryName, type PathInspector, type PathPlatform } from '@atlas/projects';
import { describeError, noopLogger, type Logger } from '@atlas/shared';
import { inspectGit } from './git-inspector.js';

/** Upper bound for a single inspection, protecting against hung network volumes. */
export const DEFAULT_INSPECTION_TIMEOUT_MS = 3000;

class InspectionTimeoutError extends Error {
  constructor() {
    super('Path inspection timed out');
  }
}

export interface NodePathInspectorOptions {
  platform: PathPlatform;
  timeoutMs?: number;
  now?: () => Date;
  logger?: Logger;
}

export class NodePathInspector implements PathInspector {
  private readonly now: () => Date;
  private readonly logger: Logger;

  constructor(private readonly options: NodePathInspectorOptions) {
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? noopLogger;
  }

  async inspect(absolutePath: string): Promise<ProjectPathInspection> {
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_INSPECTION_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new InspectionTimeoutError()), timeoutMs);
    });
    try {
      return await Promise.race([this.inspectNow(absolutePath), timeout]);
    } catch (error) {
      if (!(error instanceof InspectionTimeoutError)) throw error;
      // An unresponsive volume (e.g. disconnected network share) is reported as unreachable.
      this.logger.warn('Path inspection timed out', { timeoutMs });
      return {
        inputPath: absolutePath,
        availability: { status: 'missing', checkedAt: this.now().toISOString() },
        git: { isRepository: false },
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Performs the actual filesystem checks; overridable for tests. */
  protected async inspectNow(absolutePath: string): Promise<ProjectPathInspection> {
    const checkedAt = this.now().toISOString();
    const unavailable = (status: AvailabilityStatus): ProjectPathInspection => ({
      inputPath: absolutePath,
      availability: { status, checkedAt },
      git: { isRepository: false },
    });

    let resolvedPath: string;
    try {
      resolvedPath = await realpath(absolutePath);
      const info = await stat(resolvedPath);
      if (!info.isDirectory()) return unavailable('not-a-directory');
      // Directories need read + traverse permission to be usable as a workspace.
      await access(resolvedPath, constants.R_OK | constants.X_OK);
    } catch (error) {
      const status = statusFromError(error);
      if (status === 'missing' && (error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.warn('Path inspection failed', { error: describeError(error) });
      }
      return unavailable(status);
    }

    return {
      inputPath: absolutePath,
      resolvedPath,
      availability: { status: 'available', checkedAt },
      git: await inspectGit(resolvedPath),
      suggestedName: directoryName(resolvedPath, this.options.platform),
    };
  }
}

function statusFromError(error: unknown): AvailabilityStatus {
  switch ((error as NodeJS.ErrnoException).code) {
    case 'EACCES':
    case 'EPERM':
      return 'permission-denied';
    case 'ENOTDIR':
      return 'not-a-directory';
    default:
      // ENOENT, ELOOP, unmounted volumes (EIO), etc.
      return 'missing';
  }
}
