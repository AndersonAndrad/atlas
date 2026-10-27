import type { ProjectGitSnapshot, ProjectGitState } from '@atlas/contracts';
import { describe, expect, it } from 'vitest';
import { projectGitIndicator } from '../src/renderer/src/components/git/git-format';

const repository = (
  overrides: Partial<Extract<ProjectGitSnapshot, { state: 'repository' }>> = {},
) =>
  ({
    state: 'repository',
    branch: 'main',
    detachedHead: false,
    unbornHead: false,
    upstream: 'origin/main',
    ahead: 0,
    behind: 0,
    upstreamGone: false,
    changes: {
      modified: 0,
      staged: 0,
      untracked: 0,
      deleted: 0,
      renamed: 0,
      conflicted: 0,
      total: 0,
    },
    ...overrides,
  }) satisfies ProjectGitSnapshot;

const state = (overrides: Partial<ProjectGitState> = {}): ProjectGitState => ({
  projectId: 'p',
  monitoringEnabled: true,
  freshness: 'live',
  snapshot: repository(),
  refreshedAt: new Date().toISOString(),
  error: null,
  ...overrides,
});

describe('project Git badge (SDD-024 FR-006)', () => {
  it('is clean and neutral without changes or commits to push', () => {
    const indicator = projectGitIndicator(state());
    expect(indicator).toMatchObject({ kind: 'clean', live: true, changes: 0 });
    expect(indicator.description).toMatch(/^Clean, nothing to commit or push\. Branch main\. Live/);
  });

  it('needs attention for uncommitted, untracked or conflicted files and commits ahead', () => {
    const untracked = repository({
      changes: {
        modified: 0,
        staged: 0,
        untracked: 2,
        deleted: 0,
        renamed: 0,
        conflicted: 0,
        total: 2,
      },
    });
    expect(projectGitIndicator(state({ snapshot: untracked }))).toMatchObject({
      kind: 'attention',
      changes: 2,
    });
    expect(
      projectGitIndicator(state({ snapshot: repository({ ahead: 3 }) })).description,
    ).toContain('3 commits to push');
  });

  it('does not treat commits to pull as a required action', () => {
    const indicator = projectGitIndicator(state({ snapshot: repository({ behind: 5 }) }));
    expect(indicator.kind).toBe('clean');
    expect(indicator.description).not.toContain('pull');
  });

  it('handles a missing upstream', () => {
    const snapshot = repository({ upstream: null, ahead: null, behind: null });
    expect(projectGitIndicator(state({ snapshot })).kind).toBe('clean');
  });

  it('marks cached data and paused monitoring', () => {
    const indicator = projectGitIndicator(
      state({ monitoringEnabled: false, freshness: 'cached', snapshot: repository({ ahead: 1 }) }),
    );
    expect(indicator).toMatchObject({ kind: 'attention', live: false });
    expect(indicator.description).toContain('Cached, updated');
    expect(indicator.description).toContain('Monitoring paused.');
  });

  it('is unknown without a snapshot, without Git, or when Git failed', () => {
    expect(projectGitIndicator(undefined)).toMatchObject({ kind: 'unknown', changes: null });
    expect(projectGitIndicator(undefined).description).toContain('not refreshed yet');
    expect(
      projectGitIndicator(state({ snapshot: { state: 'not-repository' } })).description,
    ).toContain('No Git repository');
    const failed = projectGitIndicator(
      state({
        freshness: 'none',
        snapshot: null,
        refreshedAt: null,
        error: { reason: 'not-installed', at: new Date().toISOString() },
      }),
    );
    expect(failed.kind).toBe('unknown');
    expect(failed.description).toContain('Git status unavailable.');
    expect(failed.description).toContain('Git is not installed');
  });

  it('keeps the last snapshot and reports a failed refresh', () => {
    const indicator = projectGitIndicator(
      state({ freshness: 'cached', error: { reason: 'timeout', at: new Date().toISOString() } }),
    );
    expect(indicator.kind).toBe('clean');
    expect(indicator.description).toContain('Last refresh failed: Git took too long');
  });
});
