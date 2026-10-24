import { z } from 'zod';

// ---------------------------------------------------------------------------
// Preflight: local validation (SDD-007 Milestone A, PLAN-028)
// ---------------------------------------------------------------------------

export const PREFLIGHT_CHECK_TYPES = ['COMMAND', 'PACKAGE_SCRIPT', 'GITHUB_ACTIONS'] as const;
export type PreflightCheckType = (typeof PREFLIGHT_CHECK_TYPES)[number];

/** What a check validates (FR-702). Only a label: no command is implied by a category. */
export const PREFLIGHT_CHECK_CATEGORIES = [
  'LINT',
  'TYPECHECK',
  'UNIT_TEST',
  'INTEGRATION_TEST',
  'E2E_TEST',
  'BUILD',
  'FORMAT',
  'SECURITY',
  'GIT_DIFF',
  'WORKFLOW',
  'CUSTOM',
] as const;
export type PreflightCheckCategory = (typeof PREFLIGHT_CHECK_CATEGORIES)[number];

/** When a check is meant to run. Milestone A runs checks manually only. */
export const PREFLIGHT_TRIGGERS = [
  'MANUAL',
  'PRE_COMMIT',
  'PRE_PUSH',
  'PRE_MERGE',
  'PRE_DELIVERY',
] as const;
export type PreflightTrigger = (typeof PREFLIGHT_TRIGGERS)[number];

export const PACKAGE_MANAGERS = ['npm', 'pnpm', 'yarn'] as const;
export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

export const PREFLIGHT_MAX_CHECKS = 50;
export const PREFLIGHT_MAX_PROFILES = 20;
export const PREFLIGHT_MAX_CONCURRENCY = 8;

const singleLine = (max: number, empty: string) =>
  z
    .string()
    .trim()
    .min(1, empty)
    .max(max)
    .refine((value) => !/[\0\r\n]/.test(value), 'Use a single line.');

/** Short identifiers chosen by ATLAS; stable across edits. */
export const PreflightItemIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'Invalid identifier.');
export const PreflightWorkspaceIdSchema = z.uuid({ message: 'Invalid workspace identifier.' });
export const PreflightRunIdSchema = z.uuid({ message: 'Invalid run identifier.' });

/**
 * A folder inside the workspace: relative, without `..` segments, so a check can never
 * run outside the folder the user chose. Empty means the workspace itself.
 */
export const RelativeDirectorySchema = z
  .string()
  .trim()
  .max(500)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.startsWith('\\') &&
      !/^[A-Za-z]:/.test(value) &&
      !value.split(/[\\/]/).includes('..') &&
      !/[\0\r\n]/.test(value),
    'Use a folder inside the workspace (a relative path without "..").',
  );

/**
 * Variables given to a check. Values are stored in the database in plain text, so names
 * that look like secrets are refused (secrets are not supported in Milestone A).
 */
export const PreflightEnvSchema = z
  .record(
    z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/, 'Use letters, digits and underscores.')
      .refine(
        (name) => !/token|secret|passw|pwd|credential|private|api_?key|auth/i.test(name),
        'Secrets cannot be stored here.',
      ),
    z
      .string()
      .max(2000)
      .refine((value) => !/[\0\r\n]/.test(value), 'Use a single line.'),
  )
  .refine((value) => Object.keys(value).length <= 50, 'Up to 50 variables.');

