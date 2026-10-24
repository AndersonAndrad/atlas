import type { LimitWindow, TerminalLlmUsage } from '@atlas/contracts';
import { describe, expect, it } from 'vitest';
import { llmUsageDescription, meterTone, profileLabel } from '../src/renderer/src/usage/format';

const now = new Date('2026-10-23T12:00:00Z');
const session = (changes: Partial<LimitWindow> = {}): LimitWindow => ({
  key: 'five_hour',
  kind: 'session',
  label: 'Current session (5h)',
  usedPercent: 26,
  windowMinutes: 300,
  resetsAt: '2026-10-23T14:00:00.000Z',
  observedAt: '2026-10-23T11:58:00.000Z',
  source: 'PROVIDER_CLI',
  state: 'current',
  ...changes,
});
const usage = (window: LimitWindow | null): TerminalLlmUsage => ({
  providerId: 'claude',
  profileId: null,
  displayName: 'my',
  session: window,
});

describe('LLM usage in the terminal header (PLAN-031)', () => {
  it('names profiles as the CLI aliases do', () => {
    expect(profileLabel('claude', 'my')).toBe('claude-my');
    expect(profileLabel('claude', 'default')).toBe('claude');
    expect(profileLabel('codex', 'work')).toBe('codex-work');
  });

  it('is green below 70%, yellow from 70% and red from 90%', () => {
    expect([0, 69, 70, 89, 90, 100].map(meterTone)).toEqual([
      'normal',
      'normal',
      'high',
      'high',
      'critical',
      'critical',
    ]);
  });

  it('describes the window, its reset and how fresh the value is', () => {
    const text = llmUsageDescription(usage(session()), now);
    expect(text).toContain('Claude Code · my: 26% of the current session (5h) used');
    expect(text).toContain('resets ');
    expect(text).toContain('observed 2 minutes ago');
    expect(llmUsageDescription(usage(session({ state: 'stale' })), now)).toContain(
      'may be outdated',
    );
    expect(
      llmUsageDescription(
        usage(session({ state: 'reset', resetsAt: '2026-10-23T11:00:00Z' })),
        now,
      ),
    ).toBe('Claude Code · my: the session window was reset 1 hour ago; waiting for a new reading.');
    expect(llmUsageDescription(usage(null), now)).toBe(
      'Claude Code · my: no session usage reported yet.',
    );
  });
});
