import type {
  TerminalActivity,
  TerminalActivityState,
  TerminalActivitySummary,
} from '@atlas/contracts';
import { describeError, noopLogger, type Logger } from '@atlas/shared';

/** Storage of tracked terminal activities (SQLite in the Engine). */
export interface TerminalActivityStore {
  list(): Promise<TerminalActivity[]>;
  /** False when the terminal does not exist (nothing is written). */
  upsert(activity: TerminalActivity): Promise<boolean>;
  /** Removes acknowledged activities of a terminal except `keepRef`. */
  pruneAcknowledged(terminalId: string, keepRef: string): Promise<void>;
}

export interface TerminalActivityServiceOptions {
  store: TerminalActivityStore;
  now: () => Date;
  onChange: (summary: TerminalActivitySummary) => void;
  logger?: Logger;
}

export interface AiLifecycleEvent {
  terminalId: string;
  provider: 'claude' | 'codex';
  /** The wrapper's run id; identifies the activity. */
  run: string;
  contextSessionId?: string | null;
}

const key = (terminalId: string, ref: string) => `${terminalId}\0${ref}`;
const finished = (state: TerminalActivityState) => state !== 'RUNNING';

/**
 * Status of tracked operations per terminal (SDD-023 Task A02), fed by explicit lifecycle
 * events only: AI wrapper start and end, and terminal exit. Never inferred from output.
 * Each operation keeps its own state; a finished one never runs again, so late or repeated
 * events cannot overwrite newer state. Results stay pending until explicitly reviewed.
 */
export class TerminalActivityService {
  private readonly activities = new Map<string, TerminalActivity>();
  private readonly logger: Logger;
  private loaded: Promise<void> | null = null;

  constructor(private readonly options: TerminalActivityServiceOptions) {
    this.logger = options.logger ?? noopLogger;
  }

  /**
   * Loads stored activities. Nothing survives ATLAS: activities still RUNNING are recorded
   * as INTERRUPTED (their terminals ended with the previous Engine).
   */
  load(): Promise<void> {
    this.loaded ??= (async () => {
      const at = this.timestamp();
      for (const stored of await this.options.store.list()) {
        const activity =
          stored.state === 'RUNNING'
            ? { ...stored, state: 'INTERRUPTED' as const, finishedAt: at }
            : stored;
        this.activities.set(key(activity.terminalId, activity.ref), activity);
        if (activity !== stored) await this.save(activity);
      }
    })();
    return this.loaded;
  }

  summaries(): TerminalActivitySummary[] {
    const ids = new Set([...this.activities.values()].map((item) => item.terminalId));
    return [...ids].map((terminalId) => this.summary(terminalId));
  }

  summary(terminalId: string): TerminalActivitySummary {
    const all = [...this.activities.values()]
      .filter((item) => item.terminalId === terminalId)
      .sort((a, b) => order(a).localeCompare(order(b)));
    const pending = all.filter((item) => item.acknowledgedAt === null);
    const latest = all.at(-1) ?? null;
    return {
      terminalId,
      activities: pending,
      reviewed: latest !== null && latest.acknowledgedAt !== null ? latest : null,
    };
  }

  async aiStarted(event: AiLifecycleEvent): Promise<void> {
    await this.load();
    const existing = this.activities.get(key(event.terminalId, event.run));
    // A start that arrives after the end (or twice) changes nothing.
    if (existing !== undefined) return;
    await this.apply({
      terminalId: event.terminalId,
      kind: 'ai',
      provider: event.provider,
      ref: event.run,
      state: 'RUNNING',
      startedAt: this.timestamp(),
      finishedAt: null,
      exitCode: null,
      acknowledgedAt: null,
      contextSessionId: event.contextSessionId ?? null,
    });
  }

  /** Success asks for review; anything else (including an unknown exit code) failed. */
  async aiEnded(event: AiLifecycleEvent & { exitCode: number | null }): Promise<void> {
    await this.load();
    const existing = this.activities.get(key(event.terminalId, event.run));
    if (existing !== undefined && finished(existing.state)) return;
    const at = this.timestamp();
    await this.apply({
      terminalId: event.terminalId,
      kind: 'ai',
      provider: event.provider,
      ref: event.run,
      startedAt: existing?.startedAt ?? null,
      contextSessionId: existing?.contextSessionId ?? event.contextSessionId ?? null,
      acknowledgedAt: null,
      state: event.exitCode === 0 ? 'ATTENTION_REQUIRED' : 'FAILED',
      finishedAt: at,
      exitCode: event.exitCode,
    });
  }

  /** The terminal ended: what was still running can no longer report its end. */
  async terminalEnded(terminalId: string): Promise<void> {
    await this.load();
    const at = this.timestamp();
    const running = [...this.activities.values()].filter(
      (item) => item.terminalId === terminalId && item.state === 'RUNNING',
    );
    for (const activity of running) {
      await this.apply({ ...activity, state: 'INTERRUPTED', finishedAt: at }, false);
    }
    if (running.length > 0) this.options.onChange(this.summary(terminalId));
  }

  /** The terminal's record was removed; its activities went with it (cascade). */
  terminalRemoved(terminalId: string): void {
    for (const [id, activity] of this.activities) {
      if (activity.terminalId === terminalId) this.activities.delete(id);
    }
  }

  /**
   * Marks every finished, unreviewed result of the terminal as reviewed (explicit user
   * action). Running activities are left alone. Older reviewed results are dropped.
   */
  async markReviewed(terminalId: string): Promise<TerminalActivitySummary> {
    await this.load();
    const at = this.timestamp();
    const pending = [...this.activities.values()].filter(
      (item) =>
        item.terminalId === terminalId && finished(item.state) && item.acknowledgedAt === null,
    );
    for (const activity of pending) {
      await this.apply({ ...activity, acknowledgedAt: at }, false);
    }
    const reviewed = this.summary(terminalId).reviewed;
    if (reviewed !== null) {
      for (const [id, activity] of this.activities) {
        if (
          activity.terminalId === terminalId &&
          activity.acknowledgedAt !== null &&
          activity.ref !== reviewed.ref
        ) {
          this.activities.delete(id);
        }
      }
      await this.options.store.pruneAcknowledged(terminalId, reviewed.ref);
    }
    const summary = this.summary(terminalId);
    if (pending.length > 0) this.options.onChange(summary);
    return summary;
  }

  private async apply(activity: TerminalActivity, notify = true): Promise<void> {
    if (!(await this.save(activity))) return;
    this.activities.set(key(activity.terminalId, activity.ref), activity);
    if (notify) this.options.onChange(this.summary(activity.terminalId));
  }

  private async save(activity: TerminalActivity): Promise<boolean> {
    try {
      return await this.options.store.upsert(activity);
    } catch (error) {
      this.logger.warn('Terminal activity could not be saved', { error: describeError(error) });
      return false;
    }
  }

  private timestamp(): string {
    return this.options.now().toISOString();
  }
}

/** Order of activities: by when they started, else when they finished. */
function order(activity: TerminalActivity): string {
  return activity.startedAt ?? activity.finishedAt ?? '';
}
