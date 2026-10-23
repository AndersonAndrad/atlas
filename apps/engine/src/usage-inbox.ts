import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { describeError, noopLogger, type Logger } from '@atlas/shared';
import { parseClaudeStatus, type UsageService } from '@atlas/usage';

/** The status files are checked this often while the Engine host runs. */
export const USAGE_INBOX_POLL_MS = 5000;
/** A status line answer is small; a larger file is not one and is ignored. */
const MAX_STATUS_BYTES = 256 * 1024;
/** Run folders untouched for this long belong to sessions that ended. */
const RUN_RETENTION_MS = 24 * 60 * 60_000;
const RUN = /^\d{8}T\d{6}-\d{1,10}$/;

export interface ClaudeStatusInboxOptions {
  /** `<data>/usage/claude`: one folder per Claude Code run started by the wrapper. */
  directory: string;
  usage: Pick<UsageService, 'recordClaudeStatus'>;
  now?: () => Date;
  logger?: Logger;
}

/**
 * Reads what Claude Code gave the ATLAS status line in ATLAS sessions (PLAN-027). Each
 * run folder holds `config-dir` (the profile, written by the wrapper) and `status.json`
 * (the latest status line input). Only whitelisted fields are kept; files are local and
 * private (0700 folder) and are deleted once their session is over.
 */
export class ClaudeStatusInbox {
  private readonly processed = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private scanning: Promise<void> | null = null;

  constructor(private readonly options: ClaudeStatusInboxOptions) {}

  async start(): Promise<void> {
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    await this.scan();
    this.timer = setInterval(() => void this.scan(), USAGE_INBOX_POLL_MS);
    this.timer.unref?.();
  }

  async close(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    await this.scanning;
  }

  /** Processes new status files; overlapping calls share one scan. */
  scan(): Promise<void> {
    this.scanning ??= this.scanOnce().finally(() => {
      this.scanning = null;
    });
    return this.scanning;
  }

  private async scanOnce(): Promise<void> {
    const logger = this.options.logger ?? noopLogger;
    let runs: string[];
    try {
      runs = (await readdir(this.options.directory)).filter((name) => RUN.test(name));
    } catch {
      return;
    }
    const now = (this.options.now ?? (() => new Date()))();
    for (const run of runs) {
      const folder = path.join(this.options.directory, run);
      try {
        await this.processRun(run, folder, now);
      } catch (error) {
        // The content is never logged: it holds local paths and session names.
        // The same file is not read again; the next status update is.
        logger.warn('Claude Code status could not be read', { run, error: describeError(error) });
      }
    }
  }

  private async processRun(run: string, folder: string, now: Date): Promise<void> {
    const statusFile = path.join(folder, 'status.json');
    const info = await stat(statusFile).catch(() => null);
    const folderInfo = await stat(folder);
    const lastChange = info?.mtimeMs ?? folderInfo.mtimeMs;
    if (now.getTime() - lastChange > RUN_RETENTION_MS) {
      await rm(folder, { recursive: true, force: true });
      this.processed.delete(run);
      return;
    }
    if (info === null || info.size > MAX_STATUS_BYTES) return;
    if ((this.processed.get(run) ?? -1) >= info.mtimeMs) return;
    this.processed.set(run, info.mtimeMs);
    const configDirectory = (await readFile(path.join(folder, 'config-dir'), 'utf8')).trim();
    if (!path.isAbsolute(configDirectory) || configDirectory.length > 4096) return;
    const status = parseClaudeStatus(
      JSON.parse(await readFile(statusFile, 'utf8')),
      new Date(info.mtimeMs).toISOString(),
    );
    await this.options.usage.recordClaudeStatus({
      configDirectory,
      status,
      observedAt: new Date(info.mtimeMs),
    });
  }
}
