import type {
  SkillCompatibility,
  SkillIssue,
  SkillScope,
  SkillSourceKind,
  SkillSyncAction,
} from '@atlas/contracts';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export const PROVIDER_NAMES = { claude: 'Claude Code', codex: 'Codex' } as const;

export const SOURCE_LABELS: Record<SkillSourceKind, string> = {
  claude: 'Claude Code folder',
  codex: 'Codex folder',
  path: 'Local folder',
  template: 'ATLAS template',
  atlas: 'Created in ATLAS',
};

export const SCOPE_LABELS: Record<SkillScope, string> = {
  project: 'Project',
  provider: 'Provider',
  role: 'Role',
  session: 'Session',
};

export const SYNC_ACTION_LABELS: Record<SkillSyncAction, string> = {
  create: 'Add',
  update: 'Update',
  remove: 'Remove',
  unchanged: 'Up to date',
  conflict: 'Conflict',
  skip: 'Skipped',
};

const COMPAT_TONES: Record<SkillCompatibility['status'], string> = {
  compatible: 'bg-success/15 text-success',
  partial: 'bg-warning/15 text-warning',
  incompatible: 'bg-destructive/15 text-destructive',
};

const COMPAT_LABELS: Record<SkillCompatibility['status'], string> = {
  compatible: 'compatible',
  partial: 'partial',
  incompatible: 'incompatible',
};

export function Badge({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium', className)}>
      {children}
    </span>
  );
}

/** Provider compatibility as short badges, e.g. "Claude Code: partial". */
export function CompatibilityBadges({ items }: { items: SkillCompatibility[] }) {
  return (
    <span className="flex flex-wrap gap-1">
      {items.map((item) => (
        <Badge key={item.provider} className={COMPAT_TONES[item.status]}>
          {PROVIDER_NAMES[item.provider]}: {COMPAT_LABELS[item.status]}
        </Badge>
      ))}
    </span>
  );
}

const ISSUE_TONES: Record<SkillIssue['level'], string> = {
  error: 'text-destructive',
  warning: 'text-warning',
  info: 'text-muted-foreground',
};

export function IssueList({ issues, testId }: { issues: SkillIssue[]; testId?: string }) {
  if (issues.length === 0) return null;
  return (
    <ul className="flex flex-col gap-0.5 text-xs" data-testid={testId}>
      {issues.map((issue, index) => (
        <li
          key={`${issue.code}:${index}`}
          className={ISSUE_TONES[issue.level]}
          data-level={issue.level}
        >
          {issue.level === 'error' ? 'Error: ' : issue.level === 'warning' ? 'Warning: ' : ''}
          {issue.message}
        </li>
      ))}
    </ul>
  );
}

export const formatBytes = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
