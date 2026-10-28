import {
  TEAM_ROLE_LABELS,
  TEAM_ROLE_ORDER,
  TEAM_STAGES_MAX,
  type AiProvider,
  type ContextTask,
  type DecisionRecord,
  type TaskAssessment,
  type TaskComplexity,
  type TaskDiscipline,
  type TeamProfileOption,
  type TeamProviderOption,
  type TeamRole,
  type TeamExecution,
  type TeamStage,
  type TeamStageProposal,
} from '@atlas/contracts';

// Deterministic, explainable planning for "Execute with ATLAS" (SDD-026 Task 02, PLAN-055
// Q3): no provider is called, so a proposal costs nothing and always says why.

const DISCIPLINE_TERMS: Record<TaskDiscipline, RegExp> = {
  architecture:
    /\b(architecture|architectural|refactor\w*|redesign|restructur\w*|modulari[sz]\w*|across|cross-cutting|integration|breaking change|migrat\w+ to)\b/i,
  backend:
    /\b(api|endpoint\w*|server|backend|back-end|database|migration\w*|sql|schema|service\w*|repositor(y|ies)|queue|job\w*|engine|ipc|webhook\w*)\b/i,
  frontend:
    /\b(ui|ux|frontend|front-end|component\w*|page\w*|screen\w*|dialog\w*|button\w*|form\w*|css|layout|responsive|react|view\w*|modal\w*|menu\w*)\b/i,
  security:
    /\b(auth\w*|token\w*|jwt|password\w*|secret\w*|credential\w*|permission\w*|oauth|csrf|xss|injection|encrypt\w*|vulnerab\w*|security|sanitiz\w*|role-based|rbac)\b/i,
  testing: /\b(test\w*|coverage|e2e|regression\w*|flaky|qa)\b/i,
  documentation: /\b(doc|docs|documentation|readme|changelog|guide|swagger|openapi)\b/i,
};

