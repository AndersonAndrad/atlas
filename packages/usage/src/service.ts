import path from 'node:path';
import {
  AddUsageProfileSchema,
  DEFAULT_USAGE_SETTINGS,
  UpdateUsageProfileSchema,
  UpdateUsageSettingsSchema,
  UsageOverviewQuerySchema,
  parseInput,
  AI_SESSIONS_SHOWN,
  type AiBillingKind,
  type AiProvider,
  type AiSessionUsage,
  type TerminalLlmUsage,
  type UsageDayValue,
  type UsageMetric,
  type UsageOverview,
  type UsageProfile,
  type UsageProfileReport,
  type UsageSettings,
  type UsageSource,
} from '@atlas/contracts';
import { AtlasError, describeError, type Logger } from '@atlas/shared';
import { localDate, presentWindows, rangeStart, weeklyTotals } from './aggregation.js';
import type { ClaudeStatus } from './claude.js';
import { detectProfiles, profileName } from './profiles.js';
import {
  UsageCollectionFailure,
  type ClaudeAuthReader,
  type CodexReader,
  type StoredAiSession,
  type UsageRepository,
} from './ports.js';
import type { LimitSnapshot } from './windows.js';

const SETTINGS_KEY = 'usage.settings';
/** Collections of one profile are at least this far apart, manual refreshes included. */
export const MIN_COLLECTION_INTERVAL_MS = 60_000;
/** Claude Code data only arrives while an ATLAS session runs. */
const CLAUDE_STALE_AFTER_MS = 30 * 60_000;
/** An unchanged window is stored again at most this often (keeps freshness visible). */
const UNCHANGED_SNAPSHOT_INTERVAL_MS = 5 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

export interface UsageSettingsStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

export interface UsageServiceOptions {
  repository: UsageRepository;
  settings: UsageSettingsStore;
  codex: CodexReader;
  claudeAuth: ClaudeAuthReader;
  home: string;
  env: Record<string, string | undefined>;
  /** Names of the entries of the home folder that are directories. */
  listHomeDirectories: () => Promise<string[]>;
  isDirectory: (directory: string) => Promise<boolean>;
  clock: { now(): Date };
  generateId: () => string;
  logger: Logger;
  /** Profiles were added, changed or removed (e.g. to rewrite the wrapper's settings). */
  onProfilesChanged?: (profiles: UsageProfile[]) => void;
}

/**
 * Account profiles and their usage (SDD-008 Milestone B). Values come only from the
 * provider (through its CLI) or from ATLAS sessions; nothing is inferred or invented.
 */
export class UsageService {
  private readonly lastAttempt = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(private readonly options: UsageServiceOptions) {}

  // Profiles -------------------------------------------------------------------

  /** Registers profile directories that follow the CLI naming convention. */
  async syncProfiles(): Promise<UsageProfile[]> {
    const { repository } = this.options;
    const candidates = detectProfiles({
      home: this.options.home,
      entries: await this.options.listHomeDirectories(),
      env: this.options.env,
    });
    let changed = false;
    for (const candidate of candidates) {
      if (await repository.findProfileByDirectory(candidate.providerId, candidate.directory)) {
        continue;
      }
      if (!(await this.options.isDirectory(candidate.directory))) continue;
      await repository.insertProfile(
        this.newProfile(
          candidate.providerId,
          candidate.directory,
          candidate.displayName,
          'detected',
        ),
      );
      changed = true;
    }
    const profiles = await repository.listProfiles();
    if (changed) this.options.onProfilesChanged?.(profiles);
    return profiles;
  }

