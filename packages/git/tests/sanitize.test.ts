import { describe, expect, it } from 'vitest';
import { redactCredentials, redactTail, sanitizeGitOutput } from '../src/index.js';

/** Fastest of three runs, so a busy machine pausing one run does not fail a linear-time check. */
const elapsed = (action: () => unknown) => {
  let fastest = Number.POSITIVE_INFINITY;
  for (let run = 0; run < 3; run += 1) {
    const started = performance.now();
    action();
    fastest = Math.min(fastest, performance.now() - started);
  }
  return fastest;
};

describe('redactCredentials', () => {
  it.each([
    ['AWS_SECRET_ACCESS_KEY=fake-aws-secret', 'AWS_SECRET_ACCESS_KEY=***'],
    ['PRIVATE_KEY=fake-private', 'PRIVATE_KEY=***'],
    ['NPM_AUTH=fake-npm', 'NPM_AUTH=***'],
    ['NODE_AUTH_TOKEN=fake-node', 'NODE_AUTH_TOKEN=***'],
    ['//registry.npmjs.org/:_authToken=fake-npmrc', '//registry.npmjs.org/:_authToken=***'],
    ['access_key: fake-access', 'access_key: ***'],
    ['apiKey = fake-api', 'apiKey = ***'],
    ['db_passwd=fake-passwd', 'db_passwd=***'],
    ['password: "a\\"b c"', 'password: ***'],
    ["secret: 'fake value'", 'secret: ***'],
    ['{"client_secret": "fake value", "id": 1}', '{"client_secret": ***, "id": 1}'],
    ['token="unterminated fake value', 'token=***'],
    ['GITHUB_TOKEN=fake-gh', 'GITHUB_TOKEN=***'],
    ['NPM_AUTH_TOKEN=fake-npm', 'NPM_AUTH_TOKEN=***'],
    ['API_KEY=fake-api', 'API_KEY=***'],
    ['DB_PASSWORD=fake-db', 'DB_PASSWORD=***'],
    ['client_secret=fake-client', 'client_secret=***'],
    ['x-api-key: fake-header', 'x-api-key: ***'],
    ['GITHUBTOKEN=fake-joined', 'GITHUBTOKEN=***'],
    ['dbPassword: fake-camel', 'dbPassword: ***'],
    ['spring.datasource.password=fake-dotted', 'spring.datasource.password=***'],
    ['DB_PWD=fake-pwd', 'DB_PWD=***'],
    ['pwd: fake-pwd', 'pwd: ***'],
    ['DB_PASS=fake-pass', 'DB_PASS=***'],
    ['smtpPass: fake-camel-pass', 'smtpPass: ***'],
    ['AWS_CREDENTIALS=fake-credentials', 'AWS_CREDENTIALS=***'],
    ['password: 123456', 'password: ***'],
    ['PIN_PASS=4321', 'PIN_PASS=***'],
    ['pwd=1234', 'pwd=***'],
    ['client_secret: 42', 'client_secret: ***'],
    ['credentials: "9876"', 'credentials: ***'],
  ])('redacts secret keys: %s', (input, expected) => {
    expect(redactCredentials(input)).toBe(expected);
  });

  it('redacts authorization headers of any scheme and cookies', () => {
    expect(redactCredentials('Authorization: Bearer fake-bearer')).toBe(
      'Authorization: Bearer ***',
    );
    expect(redactCredentials('authorization: token fake-token')).toBe('authorization: token ***');
    expect(redactCredentials('Proxy-Authorization: Basic ZmFrZTpmYWtl')).toBe(
      'Proxy-Authorization: Basic ***',
    );
    expect(redactCredentials('Authorization: fake-raw-value')).toBe('Authorization: ***');
    expect(redactCredentials('curl -H "Authorization: Digest fake=1, nonce=2" https://h')).toBe(
      'curl -H "Authorization: Digest ***" https://h',
    );
    expect(redactCredentials('Cookie: session=fake; theme=dark')).toBe('Cookie: ***');
    expect(redactCredentials('Set-Cookie: sid=fake; HttpOnly')).toBe('Set-Cookie: ***');
  });

  it('redacts bare provider tokens', () => {
    const tokens = [
      `ghp_${'a'.repeat(36)}`,
      `gho_${'b'.repeat(36)}`,
      `ghu_${'c'.repeat(36)}`,
      `ghs_${'d'.repeat(36)}`,
      `ghr_${'e'.repeat(36)}`,
      `github_pat_${'F1'.repeat(30)}`,
      `glpat-${'g'.repeat(20)}`,
      'xoxb-1234567890-fake',
      'xoxp-1234567890-fake',
      `sk-${'h1'.repeat(20)}`,
      'AKIAABCDEFGHIJKLMNOP',
    ];
    for (const token of tokens) {
      expect(redactCredentials(`using ${token} now`)).toBe('using *** now');
    }
    expect(redactCredentials('sk-short')).toBe('sk-short');
  });

  it('redacts PEM private keys, including a key whose beginning was cut off', () => {
    const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIfake\nline\n-----END RSA PRIVATE KEY-----';
    expect(redactCredentials(`before\n${key}\nafter`)).toBe(
      'before\n[REDACTED PRIVATE KEY]\nafter',
    );
    expect(redactCredentials('-----BEGIN PRIVATE KEY-----\nMIIfake\nno end')).toBe(
      '[REDACTED PRIVATE KEY]',
    );
    expect(redactCredentials('MIIfake\n-----END OPENSSH PRIVATE KEY-----\nafter')).toBe(
      '[REDACTED PRIVATE KEY]\nafter',
    );
    expect(redactCredentials('-----BEGIN CERTIFICATE-----')).toBe('-----BEGIN CERTIFICATE-----');
  });

  it('redacts secret CLI flags but not unrelated flags', () => {
    expect(redactCredentials('login --password fake-pw --user ana')).toBe(
      'login --password *** --user ana',
    );
    expect(redactCredentials('login --password=fake-pw')).toBe('login --password=***');
    expect(redactCredentials('publish --token "fake value" --dry-run')).toBe(
      'publish --token *** --dry-run',
    );
    expect(redactCredentials('deploy --api-key fake-key')).toBe('deploy --api-key ***');
    expect(redactCredentials('run --token-file .token --verbose')).toBe(
      'run --token-file .token --verbose',
    );
  });

  it('keeps URL hosts when the user info looks like a key', () => {
    expect(redactCredentials('https://oauth2:fake-glpat@gitlab.com/x.git')).toBe(
      'https://***@gitlab.com/x.git',
    );
  });

  it('does not redact ordinary Git output', () => {
    const output = [
      ' M src/token.ts',
      '?? src/auth/password-reset.ts',
      'author: Ana <ana@example.com>',
      'Author: Ana <ana@example.com>',
      'fatal: Authentication failed for https://github.com/org/repo.git/',
      'git@github.com:org/repo.git',
      'feature/task-tokens',
    ].join('\n');
    expect(redactCredentials(output)).toBe(output);
  });

  it.each([
    'Unexpected token: }',
    'Parsing error: Unexpected token =>',
    'max_tokens: 5',
    'tests/auth: 5 passed',
    'oauth: enabled',
    'secretary=Joe',
    'git switch sk-feature-implementation-of-thing',
    'AUTHOR: Ana',
    'auth: disabled',
    'token: 3',
    'passed=12',
    'bypass=cache',
    'tests_passed: 4',
    'compass=north',
  ])('does not redact tool output that only looks like a secret: %s', (text) => {
    expect(redactCredentials(text)).toBe(text);
  });

  it('redacts `sk-` keys that contain a digit', () => {
    expect(redactCredentials(`key sk-proj-${'a1'.repeat(12)} used`)).toBe('key *** used');
  });

  it.each([
    ['letters', 'a'.repeat(256 * 1024)],
    [
      'a base64 line',
      Buffer.from(Array.from({ length: 192 * 1024 }, (_, index) => (index * 7919) % 256)).toString(
        'base64',
      ),
    ],
    ['dashed words', 'a-'.repeat(128 * 1024)],
    ['URL-like text', 'a://'.repeat(64 * 1024)],
    ['repeated keys', 'token="'.repeat(36 * 1024)],
    ['repeated harmless keys', 'max_tokens='.repeat(24 * 1024)],
    ['camelCase words', 'aB'.repeat(128 * 1024)],
    ['dotted keys', 'a.b:'.repeat(64 * 1024)],
    ['sk- prefixes', 'sk-'.repeat(86 * 1024)],
    ['separated keyword segments', 'x_token_'.repeat(32 * 1024)],
    ['password-like segments', 'x_pass_pwd.'.repeat(24 * 1024)],
    ['carriage returns', 'pass=\r'.repeat(48 * 1024)],
  ])('redacts 256 KB of %s in linear time', (_name, input) => {
    expect(input.length).toBeGreaterThanOrEqual(250 * 1024);
    expect(elapsed(() => redactCredentials(input))).toBeLessThan(100);
  });
});

