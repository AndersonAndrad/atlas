import { z } from 'zod';
import { ProjectIdSchema } from './project.js';

// ---------------------------------------------------------------------------
// Pull Request Center — repositories and hosting accounts (SDD-024 Task 04 Milestone A,
// PLAN-059). Only non-secret metadata crosses these contracts: tokens go from the
// renderer to the main process once, are encrypted there and never come back.
// ---------------------------------------------------------------------------

export const HOSTING_PROVIDERS = ['GITHUB', 'BITBUCKET'] as const;
export type HostingProvider = (typeof HOSTING_PROVIDERS)[number];

/** The public cloud host of each provider; enterprise hosts are not supported yet. */
export const HOSTING_PROVIDER_HOSTS: Record<HostingProvider, string> = {
  GITHUB: 'github.com',
  BITBUCKET: 'bitbucket.org',
};

/** What the last connection test established (FR-003). */
export const HOSTING_ACCOUNT_STATES = [
  'UNVERIFIED',
  'CONNECTED',
  'NO_CREDENTIAL',
  'INVALID_CREDENTIALS',
  'PERMISSION_DENIED',
  'RATE_LIMITED',
  'UNREACHABLE',
  'ERROR',
] as const;
export type HostingAccountState = (typeof HOSTING_ACCOUNT_STATES)[number];

export interface HostingAccount {
  id: string;
  provider: HostingProvider;
  /** The user's name for the account, e.g. "Work". */
  label: string;
  /** Bitbucket: the Atlassian account email used with the API token. Null for GitHub. */
  email: string | null;
  /** The provider's login, known after a successful test. */
  login: string | null;
  displayName: string | null;
  /** SSH host aliases that reach this account, e.g. "github-work" (FR-002). */
  sshAliases: string[];
  /** A token is stored for the account; it is never sent to the renderer. */
  hasCredential: boolean;
  state: HostingAccountState;
  /** Short and safe to show; never contains a token. */
  stateMessage: string | null;
  checkedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export const HOSTING_ACCOUNT_LABEL_MAX = 60;
export const HOSTING_ACCOUNT_ALIASES_MAX = 20;
/** Long enough for every token format the providers issue today. */
export const HOSTING_TOKEN_MAX = 1024;

/** An SSH `Host` alias: the characters ssh accepts in a host name, without patterns. */
export const SshAliasSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'Use letters, digits, dots, dashes or underscores.');

const LabelSchema = z
  .string()
  .trim()
  .min(1, 'Enter a name for the account.')
  .max(HOSTING_ACCOUNT_LABEL_MAX)
  .refine((value) => !/[\p{Cc}]/u.test(value), 'The name cannot contain control characters.');

const EmailSchema = z
  .string()
  .trim()
  .min(3)
  .max(254)
  .regex(/^[^\s@<>]+@[^\s@<>]+$/, 'Enter the email of your Atlassian account.');

const AliasesSchema = z
  .array(SshAliasSchema)
  .max(HOSTING_ACCOUNT_ALIASES_MAX)
  .refine(
    (aliases) => new Set(aliases.map((alias) => alias.toLowerCase())).size === aliases.length,
    'Each alias can be listed once.',
  );

export const HostingAccountIdSchema = z.uuid({ message: 'Invalid account identifier.' });

export const CreateHostingAccountSchema = z
  .strictObject({
    provider: z.enum(HOSTING_PROVIDERS),
    label: LabelSchema,
    email: EmailSchema.nullable().optional(),
    sshAliases: AliasesSchema.optional(),
  })
  .refine((value) => value.provider !== 'BITBUCKET' || !!value.email, {
    message: 'Bitbucket API tokens are used with the email of your Atlassian account.',
    path: ['email'],
  });
export type CreateHostingAccountInput = z.infer<typeof CreateHostingAccountSchema>;

// Written without defaults: an absent field leaves the value unchanged.
export const UpdateHostingAccountSchema = z.strictObject({
  accountId: HostingAccountIdSchema,
  label: LabelSchema.optional(),
  email: EmailSchema.nullable().optional(),
  sshAliases: AliasesSchema.optional(),
});
export type UpdateHostingAccountInput = z.infer<typeof UpdateHostingAccountSchema>;

