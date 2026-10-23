import { describe, expect, it } from 'vitest';
import {
  detectProfiles,
  parseClaudeAuthStatus,
  parseClaudeStatus,
  parseCodexAccount,
  parseCodexDailyTokens,
  parseCodexRateLimits,
  presentWindows,
  profileName,
  rangeStart,
  weekStart,
  weeklyTotals,
  windowLabel,
  type LimitSnapshot,
} from '@atlas/usage';

const OBSERVED = '2026-10-23T12:00:00.000Z';

describe('profile detection', () => {
  it('finds ~/.<cli> and ~/.<cli>-<name> folders and the environment overrides', () => {
    const found = detectProfiles({
      home: '/home/ana',
      entries: [
        '.claude',
        '.claude-my',
        '.claude-wiiascend',
        '.codex',
        '.codex-work',
        '.config',
        '.claude-',
        '.claudex',
      ],
      env: { CLAUDE_CONFIG_DIR: '/opt/claude-team', CODEX_HOME: 'relative/ignored' },
    });
    expect(
      found.map((profile) => [profile.providerId, profile.directory, profile.displayName]),
    ).toEqual([
      ['claude', '/home/ana/.claude', 'default'],
      ['claude', '/home/ana/.claude-my', 'my'],
      ['claude', '/home/ana/.claude-wiiascend', 'wiiascend'],
      ['codex', '/home/ana/.codex', 'default'],
      ['codex', '/home/ana/.codex-work', 'work'],
      ['claude', '/opt/claude-team', 'claude-team'],
    ]);
    // The same folder from the environment is not listed twice.
    expect(
      detectProfiles({
        home: '/h',
        entries: ['.claude-my'],
        env: { CLAUDE_CONFIG_DIR: '/h/.claude-my/' },
      }),
    ).toHaveLength(1);
    expect(profileName('codex', '/h/.claude-x')).toBe('claude-x');
  });
});

describe('Codex app-server responses', () => {
  const rateLimits = {
    accountId: 'secret-account',
    ordinaryUsageAllowed: true,
    rateLimits: {
      limitId: 'codex',
      limitName: null,
      primary: { usedPercent: 22, windowDurationMins: 300, resetsAt: 1792804046 },
      secondary: { usedPercent: 61, windowDurationMins: 10080, resetsAt: 1793390846 },
      credits: { hasCredits: false, unlimited: false, balance: '0' },
      planType: 'plus',
      rateLimitReachedType: null,
    },
    rateLimitsByLimitId: {
      codex: { limitId: 'codex', primary: { usedPercent: 22, windowDurationMins: 300 } },
      'gpt-mini': {
        limitId: 'gpt-mini',
        limitName: 'GPT mini',
        primary: { usedPercent: 140, windowDurationMins: 300, resetsAt: null },
      },
    },
  };

  it('keeps the session, weekly and model windows separate', () => {
    const limits = parseCodexRateLimits(rateLimits, OBSERVED);
    expect(limits.plan).toBe('plus');
    expect(limits.limited).toBe(false);
    expect(limits.windows).toEqual([
      {
        key: 'codex:primary',
        kind: 'session',
        label: 'Current session (5h)',
        usedPercent: 22,
        windowMinutes: 300,
        resetsAt: new Date(1792804046 * 1000).toISOString(),
        observedAt: OBSERVED,
        source: 'PROVIDER_CLI',
      },
      expect.objectContaining({
        key: 'codex:secondary',
        kind: 'weekly',
        label: 'Weekly',
        usedPercent: 61,
      }),
      // Over 100 is clamped; a model allowance is never merged into the main windows.
      expect.objectContaining({
        key: 'codex:gpt-mini:primary',
        kind: 'other',
        label: 'GPT mini · Current session (5h)',
        usedPercent: 100,
        resetsAt: null,
      }),
    ]);
  });

  it('reports reached limits and rejects responses without the expected fields', () => {
    expect(
      parseCodexRateLimits(
        { rateLimits: { ...rateLimits.rateLimits, rateLimitReachedType: 'primary' } },
        OBSERVED,
      ).limited,
    ).toBe(true);
    expect(parseCodexRateLimits({ rateLimits: {}, ordinaryUsageAllowed: false }, OBSERVED)).toEqual(
      {
        windows: [],
        plan: null,
        limited: true,
      },
    );
    expect(() => parseCodexRateLimits({ limits: [] }, OBSERVED)).toThrow();
    expect(() =>
      parseCodexRateLimits({ rateLimits: { primary: { usedPercent: '22' } } }, OBSERVED),
    ).toThrow();
  });

  it('reads the account without keeping the e-mail and the daily token buckets', () => {
    const account = parseCodexAccount({
      account: { type: 'chatgpt', email: 'ana@example.com', planType: 'plus' },
      requiresOpenaiAuth: true,
    });
    expect(account).toEqual({ status: 'CONNECTED', plan: 'plus' });
    expect(JSON.stringify(account)).not.toContain('@');
    expect(parseCodexAccount({ account: null, requiresOpenaiAuth: true })).toEqual({
      status: 'AUTH_REQUIRED',
      plan: null,
    });
    expect(
      parseCodexDailyTokens({
        summary: {},
        dailyUsageBuckets: [{ startDate: '2026-10-22', tokens: 379804 }],
      }),
    ).toEqual([{ date: '2026-10-22', tokens: 379804 }]);
    expect(parseCodexDailyTokens({ dailyUsageBuckets: null })).toEqual([]);
    expect(() =>
      parseCodexDailyTokens({ dailyUsageBuckets: [{ startDate: 'yesterday', tokens: 1 }] }),
    ).toThrow();
  });
});

