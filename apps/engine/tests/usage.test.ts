import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AiProvider, UsageProfile } from '@atlas/contracts';
import {
  SqliteSettingsRepository,
  SqliteUsageRepository,
  openDatabase,
  type Database,
} from '@atlas/persistence';
import {
  UsageCollectionFailure,
  UsageService,
  parseClaudeStatus,
  type AccountState,
  type ClaudeAuthReader,
  type CodexReader,
} from '@atlas/usage';
import { createTempDir } from '../../../tests/support/temp.js';
import { ClaudeAuthStatusReader, CodexAppServerReader } from '../src/adapters/usage-cli.js';
import { ProjectConfigStore, STATUS_LINE_OFF_FILE } from '../src/project-config.js';
import { ClaudeStatusInbox } from '../src/usage-inbox.js';

const posix = process.platform !== 'win32';

class FakeCodex implements CodexReader {
  calls: string[] = [];
  failure: Error | null = null;
  usedPercent = 22;
  async read(profileDirectory: string) {
    this.calls.push(profileDirectory);
    if (this.failure) throw this.failure;
    return {
      account: { status: 'CONNECTED' as const, plan: 'plus' },
      limits: {
        plan: 'plus',
        limited: false,
        windows: [
          {
            key: 'codex:primary',
            kind: 'session' as const,
            label: 'Current session (5h)',
            usedPercent: this.usedPercent,
            windowMinutes: 300,
            resetsAt: '2026-10-23T15:00:00.000Z',
            observedAt: '2026-10-23T12:00:00.000Z',
            source: 'PROVIDER_CLI' as const,
          },
          {
            key: 'codex:secondary',
            kind: 'weekly' as const,
            label: 'Weekly',
            usedPercent: 100,
            windowMinutes: 10080,
            resetsAt: '2026-10-28T00:00:00.000Z',
            observedAt: '2026-10-23T12:00:00.000Z',
            source: 'PROVIDER_CLI' as const,
          },
        ],
      },
      daily: [
        { date: '2026-10-22', tokens: 1000 },
        { date: '2026-10-23', tokens: 500 },
      ],
    };
  }
}

class FakeClaudeAuth implements ClaudeAuthReader {
  calls: string[] = [];
  async read(profileDirectory: string): Promise<AccountState> {
    this.calls.push(profileDirectory);
    return { status: 'CONNECTED', plan: 'max' };
  }
}

