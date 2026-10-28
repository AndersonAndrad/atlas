import type {
  AiProvider,
  AuditFindingValidation,
  AuditLocationStatus,
  AuditReadOnlyMode,
  AuditSeverity,
  AuditStatus,
  AuditWorkspaceCheck,
} from '@atlas/contracts';

export const AUDIT_PROVIDER_LABELS: Record<AiProvider, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
};

export const READ_ONLY_LABELS: Record<AuditReadOnlyMode, string> = {
  'tools-restricted': 'Only file reading and search tools; no commands',
  'sandboxed-commands': 'Read-only sandbox; commands may run without network or writes',
};

export const AUDIT_STATUS_LABELS: Record<AuditStatus, string> = {
  QUEUED: 'Queued',
  RUNNING: 'Running',
  COMPLETED: 'Completed',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
  INTERRUPTED: 'Interrupted',
};

export const SEVERITY_CLASSES: Record<AuditSeverity, string> = {
  CRITICAL: 'border-destructive bg-destructive/15 text-destructive',
  HIGH: 'border-destructive/50 text-destructive',
  MEDIUM: 'border-warning/60 text-warning',
  LOW: 'border-border text-foreground',
  INFORMATIONAL: 'border-border text-muted-foreground',
};

/** Never "verified": ATLAS only checks that the evidence exists. */
export const VALIDATION_LABELS: Record<AuditFindingValidation, string> = {
  'evidence-located': 'Evidence located',
  'needs-review': 'Needs manual review',
  invalid: 'Evidence not found',
};

export const LOCATION_LABELS: Record<AuditLocationStatus, string> = {
  located: 'found',
  'line-out-of-range': 'line out of range',
  missing: 'not found',
  'outside-project': 'outside the project',
  ignored: 'ignored',
  'not-a-file': 'not a file',
};

export const WORKSPACE_CHECK_LABELS: Record<AuditWorkspaceCheck, string> = {
  unchanged: 'No project files changed while the audit ran.',
  changed:
    'Project files changed while the audit ran. Review them: ATLAS cannot tell who changed them.',
  unverifiable: 'Not a Git repository: ATLAS could not check whether files changed.',
};
