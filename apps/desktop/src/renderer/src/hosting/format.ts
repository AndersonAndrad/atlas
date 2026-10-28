import type {
  HostingAccessState,
  HostingAccountState,
  HostingAssignment,
  HostingProvider,
  HostingRemoteKind,
} from '@atlas/contracts';

export const PROVIDER_LABELS: Record<HostingProvider, string> = {
  GITHUB: 'GitHub',
  BITBUCKET: 'Bitbucket',
};

export const ACCOUNT_STATE_LABELS: Record<HostingAccountState, string> = {
  UNVERIFIED: 'Not tested',
  CONNECTED: 'Connected',
  NO_CREDENTIAL: 'No token',
  INVALID_CREDENTIALS: 'Token rejected',
  PERMISSION_DENIED: 'Missing permission',
  RATE_LIMITED: 'Rate limited',
  UNREACHABLE: 'Unreachable',
  ERROR: 'Error',
};

/** Badge tone of an account state: good, neutral or a problem to fix. */
export function accountStateTone(state: HostingAccountState): 'ok' | 'muted' | 'problem' {
  if (state === 'CONNECTED') return 'ok';
  if (state === 'UNVERIFIED') return 'muted';
  return 'problem';
}

export const REMOTE_KIND_LABELS: Record<HostingRemoteKind, string> = {
  SUPPORTED: 'Supported',
  UNRESOLVED_ALIAS: 'Unknown SSH alias',
  UNSUPPORTED_HOST: 'Other host',
  INVALID_URL: 'Not a hosted repository',
};

export const ASSIGNMENT_LABELS: Record<HostingAssignment, string> = {
  MANUAL: 'Chosen by you',
  SSH_ALIAS: 'From its SSH alias',
  ONLY_ACCOUNT: 'Only account',
  ACCESS_CHECK: 'Only account with access',
};

export const ACCESS_LABELS: Record<HostingAccessState, string> = {
  UNKNOWN: 'Not checked',
  ACCESSIBLE: 'Accessible',
  NOT_FOUND: 'No access',
  ERROR: 'Check failed',
};

/** What each provider's token needs (PLAN-059 Q3); shown where the token is entered. */
export const TOKEN_HELP: Record<HostingProvider, string> = {
  GITHUB:
    'A fine-grained personal access token with read-only "Pull requests" and "Metadata" for the repositories, or a classic token with the repo scope.',
  BITBUCKET:
    'An Atlassian API token with scopes for Bitbucket: read:user, read:repository and read:pullrequest. App passwords no longer work.',
};

/** Aliases typed as a comma- or space-separated list. */
export function parseAliases(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((alias) => alias.trim())
    .filter((alias) => alias !== '');
}
