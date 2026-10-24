import type {
  PreflightCheck,
  PreflightCheckCategory,
  PreflightCheckStatus,
  PreflightRunStatus,
  WorkflowCompatibility,
} from '@atlas/contracts';
import { DEFAULT_ACT_SETTINGS } from '@atlas/contracts';

export const CATEGORY_LABELS: Record<PreflightCheckCategory, string> = {
  LINT: 'Lint',
  TYPECHECK: 'Type check',
  UNIT_TEST: 'Unit tests',
  INTEGRATION_TEST: 'Integration tests',
  E2E_TEST: 'End-to-end tests',
  BUILD: 'Build',
  FORMAT: 'Formatting',
  SECURITY: 'Security',
  GIT_DIFF: 'Git diff',
  WORKFLOW: 'GitHub Actions',
  CUSTOM: 'Custom',
};

export const STATUS_LABELS: Record<PreflightCheckStatus, string> = {
  PENDING: 'Pending',
  RUNNING: 'Running',
  PASSED: 'Passed',
  FAILED: 'Failed',
  SKIPPED: 'Skipped',
  BLOCKED: 'Blocked',
  UNSUPPORTED: 'Unsupported',
  CANCELLED: 'Cancelled',
  TIMED_OUT: 'Timed out',
};

export const RUN_STATUS_LABELS: Record<PreflightRunStatus, string> = {
  RUNNING: 'Running',
  PASSED: 'Passed',
  FAILED: 'Failed',
  INCOMPLETE: 'Incomplete',
  CANCELLED: 'Cancelled',
};

export const COMPATIBILITY_LABELS: Record<WorkflowCompatibility, string> = {
  COMPATIBLE: 'Compatible',
  PARTIALLY_COMPATIBLE: 'Partially compatible',
  UNSUPPORTED: 'Unsupported',
  UNKNOWN: 'Unknown',
};

type Tone = 'success' | 'danger' | 'warning' | 'muted' | 'active';

const STATUS_TONES: Record<PreflightCheckStatus | PreflightRunStatus, Tone> = {
  PENDING: 'muted',
  RUNNING: 'active',
  PASSED: 'success',
  FAILED: 'danger',
  TIMED_OUT: 'danger',
  SKIPPED: 'muted',
  BLOCKED: 'warning',
  UNSUPPORTED: 'warning',
  CANCELLED: 'muted',
  INCOMPLETE: 'warning',
};

const TONE_CLASSES: Record<Tone, string> = {
  success: 'text-success',
  danger: 'text-destructive',
  warning: 'text-warning',
  muted: 'text-muted-foreground',
  active: 'text-primary',
};

export function statusClass(status: PreflightCheckStatus | PreflightRunStatus): string {
  return TONE_CLASSES[STATUS_TONES[status]];
}

export function compatibilityClass(value: WorkflowCompatibility): string {
  return TONE_CLASSES[
    value === 'COMPATIBLE' ? 'success' : value === 'UNSUPPORTED' ? 'danger' : 'warning'
  ];
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms} ms`;
  const seconds = Math.round(ms / 100) / 10;
  if (seconds < 60) return `${seconds} s`;
  return `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`;
}

export function formatTime(iso: string | null): string {
  if (iso === null) return '—';
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** A short stable identifier for a new check or profile, unique among `taken`. */
export function newItemId(name: string, taken: readonly string[]): string {
  const base =
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'check';
  let id = base;
  for (let index = 2; taken.includes(id); index += 1) id = `${base}-${index}`;
  return id;
}

/** A new check with safe defaults: enabled, advisory, run manually, 10 minutes. */
export function blankCheck(
  partial: Pick<PreflightCheck, 'id' | 'name' | 'type' | 'category'> & Partial<PreflightCheck>,
): PreflightCheck {
  return {
    workingDirectory: '',
    command: null,
    packageManager: null,
    script: null,
    workflowPath: null,
    workflowJob: null,
    act: partial.type === 'GITHUB_ACTIONS' ? { ...DEFAULT_ACT_SETTINGS } : null,
    required: false,
    enabled: true,
    timeoutSeconds: 600,
    executionTriggers: ['MANUAL'],
    dependsOn: [],
    exclusive: false,
    requiredTools: [],
    env: {},
    ...partial,
  };
}

/** The command a check runs, for lists. */
export function checkSummary(check: PreflightCheck): string {
  switch (check.type) {
    case 'COMMAND':
      return check.command ?? '';
    case 'PACKAGE_SCRIPT':
      return `${check.packageManager ?? 'npm'} run ${check.script ?? ''}`;
    case 'GITHUB_ACTIONS':
      return `${check.workflowPath ?? ''}${check.workflowJob ? ` → ${check.workflowJob}` : ' (all jobs)'}`;
  }
}