export const HostingTokenSchema = z
  .string()
  .min(1, 'Paste the token.')
  .max(HOSTING_TOKEN_MAX)
  .refine((value) => /^[\x21-\x7e]+$/.test(value), 'A token has no spaces or special characters.');

export const SaveHostingCredentialSchema = z.strictObject({
  accountId: HostingAccountIdSchema,
  token: HostingTokenSchema,
});
export type SaveHostingCredentialInput = z.infer<typeof SaveHostingCredentialSchema>;

/** Whether tokens can be stored on this computer (PLAN-059 Q2). */
export interface HostingCredentialStoreStatus {
  available: boolean;
  /** Why not, safe to show; null when available. */
  reason: string | null;
}

/** How a remote was understood (FR-001). */
export const HOSTING_REMOTE_KINDS = [
  'SUPPORTED',
  'UNRESOLVED_ALIAS',
  'UNSUPPORTED_HOST',
  'INVALID_URL',
] as const;
export type HostingRemoteKind = (typeof HOSTING_REMOTE_KINDS)[number];

/** Why a remote uses its account (FR-004). */
export const HOSTING_ASSIGNMENTS = ['MANUAL', 'SSH_ALIAS', 'ONLY_ACCOUNT', 'ACCESS_CHECK'] as const;
export type HostingAssignment = (typeof HOSTING_ASSIGNMENTS)[number];

export const HOSTING_ACCESS_STATES = ['UNKNOWN', 'ACCESSIBLE', 'NOT_FOUND', 'ERROR'] as const;
export type HostingAccessState = (typeof HOSTING_ACCESS_STATES)[number];

export interface HostingRemote {
  projectId: string;
  projectName: string;
  remoteName: string;
  /** The remote URL without any credentials. */
  remoteUrl: string;
  kind: HostingRemoteKind;
  provider: HostingProvider | null;
  /** The SSH alias the remote uses, when it is not the provider's own host. */
  sshAlias: string | null;
  /** The host the alias resolved to (or the URL's host). */
  host: string | null;
  owner: string | null;
  name: string | null;
  /** Stable identity of the hosted repository, e.g. "GITHUB:owner/repo" (lower case). */
  repositoryKey: string | null;
  accountId: string | null;
  assignment: HostingAssignment | null;
  /** More than one account could be used and none was chosen. */
  ambiguous: boolean;
  /** Access checked with the assigned account, or with every candidate. */
  access: HostingAccessState;
  accessCheckedAt: string | null;
  /** The remote no longer exists in the project; kept until it is dismissed. */
  removed: boolean;
}

export interface HostingRepositoryScan {
  remotes: HostingRemote[];
  /** Projects whose remotes could not be read, with a short reason. */
  skipped: { projectId: string; projectName: string; reason: string }[];
  /** An SSH configuration file was found and read. */
  sshConfigFound: boolean;
  scannedAt: string;
}

export const HostingRemoteRefSchema = z.strictObject({
  projectId: ProjectIdSchema,
  remoteName: z.string().min(1).max(255),
});
export type HostingRemoteRef = z.infer<typeof HostingRemoteRefSchema>;

export const SetHostingRemoteAccountSchema = HostingRemoteRefSchema.extend({
  /** Null returns the remote to automatic assignment. */
  accountId: HostingAccountIdSchema.nullable(),
});
export type SetHostingRemoteAccountInput = z.infer<typeof SetHostingRemoteAccountSchema>;

/** Checks repository access with the candidate accounts (PLAN-059 Q5: explicit only). */
export const CheckHostingAccessSchema = z.strictObject({
  projectId: ProjectIdSchema.optional(),
});
export type CheckHostingAccessInput = z.infer<typeof CheckHostingAccessSchema>;

/** Remotes checked at most per request, so one click never floods a provider. */
export const HOSTING_ACCESS_CHECK_MAX_REMOTES = 50;
