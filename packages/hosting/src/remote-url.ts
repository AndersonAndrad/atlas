import {
  HOSTING_PROVIDER_HOSTS,
  type HostingProvider,
  type HostingRemoteKind,
} from '@atlas/contracts';

/** A Git remote URL split into what matters for hosting (FR-001); no network access. */
export interface ParsedRemoteUrl {
  /** `ssh` covers both `git@host:path` and `ssh://` URLs. */
  transport: 'ssh' | 'https';
  /** Lower case; for SSH it may be an alias defined in the SSH configuration. */
  host: string;
  /** The repository path, without leading slash or `.git`. */
  path: string;
}

/** Hosts that are the providers themselves, including their documented SSH alternatives. */
const PROVIDER_HOSTS: Record<string, HostingProvider> = {
  'github.com': 'GITHUB',
  'ssh.github.com': 'GITHUB',
  'www.github.com': 'GITHUB',
  'bitbucket.org': 'BITBUCKET',
  'altssh.bitbucket.org': 'BITBUCKET',
  'www.bitbucket.org': 'BITBUCKET',
};

export function providerOfHost(host: string): HostingProvider | null {
  return PROVIDER_HOSTS[host.toLowerCase()] ?? null;
}

const HOST = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,252})$/;
/** Owners and repositories of both providers: letters, digits, dots, dashes, underscores. */
const SEGMENT = /^[A-Za-z0-9._-]{1,100}$/;

function cleanPath(path: string): string {
  return path
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '');
}

/**
 * Parses `git@host:owner/repo.git`, `ssh://git@host[:port]/owner/repo.git` and
 * `https://[user@]host/owner/repo.git`. Anything else (local paths, file://, git://, http://)
 * is not a hosted remote and returns null.
 */
export function parseRemoteUrl(url: string): ParsedRemoteUrl | null {
  const value = url.trim();
  if (value === '' || value.length > 2048) return null;
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/.exec(value);
  if (scp && !/^[A-Za-z]:[\\/]/.test(value) && !value.includes('://')) {
    const host = scp[1]!.toLowerCase();
    return HOST.test(host) ? { transport: 'ssh', host, path: cleanPath(scp[2]!) } : null;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  const transport =
    parsed.protocol === 'ssh:' ? 'ssh' : parsed.protocol === 'https:' ? 'https' : null;
  const host = parsed.hostname.toLowerCase();
  if (transport === null || !HOST.test(host)) return null;
  let path: string;
  try {
    path = decodeURIComponent(parsed.pathname);
  } catch {
    return null;
  }
  return { transport, host, path: cleanPath(path) };
}

/** The remote URL without user name, password or token, safe to store and show (FR-020). */
export function sanitizeRemoteUrl(url: string): string {
  const value = url.trim().slice(0, 2048);
  if (!value.includes('://')) return value;
  try {
    const parsed = new URL(value);
    if (parsed.password === '' && parsed.username === '') return value;
    // ssh keeps a plain user name (git@): it is not a secret, and the URL works as shown.
    if (parsed.protocol === 'ssh:' && parsed.password === '') return value;
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return value.replace(/\/\/[^@/]*@/, '//');
  }
}

/** `owner/repo` with exactly two valid segments, or null. */
export function repositoryPath(path: string): { owner: string; name: string } | null {
  const segments = path.split('/');
  if (segments.length !== 2) return null;
  const [owner, name] = segments as [string, string];
  if (!SEGMENT.test(owner) || !SEGMENT.test(name) || owner === '.' || owner === '..') return null;
  if (name === '.' || name === '..') return null;
  return { owner, name };
}

/** Lower-case identity of a hosted repository, so the same one is never listed twice. */
export function repositoryKey(provider: HostingProvider, owner: string, name: string): string {
  return `${provider}:${HOSTING_PROVIDER_HOSTS[provider]}/${owner}/${name}`.toLowerCase();
}

export interface RemoteClassification {
  kind: HostingRemoteKind;
  provider: HostingProvider | null;
  /** The alias the remote names, when it is not a provider host. */
  sshAlias: string | null;
  /** The host the remote reaches (after alias resolution), when known. */
  host: string | null;
  owner: string | null;
  name: string | null;
  repositoryKey: string | null;
}

export interface ClassifyContext {
  /** Resolves an SSH alias to its HostName; null when unknown or not resolvable. */
  resolveAlias: (alias: string) => string | null;
  /** The provider of the accounts that declare this alias, when they agree. */
  providerOfAlias: (alias: string) => HostingProvider | null;
}

/**
 * What a remote is (FR-001): a provider repository, an SSH alias ATLAS could not resolve,
 * a host that is neither GitHub nor Bitbucket Cloud, or not a hosted URL at all.
 */
export function classifyRemote(url: string, context: ClassifyContext): RemoteClassification {
  const none = {
    provider: null,
    sshAlias: null,
    host: null,
    owner: null,
    name: null,
    repositoryKey: null,
  };
  const parsed = parseRemoteUrl(url);
  if (parsed === null) return { kind: 'INVALID_URL', ...none };
  const path = repositoryPath(parsed.path);
  let provider = providerOfHost(parsed.host);
  let host: string | null = parsed.host;
  let sshAlias: string | null = null;
  if (provider === null && parsed.transport === 'ssh') {
    sshAlias = parsed.host;
    const resolved = context.resolveAlias(parsed.host);
    host = resolved;
    provider = resolved === null ? null : providerOfHost(resolved);
    // An alias an account declares tells the provider even without an SSH HostName.
    provider ??= context.providerOfAlias(parsed.host);
    if (provider === null) {
      return {
        kind: resolved === null ? 'UNRESOLVED_ALIAS' : 'UNSUPPORTED_HOST',
        ...none,
        sshAlias,
        host: resolved,
      };
    }
  }
  if (provider === null) return { kind: 'UNSUPPORTED_HOST', ...none, host };
  if (path === null) return { kind: 'INVALID_URL', ...none, provider, sshAlias, host };
  return {
    kind: 'SUPPORTED',
    provider,
    sshAlias,
    // Unknown when only an account's alias told the provider.
    host,
    owner: path.owner,
    name: path.name,
    repositoryKey: repositoryKey(provider, path.owner, path.name),
  };
}