  async addProfile(input: unknown, explicit: boolean): Promise<UsageProfile> {
    const parsed = parseInput(AddUsageProfileSchema, input);
    // Only folders the user chose in the native picker (or typed in the CLI) are accepted.
    if (!explicit || !path.isAbsolute(parsed.directory)) {
      throw new AtlasError('USAGE_PROFILE_UNAUTHORIZED');
    }
    const directory = path.resolve(parsed.directory);
    if (!(await this.options.isDirectory(directory))) {
      throw new AtlasError('USAGE_PROFILE_UNAUTHORIZED', undefined, {
        details: { reason: 'not-a-directory' },
      });
    }
    const existing = await this.options.repository.findProfileByDirectory(
      parsed.providerId,
      directory,
    );
    if (existing !== null) {
      return existing.hidden ? this.saveProfile({ ...existing, hidden: false }) : existing;
    }
    const profile = this.newProfile(
      parsed.providerId,
      directory,
      parsed.displayName ?? profileName(parsed.providerId, directory),
      'added',
    );
    await this.options.repository.insertProfile(profile);
    await this.profilesChanged();
    return profile;
  }

  async updateProfile(id: string, changes: unknown): Promise<UsageProfile> {
    const parsed = parseInput(UpdateUsageProfileSchema, changes);
    const profile = await this.requireProfile(id);
    return this.saveProfile({
      ...profile,
      ...(parsed.displayName !== undefined ? { displayName: parsed.displayName } : {}),
      ...(parsed.hidden !== undefined ? { hidden: parsed.hidden } : {}),
      ...(parsed.statusLineEnabled !== undefined
        ? { statusLineEnabled: parsed.statusLineEnabled }
        : {}),
    });
  }

  /**
   * Removes a profile the user added, with its observations. Detected profiles would be
   * found again, so they are hidden instead. Provider files are never touched.
   */
  async removeProfile(id: string): Promise<void> {
    const profile = await this.requireProfile(id);
    if (profile.origin === 'detected') {
      await this.saveProfile({ ...profile, hidden: true });
      return;
    }
    await this.options.repository.removeProfile(id);
    this.lastAttempt.delete(id);
    await this.profilesChanged();
  }

  /** Claude profile directories whose ATLAS sessions must not use the ATLAS status line. */
  static statusLineDisabled(profiles: readonly UsageProfile[]): string[] {
    return profiles
      .filter((profile) => profile.providerId === 'claude' && !profile.statusLineEnabled)
      .map((profile) => profile.profileDirectory);
  }

  // Settings -------------------------------------------------------------------

  async getSettings(): Promise<UsageSettings> {
    const raw = await this.options.settings.get(SETTINGS_KEY);
    if (raw === null) return { ...DEFAULT_USAGE_SETTINGS };
    try {
      const stored = UpdateUsageSettingsSchema.safeParse(JSON.parse(raw));
      return { ...DEFAULT_USAGE_SETTINGS, ...(stored.success ? stored.data : {}) };
    } catch {
      return { ...DEFAULT_USAGE_SETTINGS };
    }
  }

  async updateSettings(changes: unknown): Promise<UsageSettings> {
    const parsed = parseInput(UpdateUsageSettingsSchema, changes);
    const next = { ...(await this.getSettings()), ...parsed };
    await this.options.settings.set(SETTINGS_KEY, JSON.stringify(next));
    return next;
  }

  // Reports --------------------------------------------------------------------

  async overview(query: unknown = {}): Promise<UsageOverview> {
    const { days } = parseInput(UsageOverviewQuerySchema, query);
    const settings = await this.getSettings();
    const profiles = await this.syncProfiles();
    const now = this.options.clock.now();
    const from = rangeStart(localDate(now), days);
    const reports: UsageProfileReport[] = [];
    for (const profile of profiles) {
      const staleAfter =
        profile.providerId === 'codex' && settings.refreshMinutes > 0
          ? Math.max(3 * settings.refreshMinutes * 60_000, CLAUDE_STALE_AFTER_MS)
          : CLAUDE_STALE_AFTER_MS;
      const windows = presentWindows(
        await this.options.repository.latestWindows(profile.id),
        now,
        staleAfter,
      );
      const daily = await this.options.repository.daily(profile.id, from);
      const limited = windows.some(
        (window) => window.state !== 'reset' && window.usedPercent >= 100,
      );
      reports.push({
        profile:
          limited && profile.status === 'CONNECTED' ? { ...profile, status: 'LIMITED' } : profile,
        windows,
        daily,
        weekly: weeklyTotals(daily),
        coverage: profile.providerId === 'codex' ? 'account' : 'atlas-sessions',
        sessions: (
          await this.options.repository.recentAiSessions(profile.id, AI_SESSIONS_SHOWN)
        ).map(sessionUsage),
      });
    }
    return { generatedAt: now.toISOString(), settings, profiles: reports };
  }

