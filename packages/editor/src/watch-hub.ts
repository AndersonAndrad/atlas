import { watch as watchFolder, type FSWatcher } from 'node:fs';
import { describeError, noopLogger, type Logger } from '@atlas/shared';
import { TEMP_FILE_PATTERN } from './project-files.js';

export interface WatchSelection {
  projectId: string;
  /** Folders inside the project: relative path for events, resolved path to watch. */
  directories: { relative: string; absolute: string }[];
}

export interface FileWatchHubOptions {
  /** Called (debounced) with the relative paths of changed entries. */
  onChange: (projectId: string, paths: string[]) => void;
  logger?: Logger;
  debounceMs?: number;
  /** Clients (windows) watched at once; the least recently updated one is dropped. */
  maxSubscribers?: number;
  /** Injectable for tests. */
  watch?: (directory: string, listener: (file: string | null) => void) => FSWatcher;
}

interface Folder {
  watcher: FSWatcher | null;
  projectId: string;
  relative: string;
  subscribers: Set<string>;
}

/**
 * Watches the folders that editor clients show (open files and expanded folders, FR-1107)
 * without recursion, so large repositories are never scanned. Watching is best effort:
 * clients also compare versions when the window gains focus and before saving.
 */
export class FileWatchHub {
  private readonly folders = new Map<string, Folder>();
  private readonly subscribers = new Map<string, Set<string>>();
  private readonly pending = new Map<string, Set<string>>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly logger: Logger;
  private closed = false;

  constructor(private readonly options: FileWatchHubOptions) {
    this.logger = options.logger ?? noopLogger;
  }

  /** Replaces what `subscriber` watches; null stops watching for it. */
  set(subscriber: string, selection: WatchSelection | null): void {
    if (this.closed) return;
    const next = new Set<string>();
    for (const directory of selection?.directories ?? []) {
      const key = `${selection!.projectId}\0${directory.absolute}`;
      next.add(key);
      let folder = this.folders.get(key);
      if (folder === undefined) {
        folder = {
          watcher: this.start(selection!.projectId, directory.relative, directory.absolute),
          projectId: selection!.projectId,
          relative: directory.relative,
          subscribers: new Set(),
        };
        this.folders.set(key, folder);
      }
      folder.subscribers.add(subscriber);
    }
    for (const key of this.subscribers.get(subscriber) ?? []) {
      if (!next.has(key)) this.release(key, subscriber);
    }
    this.subscribers.delete(subscriber);
    if (next.size > 0) this.subscribers.set(subscriber, next);
    const max = this.options.maxSubscribers ?? 8;
    while (this.subscribers.size > max) {
      const [oldest] = this.subscribers.keys();
      this.set(oldest!, null);
    }
  }

  /** Folders watched now (for tests and diagnostics). */
  get watchedCount(): number {
    return this.folders.size;
  }

  close(): void {
    this.closed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    for (const folder of this.folders.values()) folder.watcher?.close();
    this.folders.clear();
    this.subscribers.clear();
  }

  private start(projectId: string, relative: string, absolute: string): FSWatcher | null {
    const onEvent = (file: string | null) => {
      if (file !== null && TEMP_FILE_PATTERN.test(file)) return;
      const changed = file === null ? relative : relative === '' ? file : `${relative}/${file}`;
      let paths = this.pending.get(projectId);
      if (paths === undefined) this.pending.set(projectId, (paths = new Set()));
      paths.add(changed);
      this.schedule();
    };
    try {
      const watcher =
        this.options.watch?.(absolute, onEvent) ??
        watchFolder(absolute, { persistent: false }, (_event, file) =>
          onEvent(typeof file === 'string' ? file : null),
        );
      watcher.on('error', () => watcher.close());
      return watcher;
    } catch (error) {
      this.logger.debug('Folder watching unavailable', { error: describeError(error) });
      return null;
    }
  }

  private release(key: string, subscriber: string): void {
    const folder = this.folders.get(key);
    if (folder === undefined) return;
    folder.subscribers.delete(subscriber);
    if (folder.subscribers.size === 0) {
      folder.watcher?.close();
      this.folders.delete(key);
    }
  }

  private schedule(): void {
    if (this.timer !== undefined || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const batches = [...this.pending];
      this.pending.clear();
      for (const [projectId, paths] of batches) {
        try {
          this.options.onChange(projectId, [...paths]);
        } catch (error) {
          this.logger.warn('File change listener failed', { error: describeError(error) });
        }
      }
    }, this.options.debounceMs ?? 150);
    this.timer.unref?.();
  }
}