/** Local `act` settings of a GitHub Actions check (FR-712). */
export const PreflightActSettingsSchema = z.strictObject({
  /** Event `act` simulates; the workflow must be triggered by it. */
  event: z.enum(['push', 'pull_request', 'workflow_dispatch']),
  /** `--matrix key:value` filters, e.g. `os:ubuntu-24.04`. */
  matrix: z
    .array(
      z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9_.-]{1,64}:[^\s]{1,200}$/, 'Use key:value.'),
    )
    .max(10),
  /** `-P label=image` runner image mapping, e.g. `ubuntu-24.04=catthehacker/ubuntu:act-24.04`. */
  platforms: z
    .array(
      z.strictObject({
        label: z
          .string()
          .trim()
          .regex(/^[A-Za-z0-9_.-]{1,64}$/, 'Invalid runner label.'),
        image: z
          .string()
          .trim()
          .regex(/^[A-Za-z0-9][A-Za-z0-9_.:/@-]{0,254}$/, 'Invalid image name.'),
      }),
    )
    .max(10),
  /** `--container-architecture`, e.g. `linux/amd64` on Apple silicon. */
  containerArchitecture: z.enum(['linux/amd64', 'linux/arm64']).nullable(),
  /** Docker resource limits of the job containers; null leaves Docker's defaults. */
  cpus: z.number().min(0.5).max(64).nullable(),
  memoryMb: z.number().int().min(256).max(262144).nullable(),
});
export type PreflightActSettings = z.infer<typeof PreflightActSettingsSchema>;

export const DEFAULT_ACT_SETTINGS: PreflightActSettings = {
  event: 'push',
  matrix: [],
  platforms: [],
  containerArchitecture: null,
  cpus: null,
  memoryMb: null,
};

export const PreflightCheckSchema = z
  .strictObject({
    id: PreflightItemIdSchema,
    name: singleLine(80, 'Enter a name.'),
    type: z.enum(PREFLIGHT_CHECK_TYPES),
    category: z.enum(PREFLIGHT_CHECK_CATEGORIES),
    workingDirectory: RelativeDirectorySchema,
    /** COMMAND: run by the user's shell, exactly as typed in a terminal. */
    command: singleLine(2000, 'Enter a command.').nullable(),
    /** PACKAGE_SCRIPT: `<manager> run <script>`; the script name is quoted, never interpolated. */
    packageManager: z.enum(PACKAGE_MANAGERS).nullable(),
    script: singleLine(200, 'Choose a script.').nullable(),
    /** GITHUB_ACTIONS: workflow file relative to the workspace and, optionally, one job. */
    workflowPath: z
      .string()
      .regex(
        /^\.github\/workflows\/[A-Za-z0-9_.-]{1,200}\.ya?ml$/,
        'Choose a workflow in .github/workflows.',
      )
      .nullable(),
    workflowJob: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_-]{0,99}$/, 'Invalid job identifier.')
      .nullable(),
    act: PreflightActSettingsSchema.nullable(),
    required: z.boolean(),
    enabled: z.boolean(),
    timeoutSeconds: z.number().int().min(5).max(21600),
    executionTriggers: z.array(z.enum(PREFLIGHT_TRIGGERS)).max(PREFLIGHT_TRIGGERS.length),
    /** Checks of the same run that must pass first. */
    dependsOn: z.array(PreflightItemIdSchema).max(PREFLIGHT_MAX_CHECKS),
    /** Runs alone, never next to another check (shared state, heavy resources). */
    exclusive: z.boolean(),
    /** Executables that must be found on PATH; the check is BLOCKED otherwise. */
    requiredTools: z
      .array(z.string().regex(/^[A-Za-z0-9_.+-]{1,64}$/, 'Use an executable name, e.g. docker.'))
      .max(10),
    env: PreflightEnvSchema,
  })
  .superRefine((check, context) => {
    const issue = (path: string, message: string) =>
      context.addIssue({ code: 'custom', path: [path], message });
    if (check.type === 'COMMAND' && check.command === null) issue('command', 'Enter a command.');
    if (check.type === 'PACKAGE_SCRIPT') {
      if (check.packageManager === null) issue('packageManager', 'Choose a package manager.');
      if (check.script === null) issue('script', 'Choose a script.');
    }
    if (check.type === 'GITHUB_ACTIONS') {
      if (check.workflowPath === null) issue('workflowPath', 'Choose a workflow.');
      if (check.act === null) issue('act', 'Local runner settings are missing.');
    }
    if (check.dependsOn.includes(check.id)) issue('dependsOn', 'A check cannot depend on itself.');
  });
export type PreflightCheck = z.infer<typeof PreflightCheckSchema>;

