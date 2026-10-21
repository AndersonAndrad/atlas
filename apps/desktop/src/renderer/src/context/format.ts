import type {
  AgentRole,
  AiSession,
  BundleSection,
  ContextCategory,
  ExclusionReason,
  ContextTarget,
  ContextVerification,
} from '@atlas/contracts';

export const CATEGORY_LABELS: Record<ContextCategory, string> = {
  overview: 'Overview',
  architecture: 'Architecture',
  convention: 'Convention',
  constraint: 'Constraint',
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
  checkpoint: 'Checkpoint (LLM)',
  note: 'Note',
};

export const SECTION_LABELS: Record<BundleSection, string> = {
  constraints: 'Constraints',
  decisions: 'Active decisions',
  'relevant-files': 'Relevant files',
  'task-state': 'Current task state',
  validations: 'Validations',
  blockers: 'Blockers and known failures',
  knowledge: 'Project knowledge',
  history: 'History and notes',
  global: 'Shared conventions (global)',
};

export const EXCLUSION_LABELS: Record<ExclusionReason, string> = {
  budget: 'Did not fit the budget',
  user: 'Excluded by you',
  duplicate: 'Duplicate of an included record',
  compacted: 'Older session summary',
  'not-relevant': 'No match with the objective',
  progressive: 'Available on request',
};

export const ROLE_LABELS: Record<AgentRole, string> = {
  generic: 'Ordinary session',
  architect: 'Architect',
  developer: 'Developer',
  qa: 'QA',
  security: 'Security',
  reviewer: 'Reviewer',
};

/** Budget choices in estimated tokens (500–32,000 are accepted). */
export const BUDGET_OPTIONS = [1000, 2000, 4000, 6000, 8000, 12000, 16000, 24000, 32000];

export const formatTokens = (tokens: number) => `~${tokens.toLocaleString('en-US')} tokens`;

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
