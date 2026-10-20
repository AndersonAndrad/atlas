import type {
  AiSession,
  ContextCategory,
  ContextTarget,
  ContextVerification,
} from '@atlas/contracts';

export const CATEGORY_LABELS: Record<ContextCategory, string> = {
  overview: 'Overview',
  architecture: 'Architecture',
  convention: 'Convention',
  command: 'Command',
  objective: 'Objective',
  progress: 'Progress',
  'files-changed': 'Files changed',
  commit: 'Commits',
  'test-result': 'Test result',
  'known-failure': 'Known failure',
  blocker: 'Blocker',
  'pending-decision': 'Pending decision',
  'next-action': 'Next action',
  'provider-reference': 'Provider reference',
  summary: 'Session summary',
  note: 'Note',
};

export const VERIFICATION_LABELS: Record<ContextVerification, string> = {
  verified: 'Verified',
  user: 'By you',
  observed: 'Unverified',
};

export const VERIFICATION_TONES: Record<ContextVerification, string> = {
  verified: 'bg-success/15 text-success',
  user: 'bg-sky-500/15 text-sky-300',
  observed: 'bg-warning/15 text-warning',
};

export const PROVIDER_LABELS: Record<AiSession['provider'], string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  external: 'Terminal',
};

/** One item per non-empty line, for list fields edited as text. */
export function toLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

export function targetKey(target: ContextTarget | null): string | null {
  if (target === null) return null;
  return 'projectId' in target
    ? `project:${target.projectId}`
    : `workspace:${target.workspacePath}`;
}

export function formatDateTime(value: string | null): string {
  if (value === null) return '—';
  return new Date(value).toLocaleString();
}