  /**
   * Name and session window of the Claude Code profile at `configDirectory`, for the
   * terminal where it is open (PLAN-031). Read only: an unknown profile is not created.
   */
  async claudeSessionUsage(configDirectory: string): Promise<TerminalLlmUsage> {
    const directory = path.resolve(configDirectory);
    const profile = await this.options.repository.findProfileByDirectory('claude', directory);
    if (profile === null) {
      return {
        providerId: 'claude',
        profileId: null,
        displayName: profileName('claude', directory),
        session: null,
      };
    }
    const windows = presentWindows(
      await this.options.repository.latestWindows(profile.id),
      this.options.clock.now(),
      CLAUDE_STALE_AFTER_MS,
    );
    return {
      providerId: 'claude',
      profileId: profile.id,
      displayName: profile.displayName,
      session: windows.find((window) => window.kind === 'session') ?? null,
    };
  }

  // Collection -----------------------------------------------------------------

  /**
   * Collects from the provider CLIs: one profile, or every visible one. A profile is
   * collected at most once per minute; earlier requests return without collecting.
   */
  async refresh(profileId: string | null = null): Promise<void> {
    const profiles =
      profileId === null
        ? (await this.syncProfiles()).filter((profile) => !profile.hidden)
        : [await this.requireProfile(profileId)];
    await Promise.all(profiles.map((profile) => this.collect(profile)));
  }

  /** Background collection: profiles whose last attempt is older than the interval. */
  async refreshDue(): Promise<void> {
    const { refreshMinutes, retentionDays } = await this.getSettings();
    if (refreshMinutes === 0) return;
    const now = this.options.clock.now().getTime();
    const due = (await this.syncProfiles()).filter(
      (profile) =>
        !profile.hidden && now - (this.lastAttempt.get(profile.id) ?? 0) >= refreshMinutes * 60_000,
    );
    await Promise.all(due.map((profile) => this.collect(profile)));
    await this.prune(retentionDays);
  }

  private collect(profile: UsageProfile): Promise<void> {
    const running = this.inFlight.get(profile.id);
    if (running !== undefined) return running;
    const now = this.options.clock.now().getTime();
    if (now - (this.lastAttempt.get(profile.id) ?? 0) < MIN_COLLECTION_INTERVAL_MS) {
      return Promise.resolve();
    }
    this.lastAttempt.set(profile.id, now);
    const work = this.collectNow(profile).finally(() => this.inFlight.delete(profile.id));
    this.inFlight.set(profile.id, work);
    return work;
  }

  private async collectNow(profile: UsageProfile): Promise<void> {
    const observedAt = this.options.clock.now().toISOString();
    try {
      if (profile.providerId === 'codex') {
        const result = await this.options.codex.read(profile.profileDirectory);
        for (const window of result.limits.windows) {
          await this.options.repository.addWindowSnapshot(profile.id, window);
        }
        for (const day of result.daily) {
          await this.options.repository.setDaily(profile.id, {
            date: day.date,
            metric: 'TOTAL_TOKENS',
            unit: 'tokens',
            value: day.tokens,
            source: 'PROVIDER_CLI',
            isEstimated: false,
          });
        }
        await this.saveCollected(profile.id, {
          status: result.account.status,
          plan: result.account.plan ?? result.limits.plan,
          lastSyncAt: observedAt,
          lastError: null,
        });
      } else {
        // Claude Code limits arrive through the status line; here only the sign-in state.
        const account = await this.options.claudeAuth.read(profile.profileDirectory);
        await this.saveCollected(profile.id, { ...account, lastError: null });
      }
    } catch (error) {
      const failure =
        error instanceof UsageCollectionFailure
          ? error
          : new UsageCollectionFailure(
              'unexpected-response',
              'The provider returned unexpected data.',
            );
      this.options.logger.warn('Usage collection failed', {
        provider: profile.providerId,
        profileId: profile.id,
        code: failure.code,
        ...(error instanceof UsageCollectionFailure ? {} : { error: describeError(error) }),
      });
      await this.saveCollected(profile.id, {
        status: failure.status,
        lastError: { code: failure.code, message: failure.message, at: observedAt },
      });
    }
  }