export const PreflightProfileSchema = z.strictObject({
  id: PreflightItemIdSchema,
  name: singleLine(60, 'Enter a name.'),
  /** Checks in execution order (dependencies still run first). */
  checkIds: z.array(PreflightItemIdSchema).max(PREFLIGHT_MAX_CHECKS),
  concurrency: z.number().int().min(1).max(PREFLIGHT_MAX_CONCURRENCY),
});
export type PreflightProfile = z.infer<typeof PreflightProfileSchema>;

export const PreflightConfigSchema = z
  .strictObject({
    checks: z.array(PreflightCheckSchema).max(PREFLIGHT_MAX_CHECKS, 'Up to 50 checks.'),
    profiles: z.array(PreflightProfileSchema).max(PREFLIGHT_MAX_PROFILES, 'Up to 20 profiles.'),
  })
  .superRefine((config, context) => {
    const ids = new Set<string>();
    config.checks.forEach((check, index) => {
      if (ids.has(check.id)) {
        context.addIssue({ code: 'custom', path: ['checks', index, 'id'], message: 'Duplicate.' });
      }
      ids.add(check.id);
    });
    config.checks.forEach((check, index) => {
      for (const dependency of check.dependsOn) {
        if (!ids.has(dependency)) {
          context.addIssue({
            code: 'custom',
            path: ['checks', index, 'dependsOn'],
            message: 'Depends on a check that does not exist.',
          });
        }
      }
    });
    if (hasDependencyCycle(config.checks)) {
      context.addIssue({
        code: 'custom',
        path: ['checks'],
        message: 'Check dependencies form a cycle.',
      });
    }
    const profileIds = new Set<string>();
    config.profiles.forEach((profile, index) => {
      if (profileIds.has(profile.id)) {
        context.addIssue({
          code: 'custom',
          path: ['profiles', index, 'id'],
          message: 'Duplicate.',
        });
      }
      profileIds.add(profile.id);
      if (profile.checkIds.some((id) => !ids.has(id))) {
        context.addIssue({
          code: 'custom',
          path: ['profiles', index, 'checkIds'],
          message: 'The profile lists a check that does not exist.',
        });
      }
    });
  });
export type PreflightConfig = z.infer<typeof PreflightConfigSchema>;

export const EMPTY_PREFLIGHT_CONFIG: PreflightConfig = { checks: [], profiles: [] };

/** True when following `dependsOn` from some check leads back to it. */
export function hasDependencyCycle(
  checks: readonly { id: string; dependsOn: readonly string[] }[],
): boolean {
  const byId = new Map(checks.map((check) => [check.id, check]));
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (id: string): boolean => {
    const current = state.get(id);
    if (current === 'visiting') return true;
    if (current === 'done') return false;
    state.set(id, 'visiting');
    for (const dependency of byId.get(id)?.dependsOn ?? []) {
      if (byId.has(dependency) && visit(dependency)) return true;
    }
    state.set(id, 'done');
    return false;
  };
  return checks.some((check) => visit(check.id));
}

/**
 * A folder Preflight validates: a registered project's folder or a folder the user chose
 * in the native picker. Requests name workspaces by id, never by path.
 */
