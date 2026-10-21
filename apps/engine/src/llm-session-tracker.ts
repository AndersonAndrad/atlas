import { watch, type FSWatcher } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ResolvedTarget, SharedContextService } from '@atlas/context';
import { describeError, noopLogger, type Logger } from '@atlas/shared';

/** What a wrapper writes when an LLM session starts or ends (PLAN-021). */
interface WrapperEvent {
  event: 'start' | 'end';
  provider: 'claude' | 'codex';
  run: string;
  /** Empty when the wrapper ran outside an ATLAS terminal or project. */
  terminalId: string;
  projectId: string;
  exitCode: number | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RUN = /^\d{8}T\d{6}-\d{1,10}$/;

/** The event file is written by a shell script; every field is checked strictly. */
export function parseWrapperEvent(value: unknown): WrapperEvent | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const event = value as Record<string, unknown>;
  const keys = Object.keys(event).sort().join(',');
  if (keys !== 'event,exitCode,projectId,provider,run,terminalId') return null;
  const id = (field: unknown) => field === '' || (typeof field === 'string' && UUID.test(field));
  if (event.event !== 'start' && event.event !== 'end') return null;
  if (event.provider !== 'claude' && event.provider !== 'codex') return null;
  if (typeof event.run !== 'string' || !RUN.test(event.run)) return null;
  if (!id(event.terminalId) || !id(event.projectId)) return null;
  if (event.exitCode !== null && !Number.isInteger(event.exitCode)) return null;
  return event as unknown as WrapperEvent;
}

/** Checkpoints are read this often (they are small files written by the LLM). */
const CHECKPOINT_POLL_MS = 3000;
/** Event files are also scanned this often, in case a watch notification is missed. */
const EVENT_POLL_MS = 5000;
/** Larger checkpoint files are not imported (the stored text is limited anyway). */
const MAX_CHECKPOINT_BYTES = 256 * 1024;

export interface LlmSessionTrackerOptions {
  eventsDir: string;
  /** `<data>/projects/<id>`: the project folder holding `checkpoints/`. */
  projectDir: (projectId: string) => string;
  /** Whether the project keeps shared context (`keepContext`); nothing is tracked otherwise. */
  keepsContext: (projectId: string) => Promise<boolean>;
  resolveProject: (projectId: string) => Promise<ResolvedTarget>;
  context: SharedContextService;
  /** Called after context changed, e.g. to refresh the project's context.md. */
  changed: (target: ResolvedTarget) => Promise<void>;
  logger?: Logger;
}

interface Run {
  projectId: string;
  provider: 'claude' | 'codex';
  sessionId: string | null;
  checkpoint: string;
  lastModified: number;
}

/**
 * Records LLM sessions started in ATLAS terminals without the user's help (PLAN-021):
 * the wrappers report start and end; ATLAS opens an AI session at the start, imports the
 * checkpoint the LLM keeps while it works, and at the end (or when the terminal closes)
 * records what Git shows changed. Nothing here reads the LLM's conversation.
 */
