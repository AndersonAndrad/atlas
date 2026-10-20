import { describe, expect, it } from 'vitest';
import {
  parseNumstat,
  parseProgress,
  parseRefs,
  parseRemotes,
  parseStatusEntries,
  redactCredentials,
  sanitizeGitOutput,
} from '../src/index.js';

const z = (...fields: string[]) => `${fields.join('\0')}\0`;

describe('parseStatusEntries', () => {
  it('maps index (X) and working tree (Y) codes and keeps paths with spaces', () => {
    const entries = parseStatusEntries(
      z(
        '# branch.head main',
        '1 MM N... 100644 100644 100644 aaa bbb src/my file.ts',
        '1 .D N... 100644 100644 000000 aaa aaa gone.txt',
        '1 A. N... 000000 100644 100644 000 bbb added.txt',
        '2 R. N... 100644 100644 100644 aaa aaa R100 new name.ts',
        'old name.ts',
        'u UU N... 100644 100644 100644 100644 a b c conflict.txt',
        '? untracked dir/file.txt',
      ),
    );
    expect(entries).toEqual([
      { path: 'src/my file.ts', originalPath: null, staged: 'modified', unstaged: 'modified' },
      { path: 'gone.txt', originalPath: null, staged: null, unstaged: 'deleted' },
      { path: 'added.txt', originalPath: null, staged: 'added', unstaged: null },
      { path: 'new name.ts', originalPath: 'old name.ts', staged: 'renamed', unstaged: null },
      { path: 'conflict.txt', originalPath: null, staged: 'conflicted', unstaged: 'conflicted' },
      { path: 'untracked dir/file.txt', originalPath: null, staged: null, unstaged: 'untracked' },
    ]);
  });
});

describe('parseNumstat', () => {
  it('reads counts, binary files and renames', () => {
    const stats = parseNumstat(`3\t1\ta.ts\0-\t-\timg.png\0${'2\t0\t'}\0old.ts\0new.ts\0`);
    expect(stats.get('a.ts')).toEqual({ added: 3, removed: 1 });
    expect(stats.get('img.png')).toEqual({ added: null, removed: null });
    expect(stats.get('new.ts')).toEqual({ added: 2, removed: 0 });
    expect(stats.has('old.ts')).toBe(false);
  });
});

describe('parseRefs', () => {
  it('reads current branch, upstream tracking and gone upstreams', () => {
    const refs = parseRefs(
      [
        ['refs/heads/main', '*', 'origin/main', 'ahead 2, behind 1', '2026-01-02T00:00:00+00:00'],
        ['refs/heads/old', ' ', 'origin/old', 'gone', ''],
        ['refs/heads/local', ' ', '', '', ''],
        ['refs/heads/synced', ' ', 'origin/synced', '', ''],
      ]
        .map((fields) => fields.join('\0'))
        .join('\n'),
    );
    expect(refs[0]).toMatchObject({ current: true, ahead: 2, behind: 1, upstream: 'origin/main' });
    expect(refs[1]).toMatchObject({ upstreamGone: true, ahead: null, behind: null });
    expect(refs[2]).toMatchObject({ upstream: null, ahead: null });
    expect(refs[3]).toMatchObject({ ahead: 0, behind: 0 });
  });
});

describe('parseRemotes', () => {
  it('groups fetch and push URLs', () => {
    expect(
      parseRemotes(
        'origin\tgit@host:a.git (fetch)\norigin\tgit@host:b.git (push)\nup\t/tmp/x (fetch)\n',
      ),
    ).toEqual([
      { name: 'origin', fetchUrl: 'git@host:a.git', pushUrl: 'git@host:b.git' },
      { name: 'up', fetchUrl: '/tmp/x', pushUrl: null },
    ]);
  });
});

describe('parseProgress', () => {
  it('reads phases and percentages, ignoring errors', () => {
    expect(parseProgress('Receiving objects:  42% (21/50)')).toEqual({
      phase: 'Receiving objects',
      percent: 42,
    });
    expect(parseProgress('remote: Counting objects: 100% (3/3), done.')).toEqual({
      phase: 'Counting objects',
      percent: 100,
    });
    expect(parseProgress('Enumerating objects: 5, done.')).toEqual({
      phase: 'Enumerating objects',
      percent: null,
    });
    expect(parseProgress('error: failed to push some refs')).toBeNull();
    expect(parseProgress('To /tmp/origin.git')).toBeNull();
  });
});

describe('credential redaction', () => {
  it('removes user info from URLs and token query parameters', () => {
    expect(redactCredentials('fatal: unable to access https://ana:t0k@github.com/x.git/')).toBe(
      'fatal: unable to access https://***@github.com/x.git/',
    );
    expect(redactCredentials('https://ghp_abc@github.com/x')).toBe('https://***@github.com/x');
    expect(redactCredentials('https://h/x?access_token=abc&y=1')).toBe(
      'https://h/x?access_token=***&y=1',
    );
    expect(redactCredentials('git@github.com:org/repo.git')).toBe('git@github.com:org/repo.git');
  });

  it('limits output size and returns null without content', () => {
    expect(sanitizeGitOutput('', '  ')).toBeNull();
    const long = sanitizeGitOutput('x'.repeat(20_000))!;
    expect(long.length).toBeLessThanOrEqual(8 * 1024 + 1);
    expect(long.startsWith('…')).toBe(true);
  });

  it('redacts common credentials printed by pre-commit commands', () => {
    const output = sanitizeGitOutput(
      'API_TOKEN=first-secret\n{"password": "second secret"}\nAuthorization: Bearer third-secret',
    )!;
    expect(output).not.toContain('first-secret');
    expect(output).not.toContain('second secret');
    expect(output).not.toContain('third-secret');
    expect(output).toContain('API_TOKEN=***');
    expect(output).toContain('Authorization: Bearer ***');
  });
});
