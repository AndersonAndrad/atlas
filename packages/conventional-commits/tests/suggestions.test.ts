import { describe, expect, it } from 'vitest';
import { suggestCommitMessage, validateCommitMessage } from '../src/index.js';

describe('suggestCommitMessage (deterministic)', () => {
  it('returns null without files', () => {
    expect(suggestCommitMessage({ files: [] })).toBeNull();
  });

  it('suggests docs only when every file is documentation', () => {
    const suggestion = suggestCommitMessage({
      files: [
        { path: 'docs/ARCHITECTURE.md', change: 'modified' },
        { path: 'README.md', change: 'modified' },
      ],
    })!;
    expect(suggestion.message).toBe('docs: update ARCHITECTURE.md and 1 other file');
    expect(validateCommitMessage(suggestion.message).valid).toBe(true);
  });

  it('uses the package name as scope inside a monorepo container', () => {
    const suggestion = suggestCommitMessage({
      files: [
        { path: 'packages/git/tests/a.test.ts', change: 'added' },
        { path: 'packages/git/tests/b.test.ts', change: 'added' },
      ],
    })!;
    expect(suggestion).toMatchObject({ type: 'test', scope: 'git' });
    expect(suggestion.message).toBe('test(git): add a.test.ts and 1 other file');
  });

  it('does not invent a type for mixed changes and leaves a placeholder', () => {
    const suggestion = suggestCommitMessage({
      files: [
        { path: 'apps/engine/src/engine.ts', change: 'modified' },
        { path: 'apps/engine/tests/engine.test.ts', change: 'modified' },
      ],
    })!;
    expect(suggestion.type).toBeNull();
    expect(suggestion.message).toBe('<type>(engine): update engine.ts and 1 other file');
    // The placeholder is intentionally invalid so the user must choose a type.
    expect(validateCommitMessage(suggestion.message).valid).toBe(false);
  });

  it('recognizes CI and build files and describes removals and renames', () => {
    expect(
      suggestCommitMessage({ files: [{ path: '.github/workflows/ci.yml', change: 'deleted' }] })!
        .message,
    ).toBe('ci: remove ci.yml');
    expect(
      suggestCommitMessage({ files: [{ path: 'pnpm-lock.yaml', change: 'modified' }] })!.message,
    ).toBe('build: update pnpm-lock.yaml');
    expect(
      suggestCommitMessage({ files: [{ path: 'src/a.ts', change: 'renamed' }] })!.message,
    ).toBe('<type>: rename a.ts');
  });
});