describe('redactTail', () => {
  it('does not leave a secret split from its key by the limit', () => {
    const text = `PASSWORD=fake-split-secret\n${'x'.repeat(30)}`;
    // A plain tail of 45 characters would start with `WORD=fake-split-secret`.
    expect(redactTail(text, 45)).not.toContain('fake-split-secret');
    expect(redactTail(text, 45).length).toBeLessThanOrEqual(45);
  });

  it('drops the partial first line of a long text before redacting it', () => {
    const rest = `WORD=fake-long-secret\n${'r'.repeat(100 + 1024 - 22)}`;
    const text = `${'q'.repeat(3000)}PASS${rest}`;
    const tail = redactTail(text, 100);
    expect(tail).not.toContain('fake-long-secret');
    expect(tail).toBe('r'.repeat(100));
  });

  it('drops a cut line whose key lies before the kept window', () => {
    const token = `GITHUB_TOKEN=eyJ${'A'.repeat(2500)}`;
    // The key is beyond the redaction margin: only the value's end remains.
    expect(redactTail(token, 1000)).toBe('');
    const followed = redactTail(`${token}\nnext line`, 1000);
    expect(followed).toBe('next line');
  });

  it('does not leak a long bearer value cut by the output limit', () => {
    const value = 'b'.repeat(12 * 1024);
    const output = sanitizeGitOutput(`curl -H "Authorization: Bearer ${value}"`)!;
    expect(output).not.toContain('bbbb');
    expect(output).toBe('…');
    const withNextLine = sanitizeGitOutput(`Authorization: Bearer ${value}\ndone`)!;
    expect(withNextLine).toBe('…done');
  });

  it('treats a carriage return as a line break', () => {
    const token = `GITHUB_TOKEN=eyJ${'A'.repeat(2500)}`;
    // Progress output redraws lines with `\r` only; the cut line is still dropped.
    expect(redactTail(`${token}\rnext line`, 1000)).toBe('next line');
  });

  it('keeps short text whole', () => {
    expect(redactTail('token=fake', 100)).toBe('token=***');
  });
});

describe('sanitizeGitOutput', () => {
  it('redacts a secret cut by the output limit', () => {
    const output = sanitizeGitOutput(`API_TOKEN=fake-cut-secret\n${'y'.repeat(8 * 1024 - 20)}`)!;
    expect(output).not.toContain('fake-cut-secret');
    expect(output.length).toBeLessThanOrEqual(8 * 1024 + 1);
  });
});
