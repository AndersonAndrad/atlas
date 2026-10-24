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
const RUN = /^\d{8}T\d{6}-(\d{1,10})$/;
const TERMINAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a process exists; a process of another user (EPERM) exists too. */
export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** A Claude Code run started by the wrapper. */
interface RunInfo {
  configDirectory: string;
  /** The ATLAS terminal it runs in; null for wrappers written before PLAN-031. */
  terminalId: string | null;
  /** The wrapper's process: it lives exactly as long as the Claude Code session. */
  pid: number;
}

export interface ClaudeStatusInboxOptions {
  /** `<data>/usage/claude`: one folder per Claude Code run started by the wrapper. */
  directory: string;
  usage: Pick<UsageService, 'recordClaudeStatus'>;
  now?: () => Date;
  logger?: Logger;
  /** Called when the run open in a terminal, or the usage it shows, may have changed. */
  onChange?: () => void;
  isProcessAlive?: (pid: number) => boolean;
}

/**
 * Reads what Claude Code gave the ATLAS status line in ATLAS sessions (PLAN-027). Each
 * run folder holds `config-dir` (the profile, written by the wrapper) and `status.json`
 * (the latest status line input). Only whitelisted fields are kept; files are local and
 * private (0700 folder) and are deleted once their session is over.
 *
 * PLAN-031: the wrapper also writes `terminal-id`, so ATLAS knows which terminal has
 * Claude Code open; a run stays open while the wrapper's process (its folder suffix) lives.
 */
export class ClaudeStatusInbox {
  private readonly processed = new Map<string, number>();
  private readonly runs = new Map<string, RunInfo>();
  /** Runs whose process exited: never open again, even if the process id is reused. */
  private readonly finished = new Set<string>();
  /** Terminal id → the latest open run in it. */
  private open = new Map<string, string>();
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

  /** The Claude Code run open in a terminal, if any. */
  openRun(terminalId: string): { configDirectory: string } | null {
    const run = this.open.get(terminalId);
    const info = run === undefined ? undefined : this.runs.get(run);
    return info === undefined ? null : { configDirectory: info.configDirectory };
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
    let recorded = false;
    for (const run of runs) {
      const folder = path.join(this.options.directory, run);
      try {
        recorded = (await this.processRun(run, folder, now)) || recorded;
      } catch (error) {
        // The content is never logged: it holds local paths and session names.
        // The same file is not read again; the next status update is.
        logger.warn('Claude Code status could not be read', { run, error: describeError(error) });
      }
    }
    const previous = this.open;
    this.open = this.openRuns();
    const moved =
      previous.size !== this.open.size ||
      [...this.open].some(([terminalId, run]) => previous.get(terminalId) !== run);
    if (moved || (recorded && this.open.size > 0)) this.options.onChange?.();
  }

  private openRuns(): Map<string, string> {
    const alive = this.options.isProcessAlive ?? processExists;
    const open = new Map<string, string>();
    for (const [run, info] of this.runs) {
      if (info.terminalId === null || this.finished.has(run)) continue;
      if (!alive(info.pid)) {
        this.finished.add(run);
        continue;
      }
      // Run names start with their start time: the latest one is the one in use.
      const current = open.get(info.terminalId);
      if (current === undefined || current < run) open.set(info.terminalId, run);
    }
    return open;
  }

  /** Reads the run's identity once; false while it is not available. */
  private async loadRun(run: string, folder: string): Promise<boolean> {
    if (this.runs.has(run)) return true;
    const configDirectory = await readFile(path.join(folder, 'config-dir'), 'utf8').then(
      (text) => text.trim(),
      () => null,
    );
    // Missing while the wrapper is still writing it; a run with an invalid one is ignored.
    if (configDirectory === null || !path.isAbsolute(configDirectory)) return false;
    if (configDirectory.length > 4096) return false;
    const terminalId = await readFile(path.join(folder, 'terminal-id'), 'utf8').then(
      (text) => text.trim(),
      () => '',
    );
    this.runs.set(run, {
      configDirectory,
      terminalId: TERMINAL_ID.test(terminalId) ? terminalId.toLowerCase() : null,
      pid: Number(RUN.exec(run)![1]),
    });
    return true;
  }

  /** True when a new status was recorded. */
  private async processRun(run: string, folder: string, now: Date): Promise<boolean> {
    const statusFile = path.join(folder, 'status.json');
    const info = await stat(statusFile).catch(() => null);
    const folderInfo = await stat(folder);
    const lastChange = info?.mtimeMs ?? folderInfo.mtimeMs;
    if (now.getTime() - lastChange > RUN_RETENTION_MS) {
      await rm(folder, { recursive: true, force: true });
      this.processed.delete(run);
      this.runs.delete(run);
      this.finished.delete(run);
      return false;
    }
    if (!(await this.loadRun(run, folder))) return false;
    if (info === null || info.size > MAX_STATUS_BYTES) return false;
    if ((this.processed.get(run) ?? -1) >= info.mtimeMs) return false;
    this.processed.set(run, info.mtimeMs);
    const { configDirectory } = this.runs.get(run)!;
    const status = parseClaudeStatus(
      JSON.parse(await readFile(statusFile, 'utf8')),
      new Date(info.mtimeMs).toISOString(),
    );
    await this.options.usage.recordClaudeStatus({
      configDirectory,
      status,
      observedAt: new Date(info.mtimeMs),
    });
    return true;
  }
}