  /**
   * Records what Claude Code reported to the ATLAS status line in a session of the
   * profile at `configDirectory`. Cumulative session values become daily increments.
   */
  async recordClaudeStatus(input: {
    configDirectory: string;
    status: ClaudeStatus;
    observedAt: Date;
  }): Promise<void> {
    const { repository } = this.options;
    const directory = path.resolve(input.configDirectory);
    let profile = await repository.findProfileByDirectory('claude', directory);
    if (profile === null) {
      profile = this.newProfile('claude', directory, profileName('claude', directory), 'detected');
      await repository.insertProfile(profile);
      await this.profilesChanged();
    }
    const latest = new Map(
      (await repository.latestWindows(profile.id)).map((window) => [window.key, window]),
    );
    for (const window of input.status.windows) {
      if (this.changed(latest.get(window.key), window)) {
        await repository.addWindowSnapshot(profile.id, window);
      }
    }
    const date = localDate(input.observedAt);
    const at = input.observedAt.toISOString();
    await this.addSessionIncrement(profile.id, input.status.sessionId, date, at, {
      metric: 'API_DURATION',
      unit: 'ms',
      value: input.status.apiDurationMs,
      source: 'ATLAS_EXECUTION',
      isEstimated: false,
    });
    await this.addSessionIncrement(profile.id, input.status.sessionId, date, at, {
      metric: 'COST',
      unit: 'USD',
      value: input.status.costUsd,
      source: 'LOCAL_ESTIMATE',
      isEstimated: true,
    });
    await this.recordSession(profile, input.status, at);
    await this.saveCollected(profile.id, {
      lastUsedAt: at,
      ...(input.status.windows.length > 0 ? { lastSyncAt: at } : {}),
    });
  }

  /**
   * Keeps the session's estimated cost (Task E01.1). Claude Code reports a cumulative
   * value; when it drops within the same session its counters restarted, so the previous
   * run is added to the base and the new run starts: nothing is counted twice, and
   * re-reading the same answer changes nothing.
   */
  private async recordSession(
    profile: UsageProfile,
    status: ClaudeStatus,
    at: string,
  ): Promise<void> {
    const { repository } = this.options;
    const previous = await repository.findAiSession(profile.id, status.sessionId);
    let base = previous?.costBaseUsd ?? 0;
    let run = previous?.costRunUsd ?? null;
    if (status.costUsd !== null) {
      if (run !== null && status.costUsd < run) base += run;
      run = status.costUsd;
    }
    await repository.saveAiSession({
      profileId: profile.id,
      sessionId: status.sessionId,
      providerId: profile.providerId,
      model: status.model ?? previous?.model ?? null,
      costBaseUsd: base,
      costRunUsd: run,
      billing: mergeBilling(previous?.billing ?? 'UNKNOWN', billingOf(profile, status)),
      source: 'LOCAL_ESTIMATE',
      firstSeenAt: previous?.firstSeenAt ?? at,
      updatedAt: at,
    });
  }

  private changed(previous: LimitSnapshot | undefined, next: LimitSnapshot): boolean {
    if (previous === undefined) return true;
    if (previous.usedPercent !== next.usedPercent || previous.resetsAt !== next.resetsAt) {
      return true;
    }
    return (
      Date.parse(next.observedAt) - Date.parse(previous.observedAt) >=
      UNCHANGED_SNAPSHOT_INTERVAL_MS
    );
  }

