import { describe, expect, it } from 'vitest';
import { validateCommitMessage } from '../src/index.js';

describe('validateCommitMessage — specification examples', () => {
  it('accepts a description and a breaking change footer', () => {
    const result = validateCommitMessage(
      'feat: allow provided config object to extend other configs\n\nBREAKING CHANGE: `extends` key in config file is now used for extending other config files',
    );
    expect(result).toMatchObject({ valid: true, type: 'feat', breaking: true, errors: [] });
    expect(result.footers).toEqual([
      {
        token: 'BREAKING CHANGE',
        separator: ': ',
        value: '`extends` key in config file is now used for extending other config files',
      },
    ]);
  });

  it('accepts ! to draw attention to a breaking change, with and without scope', () => {
    expect(
      validateCommitMessage('feat!: send an email to the customer when a product is shipped'),
    ).toMatchObject({ valid: true, breaking: true });
    expect(
      validateCommitMessage('feat(api)!: send an email to the customer when a product is shipped'),
    ).toMatchObject({ valid: true, breaking: true, scope: 'api' });
  });

  it('accepts both ! and a BREAKING CHANGE footer', () => {
    const result = validateCommitMessage(
      'chore!: drop support for Node 6\n\nBREAKING CHANGE: use JavaScript features not available in Node 6.',
    );
    expect(result).toMatchObject({ valid: true, breaking: true });
  });

  it('accepts a message without body', () => {
    expect(validateCommitMessage('docs: correct spelling of CHANGELOG')).toMatchObject({
      valid: true,
      type: 'docs',
      description: 'correct spelling of CHANGELOG',
      breaking: false,
    });
  });

  it('accepts a scope', () => {
    expect(validateCommitMessage('feat(lang): add Polish language')).toMatchObject({
      valid: true,
      scope: 'lang',
    });
  });

  it('accepts a multi-paragraph body and multiple footers', () => {
    const result = validateCommitMessage(
      [
        'fix: prevent racing of requests',
        '',
        'Introduce a request id and a reference to latest request. Dismiss',
        'incoming responses other than from latest request.',
        '',
        'Remove timeouts which were used to mitigate the racing issue but are',
        'obsolete now.',
        '',
        'Reviewed-by: Z',
        'Refs: #123',
      ].join('\n'),
    );
    expect(result.valid).toBe(true);
    expect(result.body).toContain('obsolete now.');
    expect(result.footers.map((footer) => footer.token)).toEqual(['Reviewed-by', 'Refs']);
  });

  it('accepts the " #" footer separator and multi-line footer values', () => {
    const result = validateCommitMessage(
      'fix(git): correct ahead and behind counters\n\nCloses #42\nBREAKING-CHANGE: counters are\nnow nullable',
    );
    expect(result.valid).toBe(true);
    expect(result.breaking).toBe(true);
    expect(result.footers).toEqual([
      { token: 'Closes', separator: ' #', value: '42' },
      { token: 'BREAKING-CHANGE', separator: ': ', value: 'counters are\nnow nullable' },
    ]);
  });

  it('treats types case-insensitively and accepts any valid type', () => {
    expect(validateCommitMessage('Feat: add groups').valid).toBe(true);
    expect(validateCommitMessage('security: rotate keys').valid).toBe(true);
  });

  it('ignores trailing blank lines and CRLF line endings', () => {
    expect(validateCommitMessage('fix: a\r\n\r\nbody\r\n\r\n').valid).toBe(true);
  });
});

describe('validateCommitMessage — invalid messages', () => {
  const errorsOf = (message: string) => validateCommitMessage(message).errors;

  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['add terminal groups', 'header must follow'],
    ['feat:add groups', 'header must follow'],
    ['feat add groups', 'header must follow'],
    ['feat: ', 'description must follow'],
    ['feat:  two spaces', 'single space'],
    ['feat(): empty scope', 'scope must not be empty'],
    ['feat( api ): spaced scope', 'start or end with spaces'],
    ['fe at: x', 'header must follow'],
    ['feat_x: y', 'single word'],
    [' feat: leading space', 'must not start with whitespace'],
    ['feat: x\nbody without blank line', 'blank line'],
    ['feat: x\n\nBREAKING CHANGE #1', 'must be followed by ": "'],
    ['feat: x\n\nRefs: ', 'has no value'],
  ])('rejects %j (%s)', (message, expected) => {
    const result = validateCommitMessage(message);
    expect(result.valid).toBe(false);
    expect(errorsOf(message).join(' ')).toContain(expected);
  });

  it('does not treat a lowercase "breaking change" footer as breaking', () => {
    const result = validateCommitMessage('feat: x\n\nbreaking change: nothing');
    expect(result.breaking).toBe(false);
  });
});

describe('validateCommitMessage — project rules only add restrictions', () => {
  it('restricts types when configured', () => {
    const rules = { types: ['feat', 'fix'] };
    expect(validateCommitMessage('FIX: x', rules).valid).toBe(true);
    expect(validateCommitMessage('chore: x', rules).errors[0]).toContain('not allowed');
  });

  it('requires a scope and limits header length', () => {
    expect(validateCommitMessage('feat: x', { requireScope: true }).valid).toBe(false);
    expect(validateCommitMessage('feat(a): x', { requireScope: true }).valid).toBe(true);
    expect(validateCommitMessage(`feat: ${'x'.repeat(20)}`, { headerMaxLength: 10 }).valid).toBe(
      false,
    );
  });

  it('cannot make an invalid message valid', () => {
    expect(validateCommitMessage('nope', { types: [] }).valid).toBe(false);
  });
});
