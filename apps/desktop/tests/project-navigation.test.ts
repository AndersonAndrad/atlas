import { describe, expect, it } from 'vitest';
import {
  RECENT_PROJECTS_LIMIT,
  filterByName,
  pushRecent,
} from '../src/renderer/src/terminal/state/project-navigation';

const names = (items: { name: string }[]) => items.map((item) => item.name);
const byName = (item: { name: string }) => item.name;

describe('filterByName', () => {
  const projects = [
    { name: 'Backend IB' },
    { name: 'bet-agendamento' },
    { name: 'Seres home' },
    { name: 'srs-agendamento' },
    { name: 'Sêres app' },
  ];

  it('keeps every item, in order, for an empty or blank query', () => {
    expect(names(filterByName(projects, '', byName))).toEqual(names(projects));
    expect(names(filterByName(projects, '   ', byName))).toEqual(names(projects));
  });

  it('ignores case and accents', () => {
    expect(names(filterByName(projects, 'SERES', byName))).toEqual(['Seres home', 'Sêres app']);
    expect(names(filterByName(projects, 'sêres', byName))).toEqual(['Seres home', 'Sêres app']);
  });

  it('lists names starting with the query first, then those containing it', () => {
    expect(names(filterByName(projects, 'agend', byName))).toEqual([
      'bet-agendamento',
      'srs-agendamento',
    ]);
    const apis = [{ name: 'my-api' }, { name: 'web' }, { name: 'api-gateway' }];
    expect(names(filterByName(apis, 'api', byName))).toEqual(['api-gateway', 'my-api']);
  });

  it('returns nothing when no name matches', () => {
    expect(filterByName(projects, 'zzz', byName)).toEqual([]);
  });

  it('treats the query as text, not as a pattern', () => {
    expect(filterByName([{ name: 'a.b' }, { name: 'axb' }], '.', byName)).toEqual([
      { name: 'a.b' },
    ]);
  });
});

describe('pushRecent', () => {
  it('moves an id to the front without duplicates', () => {
    expect(pushRecent(['a', 'b', 'c'], 'c')).toEqual(['c', 'a', 'b']);
    expect(pushRecent([], 'a')).toEqual(['a']);
    expect(pushRecent(['a'], 'a')).toEqual(['a']);
  });

  it('keeps at most the limit, dropping the oldest', () => {
    const full = ['1', '2', '3', '4', '5'];
    expect(full).toHaveLength(RECENT_PROJECTS_LIMIT);
    expect(pushRecent(full, '6')).toEqual(['6', '1', '2', '3', '4']);
    expect(pushRecent(['a', 'b'], 'c', 2)).toEqual(['c', 'a']);
    expect(pushRecent(['a'], 'b', 0)).toEqual([]);
  });
});
