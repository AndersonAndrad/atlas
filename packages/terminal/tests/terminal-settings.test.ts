import { describe, expect, it } from 'vitest';
import {
  TERMINAL_PREFERENCES_SETTING,
  TerminalSettings,
  type KeyValueStore,
} from '../src/index.js';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const SESSION = '00000000-0000-4000-8000-000000000001';

function store(
  initial: Record<string, string> = {},
): KeyValueStore & { values: Map<string, string> } {
  const values = new Map(Object.entries(initial));
  return {
    values,
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => void values.set(key, value),
    delete: async (key) => void values.delete(key),
  };
}

describe('TerminalSettings', () => {
  it('returns defaults and persists partial updates', async () => {
    const settings = new TerminalSettings(store());
    expect(await settings.getPreferences()).toEqual({
      fontSize: 13,
      fontFamily: 'system',
      scrollback: 5000,
      defaultShellId: null,
    });
    await settings.updatePreferences({ fontSize: 16 });
    await settings.updatePreferences({ defaultShellId: 'bash' });
    expect(await settings.getPreferences()).toMatchObject({ fontSize: 16, defaultShellId: 'bash' });
  });

  it('validates preference updates', async () => {
    const settings = new TerminalSettings(store());
    for (const input of [
      {},
      { fontSize: 99 },
      { fontFamily: 'comic' },
      { scrollback: 1 },
      { x: 1 },
    ]) {
      await expect(settings.updatePreferences(input)).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
      });
    }
  });

  it('falls back to defaults when stored preferences are corrupt', async () => {
    const settings = new TerminalSettings(store({ [TERMINAL_PREFERENCES_SETTING]: '{bad json' }));
    expect((await settings.getPreferences()).fontSize).toBe(13);
  });

  it('stores validated layouts per project', async () => {
    const backing = store();
    const settings = new TerminalSettings(backing);
    const layout = {
      version: 1 as const,
      root: { type: 'pane' as const, id: 'p1', sessionId: SESSION },
      activePaneId: 'p1',
    };
    await settings.setLayout(PROJECT, layout);
    expect(await settings.getLayout(PROJECT)).toEqual(layout);

    await expect(
      settings.setLayout(PROJECT, { ...layout, root: { type: 'pane', id: 'p1', sessionId: 'x' } }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    await settings.deleteLayout(PROJECT);
    expect(await settings.getLayout(PROJECT)).toBeNull();
  });

  it('rejects layouts with more panes than allowed', async () => {
    const settings = new TerminalSettings(store());
    const pane = (index: number) => ({
      type: 'pane' as const,
      id: `p${index}`,
      sessionId: `00000000-0000-4000-8000-00000000000${index}`,
    });
    let root: unknown = pane(0);
    for (let index = 1; index <= 6; index += 1) {
      root = {
        type: 'split',
        id: `s${index}`,
        direction: 'row',
        ratio: 50,
        children: [root, pane(index)],
      };
    }
    await expect(
      settings.setLayout(PROJECT, { version: 1, root, activePaneId: 'p0' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
