const MAX_OUTPUT_CHARS = 8 * 1024;
/**
 * Extra characters redacted beyond a tail limit, so a secret cut by the limit is
 * still recognized by its key (`PASSWORD=x` instead of `WORD=x`) and then dropped.
 */
const TAIL_MARGIN_CHARS = 1024;
const REDACTED = '***';

/** A value after `key=` or `key:`: quoted (with escapes), an unterminated quote, or a bare word. */
const VALUE = String.raw`(?:"(?:[^"\\\r\n]|\\.)*"|'(?:[^'\\\r\n]|\\.)*'|["'][^\r\n]*|[^\s&;,"']+)`;

/** A key's first character: not preceded by another key character. */
const KEY_START = String.raw`(?<![A-Za-z0-9_.-])`;
const KEY_CHAR = '[A-Za-z0-9_.-]';
/** Optional closing quote of the key, then `:` or `=`. */
const ASSIGNMENT = String.raw`["']?[ \t]*[:=][ \t]*`;

/** `word`, `Word` or `WORD`, so camelCase boundaries stay visible to the pattern. */
const cased = (word: string) =>
  `(?:${word}|${word[0]!.toUpperCase()}${word.slice(1)}|${word.toUpperCase()})`;
/**
 * Keywords that mark a key as secret when they form a whole segment of it, so
 * `pass` matches `DB_PASS` and `smtpPass` but not `passed` or `bypass`.
 */
const SEGMENT_KEYWORD = `(?:${[
  ...[
    'token',
    'secrets',
    'secret',
    'passwords',
    'password',
    'passwd',
    'pwd',
    'pass',
    'credentials',
    'auth',
  ].map(cased),
  ...['api', 'private', 'access'].map((word) => `${cased(word)}[_.-]?${cased('key')}`),
].join('|')})`;

/**
 * Values that cannot be credentials: punctuation (`token: }`, an already redacted
 * `***`) and switches (`auth: enabled`).
 */
const NOT_A_SECRET = /^(?:[^A-Za-z0-9]*|true|false|enabled|disabled|null)$/i;
/** Small counts (`auth: 5 passed`), harmless only after keys that are not passwords. */
const SMALL_NUMBER = /^\d{1,6}$/;
/** Keys whose values may be short numeric passwords or PINs. */
const PASSWORD_KEY = /pass|pwd|secret|credential/i;

