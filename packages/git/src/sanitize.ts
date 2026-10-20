const MAX_OUTPUT_CHARS = 8 * 1024;

/**
 * Removes credentials Git may echo: `user:password@` or `token@` in URLs and
 * token-like query parameters. Applied to every URL and command output that
 * leaves the Git service.
 */
export function redactCredentials(text: string): string {
  return text
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, '$1***@')
    .replace(
      /([?&](?:access_token|private_token|token|password|passwd|secret|key|sig|signature)=)[^&\s]+/gi,
      '$1***',
    );
}

/** Credential-free Git output limited to its last `MAX_OUTPUT_CHARS` characters. */
export function sanitizeGitOutput(...parts: string[]): string | null {
  const text = redactCredentials(
    parts
      .map((part) => part.trim())
      .filter((part) => part !== '')
      .join('\n'),
  );
  if (text === '') return null;
  return text.length > MAX_OUTPUT_CHARS ? `…${text.slice(-MAX_OUTPUT_CHARS)}` : text;
}
