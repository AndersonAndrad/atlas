import { watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { describeError, noopLogger, type Logger } from '@atlas/shared';
import type { GitInspectionService } from './git-inspection-service.js';

export interface RepositoryWatcherOptions {
  git: GitInspectionService;
  /** Called (debounced) when a watched repository may have changed. */
  onChange: (repositoryRoot: string) => void;
  logger?: Logger;
  debounceMs?: number;
  /** Fallback refresh interval for changes the watcher cannot see (e.g. file edits). */
  refreshIntervalMs?: number;
  maxRepositories?: number;
}

interface Watched {
  watchers: FSWatcher[];
  timer: ReturnType<typeof setTimeout> | undefined;
  lastUsed: number;
}

/**
 * Watches the git directory (HEAD, index, refs) of repositories that clients are
 * looking at, and periodically refreshes them. Watching is best effort: volumes
 * that do not support it fall back to the periodic refresh.
 */
export class RepositoryWatcher {
  private readonly watched = new Map<string, Watched>();
  private readonly logger: Logger;
  private readonly interval: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(private readonly options: RepositoryWatcherOptions) {
    this.logger = options.logger ?? noopLogger;
    this.interval = setInterval(() => {
      for (const root of this.watched.keys()) this.changed(root);
    }, options.refreshIntervalMs ?? 30_000);
    this.interval.unref?.();
  }

  async watch(repositoryRoot: string): Promise<void> {
    if (this.closed) return;
    const existing = this.watched.get(repositoryRoot);
    if (existing) {
      existing.lastUsed = Date.now();
      return;
    }
    const entry: Watched = { watchers: [], timer: undefined, lastUsed: Date.now() };
    this.watched.set(repositoryRoot, entry);
    this.evictOldest();

    const gitDir = await this.options.git.gitDirectory(repositoryRoot);
    if (gitDir === null || this.closed || this.watched.get(repositoryRoot) !== entry) return;
    const onEvent = (_event: string, file: string | Buffer | null) => {
      if (typeof file === 'string' && file.endsWith('.lock')) return;
      this.schedule(repositoryRoot, entry);
    };
    for (const [target, recursive] of [
      [gitDir, false],
      [path.join(gitDir, 'refs'), true],
    ] as const) {
      try {
        const watcher = watch(target, { persistent: false, recursive }, onEvent);
        watcher.on('error', () => watcher.close());
        entry.watchers.push(watcher);
      } catch (error) {
        this.logger.debug('Repository watching unavailable', { error: describeError(error) });
      }
    }
  }

  close(): void {
    this.closed = true;
    clearInterval(this.interval);
    for (const root of [...this.watched.keys()]) this.unwatch(root);
  }

  private schedule(root: string, entry: Watched): void {
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      this.changed(root);
    }, this.options.debounceMs ?? 500);
  }

  private changed(root: string): void {
    this.options.git.invalidate(root);
    this.options.onChange(root);
  }

  private evictOldest(): void {
    const limit = this.options.maxRepositories ?? 32;
    while (this.watched.size > limit) {
      const oldest = [...this.watched.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      if (!oldest) return;
      this.unwatch(oldest[0]);
    }
  }

  private unwatch(root: string): void {
    const entry = this.watched.get(root);
    if (!entry) return;
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    for (const watcher of entry.watchers) watcher.close();
    this.watched.delete(root);
  }
}