describe('Claude Code status line data', () => {
  const status = {
    session_id: 'abc',
    transcript_path: '/home/ana/secret/transcript.jsonl',
    cwd: '/home/ana/project',
    model: { id: 'claude-opus-5-5', display_name: 'Opus' },
    cost: { total_cost_usd: 1.25, total_api_duration_ms: 90_000 },
    rate_limits: {
      five_hour: { used_percentage: 23.5, resets_at: 1738425600 },
      seven_day: { used_percentage: 41.2, resets_at: 1738857600 },
    },
  };

  it('keeps only the limit windows and cumulative session values', () => {
    const parsed = parseClaudeStatus(status, OBSERVED);
    expect(parsed).toEqual({
      sessionId: 'abc',
      costUsd: 1.25,
      apiDurationMs: 90_000,
      windows: [
        expect.objectContaining({ key: 'five_hour', kind: 'session', usedPercent: 23.5 }),
        expect.objectContaining({ key: 'seven_day', kind: 'weekly', usedPercent: 41.2 }),
      ],
    });
    expect(JSON.stringify(parsed)).not.toContain('/home/ana');
  });

  it('has no windows before the first answer or without a Pro/Max plan', () => {
    expect(parseClaudeStatus({ session_id: 'x' }, OBSERVED)).toEqual({
      sessionId: 'x',
      windows: [],
      costUsd: null,
      apiDurationMs: null,
    });
    expect(() => parseClaudeStatus({ rate_limits: {} }, OBSERVED)).toThrow();
  });

  it('reads the sign-in state and plan, never the e-mail or organization', () => {
    expect(
      parseClaudeAuthStatus({
        loggedIn: true,
        authMethod: 'claude.ai',
        subscriptionType: 'pro',
        email: 'ana@example.com',
        orgName: 'Org',
      }),
    ).toEqual({ status: 'CONNECTED', plan: 'pro' });
    expect(parseClaudeAuthStatus({ loggedIn: false })).toEqual({
      status: 'AUTH_REQUIRED',
      plan: null,
    });
  });
});

describe('aggregation', () => {
  it('groups days into Monday-to-Sunday weeks without mixing metrics or sources', () => {
    expect(weekStart('2026-10-25')).toBe('2026-10-19'); // Sunday
    expect(weekStart('2026-10-19')).toBe('2026-10-19'); // Monday
    expect(weekStart('2026-01-01')).toBe('2025-12-29'); // across years
    expect(rangeStart('2026-03-01', 7)).toBe('2026-02-23');
    const day = (date: string, metric: 'TOTAL_TOKENS' | 'COST', value: number) => ({
      date,
      metric,
      unit: metric === 'COST' ? 'USD' : 'tokens',
      value,
      source: metric === 'COST' ? ('LOCAL_ESTIMATE' as const) : ('PROVIDER_CLI' as const),
      isEstimated: metric === 'COST',
    });
    expect(
      weeklyTotals([
        day('2026-10-19', 'TOTAL_TOKENS', 100),
        day('2026-10-25', 'TOTAL_TOKENS', 50),
        day('2026-10-26', 'TOTAL_TOKENS', 7),
        day('2026-10-20', 'COST', 1.5),
      ]),
    ).toEqual([
      expect.objectContaining({
        weekStart: '2026-10-19',
        metric: 'COST',
        value: 1.5,
        isEstimated: true,
      }),
      expect.objectContaining({
        weekStart: '2026-10-19',
        metric: 'TOTAL_TOKENS',
        value: 150,
        days: 2,
      }),
      expect.objectContaining({
        weekStart: '2026-10-26',
        metric: 'TOTAL_TOKENS',
        value: 7,
        days: 1,
      }),
    ]);
  });

  it('marks stale windows and windows whose reported reset passed', () => {
    const snapshot = (
      key: string,
      kind: LimitSnapshot['kind'],
      observedAt: string,
      resetsAt: string | null,
    ): LimitSnapshot => ({
      key,
      kind,
      label: key,
      usedPercent: 50,
      windowMinutes: null,
      resetsAt,
      observedAt,
      source: 'PROVIDER_CLI',
    });
    const now = new Date('2026-10-23T12:00:00Z');
    const windows = presentWindows(
      [
        snapshot('w', 'weekly', '2026-10-23T11:55:00Z', '2026-10-27T00:00:00Z'),
        snapshot('s', 'session', '2026-10-23T09:00:00Z', '2026-10-23T13:00:00Z'),
        snapshot('o', 'other', '2026-10-23T11:00:00Z', '2026-10-23T11:30:00Z'),
        snapshot('n', 'other', '2026-10-20T00:00:00Z', null),
      ],
      now,
      30 * 60_000,
    );
    expect(windows.map((window) => [window.key, window.state])).toEqual([
      ['s', 'stale'],
      ['w', 'current'],
      ['n', 'stale'],
      ['o', 'reset'],
    ]);
    expect(windowLabel(10080, 'weekly')).toBe('Weekly');
    expect(windowLabel(43200, 'other')).toBe('30-day window');
  });
});
