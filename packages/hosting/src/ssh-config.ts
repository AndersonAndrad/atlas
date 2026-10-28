/**
 * Read-only interpretation of an OpenSSH client configuration (FR-001), enough to find the
 * HostName of an alias. Nothing is executed: `ssh -G` is never used, because it runs
 * `Match exec` and other commands of the configuration. `Include` is expanded by the
 * caller, which inlines the included files where the directive appears.
 */

export interface SshAliasResolution {
  /** The HostName that applies to the alias, or null when none or not determinable. */
  hostName: string | null;
  /** A `Match` block or an unsupported token may change the answer; it was not evaluated. */
  uncertain: boolean;
}

/**
 * `*` and `?` wildcards against the whole value, in at most pattern × value steps (no
 * regular expression, so a pathological pattern cannot stall the Engine).
 */
export function globMatch(pattern: string, value: string, ignoreCase = true): boolean {
  const p = ignoreCase ? pattern.toLowerCase() : pattern;
  const v = ignoreCase ? value.toLowerCase() : value;
  let pi = 0;
  let vi = 0;
  let star = -1;
  let resume = 0;
  while (vi < v.length) {
    if (pi < p.length && (p[pi] === '?' || p[pi] === v[vi])) {
      pi++;
      vi++;
    } else if (pi < p.length && p[pi] === '*') {
      star = pi++;
      resume = vi;
    } else if (star !== -1) {
      pi = star + 1;
      vi = ++resume;
    } else {
      return false;
    }
  }
  while (p[pi] === '*') pi++;
  return pi === p.length;
}

/** ssh's rule: any negated match excludes the host; otherwise one positive match is needed. */
function hostMatches(patterns: string[], host: string): boolean {
  let matched = false;
  for (const pattern of patterns) {
    if (pattern.startsWith('!')) {
      if (globMatch(pattern.slice(1), host)) return false;
    } else if (globMatch(pattern, host)) {
      matched = true;
    }
  }
  return matched;
}

/** Splits a line into keyword and arguments; supports `Key=value` and double quotes. */
function tokens(line: string): string[] {
  const result: string[] = [];
  const pattern = /"([^"]*)"|(\S+)/g;
  const normalized = line.replace(/^(\s*\w+)\s*=\s*/, '$1 ');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(normalized)) !== null) result.push(match[1] ?? match[2]!);
  return result;
}

const TOKEN = /%(.)/g;

/**
 * The HostName ssh would use for `alias`. As ssh does, the first value obtained wins, and
 * lines before the first `Host`/`Match` apply to every host. `%h` and `%%` are expanded;
 * any other token makes the answer uncertain.
 */
export function resolveSshAlias(config: string, alias: string): SshAliasResolution {
  let active = true;
  let uncertain = false;
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const [keyword = '', ...args] = tokens(line);
    const key = keyword.toLowerCase();
    if (key === 'host') {
      active = hostMatches(args, alias);
      continue;
    }
    if (key === 'match') {
      // Match conditions (exec, user, canonical…) are not evaluated: skip the block, but
      // tell the caller its answer may differ from ssh's.
      active = false;
      if (args.length !== 1 || args[0]!.toLowerCase() !== 'all') uncertain = true;
      else active = true;
      continue;
    }
    if (!active || key !== 'hostname' || args.length === 0) continue;
    let unsupported = false;
    const value = args[0]!.replace(TOKEN, (_, token: string) => {
      if (token === 'h') return alias;
      if (token === '%') return '%';
      unsupported = true;
      return '';
    });
    if (unsupported) return { hostName: null, uncertain: true };
    return { hostName: value.toLowerCase(), uncertain };
  }
  return { hostName: null, uncertain };
}

/** The `Include` arguments of a line, or null when it is not an Include directive. */
export function includePatterns(line: string): string[] | null {
  const trimmed = line.trim();
  if (trimmed.startsWith('#')) return null;
  const [keyword = '', ...args] = tokens(trimmed);
  return keyword.toLowerCase() === 'include' ? args : null;
}
