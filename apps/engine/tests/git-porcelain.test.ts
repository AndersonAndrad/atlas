import { describe, expect, it } from 'vitest';
import { parseBranches, parseStatusV2 } from '../src/index.js';

const z = (...fields: string[]) => `${fields.join('\0')}\0`;

describe('parseStatusV2', () => {
  it('reads branch, upstream and ahead/behind headers', () => {
    const parsed = parseStatusV2(
      z(
        '# branch.oid 1234',
        '# branch.head feature/auth',
        '# branch.upstream origin/feature/auth',
        '# branch.ab +3 -1',
      ),
    );
    expect(parsed).toMatchObject({
      branch: 'feature/auth',
      detachedHead: false,
      unbornHead: false,
      upstream: 'origin/feature/auth',
      ahead: 3,
      behind: 1,
      upstreamGone: false,
    });
  });

  it('handles detached HEAD, unborn branches and missing or gone upstreams', () => {
    expect(parseStatusV2(z('# branch.oid 1234', '# branch.head (detached)'))).toMatchObject({
      branch: null,
      detachedHead: true,
      upstream: null,
      ahead: null,
      behind: null,
    });
    expect(parseStatusV2(z('# branch.oid (initial)', '# branch.head main'))).toMatchObject({
      branch: 'main',
      unbornHead: true,
    });
    expect(
      parseStatusV2(z('# branch.oid 1', '# branch.head main', '# branch.upstream origin/gone')),
    ).toMatchObject({ upstream: 'origin/gone', upstreamGone: true, ahead: null, behind: null });
  });

  it('counts each path once in the total while categories may overlap', () => {
    const parsed = parseStatusV2(
      z(
        '# branch.oid 1',
        '# branch.head main',
        '1 .M N... 100644 100644 100644 a a src/modified.ts',
        '1 M. N... 100644 100644 100644 a b src/staged.ts',
        '1 MM N... 100644 100644 100644 a b src/both.ts',
        '1 D. N... 100644 000000 000000 a 0 src/deleted-staged.ts',
        '1 .D N... 100644 100644 000000 a a src/deleted.ts',
        '2 R. N... 100644 100644 100644 a a R100 src/new name.ts',
        'src/old name.ts',
        'u UU N... 100644 100644 100644 100644 a b c src/conflict.ts',
        '? notes with spaces.txt',
        '? other.txt',
      ),
    );
    expect(parsed.changes).toEqual({
      modified: 2,
      staged: 4,
      untracked: 2,
      deleted: 2,
      renamed: 1,
      conflicted: 1,
      total: 9,
    });
  });

  it('returns zero counts for a clean tree', () => {
    expect(parseStatusV2(z('# branch.oid 1', '# branch.head main')).changes.total).toBe(0);
    expect(parseStatusV2('').changes.total).toBe(0);
  });
});

describe('parseBranches', () => {
  it('parses names and committer dates', () => {
    expect(parseBranches('main\x002026-10-01T10:00:00-03:00\nfeature/x\x00\n\n')).toEqual([
      { name: 'main', latestCommitAt: '2026-10-01T13:00:00.000Z' },
      { name: 'feature/x', latestCommitAt: null },
    ]);
  });
});