const FILE_DISCIPLINES: [RegExp, TaskDiscipline][] = [
  [/\.(tsx|jsx|vue|svelte|css|scss|html)$/i, 'frontend'],
  [/\.(sql|go|py|java|rb|rs|cs|php)$/i, 'backend'],
  [/(^|\/)(migrations?|api|server|routes?)\//i, 'backend'],
  [/(^|\/)(components?|pages?|views?|renderer)\//i, 'frontend'],
  [/(^|\/)(tests?|__tests__|e2e)\/|\.(test|spec)\.[a-z]+$/i, 'testing'],
  [/\.md$/i, 'documentation'],
];

/** Path-like tokens of the objective, e.g. `src/auth/jwt.ts`. */
const PATH_TOKEN = /(?:^|[\s`'"(])((?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]{1,8})(?=$|[\s`'"),.:;])/g;

export function filesInText(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(PATH_TOKEN)) {
    const file = match[1]!.replace(/^\.\//, '');
    if (!file.startsWith('/') && !file.split('/').includes('..')) found.add(file);
  }
  return [...found];
}

/** Bullet, numbered or "Given/When/Then" lines of the objective. */
export function criteriaLines(objective: string): string[] {
  return objective
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^([-*•]|\d+[.)]|\[[ x]\]|given\b|when\b|then\b)/i.test(line))
    .map((line) => line.replace(/^([-*•]|\d+[.)]|\[[ x]\])\s*/, '').trim())
    .filter((line) => line !== '')
    .slice(0, 20);
}

export interface AssessmentInput {
  task: Pick<ContextTask, 'title' | 'objective'>;
  /** Files referenced by the task's context entries. */
  contextFiles: readonly string[];
  /** Active decisions of the owner and the task. */
  decisions: readonly DecisionRecord[];
}

/** Evaluates a task from its text, files and decisions (FR-002); no repository audit. */
export function assessTask(input: AssessmentInput): TaskAssessment {
  const text = `${input.task.title}\n${input.task.objective}`;
  const files = [...new Set([...filesInText(text), ...input.contextFiles])].slice(0, 50);
  const disciplines = new Map<TaskDiscipline, string>();
  for (const [discipline, pattern] of Object.entries(DISCIPLINE_TERMS) as [
    TaskDiscipline,
    RegExp,
  ][]) {
    const match = pattern.exec(text);
    if (match) disciplines.set(discipline, `The task mentions “${match[0]}”.`);
  }
  for (const file of files) {
    for (const [pattern, discipline] of FILE_DISCIPLINES) {
      if (pattern.test(file) && !disciplines.has(discipline)) {
        disciplines.set(discipline, `It concerns ${file}.`);
      }
    }
  }
  const directories = new Set(files.map((file) => file.split('/')[0]));
  if (directories.size >= 3 && !disciplines.has('architecture')) {
    disciplines.set('architecture', `It spans ${directories.size} top-level folders.`);
  }

  const criteria = criteriaLines(input.task.objective);
  const reasons: string[] = [];
  let score = 0;
  const implementation = ['backend', 'frontend'].filter((item) =>
    disciplines.has(item as TaskDiscipline),
  );
  if (implementation.length === 2) {
    score += 2;
    reasons.push('Both backend and frontend work are involved.');
  } else if (implementation.length === 1) {
    score += 1;
  }
  if (disciplines.has('architecture')) {
    score += 1;
    reasons.push('It touches structure or several modules.');
  }
  if (disciplines.has('security')) {
    score += 1;
    reasons.push('It has a potential security impact.');
  }
  if (files.length >= 5) {
    score += 1;
    reasons.push(`${files.length} files are named.`);
  }
  if (criteria.length >= 4) {
    score += 1;
    reasons.push(`${criteria.length} acceptance criteria are listed.`);
  }
  if (input.task.objective.length > 800) {
    score += 1;
    reasons.push('The objective is long and detailed.');
  }
  const complexity: TaskComplexity = score <= 1 ? 'simple' : score <= 3 ? 'moderate' : 'complex';
  if (reasons.length === 0) reasons.push('A focused change with no cross-cutting signals.');

  return {
    complexity,
    reasons,
    disciplines: [...disciplines].map(([discipline, evidence]) => ({ discipline, evidence })),
    files,
    acceptanceCriteria: criteria,
    decisions: input.decisions
      .filter((decision) => decision.status === 'ACTIVE')
      .slice(0, 10)
      .map((decision) => ({
        id: decision.id,
        question: decision.question,
        decision: decision.decision,
      })),
  };
}

const RESPONSIBILITIES: Record<TeamRole, { responsibility: string; deliverables: string[] }> = {
  architect: {
    responsibility:
      'Plans the change: modules, contracts and risks, recorded as decisions before code changes.',
    deliverables: ['Implementation approach', 'Recorded decisions and constraints'],
  },
  backend: {
    responsibility: 'Implements the server, data and integration side of the task.',
    deliverables: ['Backend changes', 'Unit tests for them'],
  },
  frontend: {
    responsibility: 'Implements the user interface side of the task.',
    deliverables: ['UI changes', 'Tests for the changed screens'],
  },
  executor: {
    responsibility: 'Implements the whole task.',
    deliverables: ['Code changes', 'Tests for them'],
  },
  security: {
    responsibility: 'Reviews the changes for security issues and fixes or reports what it finds.',
    deliverables: ['Security review notes', 'Fixes for confirmed issues'],
  },
  qa: {
    responsibility: 'Checks the acceptance criteria and adds or completes the tests.',
    deliverables: ['Test results', 'Missing tests', 'Open issues'],
  },
  docs: {
    responsibility: 'Updates the documentation of the changed behavior.',
    deliverables: ['Documentation updates'],
  },
};

/** The smallest team that covers the assessment (FR-003), in stage order. */
export function recommendRoles(assessment: TaskAssessment): { role: TeamRole; reason: string }[] {
  const has = (discipline: TaskDiscipline) =>
    assessment.disciplines.find((item) => item.discipline === discipline)?.evidence ?? null;
  const roles: { role: TeamRole; reason: string }[] = [];
  const onlyDocs =
    assessment.disciplines.length === 1 &&
    assessment.disciplines[0]!.discipline === 'documentation';

  if (assessment.complexity === 'simple') {
    roles.push(
      onlyDocs
        ? { role: 'docs', reason: 'A documentation-only task: one specialist is enough.' }
        : { role: 'executor', reason: 'A simple task: one engineer is enough.' },
    );
    return roles;
  }
  const architecture = has('architecture');
  if (assessment.complexity === 'complex' || architecture) {
    roles.push({
      role: 'architect',
      reason: architecture
        ? `Structural impact. ${architecture}`
        : 'A complex task benefits from a plan before code changes.',
    });
  }
  const backend = has('backend');
  const frontend = has('frontend');
  if (backend && frontend) {
    roles.push({ role: 'backend', reason: backend });
    roles.push({ role: 'frontend', reason: frontend });
  } else {
    roles.push({
      role: 'executor',
      reason: backend ?? frontend ?? 'One engineer implements the change.',
    });
  }
  const security = has('security');
  if (security) roles.push({ role: 'security', reason: `Potential security impact. ${security}` });
  const testing = has('testing');
  if (testing || assessment.complexity === 'complex') {
    roles.push({
      role: 'qa',
      reason: testing ?? 'A complex change needs its acceptance criteria verified.',
    });
  }
  const documentation = has('documentation');
  if (documentation) roles.push({ role: 'docs', reason: documentation });
  return roles
    .sort((a, b) => TEAM_ROLE_ORDER.indexOf(a.role) - TEAM_ROLE_ORDER.indexOf(b.role))
    .slice(0, TEAM_STAGES_MAX);
}

const PROVIDER_NAMES: Record<AiProvider, string> = { claude: 'Claude Code', codex: 'Codex' };

/**
 * A provider and account for a role (FR-004): the preferred provider when installed,
 * else another one with an explanation; the visible account with the lowest known use,
 * skipping limited ones. Remaining capacity is never invented: unknown use stays unknown.
 */
export function allocateProvider(
  providers: readonly TeamProviderOption[],
  profiles: readonly TeamProfileOption[],
  preferred: AiProvider = 'claude',
): Pick<TeamStageProposal, 'provider' | 'profileId' | 'substitution'> {
  const installed = providers.filter((option) => option.availability !== 'missing');
  const choice = installed.find((option) => option.provider === preferred) ?? installed[0] ?? null;
  if (choice === null) return { provider: null, profileId: null, substitution: null };
  const candidates = profiles
    .filter((profile) => profile.provider === choice.provider && !profile.limited)
    .sort((a, b) => (a.usedPercent ?? 101) - (b.usedPercent ?? 101));
  const known = candidates.find((profile) => profile.usedPercent !== null);
  return {
    provider: choice.provider,
    profileId: known?.id ?? null,
    substitution:
      choice.provider === preferred
        ? null
        : `${PROVIDER_NAMES[preferred]} is not available; ${PROVIDER_NAMES[choice.provider]} is proposed instead.`,
  };
}

export function proposeStages(
  assessment: TaskAssessment,
  providers: readonly TeamProviderOption[],
  profiles: readonly TeamProfileOption[],
): TeamStageProposal[] {
  return recommendRoles(assessment).map(({ role, reason }) => ({
    role,
    reason,
    ...RESPONSIBILITIES[role],
    ...allocateProvider(providers, profiles),
  }));
}

export function teamRisks(
  assessment: TaskAssessment,
  stages: readonly TeamStageProposal[],
  providers: readonly TeamProviderOption[],
): string[] {
  const risks: string[] = [];
  if (stages.some((stage) => stage.provider === null)) {
    risks.push('No AI provider is installed: install Claude Code or Codex to run the team.');
  }
  if (stages.length > 1) {
    risks.push(
      'Members work one after another in their own terminal, each starting from what Git shows the previous ones changed.',
    );
  }
  if (assessment.disciplines.some((item) => item.discipline === 'security')) {
    risks.push('Security-sensitive change: review the result carefully before merging.');
  }
  if (
    providers.some(
      (option) => option.availability !== 'wrapped' && option.availability !== 'missing',
    )
  ) {
    risks.push(
      'A provider runs without the ATLAS wrapper: ATLAS cannot tell when its stage ends and will ask you.',
    );
  }
  if (assessment.acceptanceCriteria.length === 0) {
    risks.push('The task lists no acceptance criteria; the team relies on its objective.');
  }
  return risks;
}

/** Characters available for a stage's objective (ExecuteTaskSchema's limit). */
export const STAGE_OBJECTIVE_MAX = 4000;

export interface StageObjectiveInput {
  task: Pick<ContextTask, 'title' | 'objective'>;
  stages: readonly Pick<TeamStage, 'role'>[];
  index: number;
  /** Earlier stages that ended, with what Git shows they changed. */
  previous: readonly Pick<TeamStage, 'role' | 'status' | 'changedFiles' | 'commits'>[];
}

/**
 * The objective a stage receives (FR-008): its role and responsibility, its place in the
 * team, and a handoff of what the earlier stages changed. The task's own context reaches
 * it through the usual bundle; nothing else of the project is repeated here.
 */
export function stageObjective(input: StageObjectiveInput): string {
  const role = input.stages[input.index]!.role;
  const team = input.stages.map((stage) => TEAM_ROLE_LABELS[stage.role]).join(' → ');
  const lines = [
    `You are the ${TEAM_ROLE_LABELS[role]} of an ATLAS team (stage ${input.index + 1} of ${input.stages.length}: ${team}).`,
    `Your responsibility: ${RESPONSIBILITIES[role].responsibility}`,
    `Deliver: ${RESPONSIBILITIES[role].deliverables.join('; ')}.`,
    'Do only your part; later members handle theirs. Exit the CLI when you are done.',
    '',
    `Task: ${input.task.title}`,
    input.task.objective,
  ];
  if (input.previous.length > 0) {
    lines.push('', 'Handoff from the earlier members (from Git):');
    for (const stage of input.previous) {
      const files = stage.changedFiles.slice(0, 15);
      lines.push(
        `- ${TEAM_ROLE_LABELS[stage.role]}: ${stage.status.toLowerCase()}` +
          (stage.commits.length > 0
            ? `; commits: ${stage.commits
                .slice(0, 5)
                .map((commit) => `${commit.hash.slice(0, 8)} ${commit.subject}`)
                .join(' | ')}`
            : '') +
          (files.length > 0
            ? `; changed: ${files.join(', ')}${stage.changedFiles.length > files.length ? ', …' : ''}`
            : '; no file changes'),
      );
    }
  }
  const text = lines.join('\n');
  return text.length <= STAGE_OBJECTIVE_MAX ? text : `${text.slice(0, STAGE_OBJECTIVE_MAX - 1)}…`;
}

/** Storage of ATLAS team executions (SQLite in the Engine). */
export interface TeamExecutionStore {
  insert(execution: TeamExecution): Promise<void>;
  /** Status, plan progress and summary; the owner follows its project elsewhere. */
  update(execution: TeamExecution): Promise<void>;
  get(id: string): Promise<TeamExecution | null>;
  findByRequestId(requestId: string): Promise<TeamExecution | null>;
  /** Newest first. */
  listForTask(taskId: string, limit: number): Promise<TeamExecution[]>;
  /** RUNNING, PAUSED and CHECKING, oldest first. */
  listActive(): Promise<TeamExecution[]>;
}
