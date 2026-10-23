import type { TerminalWorkspaceLayout } from '@atlas/contracts';
import { TerminalWorkspaceLayoutSchema } from '@atlas/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_LAYOUT,
  MAX_PANES,
  activePane,
  closePane,
  collapseToActivePane,
  focusAdjacentPane,
  listPanes,
  reconcileLayout,
  removeSession,
  replaceSession,
  setSplitRatio,
  showSession,
  splitActivePane,
} from '../src/renderer/src/terminal/state/layout';

const S = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('terminal layout', () => {
  let counter: number;
  const newId = () => `id${counter++}`;
  const sessionsOf = (layout: TerminalWorkspaceLayout) =>
    listPanes(layout.root).map((pane) => pane.sessionId);

  beforeEach(() => {
    counter = 0;
  });

  it('shows the first session in a single pane', () => {
    const layout = showSession(EMPTY_LAYOUT, S(1), newId);
    expect(layout.root).toEqual({ type: 'pane', id: 'id0', sessionId: S(1) });
    expect(layout.activePaneId).toBe('id0');
  });

  it('shows another session in the active pane without duplicating it', () => {
    let layout = showSession(EMPTY_LAYOUT, S(1), newId);
    layout = showSession(layout, S(2), newId);
    expect(sessionsOf(layout)).toEqual([S(2)]);
    layout = splitActivePane(layout, 'row', S(3), newId);
    // Selecting a visible session focuses its pane instead of showing it twice.
    layout = showSession(layout, S(2), newId);
    expect(sessionsOf(layout)).toEqual([S(2), S(3)]);
    expect(activePane(layout)?.sessionId).toBe(S(2));
  });

  it('splits horizontally and vertically, focusing the new pane', () => {
    let layout = showSession(EMPTY_LAYOUT, S(1), newId);
    layout = splitActivePane(layout, 'row', S(2), newId);
    layout = splitActivePane(layout, 'column', S(3), newId);
    expect(layout.root).toMatchObject({
      type: 'split',
      direction: 'row',
      children: [
        { type: 'pane', sessionId: S(1) },
        {
          type: 'split',
          direction: 'column',
          children: [{ sessionId: S(2) }, { sessionId: S(3) }],
        },
      ],
    });
    expect(activePane(layout)?.sessionId).toBe(S(3));
    expect(TerminalWorkspaceLayoutSchema.safeParse(layout).success).toBe(true);
  });

  it('never exceeds the pane limit and never shows a session twice', () => {
    let layout = showSession(EMPTY_LAYOUT, S(0), newId);
    for (let n = 1; n < 10; n += 1) layout = splitActivePane(layout, 'row', S(n), newId);
    expect(listPanes(layout.root)).toHaveLength(MAX_PANES);
    expect(splitActivePane(layout, 'row', S(0), newId)).toBe(layout);
  });

  it('closes panes, promoting the sibling, without touching other sessions', () => {
    let layout = showSession(EMPTY_LAYOUT, S(1), newId);
    layout = splitActivePane(layout, 'row', S(2), newId);
    layout = splitActivePane(layout, 'column', S(3), newId);
    const middle = listPanes(layout.root)[1]!;
    layout = closePane(layout, middle.id);
    expect(sessionsOf(layout)).toEqual([S(1), S(3)]);
    expect(layout.root).toMatchObject({ type: 'split', direction: 'row' });

    layout = closePane(layout, listPanes(layout.root)[1]!.id);
    expect(layout.root).toMatchObject({ type: 'pane', sessionId: S(1) });
    expect(layout.activePaneId).toBe(listPanes(layout.root)[0]!.id);

    layout = closePane(layout, layout.activePaneId!);
    expect(layout).toMatchObject({ root: null, activePaneId: null });
  });

  it('replaces a removed session with a hidden one or closes its pane', () => {
    let layout = showSession(EMPTY_LAYOUT, S(1), newId);
    layout = splitActivePane(layout, 'row', S(2), newId);
    expect(sessionsOf(removeSession(layout, S(1), S(9)))).toEqual([S(9), S(2)]);
    expect(sessionsOf(removeSession(layout, S(1)))).toEqual([S(2)]);
    // A replacement that is already visible is not duplicated.
    expect(sessionsOf(removeSession(layout, S(1), S(2)))).toEqual([S(2)]);
    expect(removeSession(layout, S(7))).toBe(layout);
  });

  it('restores a single-pane layout around the active pane', () => {
    let layout = showSession(EMPTY_LAYOUT, S(1), newId);
    layout = splitActivePane(layout, 'row', S(2), newId);
    layout = collapseToActivePane(layout);
    expect(layout.root).toMatchObject({ type: 'pane', sessionId: S(2) });
  });

  it('cycles focus across panes in both directions', () => {
    let layout = showSession(EMPTY_LAYOUT, S(1), newId);
    layout = splitActivePane(layout, 'row', S(2), newId);
    layout = splitActivePane(layout, 'row', S(3), newId);
    expect(activePane(focusAdjacentPane(layout, 1))?.sessionId).toBe(S(1));
    expect(activePane(focusAdjacentPane(layout, -1))?.sessionId).toBe(S(2));
  });

  it('clamps split ratios and swaps restarted sessions', () => {
    let layout = showSession(EMPTY_LAYOUT, S(1), newId);
    layout = splitActivePane(layout, 'column', S(2), newId);
    const splitId = (layout.root as { id: string }).id;
    expect(setSplitRatio(layout, splitId, 3).root).toMatchObject({ ratio: 10 });
    expect(setSplitRatio(layout, splitId, 72.46).root).toMatchObject({ ratio: 72.5 });
    expect(sessionsOf(replaceSession(layout, S(1), S(5)))).toEqual([S(5), S(2)]);
  });

  it('repairs persisted layouts against the existing sessions', () => {
    let saved = showSession(EMPTY_LAYOUT, S(1), newId);
    saved = splitActivePane(saved, 'row', S(2), newId);
    saved = splitActivePane(saved, 'row', S(1), newId); // ignored: already visible
    const repaired = reconcileLayout(saved, [S(1)]);
    expect(sessionsOf(repaired)).toEqual([S(1)]);
    expect(repaired.activePaneId).toBe(listPanes(repaired.root)[0]!.id);
    expect(reconcileLayout(null, [S(1)])).toEqual(EMPTY_LAYOUT);
    expect(reconcileLayout(saved, [])).toMatchObject({ root: null, activePaneId: null });
  });
});