export class LlmSessionTracker {
  private readonly logger: Logger;
  private readonly runs = new Map<string, Run>();
  private watcher: FSWatcher | null = null;
  private timers: NodeJS.Timeout[] = [];
  private processing: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly options: LlmSessionTrackerOptions) {
    this.logger = options.logger ?? noopLogger;
  }

  async start(): Promise<void> {
    await mkdir(this.options.eventsDir, { recursive: true, mode: 0o700 });
    try {
      this.watcher = watch(this.options.eventsDir, () => this.schedule());
      this.watcher.on('error', () => undefined);
    } catch (error) {
      this.logger.warn('LLM session events cannot be watched; polling only', {
        error: describeError(error),
      });
    }
    this.timers.push(setInterval(() => this.schedule(), EVENT_POLL_MS));
    this.timers.push(setInterval(() => void this.pollCheckpoints(), CHECKPOINT_POLL_MS));
    for (const timer of this.timers) timer.unref();
    this.schedule();
    await this.processing;
  }

  /** Stops watching; checkpoints are read one last time. */
  async close(): Promise<void> {
    this.closed = true;
    this.watcher?.close();
    for (const timer of this.timers) clearInterval(timer);
    await this.processing;
    await this.pollCheckpoints();
  }

  /** A terminal closed: its LLM can no longer report its end. */
  terminalClosed(terminalId: string): void {
    // Terminals closed by the shutdown itself are handled at the next start.
    if (this.closed) return;
    this.enqueue(async () => {
      const session = await this.options.context.sessionForTerminal(terminalId);
      if (session === null || session.projectId === null) return;
      const run = [...this.runs.entries()].find(([, item]) => item.sessionId === session.id);
      if (run) await this.importCheckpoint(run[0], run[1]);
      await this.finish(session.projectId, session.id);
      if (run) this.runs.delete(run[0]);
    });
  }

  /** Processes pending events in order; one pass at a time. */
  schedule(): void {
    this.enqueue(() => this.processEvents());
  }

  /** Resolves when everything scheduled so far was processed (tests). */
  idle(): Promise<void> {
    return this.processing;
  }

  private enqueue(task: () => Promise<void>): void {
    this.processing = this.processing.then(task).catch((error: unknown) => {
      this.logger.warn('LLM session tracking failed', { error: describeError(error) });
    });
  }

  private async processEvents(): Promise<void> {
    if (this.closed) return;
    const names = (await readdir(this.options.eventsDir).catch(() => []))
      .filter((name) => name.endsWith('.json') && !name.startsWith('.'))
      .sort();
    for (const name of names) {
      const file = path.join(this.options.eventsDir, name);
      // Taken first, so a slow pass never handles the same event twice.
      const taken = `${file}.processing`;
      try {
        await rename(file, taken);
      } catch {
        continue;
      }
      try {
        const parsed = parseWrapperEvent(JSON.parse(await readFile(taken, 'utf8')));
        if (parsed !== null) await this.handle(parsed);
        else this.logger.warn('Ignored an invalid LLM session event');
      } catch (error) {
        this.logger.warn('LLM session event could not be processed', {
          error: describeError(error),
        });
      } finally {
        await rm(taken, { force: true });
      }
    }
  }

  private async handle(event: WrapperEvent): Promise<void> {
    if (event.projectId === '' || !(await this.options.keepsContext(event.projectId))) return;
    const checkpoint = path.join(
      this.options.projectDir(event.projectId),
      'checkpoints',
      `${event.run}.md`,
    );
    if (event.event === 'start') {
      const target = await this.options.resolveProject(event.projectId);
      const terminalId = event.terminalId === '' ? null : event.terminalId;
      // A session started with "Start with context" already tracks this terminal.
      const existing =
        terminalId === null ? null : await this.options.context.sessionForTerminal(terminalId);
      const session =
        existing ??
        (await this.options.context.startSession(target, {
          provider: event.provider,
          captureMode: 'attached',
          terminalId,
        }));
      this.runs.set(event.run, {
        projectId: event.projectId,
        provider: event.provider,
        sessionId: session.id,
        checkpoint,
        lastModified: 0,
      });
      return;
    }
    const run = this.runs.get(event.run) ?? {
      projectId: event.projectId,
      provider: event.provider,
      sessionId:
        event.terminalId === ''
          ? null
          : ((await this.options.context.sessionForTerminal(event.terminalId))?.id ?? null),
      checkpoint,
      lastModified: 0,
    };
    await this.importCheckpoint(event.run, run);
    if (run.sessionId !== null) await this.finish(run.projectId, run.sessionId);
    this.runs.delete(event.run);
  }

  /** Ends a session with the Git evidence; sessions already ended are left alone. */
  private async finish(projectId: string, sessionId: string): Promise<void> {
    const target = await this.options.resolveProject(projectId);
    const session = (await this.options.context.listSessions(target)).find(
      (item) => item.id === sessionId,
    );
    if (session === undefined || session.status === 'ended') return;
    await this.options.context.endSession(
      target,
      sessionId,
      { summary: '', completed: [], pending: [], decisions: [], nextActions: [] },
      'atlas',
      { automatic: true },
    );
    await this.options.changed(target);
  }

  private async pollCheckpoints(): Promise<void> {
    for (const [runId, run] of this.runs) await this.importCheckpoint(runId, run);
  }

  /** Imports the run's checkpoint when the LLM changed it since the last import. */
  private async importCheckpoint(runId: string, run: Run): Promise<void> {
    try {
      const info = await stat(run.checkpoint).catch(() => null);
      if (info === null || !info.isFile() || info.mtimeMs === run.lastModified) return;
      run.lastModified = info.mtimeMs;
      if (info.size > MAX_CHECKPOINT_BYTES) {
        this.logger.warn('LLM checkpoint not imported: file too large', { size: info.size });
        return;
      }
      const target = await this.options.resolveProject(run.projectId);
      const entry = await this.options.context.recordCheckpoint(target, {
        runId,
        provider: run.provider,
        sessionId: run.sessionId,
        text: await readFile(run.checkpoint, 'utf8'),
      });
      if (entry !== null) await this.options.changed(target);
    } catch (error) {
      this.logger.warn('LLM checkpoint could not be imported', { error: describeError(error) });
    }
  }
}
