import type {
  AiBillingKind,
  AiProvider,
  UsageDayValue,
  UsageMetric,
  UsageProfile,
  UsageSource,
} from '@atlas/contracts';
import type { AccountState, CodexLimits } from './codex.js';
import type { LimitSnapshot } from './windows.js';

/** Storage of profiles and observations (SQLite in the Engine, memory in tests). */
export interface UsageRepository {
  listProfiles(): Promise<UsageProfile[]>;
  findProfile(id: string): Promise<UsageProfile | null>;
  findProfileByDirectory(providerId: AiProvider, directory: string): Promise<UsageProfile | null>;
  insertProfile(profile: UsageProfile): Promise<void>;
  updateProfile(profile: UsageProfile): Promise<void>;
  /** Removes the profile and its observations. */
  removeProfile(id: string): Promise<void>;
  /** The most recent snapshot of each window key of a profile. */
  latestWindows(profileId: string): Promise<LimitSnapshot[]>;
  addWindowSnapshot(profileId: string, snapshot: LimitSnapshot): Promise<void>;
  /** Replaces a daily value (provider snapshots: the latest report wins). */
  setDaily(profileId: string, value: UsageDayValue): Promise<void>;
  /** Adds to a daily value (incremental events measured by ATLAS). */
  addDaily(profileId: string, value: UsageDayValue): Promise<void>;
  /** Daily values from `fromDate` (inclusive), oldest first. */
  daily(profileId: string, fromDate: string): Promise<UsageDayValue[]>;
  /** Last cumulative value seen for a session, to turn snapshots into increments. */
  sessionProgress(
    profileId: string,
    sessionId: string,
    metric: UsageMetric,
  ): Promise<number | null>;
  setSessionProgress(
    profileId: string,
    sessionId: string,
    metric: UsageMetric,
    value: number,
    at: string,
  ): Promise<void>;
  findAiSession(profileId: string, sessionId: string): Promise<StoredAiSession | null>;
  saveAiSession(session: StoredAiSession): Promise<void>;
  /** Most recently updated first. */
  recentAiSessions(profileId: string, limit: number): Promise<StoredAiSession[]>;
  /**
   * Deletes snapshots, session progress and sessions observed before `before`, and daily
   * values dated before `beforeDate`.
   */
  prune(before: string, beforeDate: string): Promise<void>;
}

/** A session's cost as stored: earlier counter runs plus the current run (Task E01.1). */
export interface StoredAiSession {
  profileId: string;
  sessionId: string;
  providerId: AiProvider;
  model: string | null;
  /** Sum of earlier runs of the session's counters. */
  costBaseUsd: number;
  /** The latest cumulative value of the current run; null when none was reported. */
  costRunUsd: number | null;
  billing: AiBillingKind;
  source: UsageSource;
  firstSeenAt: string;
  updatedAt: string;
}

/** Thrown by collectors; `message` is safe to show and never contains provider output. */
export class UsageCollectionFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 'AUTH_REQUIRED' | 'DISCONNECTED' | 'UNKNOWN' = 'UNKNOWN',
  ) {
    super(message);
    this.name = 'UsageCollectionFailure';
  }
}

/** Reads one Codex profile through `codex app-server` (no model requests). */
export interface CodexReader {
  read(profileDirectory: string): Promise<{
    account: AccountState;
    limits: CodexLimits;
    daily: { date: string; tokens: number }[];
  }>;
}

/** Reads the sign-in state of one Claude Code profile (`claude auth status`). */
export interface ClaudeAuthReader {
  read(profileDirectory: string): Promise<AccountState>;
}