describe('UsageService with SQLite (SDD-008 Milestone B)', () => {
  let temp: ReturnType<typeof createTempDir>;
  let db: Database;
  let now: Date;
  let codex: FakeCodex;
  let claudeAuth: FakeClaudeAuth;
  let changes: UsageProfile[][];
  let usage: UsageService;
  let serviceOptions: ConstructorParameters<typeof UsageService>[0];
  let home: string;
  let ids: number;

  beforeEach(() => {
    temp = createTempDir();
    home = path.join(temp.dir, 'home');
    for (const name of ['.claude', '.claude-my', '.codex', '.codex-work', 'projects']) {
      mkdirSync(path.join(home, name), { recursive: true });
    }
    db = openDatabase({ filePath: path.join(temp.dir, 'atlas.db') });
    now = new Date('2026-10-23T12:00:00Z');
    codex = new FakeCodex();
    claudeAuth = new FakeClaudeAuth();
    changes = [];
    ids = 0;
    serviceOptions = {
      repository: new SqliteUsageRepository(db),
      settings: new SqliteSettingsRepository(db),
      codex,
      claudeAuth,
      home,
      env: {},
      listHomeDirectories: async () => readdirSync(home),
      isDirectory: async (directory) => existsSync(directory),
      clock: { now: () => now },
      generateId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      onProfilesChanged: (profiles) => changes.push(profiles),
    };
    usage = new UsageService(serviceOptions);
  });
  afterEach(() => {
    db.close();
    temp.cleanup();
  });

  const profile = async (providerId: AiProvider, suffix: string) =>
    (await usage.syncProfiles()).find(
      (item) =>
        item.providerId === providerId &&
        item.profileDirectory === path.join(home, `.${providerId}${suffix}`),
    )!;

  it('registers profile folders that follow the naming convention once', async () => {
    const profiles = await usage.syncProfiles();
    expect(profiles.map((item) => [item.providerId, item.displayName, item.origin])).toEqual([
      ['claude', 'default', 'detected'],
      ['claude', 'my', 'detected'],
      ['codex', 'default', 'detected'],
      ['codex', 'work', 'detected'],
    ]);
    expect(await usage.syncProfiles()).toHaveLength(4);
    expect(changes).toHaveLength(1);
  });

  it('collects Codex limits and daily tokens, at most once a minute per profile', async () => {
    const work = await profile('codex', '-work');
    await usage.refresh(work.id);
    await usage.refresh(work.id);
    expect(codex.calls).toEqual([work.profileDirectory]);

    const report = (await usage.overview({ days: 7 })).profiles.find(
      (item) => item.profile.id === work.id,
    )!;
    expect(report.coverage).toBe('account');
    // A window at 100% that has not reset yet: the account is limited.
    expect(report.profile).toMatchObject({ status: 'LIMITED', plan: 'plus', lastError: null });
    expect(report.windows.map((window) => [window.key, window.usedPercent, window.state])).toEqual([
      ['codex:primary', 22, 'current'],
      ['codex:secondary', 100, 'current'],
    ]);
    expect(report.daily.map((day) => [day.date, day.value, day.source])).toEqual([
      ['2026-10-22', 1000, 'PROVIDER_CLI'],
      ['2026-10-23', 500, 'PROVIDER_CLI'],
    ]);
    expect(report.weekly).toEqual([
      expect.objectContaining({ weekStart: '2026-10-19', value: 1500, days: 2 }),
    ]);

    // The provider's daily report replaces the day; it is not added twice.
    now = new Date('2026-10-23T12:01:01Z');
    await usage.refresh(work.id);
    const again = (await usage.overview({ days: 7 })).profiles.find(
      (item) => item.profile.id === work.id,
    )!;
    expect(again.daily.map((day) => day.value)).toEqual([1000, 500]);
  });

  it('records failures without numbers and keeps the last observation visible', async () => {
    const work = await profile('codex', '-work');
    await usage.refresh(work.id);
    now = new Date('2026-10-23T14:00:00Z');
    codex.failure = new UsageCollectionFailure('auth-required', 'Sign in.', 'AUTH_REQUIRED');
    await usage.refresh(work.id);
    const report = (await usage.overview()).profiles.find((item) => item.profile.id === work.id)!;
    expect(report.profile.status).toBe('AUTH_REQUIRED');
    expect(report.profile.lastError).toEqual({
      code: 'auth-required',
      message: 'Sign in.',
      at: '2026-10-23T14:00:00.000Z',
    });
    // Two hours later the old reading is stale, and still the provider's own value.
    expect(report.windows[0]).toMatchObject({ usedPercent: 22, state: 'stale' });

    now = new Date('2026-10-23T15:30:00Z');
    codex.failure = new Error('raw provider output with secrets');
    await usage.refresh(work.id);
    const later = (await usage.overview()).profiles.find((item) => item.profile.id === work.id)!;
    expect(later.profile.lastError?.code).toBe('unexpected-response');
    expect(later.profile.lastError?.message).not.toContain('secrets');
    // The session window's reported reset time passed: no percentage is assumed.
    expect(later.windows[0]).toMatchObject({ key: 'codex:primary', state: 'reset' });
  });

  it('collects every visible profile on schedule and skips hidden ones', async () => {
    const my = await profile('claude', '-my');
    await usage.updateProfile(my.id, { hidden: true });
    await usage.refreshDue();
    expect(codex.calls).toHaveLength(2);
    expect(claudeAuth.calls).toEqual([path.join(home, '.claude')]);
    await usage.refreshDue();
    expect(codex.calls).toHaveLength(2);
    now = new Date('2026-10-23T12:10:00Z');
    await usage.refreshDue();
    expect(codex.calls).toHaveLength(4);
    await usage.updateSettings({ refreshMinutes: 0 });
    now = new Date('2026-10-23T13:00:00Z');
    await usage.refreshDue();
    expect(codex.calls).toHaveLength(4);
    await expect(usage.updateSettings({ refreshMinutes: 2 })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('turns Claude Code session snapshots into daily increments counted once', async () => {
    const directory = path.join(home, '.claude-new');
    const record = (cost: number, ms: number, session = 's1', at = now) =>
      usage.recordClaudeStatus({
        configDirectory: directory,
        observedAt: at,
        status: parseClaudeStatus(
          {
            session_id: session,
            cost: { total_cost_usd: cost, total_api_duration_ms: ms },
            rate_limits: { five_hour: { used_percentage: 40, resets_at: 1792800000 } },
          },
          at.toISOString(),
        ),
      });
    await record(1, 60_000);
    await record(1, 60_000); // the same status line answer again
    await record(1.5, 90_000);
    await record(0.25, 10_000); // `/clear` restarted the counters
    await record(2, 30_000, 's2');

    const report = (await usage.overview()).profiles.find(
      (item) => item.profile.profileDirectory === directory,
    )!;
    // A folder seen in an ATLAS session becomes a profile even outside the convention.
    expect(report.profile).toMatchObject({ displayName: 'new', origin: 'detected' });
    expect(report.coverage).toBe('atlas-sessions');
    expect(report.daily.map((day) => [day.metric, day.value, day.source, day.isEstimated])).toEqual(
      [
        ['API_DURATION', 130_000, 'ATLAS_EXECUTION', false],
        ['COST', 3.75, 'LOCAL_ESTIMATE', true],
      ],
    );
    expect(report.windows).toEqual([
      expect.objectContaining({ key: 'five_hour', usedPercent: 40, state: 'current' }),
    ]);
    expect(report.profile.lastSyncAt).toBe(now.toISOString());
  });

  describe('session costs (Task E01.1)', () => {
    const directory = () => path.join(home, '.claude-work');
    const record = (session: string, fields: Record<string, unknown>, at = now) =>
      usage.recordClaudeStatus({
        configDirectory: directory(),
        observedAt: at,
        status: parseClaudeStatus({ session_id: session, ...fields }, at.toISOString()),
      });
    const sessions = async () =>
      (await usage.overview()).profiles.find(
        (item) => item.profile.profileDirectory === directory(),
      )!.sessions;
    const later = (minutes: number) => new Date(now.getTime() + minutes * 60_000);

    it('keeps one cumulative cost per session, without double counting', async () => {
      const model = { id: 'claude-opus-5-5', display_name: 'Opus' };
      await record('s1', { model, cost: { total_cost_usd: 0.4 } });
      await record('s1', { model, cost: { total_cost_usd: 0.4 } }, later(1)); // same answer
      await record('s1', { model, cost: { total_cost_usd: 1.25 } }, later(2));
      const [only] = await sessions();
      expect(only).toMatchObject({
        sessionId: 's1',
        providerId: 'claude',
        model: 'claude-opus-5-5',
        costUsd: 1.25,
        source: 'LOCAL_ESTIMATE',
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        firstSeenAt: now.toISOString(),
        updatedAt: later(2).toISOString(),
      });
    });

    it('adds a restarted run of the same session instead of replacing or repeating it', async () => {
      await record('s1', { cost: { total_cost_usd: 2 } });
      await record('s1', { cost: { total_cost_usd: 0.5 } }, later(1)); // counters restarted
      await record('s1', { cost: { total_cost_usd: 0.5 } }, later(2)); // read again
      await record('s1', { cost: { total_cost_usd: 0.75 } }, later(3));
      expect((await sessions())[0]?.costUsd).toBe(2.75);
      // The daily total agrees with the session.
      const report = (await usage.overview()).profiles.find(
        (item) => item.profile.profileDirectory === directory(),
      )!;
      expect(report.daily.find((day) => day.metric === 'COST')?.value).toBe(2.75);
    });

    it('keeps sessions apart (a /clear starts a new session id) and survives a restart', async () => {
      await record('s1', { cost: { total_cost_usd: 1 } });
      await record('s2', { cost: { total_cost_usd: 0.3 } }, later(5));
      // A new service over the same database: what was stored is not counted again.
      const reopened = new UsageService(serviceOptions);
      await reopened.recordClaudeStatus({
        configDirectory: directory(),
        observedAt: later(6),
        status: parseClaudeStatus(
          { session_id: 's1', cost: { total_cost_usd: 1 } },
          later(6).toISOString(),
        ),
      });
      expect((await sessions()).map((item) => [item.sessionId, item.costUsd])).toEqual([
        ['s1', 1],
        ['s2', 0.3],
      ]);
    });

    it('shows a session without a reported cost as unavailable', async () => {
      await record('s1', { model: { id: 'claude-sonnet-5-5' } });
      expect((await sessions())[0]).toMatchObject({ costUsd: null, model: 'claude-sonnet-5-5' });
    });

    it('labels subscription and API billing from evidence, never from percentages', async () => {
      // No plan known and no limits yet: unknown.
      await record('s1', { cost: { total_cost_usd: 0.1 } });
      expect((await sessions())[0]?.billing).toBe('UNKNOWN');
      // Plan limits (Pro and Max) mean a subscription, and stay so.
      await record('s1', {
        cost: { total_cost_usd: 0.2 },
        rate_limits: { five_hour: { used_percentage: 90 } },
      });
      await record('s1', { cost: { total_cost_usd: 0.3 } }, later(1));
      expect((await sessions())[0]).toMatchObject({ billing: 'SUBSCRIPTION', costUsd: 0.3 });
      // A gateway spend limit is API billing.
      await record(
        's2',
        {
          cost: { total_cost_usd: 1 },
          rate_limits: { spend_limit: { used_percentage: 10 } },
        },
        later(2),
      );
      expect((await sessions())[0]).toMatchObject({ sessionId: 's2', billing: 'API' });
    });

    it('keeps at most ten recent sessions per profile in the overview', async () => {
      for (let index = 0; index < 12; index += 1) {
        await record(`s${index}`, { cost: { total_cost_usd: index } }, later(index));
      }
      const listed = await sessions();
      expect(listed).toHaveLength(10);
      expect(listed[0]?.sessionId).toBe('s11');
    });
  });

  it('describes the session window of the profile open in a terminal (PLAN-031)', async () => {
    const directory = path.join(home, '.claude-my');
    expect(await usage.claudeSessionUsage(directory)).toEqual({
      providerId: 'claude',
      profileId: null,
      displayName: 'my',
      session: null,
    });
    // Reading does not register the profile: only the Usage view and sessions do.
    expect(await usage.claudeSessionUsage(directory)).toMatchObject({ profileId: null });

    const resetsAt = Math.floor(now.getTime() / 1000) + 3600;
    await usage.recordClaudeStatus({
      configDirectory: `${directory}/`,
      observedAt: now,
      status: parseClaudeStatus(
        {
          session_id: 's1',
          rate_limits: {
            five_hour: { used_percentage: 74, resets_at: resetsAt },
            seven_day: { used_percentage: 15 },
          },
        },
        now.toISOString(),
      ),
    });
    const my = await profile('claude', '-my');
    await usage.updateProfile(my.id, { displayName: 'personal' });
    expect(await usage.claudeSessionUsage(directory)).toEqual({
      providerId: 'claude',
      profileId: my.id,
      displayName: 'personal',
      session: expect.objectContaining({
        key: 'five_hour',
        kind: 'session',
        usedPercent: 74,
        state: 'current',
      }),
    });

    now = new Date(now.getTime() + 2 * 3600_000);
    expect((await usage.claudeSessionUsage(directory)).session).toMatchObject({ state: 'reset' });
  });

  it('only accepts picked folders, hides detected profiles and removes added ones', async () => {
    const folder = path.join(temp.dir, 'team-claude');
    mkdirSync(folder);
    await expect(
      usage.addProfile({ providerId: 'claude', directory: folder }, false),
    ).rejects.toMatchObject({ code: 'USAGE_PROFILE_UNAUTHORIZED' });
    await expect(
      usage.addProfile({ providerId: 'claude', directory: path.join(temp.dir, 'missing') }, true),
    ).rejects.toMatchObject({ code: 'USAGE_PROFILE_UNAUTHORIZED' });
    const added = await usage.addProfile(
      { providerId: 'claude', directory: folder, displayName: 'Team' },
      true,
    );
    expect(added).toMatchObject({ origin: 'added', displayName: 'Team', statusLineEnabled: true });
    expect(await usage.addProfile({ providerId: 'claude', directory: folder }, true)).toEqual(
      added,
    );

    const updated = await usage.updateProfile(added.id, { statusLineEnabled: false });
    expect(UsageService.statusLineDisabled([updated])).toEqual([folder]);
    expect(UsageService.statusLineDisabled(changes.at(-1)!)).toEqual([folder]);

    const detected = await profile('codex', '');
    await usage.removeProfile(detected.id);
    expect((await usage.syncProfiles()).find((item) => item.id === detected.id)?.hidden).toBe(true);
    await usage.removeProfile(added.id);
    expect((await usage.syncProfiles()).some((item) => item.id === added.id)).toBe(false);
    await expect(usage.updateProfile(added.id, { hidden: true })).rejects.toMatchObject({
      code: 'USAGE_PROFILE_NOT_FOUND',
    });
    await expect(usage.updateProfile(detected.id, {})).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('deletes observations older than the retention period', async () => {
    const work = await profile('codex', '-work');
    await usage.refresh(work.id);
    await usage.updateSettings({ retentionDays: 7 });
    now = new Date('2026-11-05T12:00:00Z');
    await usage.refreshDue();
    const report = (await usage.overview({ days: 30 })).profiles.find(
      (item) => item.profile.id === work.id,
    )!;
    // Only the new reading (the fake reports the same dates, now out of range) is left.
    expect(report.daily).toEqual([]);
    expect(report.windows.every((window) => window.state === 'reset')).toBe(true);
  });
});

describe('Claude Code status inbox', () => {
  let temp: ReturnType<typeof createTempDir>;
  beforeEach(() => {
    temp = createTempDir();
  });
  afterEach(() => temp.cleanup());

  it('reads new status files once and removes runs of ended sessions', async () => {
    const recorded: { configDirectory: string; sessionId: string }[] = [];
    const inbox = new ClaudeStatusInbox({
      directory: temp.dir,
      usage: {
        recordClaudeStatus: async (input) => {
          recorded.push({
            configDirectory: input.configDirectory,
            sessionId: input.status.sessionId,
          });
        },
      },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });
    const run = (name: string, status: string, configDir = '/home/ana/.claude-my') => {
      const folder = path.join(temp.dir, name);
      mkdirSync(folder);
      writeFileSync(path.join(folder, 'config-dir'), `${configDir}\n`);
      writeFileSync(path.join(folder, 'status.json'), status);
      return folder;
    };
    run('20261023T120000-1', JSON.stringify({ session_id: 'a' }));
    run('20261023T120000-2', '{not json');
    run('20261023T120000-3', JSON.stringify({ session_id: 'c' }), 'relative/dir');
    const old = run('20261021T120000-4', JSON.stringify({ session_id: 'd' }));
    const past = new Date(Date.now() - 2 * 24 * 60 * 60_000);
    utimesSync(path.join(old, 'status.json'), past, past);
    mkdirSync(path.join(temp.dir, 'not-a-run'));

    await inbox.scan();
    await inbox.scan();
    expect(recorded).toEqual([{ configDirectory: '/home/ana/.claude-my', sessionId: 'a' }]);
    expect(existsSync(old)).toBe(false);

    const later = new Date(Date.now() + 5000);
    writeFileSync(
      path.join(temp.dir, '20261023T120000-1', 'status.json'),
      JSON.stringify({ session_id: 'a2' }),
    );
    utimesSync(path.join(temp.dir, '20261023T120000-1', 'status.json'), later, later);
    await inbox.scan();
    expect(recorded.map((item) => item.sessionId)).toEqual(['a', 'a2']);
  });
});

describe('Claude Code runs open in terminals (PLAN-031)', () => {
  let temp: ReturnType<typeof createTempDir>;
  let alive: Set<number>;
  let changes: number;
  let inbox: ClaudeStatusInbox;
  const terminal = 'aaaaaaaa-0000-4000-8000-000000000001';
  const other = 'aaaaaaaa-0000-4000-8000-000000000002';

  beforeEach(() => {
    temp = createTempDir();
    alive = new Set();
    changes = 0;
    inbox = new ClaudeStatusInbox({
      directory: temp.dir,
      usage: { recordClaudeStatus: async () => {} },
      isProcessAlive: (pid) => alive.has(pid),
      onChange: () => (changes += 1),
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });
  });
  afterEach(() => temp.cleanup());

  const run = (name: string, configDir: string, terminalId?: string) => {
    const folder = path.join(temp.dir, name);
    mkdirSync(folder);
    writeFileSync(path.join(folder, 'config-dir'), `${configDir}\n`);
    if (terminalId !== undefined)
      writeFileSync(path.join(folder, 'terminal-id'), `${terminalId}\n`);
    return folder;
  };

  it('follows the latest run whose wrapper is alive in each terminal', async () => {
    run('20261023T120000-11', '/home/ana/.claude-my', terminal);
    run('20261023T120100-12', '/home/ana/.claude-work', terminal.toUpperCase());
    run('20261023T120000-13', '/home/ana/.claude', other);
    run('20261023T120000-14', '/home/ana/.claude'); // a wrapper from before PLAN-031
    run('20261023T120000-15', '/home/ana/.claude', '../not-an-id');
    alive = new Set([11, 12, 13, 14, 15]);

    await inbox.scan();
    expect(inbox.openRun(terminal)).toEqual({ configDirectory: '/home/ana/.claude-work' });
    expect(inbox.openRun(other)).toEqual({ configDirectory: '/home/ana/.claude' });
    expect(changes).toBe(1);
    await inbox.scan();
    expect(changes).toBe(1); // nothing moved, nothing reported

    // The newer session ended: the older one, still running, is shown again.
    alive.delete(12);
    await inbox.scan();
    expect(inbox.openRun(terminal)).toEqual({ configDirectory: '/home/ana/.claude-my' });
    expect(changes).toBe(2);

    // A process id reused after the end does not reopen the run.
    alive.add(12);
    alive.delete(11);
    alive.delete(13);
    await inbox.scan();
    expect(inbox.openRun(terminal)).toBeNull();
    expect(inbox.openRun(other)).toBeNull();
    expect(changes).toBe(3);
  });

  it('reports new usage while a run is open and ignores runs without a profile yet', async () => {
    const folder = run('20261023T120000-21', '/home/ana/.claude-my', terminal);
    mkdirSync(path.join(temp.dir, '20261023T120000-22')); // config-dir not written yet
    alive = new Set([21, 22]);
    await inbox.scan();
    expect(changes).toBe(1);

    writeFileSync(path.join(folder, 'status.json'), JSON.stringify({ session_id: 's' }));
    await inbox.scan();
    expect(changes).toBe(2);

    writeFileSync(
      path.join(temp.dir, '20261023T120000-22', 'config-dir'),
      'relative/folder\n', // never trusted
    );
    writeFileSync(path.join(temp.dir, '20261023T120000-22', 'terminal-id'), other);
    await inbox.scan();
    expect(inbox.openRun(other)).toBeNull();
    expect(changes).toBe(2);
  });
});

describe.skipIf(!posix)('Claude wrapper with the ATLAS status line (PLAN-027)', () => {
  let temp: ReturnType<typeof createTempDir>;
  let store: ProjectConfigStore;
  let realBin: string;
  let home: string;

  beforeEach(async () => {
    temp = createTempDir();
    store = new ProjectConfigStore({
      dataDir: path.join(temp.dir, 'data with space'),
      platform: process.platform,
      now: () => new Date(),
    });
    await store.installWrappers();
    home = path.join(temp.dir, 'home');
    mkdirSync(path.join(home, '.claude-my'), { recursive: true });
    realBin = path.join(temp.dir, 'real-bin');
    mkdirSync(realBin);
    // A stand-in for Claude Code: prints its arguments, then runs the status line command
    // from --settings the way Claude Code does (through a shell, JSON on stdin).
    writeFileSync(
      path.join(realBin, 'claude'),
      `#!/bin/sh
printf 'ARGS:%s\\n' "$*"
while [ $# -gt 0 ]; do
  if [ "$1" = --settings ]; then
    command=$(printf '%s' "$2" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).statusLine.command))')
    printf '{"session_id":"s1","rate_limits":{"five_hour":{"used_percentage":12}}}' | sh -c "$command"
  fi
  shift
done
`,
    );
    chmodSync(path.join(realBin, 'claude'), 0o755);
  });
  afterEach(() => temp.cleanup());

  const runClaude = (args: string[], env: Record<string, string> = {}, cwd = home) =>
    spawnSync(path.join(store.binDir, 'claude'), args, {
      cwd,
      encoding: 'utf8',
      env: {
        PATH: `${store.binDir}:${realBin}:${process.env.PATH}`,
        HOME: home,
        ATLAS_USAGE_DIR: store.usageDir,
        ...env,
      },
    });
  const runs = () => readdirSync(path.join(store.usageDir, 'claude'));

  it('passes the ATLAS status line, which saves the status for the profile', () => {
    const result = runClaude(['-p', 'hi'], { CLAUDE_CONFIG_DIR: path.join(home, '.claude-my') });
    expect(result.stdout).toContain('ARGS:--settings {"statusLine":{"type":"command"');
    expect(result.stdout).toContain('-p hi');
    const [run] = runs();
    const folder = path.join(store.usageDir, 'claude', run!);
    expect(readFileSync(path.join(folder, 'config-dir'), 'utf8')).toBe(
      `${path.join(home, '.claude-my')}\n`,
    );
    expect(JSON.parse(readFileSync(path.join(folder, 'status.json'), 'utf8'))).toMatchObject({
      session_id: 's1',
    });
  });

  it('serializes concurrent writes of the profiles that keep their own status line', async () => {
    await Promise.all([
      store.writeStatusLineOff(['/a']),
      store.writeStatusLineOff(['/b', 'bad\nline']),
      store.writeStatusLineOff(['/c']),
    ]);
    expect(readFileSync(path.join(store.usageDir, STATUS_LINE_OFF_FILE), 'utf8')).toBe('/c\n');
    await store.writeStatusLineOff(['/b', 'bad\nline']);
    expect(readFileSync(path.join(store.usageDir, STATUS_LINE_OFF_FILE), 'utf8')).toBe('/b\n');
  });

  it('names the ATLAS terminal of the run, and only in ATLAS terminals (PLAN-031)', () => {
    const terminalId = 'aaaaaaaa-0000-4000-8000-000000000001';
    runClaude(['-p', 'x'], { ATLAS_TERMINAL_ID: terminalId });
    const [run] = runs();
    const folder = path.join(store.usageDir, 'claude', run!);
    expect(readFileSync(path.join(folder, 'terminal-id'), 'utf8')).toBe(`${terminalId}\n`);
    // The folder name ends with the wrapper's process id: the run is open while it lives.
    expect(run).toMatch(/^\d{8}T\d{6}-\d+$/);

    runClaude(['-p', 'y']);
    const second = runs().find((name) => name !== run)!;
    expect(existsSync(path.join(store.usageDir, 'claude', second, 'terminal-id'))).toBe(false);
  });

  it('uses the default folder when CLAUDE_CONFIG_DIR is unset', () => {
    runClaude([]);
    const [run] = runs();
    expect(readFileSync(path.join(store.usageDir, 'claude', run!, 'config-dir'), 'utf8')).toBe(
      `${path.join(home, '.claude')}\n`,
    );
  });

  it('keeps a status line the profile or project already has, or one turned off in ATLAS', async () => {
    const profile = path.join(home, '.claude-my');
    writeFileSync(path.join(profile, 'settings.json'), '{ "statusLine": { "type": "command" } }');
    expect(runClaude([], { CLAUDE_CONFIG_DIR: profile }).stdout).not.toContain('--settings');

    const project = path.join(temp.dir, 'project');
    mkdirSync(path.join(project, '.claude'), { recursive: true });
    writeFileSync(path.join(project, '.claude', 'settings.local.json'), '{"statusLine":{}}');
    expect(runClaude([], {}, project).stdout).not.toContain('--settings');

    await store.writeStatusLineOff([path.join(home, '.claude')]);
    expect(readFileSync(path.join(store.usageDir, STATUS_LINE_OFF_FILE), 'utf8')).toBe(
      `${path.join(home, '.claude')}\n`,
    );
    expect(runClaude([]).stdout).not.toContain('--settings');
    // Subcommands and terminals outside ATLAS are untouched.
    expect(runClaude(['auth', 'status'], { CLAUDE_CONFIG_DIR: path.join(home, 'x') }).stdout).toBe(
      'ARGS:auth status\n',
    );
    expect(runClaude(['-p', 'x'], { ATLAS_USAGE_DIR: '' }).stdout).toBe('ARGS:-p x\n');
    await store.writeStatusLineOff([]);
    expect(runClaude(['--settings', 'mine.json']).stdout).toBe('ARGS:--settings mine.json\n');
    expect(runClaude(['--settings=mine.json', '-p', 'x']).stdout).toBe(
      'ARGS:--settings=mine.json -p x\n',
    );
    expect(runs()).toEqual([]);
  });
});

describe.skipIf(!posix)('provider CLI readers', () => {
  let temp: ReturnType<typeof createTempDir>;
  let bin: string;
  let home: string;
  beforeEach(() => {
    temp = createTempDir();
    bin = path.join(temp.dir, 'bin');
    home = path.join(temp.dir, 'home');
    mkdirSync(bin);
    mkdirSync(home);
  });
  afterEach(() => temp.cleanup());

  const script = (name: string, body: string) => {
    writeFileSync(path.join(bin, name), `#!/usr/bin/env node\n${body}`);
    chmodSync(path.join(bin, name), 0o755);
  };
  const options = (extra: { timeoutMs?: number } = {}) => ({
    env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: '/inherited' },
    home,
    searchPath: async () => bin,
    excludeDirectory: path.join(temp.dir, 'wrappers'),
    ...extra,
  });

  it('reads a Codex profile through app-server, with CODEX_HOME for named profiles', async () => {
    script(
      'codex',
      `const rl = require('node:readline').createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
rl.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') send({ id: m.id, result: {} });
  if (m.method === 'account/read') send({ id: m.id, result: { account: { type: 'chatgpt', email: 'a@b.c', planType: process.env.CODEX_HOME === undefined ? 'default-home' : process.env.CODEX_HOME } } });
  if (m.method === 'account/rateLimits/read') send({ id: m.id, result: { rateLimits: { primary: { usedPercent: 5, windowDurationMins: 300, resetsAt: 1792804046 } } } });
  if (m.method === 'account/usage/read') send({ id: m.id, error: { code: -32600, message: 'unsupported' } });
});`,
    );
    const reader = new CodexAppServerReader(options());
    const named = await reader.read(path.join(home, '.codex-work'));
    expect(named.account).toEqual({ status: 'CONNECTED', plan: path.join(home, '.codex-work') });
    // The default profile runs without the variable (the inherited one is removed).
    expect((await reader.read(path.join(home, '.codex'))).account.plan).toBe('default-home');
    expect(named.limits.windows).toEqual([
      expect.objectContaining({ key: 'codex:primary', kind: 'session', usedPercent: 5 }),
    ]);
    // An unsupported usage request leaves the daily history empty instead of failing.
    expect(named.daily).toEqual([]);
  });

  it('reports missing CLIs, signed-out profiles and silent CLIs as safe failures', async () => {
    await expect(new CodexAppServerReader(options()).read(home)).rejects.toMatchObject({
      code: 'cli-not-found',
    });
    script(
      'codex',
      `require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  const reply = (result) => process.stdout.write(JSON.stringify({ id: m.id, result }) + '\\n');
  if (m.method === 'initialize') reply({});
  if (m.method === 'account/read') reply({ account: null, requiresOpenaiAuth: true });
  if (m.method === 'account/rateLimits/read' || m.method === 'account/usage/read') reply({});
});`,
    );
    await expect(new CodexAppServerReader(options()).read(home)).rejects.toMatchObject({
      code: 'auth-required',
      status: 'AUTH_REQUIRED',
    });
    script('codex', 'setTimeout(() => {}, 10000);');
    await expect(
      new CodexAppServerReader(options({ timeoutMs: 300 })).read(home),
    ).rejects.toMatchObject({ code: 'timeout' });
  });

  it('reads claude auth status without CLAUDE_CONFIG_DIR for the default profile', async () => {
    script(
      'claude',
      `process.stdout.write(JSON.stringify({ loggedIn: true, subscriptionType: process.env.CLAUDE_CONFIG_DIR ? 'max' : 'pro', email: 'a@b.c' }));`,
    );
    const reader = new ClaudeAuthStatusReader(options());
    expect(await reader.read(path.join(home, '.claude'))).toEqual({
      status: 'CONNECTED',
      plan: 'pro',
    });
    expect(await reader.read(path.join(home, '.claude-my'))).toEqual({
      status: 'CONNECTED',
      plan: 'max',
    });
    script('claude', `process.stdout.write('not json'); process.exit(1);`);
    await expect(reader.read(home)).rejects.toMatchObject({ code: 'unexpected-response' });
  });
});