describe('terminal input chunking', () => {
  it('splits large pastes without breaking surrogate pairs', async () => {
    const { splitInput } = await import('../src/renderer/src/terminal/state/input');
    expect(splitInput('')).toEqual([]);
    expect(splitInput('abcdef', 4)).toEqual(['abcd', 'ef']);
    const emoji = 'ab😀cd'; // 😀 is two UTF-16 code units at index 2-3
    const chunks = splitInput(emoji, 3);
    expect(chunks.join('')).toBe(emoji);
    expect(chunks).toEqual(['ab', '😀c', 'd']);
    const large = 'x'.repeat(200_000);
    expect(splitInput(large).every((chunk) => chunk.length <= 64 * 1024)).toBe(true);
  });
});

describe('terminal clipboard input', () => {
  const key = (
    code: string,
    modifiers: Partial<Record<'ctrl' | 'shift' | 'alt' | 'meta', boolean>>,
  ) => ({
    code,
    ctrlKey: modifiers.ctrl ?? false,
    shiftKey: modifiers.shift ?? false,
    altKey: modifiers.alt ?? false,
    metaKey: modifiers.meta ?? false,
  });

  it('maps Ctrl+Shift+C/V/A and Shift+Insert, leaving Ctrl+C and Ctrl+V to the program', async () => {
    const { clipboardShortcut } = await import('../src/renderer/src/terminal/state/input');
    expect(clipboardShortcut(key('KeyC', { ctrl: true, shift: true }))).toBe('copy');
    expect(clipboardShortcut(key('KeyV', { ctrl: true, shift: true }))).toBe('paste');
    expect(clipboardShortcut(key('KeyA', { ctrl: true, shift: true }))).toBe('selectAll');
    expect(clipboardShortcut(key('Insert', { shift: true }))).toBe('paste');
    expect(clipboardShortcut(key('KeyC', { ctrl: true }))).toBeNull();
    expect(clipboardShortcut(key('KeyV', { ctrl: true }))).toBeNull();
    expect(clipboardShortcut(key('KeyC', { shift: true }))).toBeNull();
    expect(clipboardShortcut(key('KeyC', { ctrl: true, shift: true, alt: true }))).toBeNull();
    expect(clipboardShortcut(key('KeyV', { ctrl: true, shift: true, meta: true }))).toBeNull();
    expect(clipboardShortcut(key('KeyT', { ctrl: true, shift: true }))).toBeNull();
  });

  it('quotes dropped paths as shell words without running them', async () => {
    const { droppedPathsInput, quoteShellPath } =
      await import('../src/renderer/src/terminal/state/input');
    expect(quoteShellPath('/tmp/shot.png')).toBe('/tmp/shot.png');
    expect(quoteShellPath('/tmp/my shot.png')).toBe(`'/tmp/my shot.png'`);
    expect(quoteShellPath(`/tmp/it's $(rm -rf ~);.png`)).toBe(`'/tmp/it'\\''s $(rm -rf ~);.png'`);
    expect(quoteShellPath('/tmp/imagem ção.png')).toBe(`'/tmp/imagem ção.png'`);
    expect(droppedPathsInput(['/a.png', '', '/b c.jpg'])).toBe(`/a.png '/b c.jpg' `);
    expect(droppedPathsInput([])).toBe('');
    expect(droppedPathsInput(['', ''])).toBe('');
    expect(droppedPathsInput(['/tmp/line\nbreak.png'])).toBe(`'/tmp/line\nbreak.png' `);
  });
});
