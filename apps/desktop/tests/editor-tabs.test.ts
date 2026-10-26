import { describe, expect, it } from 'vitest';
import {
  EMPTY_TABS,
  closeTab,
  layoutTabs,
  newTab,
  openTab,
  renameTabs,
  tabLabels,
  updateTab,
  watchedDirectories,
} from '../src/renderer/src/editor/state/tabs';

const open = (...paths: string[]) => paths.reduce(openTab, EMPTY_TABS);

describe('editor tabs (SDD-011 FR-1105)', () => {
  it('opens each file once and activates it', () => {
    const state = openTab(open('a.ts', 'b.ts'), 'a.ts');
    expect(state.tabs.map((tab) => tab.path)).toEqual(['a.ts', 'b.ts']);
    expect(state.activePath).toBe('a.ts');
  });

  it('activates the neighbour when the active tab closes', () => {
    const state = openTab(open('a.ts', 'b.ts', 'c.ts'), 'b.ts');
    expect(closeTab(state, 'b.ts').activePath).toBe('c.ts');
    expect(closeTab(openTab(state, 'c.ts'), 'c.ts').activePath).toBe('b.ts');
    expect(closeTab(state, 'a.ts').activePath).toBe('b.ts');
    expect(closeTab(open('a.ts'), 'a.ts')).toEqual(EMPTY_TABS);
  });

  it('keeps the same state object when nothing changes', () => {
    const state = open('a.ts');
    expect(updateTab(state, 'a.ts', { dirty: false })).toBe(state);
    expect(updateTab(state, 'a.ts', { dirty: true }).tabs[0]!.dirty).toBe(true);
  });

  it('follows renamed files and folders', () => {
    const state = openTab(open('src/a.ts', 'src/lib/b.ts', 'srcx.ts'), 'src/lib/b.ts');
    const moved = renameTabs(state, 'src', 'app');
    expect(moved.tabs.map((tab) => tab.path)).toEqual(['app/a.ts', 'app/lib/b.ts', 'srcx.ts']);
    expect(moved.activePath).toBe('app/lib/b.ts');
  });

  it('labels files with the same name by their folder', () => {
    const labels = tabLabels(['src/a/index.ts', 'src/b/index.ts', 'README.md', 'index.ts']);
    expect(labels.get('src/a/index.ts')).toEqual({ name: 'index.ts', hint: 'src/a' });
    expect(labels.get('index.ts')).toEqual({ name: 'index.ts', hint: '/' });
    expect(labels.get('README.md')).toEqual({ name: 'README.md', hint: '' });
  });

  it('remembers references and positions only (FR-1110)', () => {
    const state = openTab(open('a.ts', 'b.ts', 'c.ts'), 'a.ts');
    const views = new Map([['a.ts', { line: 4, column: 2, scrollTop: 10 }]]);
    expect(layoutTabs(state, views, 2)).toEqual({
      tabs: [{ path: 'b.ts' }, { path: 'c.ts' }],
      activePath: 'c.ts',
    });
    expect(layoutTabs(state, views, 5).tabs[0]).toEqual({
      path: 'a.ts',
      line: 4,
      column: 2,
      scrollTop: 10,
    });
    expect(JSON.stringify(layoutTabs(state, views, 5))).not.toContain('content');
  });

  it('watches the project folder, open files’ folders and expanded folders', () => {
    const tabs = [newTab('src/a.ts'), newTab('README.md')];
    expect(watchedDirectories(tabs, ['docs'], 10)).toEqual(['', 'src', 'docs']);
    expect(watchedDirectories(tabs, ['docs'], 2)).toEqual(['', 'src']);
  });
});
