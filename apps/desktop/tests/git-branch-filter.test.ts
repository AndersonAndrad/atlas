import { describe, expect, it } from 'vitest';
import { filterBranches } from '../src/renderer/src/git/format';

const branches = [
  { name: 'main' },
  { name: 'feature/auth-login' },
  { name: 'fix/Auth-token' },
  { name: 'origin/release/2.0' },
];

describe('filterBranches', () => {
  it('keeps every branch for an empty or blank query', () => {
    expect(filterBranches(branches, '')).toEqual(branches);
    expect(filterBranches(branches, '   ')).toEqual(branches);
  });

  it('matches any part of the name, ignoring case and surrounding spaces', () => {
    expect(filterBranches(branches, ' AUTH ').map((branch) => branch.name)).toEqual([
      'feature/auth-login',
      'fix/Auth-token',
    ]);
    expect(filterBranches(branches, 'release/2').map((branch) => branch.name)).toEqual([
      'origin/release/2.0',
    ]);
  });

  it('returns nothing when no name matches and never mutates the input', () => {
    expect(filterBranches(branches, 'nope')).toEqual([]);
    expect(branches).toHaveLength(4);
  });
});