/** Replaces the value after `prefix` (the key and its separator) unless it is harmless. */
function redactValue(match = '', prefix = ''): string {
  const unquoted = match.slice(prefix.length).replace(/^["']/, '').replace(/["']$/, '');
  const harmless =
    NOT_A_SECRET.test(unquoted) || (SMALL_NUMBER.test(unquoted) && !PASSWORD_KEY.test(prefix));
  return harmless ? match : `${prefix}${REDACTED}`;
}

/**
 * Every pattern is linear in the input: quantifiers that can fail are bounded or
 * anchored by a literal, so a long line of letters or base64 cannot cause
 * quadratic backtracking.
 */
const PATTERNS: readonly (readonly [
  RegExp,
  string | ((...groups: (string | undefined)[]) => string),
])[] = [
  // PEM private keys; an unterminated block is redacted to the end of the text.
  [
    /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----(?:[\s\S]*?-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----|[\s\S]*)/g,
    '[REDACTED PRIVATE KEY]',
  ],
  // The end of a key whose beginning was cut off by a tail limit.
  [/^[\s\S]*?-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----/, '[REDACTED PRIVATE KEY]'],
  // URL user info first, so `https://oauth2:x@host` keeps its host.
  [/\b([a-z][a-z0-9+.-]{0,31}:\/\/)[^/\s@]{1,1024}@/gi, `$1${REDACTED}@`],
  [
    /([?&](?:access_token|private_token|token|password|passwd|secret|key|sig|signature)=)[^&\s]+/gi,
    `$1${REDACTED}`,
  ],
  // `Authorization: Bearer x` keeps the scheme; the rest of the header value is removed.
  [
    /\b((?:proxy-)?authorization["']?[ \t]*[:=][ \t]*["']?)(?:([a-z][\w.-]{0,31})[ \t]+(?=[^\s"']))?[^\r\n"']+/gi,
    (_match, prefix = '', scheme) =>
      `${prefix}${scheme === undefined ? '' : `${scheme} `}${REDACTED}`,
  ],
  [/\b((?:set-)?cookie["']?[ \t]*:[ \t]*["']?)[^\r\n"']+/gi, `$1${REDACTED}`],
  // `--password x`, `--password=x`, `--api-token "x"`; flags like `--token-file` are kept.
  [
    new RegExp(
      String.raw`(--(?:[a-z0-9]{1,32}-){0,4}(?:password|passwd|token|secret|api-?key)(?:=|[ \t]+(?!-)))${VALUE}`,
      'gi',
    ),
    `$1${REDACTED}`,
  ],
  // `GITHUB_TOKEN=x`, `NPM_AUTH_TOKEN=x`, `"_authToken": "x"`, `x-api-key: x`: the
  // keyword is a whole segment of the key (between `_`, `-`, `.`, a camelCase
  // boundary or the key's ends), so `max_tokens`, `secretary` and `oauth` are kept.
  [
    new RegExp(
      String.raw`(${KEY_START}(?:${KEY_CHAR}{0,48}?(?:[_.-]|(?<=[a-z0-9])(?=[A-Z])))?${SEGMENT_KEYWORD}(?:(?:[_.-]|(?<=[a-z])(?=[A-Z]))${KEY_CHAR}{0,48})?${ASSIGNMENT})${VALUE}`,
      'g',
    ),
    redactValue,
  ],
  // Keys that end with a keyword without a separator: `GITHUBTOKEN=x`, `dbPassword=x`.
  [
    new RegExp(
      String.raw`(${KEY_START}${KEY_CHAR}{0,48}?(?:token|secrets?|passw(?:or)?ds?)${ASSIGNMENT})${VALUE}`,
      'gi',
    ),
    redactValue,
  ],
  // Bare tokens recognizable by their provider prefix.
  [
    /\b(?:gh[opusr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|glpat-[\w-]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}(?![0-9A-Z]))/g,
    REDACTED,
  ],
  // `sk-` keys contain a digit, unlike branch names such as `sk-feature-of-thing`.
  [/\bsk-[\w-]{20,}/g, (match = '') => (/\d/.test(match) ? REDACTED : match)],
];

/**
 * Removes credentials Git or a command may echo: URL user info, token query
 * parameters, `KEY=value` secrets, authorization and cookie headers, secret CLI
 * flags, provider tokens and private keys. Applied to every URL and command
 * output that leaves the Git service.
 */
export function redactCredentials(text: string): string {
  let result = text;
  for (const [pattern, replacement] of PATTERNS) {
    result =
      typeof replacement === 'string'
        ? result.replace(pattern, replacement)
        : result.replace(pattern, replacement);
  }
  return result;
}

/**
 * The last `maxChars` characters of `text`, free of credentials. Redaction runs on
 * a slightly larger tail without its partial first line, so the limit cannot split
 * a secret from the key that identifies it. A tail without any line break lies
 * entirely inside one line whose key may have been cut off, so nothing is kept.
 */
export function redactTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return redactCredentials(text);
  const tail = text.slice(-(maxChars + TAIL_MARGIN_CHARS));
  // `\r` alone also ends a line, e.g. in progress output that redraws itself.
  const lineEnd = tail.search(/[\r\n]/);
  if (lineEnd === -1) return '';
  return redactCredentials(tail.slice(lineEnd + 1)).slice(-maxChars);
}

/** Credential-free Git output limited to its last `MAX_OUTPUT_CHARS` characters. */
export function sanitizeGitOutput(...parts: string[]): string | null {
  const text = parts
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .join('\n');
  if (text === '') return null;
  const tail = redactTail(text, MAX_OUTPUT_CHARS);
  return text.length > MAX_OUTPUT_CHARS ? `…${tail}` : tail;
}