  private async addSessionIncrement(
    profileId: string,
    sessionId: string,
    date: string,
    at: string,
    value: {
      metric: UsageMetric;
      unit: string;
      value: number | null;
      source: UsageSource;
      isEstimated: boolean;
    },
  ): Promise<void> {
    if (value.value === null) return;
    const { repository } = this.options;
    const previous = await repository.sessionProgress(profileId, sessionId, value.metric);
    // A lower cumulative value means the session's counters restarted.
    const delta =
      previous === null || value.value < previous ? value.value : value.value - previous;
    await repository.setSessionProgress(profileId, sessionId, value.metric, value.value, at);
    if (delta <= 0) return;
    const day: UsageDayValue = { ...value, date, value: delta };
    await repository.addDaily(profileId, day);
  }

  private async prune(retentionDays: number): Promise<void> {
    const now = this.options.clock.now();
    const cutoff = new Date(now.getTime() - retentionDays * DAY_MS);
    await this.options.repository.prune(cutoff.toISOString(), localDate(cutoff));
  }

  // Helpers --------------------------------------------------------------------

  private newProfile(
    providerId: AiProvider,
    directory: string,
    displayName: string,
    origin: UsageProfile['origin'],
  ): UsageProfile {
    const now = this.options.clock.now().toISOString();
    return {
      id: this.options.generateId(),
      providerId,
      displayName: displayName.slice(0, 80),
      profileDirectory: directory,
      origin,
      status: 'UNKNOWN',
      plan: null,
      statusLineEnabled: true,
      hidden: false,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null,
      lastSyncAt: null,
      lastError: null,
    };
  }

  private async requireProfile(id: string): Promise<UsageProfile> {
    const profile = await this.options.repository.findProfile(id);
    if (profile === null) throw new AtlasError('USAGE_PROFILE_NOT_FOUND');
    return profile;
  }

  private async saveProfile(profile: UsageProfile): Promise<UsageProfile> {
    const saved = { ...profile, updatedAt: this.options.clock.now().toISOString() };
    await this.options.repository.updateProfile(saved);
    await this.profilesChanged();
    return saved;
  }

  /** Collection results: re-read first, the profile may have changed meanwhile. */
  private async saveCollected(id: string, changes: Partial<UsageProfile>): Promise<void> {
    const current = await this.options.repository.findProfile(id);
    if (current === null) return;
    await this.options.repository.updateProfile({ ...current, ...changes });
  }

  private async profilesChanged(): Promise<void> {
    if (this.options.onProfilesChanged === undefined) return;
    this.options.onProfilesChanged(await this.options.repository.listProfiles());
  }
}

/**
 * Billing evidence of one status line answer: plan limits (`five_hour`, `seven_day`) or a
 * known plan mean a subscription; a gateway spend limit or a sign-in without a plan, API
 * billing. A usage percentage is never turned into dollars.
 */
function billingOf(profile: UsageProfile, status: ClaudeStatus): AiBillingKind {
  if (status.windows.some((window) => window.key !== 'spend_limit') || profile.plan !== null) {
    return 'SUBSCRIPTION';
  }
  if (status.windows.length > 0) return 'API';
  if (profile.status === 'CONNECTED' || profile.status === 'LIMITED') return 'API';
  return 'UNKNOWN';
}

/** Plan limits seen once settle it; otherwise the latest known evidence wins. */
function mergeBilling(previous: AiBillingKind, next: AiBillingKind): AiBillingKind {
  if (previous === 'SUBSCRIPTION' || next === 'UNKNOWN') return previous;
  return next;
}

function sessionUsage(session: StoredAiSession): AiSessionUsage {
  return {
    sessionId: session.sessionId,
    providerId: session.providerId,
    model: session.model,
    costUsd:
      session.costRunUsd === null && session.costBaseUsd === 0
        ? null
        : session.costBaseUsd + (session.costRunUsd ?? 0),
    billing: session.billing,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    source: session.source,
    firstSeenAt: session.firstSeenAt,
    updatedAt: session.updatedAt,
  };
}