export interface PreflightWorkspace {
  id: string;
  path: string;
  projectId: string | null;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface PreflightWorkspaceDetails {
  workspace: PreflightWorkspace;
  config: PreflightConfig;
  /** Stored configuration exists but cannot be read; it is replaced on the next save. */
  configInvalid: boolean;
}

// ---------------------------------------------------------------------------
// Discovery (FR-703, FR-706, FR-709, FR-710). Nothing is executed.
// ---------------------------------------------------------------------------

export const WORKFLOW_COMPATIBILITY = [
  'COMPATIBLE',
  'PARTIALLY_COMPATIBLE',
  'UNSUPPORTED',
  'UNKNOWN',
] as const;
export type WorkflowCompatibility = (typeof WORKFLOW_COMPATIBILITY)[number];

export interface DiscoveredScript {
  name: string;
  /** The script body as written in package.json (shown, never run by discovery). */
  body: string;
  category: PreflightCheckCategory;
}

export interface DiscoveredCommand {
  name: string;
  command: string;
  category: PreflightCheckCategory;
  /** Where the suggestion comes from, e.g. `Makefile` or `gradlew`. */
  source: string;
}

export interface WorkflowJobSummary {
  id: string;
  name: string;
  runsOn: string[];
  needs: string[];
  /** Reusable workflow called by the job (`jobs.<id>.uses`). */
  uses: string | null;
  hasMatrix: boolean;
  services: string[];
  container: string | null;
  environment: string | null;
  /** `uses:` of the steps: actions downloaded and run by the runner. */
  actions: string[];
  /** `secrets.<NAME>` references (names only). */
  secrets: string[];
  compatibility: WorkflowCompatibility;
  /** Evidence for the classification, one line each. */
  compatibilityReasons: string[];
  /** Steps that may change something outside the computer; empty when none was found. */
  dangerReasons: string[];
}

export interface WorkflowSummary {
  path: string;
  name: string;
  triggers: string[];
  jobs: WorkflowJobSummary[];
  compatibility: WorkflowCompatibility;
  /** The file could not be read as a workflow; `jobs` is empty. */
  parseError: string | null;
}

export interface PreflightDiscovery {
  packageManager: PackageManager | null;
  scripts: DiscoveredScript[];
  commands: DiscoveredCommand[];
  workflows: WorkflowSummary[];
}

export interface PreflightToolStatus {
  available: boolean;
  /** Version or short reason it is unavailable. */
  detail: string;
}

/** Local tools of the GitHub Actions backend (FR-707). Never installed by ATLAS. */
export interface PreflightEnvironmentStatus {
  act: PreflightToolStatus;
  docker: PreflightToolStatus;
  checkedAt: string;
}

// ---------------------------------------------------------------------------
// Execution (FR-713 – FR-717)
// ---------------------------------------------------------------------------

export const PREFLIGHT_CHECK_STATUSES = [
  'PENDING',
  'RUNNING',
  'PASSED',
  'FAILED',
  'SKIPPED',
  'BLOCKED',
  'UNSUPPORTED',
  'CANCELLED',
  'TIMED_OUT',
] as const;
export type PreflightCheckStatus = (typeof PREFLIGHT_CHECK_STATUSES)[number];

/**
 * A run's state. `PASSED`: every check ran and passed. `FAILED`: a check failed or timed
 * out. `INCOMPLETE`: no failure, but some check did not run to a verdict (blocked,
 * unsupported, skipped). `CANCELLED`: stopped by the user or by an Engine restart.
 */
export const PREFLIGHT_RUN_STATUSES = [
  'RUNNING',
  'PASSED',
  'FAILED',
  'INCOMPLETE',
  'CANCELLED',
] as const;
export type PreflightRunStatus = (typeof PREFLIGHT_RUN_STATUSES)[number];

/** The same verdict restricted to required checks; `NONE` when the run has none. */
export type PreflightRequiredOutcome = 'PASSED' | 'FAILED' | 'INCOMPLETE' | 'NONE';

/** Where a check actually ran (§3.3). Never a GitHub-hosted runner. */
export type PreflightExecutionMethod = 'LOCAL_SHELL' | 'LOCAL_ACT';

export interface PreflightCheckResult {
  position: number;
  checkId: string;
  name: string;
  type: PreflightCheckType;
  category: PreflightCheckCategory;
  required: boolean;
  method: PreflightExecutionMethod;
  /** The command, or `<workflow>#<job>`, credentials redacted. */
  reference: string;
  status: PreflightCheckStatus;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  exitCode: number | null;
  /** Short reason, e.g. "exited with code 1" or "Docker is not running". */
  detail: string | null;
  /** E.g. "Local shell (/bin/zsh)" or "Local act runner (act 0.2.80, Docker 28.1.1)". */
  environment: string;
  /** Digest of the check definition (and workflow or script body) that ran. */
  digest: string;
  outputLines: number;
  /** Earlier output was dropped to keep the log within its limit. */
  outputTruncated: boolean;
}

export interface PreflightRun {
  id: string;
  workspaceId: string;
  projectId: string | null;
  workspacePath: string;
  profileId: string | null;
  profileName: string;
  trigger: PreflightTrigger;
  status: PreflightRunStatus;
  requiredOutcome: PreflightRequiredOutcome;
  /** HEAD when the run started; null outside a Git repository or before the first commit. */
  sourceRevision: string | null;
  branch: string | null;
  /** Code state the run started from (HEAD, index, working tree, untracked files). */
  sourceStateFingerprint: string | null;
  /** The code state changed while the run was in progress; results may not match either state. */
  sourceChangedDuringRun: boolean;
  retryOf: string | null;
  startedAt: string;
  finishedAt: string | null;
  results: PreflightCheckResult[];
}

export type PreflightRunSummary = Omit<PreflightRun, 'results'> & {
  counts: Partial<Record<PreflightCheckStatus, number>>;
};

export const PreflightSelectionSchema = z.strictObject({
  workspaceId: PreflightWorkspaceIdSchema,
  /** A profile, or explicit checks (`checkIds`), not both. */
  profileId: PreflightItemIdSchema.nullable(),
  checkIds: z.array(PreflightItemIdSchema).max(PREFLIGHT_MAX_CHECKS).nullable(),
  /** Concurrency for explicit checks; a profile uses its own. */
  concurrency: z.number().int().min(1).max(PREFLIGHT_MAX_CONCURRENCY).optional(),
  retryOf: PreflightRunIdSchema.nullable().optional(),
});
export type PreflightSelection = z.infer<typeof PreflightSelectionSchema>;

/** Why a check needs the user's authorization before it runs (§13). */
export type PreflightAuthorizationReason = 'FIRST_RUN' | 'CHANGED' | 'SIDE_EFFECTS';

export interface PreflightPlannedCheck {
  checkId: string;
  name: string;
  method: PreflightExecutionMethod;
  reference: string;
  digest: string;
  /** Null when the check was authorized before for this exact definition. */
  authorization: PreflightAuthorizationReason | null;
  /** What runs and with which access, shown before authorizing. */
  warnings: string[];
}

export interface PreflightPlan {
  checks: PreflightPlannedCheck[];
  /** Checks of the selection that are disabled and will not run. */
  disabled: string[];
}

export const PreflightStartSchema = PreflightSelectionSchema.extend({
  /** Digests the user authorized in this request (from `preflight.plan`). */
  authorizations: z
    .array(
      z.strictObject({
        checkId: PreflightItemIdSchema,
        digest: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .max(PREFLIGHT_MAX_CHECKS),
});
export type PreflightStartInput = z.infer<typeof PreflightStartSchema>;

export const PreflightOutputQuerySchema = z.strictObject({
  runId: PreflightRunIdSchema,
  position: z.number().int().min(0).max(PREFLIGHT_MAX_CHECKS),
  /** Lines after this sequence number; -1 from the start. */
  after: z.number().int().min(-1),
  limit: z.number().int().min(1).max(5000).optional(),
});
export type PreflightOutputQuery = z.infer<typeof PreflightOutputQuerySchema>;

export interface PreflightOutputLine {
  seq: number;
  stream: 'out' | 'err' | 'atlas';
  text: string;
}

export interface PreflightOutputPage {
  lines: PreflightOutputLine[];
  /** Pass as `after` to continue. */
  next: number;
  /** The check finished and every line was returned. */
  complete: boolean;
  /** Lines before the first returned one were dropped to keep the log within its limit. */
  truncatedBefore: boolean;
}

export const PreflightRunsQuerySchema = z.strictObject({
  workspaceId: PreflightWorkspaceIdSchema,
  limit: z.number().int().min(1).max(100).optional(),
  /** Runs started before this run (paging). */
  before: PreflightRunIdSchema.optional(),
});
export type PreflightRunsQuery = z.infer<typeof PreflightRunsQuerySchema>;
