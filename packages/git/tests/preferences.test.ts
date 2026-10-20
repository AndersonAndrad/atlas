import { describe, expect, it } from 'vitest';
import { DEFAULT_GIT_PREFERENCES, DEFAULT_PROJECT_GIT_SETTINGS } from '@atlas/contracts';
import { GitPreferencesStore, ProjectGitSettingsStore } from '../src/index.js';

function memoryStore(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    get: async (key: string) => values.get(key) ?? null,
    set: async (key: string, value: string) => void values.set(key, value),
    delete: async (key: string) => void values.delete(key),
  };
}

const step = {
  name: 'Tests',
  command: 'pnpm test',
  mode: 'complete',
  timeoutSeconds: 60,
  readyAfterSeconds: 2,
  readyText: null,
};

describe('ProjectGitSettingsStore', () => {
  it('uses defaults when nothing is stored', async () => {
    const store = new ProjectGitSettingsStore(memoryStore());
    expect(await store.read('p1')).toEqual({
      settings: DEFAULT_PROJECT_GIT_SETTINGS,
      invalid: false,
    });
    expect(await store.forCommit('p1')).toEqual(DEFAULT_PROJECT_GIT_SETTINGS);
  });

  it('returns stored settings for display and for commits', async () => {
    const store = new ProjectGitSettingsStore(memoryStore());
    await store.set('p1', { enforceConventionalCommits: false, preCommitSteps: [step] });
    expect((await store.forCommit('p1')).preCommitSteps).toHaveLength(1);
    expect((await store.get('p1')).enforceConventionalCommits).toBe(false);
  });

  it.each([
    ['unreadable JSON', '{not json'],
    ['an invalid step', JSON.stringify({ preCommitSteps: [{ ...step, mode: 'forever' }] })],
  ])('refuses commits instead of dropping checks when stored settings hold %s', async (_, raw) => {
    const warnings: string[] = [];
    const store = new ProjectGitSettingsStore(memoryStore({ 'git.project.p1': raw }), {
      debug: () => undefined,
      info: () => undefined,
      warn: (message: string) => void warnings.push(message),
      error: () => undefined,
    });
    // Display still works, flagged as invalid.
    expect(await store.read('p1')).toEqual({
      settings: DEFAULT_PROJECT_GIT_SETTINGS,
      invalid: true,
    });
    expect(await store.get('p1')).toEqual(DEFAULT_PROJECT_GIT_SETTINGS);
    await expect(store.forCommit('p1')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      issues: [
        {
          field: 'projectSettings',
          message: 'Commit checks settings are invalid; open settings to fix.',
        },
      ],
    });
    expect(warnings.length).toBeGreaterThan(0);
    // Saving valid settings again clears the state.
    await store.set('p1', DEFAULT_PROJECT_GIT_SETTINGS);
    expect((await store.read('p1')).invalid).toBe(false);
  });
});

describe('GitPreferencesStore', () => {
  it('returns commit rules from stored preferences', async () => {
    const store = new GitPreferencesStore(memoryStore());
    await store.update({ requireScope: true });
    expect(await store.commitRules()).toMatchObject({ requireScope: true });
    expect((await store.read()).invalid).toBe(false);
  });

  it.each([
    ['unreadable JSON', '{not json'],
    ['a value that is not an object', '[1, 2]'],
    ['an invalid field', JSON.stringify({ requireScope: 'sometimes' })],
  ])(
    'refuses commits instead of dropping rules when stored preferences hold %s',
    async (_, raw) => {
      const store = new GitPreferencesStore(memoryStore({ 'git.preferences': raw }));
      // Display still works with the defaults, flagged as invalid.
      expect(await store.read()).toEqual({ preferences: DEFAULT_GIT_PREFERENCES, invalid: true });
      expect(await store.get()).toEqual(DEFAULT_GIT_PREFERENCES);
      await expect(store.commitRules()).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
        issues: [
          { field: 'preferences', message: 'Git preferences are invalid; open settings to fix.' },
        ],
      });
      // Saving from the settings form replaces the invalid value.
      await store.update({ requireScope: false });
      expect((await store.read()).invalid).toBe(false);
      await expect(store.commitRules()).resolves.toMatchObject({ requireScope: false });
    },
  );
});
