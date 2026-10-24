import type { WorkflowCompatibility, WorkflowJobSummary, WorkflowSummary } from '@atlas/contracts';
import { parse } from 'yaml';
import { actionDangers, commandDangers } from './danger.js';

// GitHub Actions workflows are read as data (FR-706, FR-709, FR-710): nothing in them is
// evaluated or run. The classification only reflects what the file shows; `act` may still
// fail on a COMPATIBLE job, which the UI states.

/** Larger files are not read. */
export const MAX_WORKFLOW_BYTES = 512 * 1024;

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const strings = (value: unknown): string[] => {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  return [];
};

/** Writes that let a job change the repository, packages, deployments or cloud identity. */
const SENSITIVE_PERMISSIONS = [
  'contents',
  'packages',
  'deployments',
  'id-token',
  'actions',
  'pages',
  'pull-requests',
  'issues',
  'releases',
  'security-events',
  'statuses',
  'checks',
] as const;

/** Actions that need GitHub-hosted storage `act` only emulates partly. */
const HOSTED_STORAGE = /^actions\/(?:upload-artifact|download-artifact|cache)(?:\/|@|$)/i;

function triggersOf(on: unknown): string[] {
  if (typeof on === 'string') return [on];
  if (Array.isArray(on)) return strings(on);
  if (isObject(on)) return Object.keys(on);
  return [];
}

function secretsIn(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(/\bsecrets\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)/g)) {
    names.add(match[1]!);
  }
  for (const match of text.matchAll(/\bsecrets\s*\[\s*['"]([^'"\]]{1,100})['"]\s*\]/g)) {
    names.add(match[1]!);
  }
  return [...names].sort();
}

function permissionDangers(permissions: unknown): string[] {
  if (permissions === 'write-all') return ['requests write access to the repository'];
  if (!isObject(permissions)) return [];
  const writes = SENSITIVE_PERMISSIONS.filter((scope) => permissions[scope] === 'write');
  return writes.length === 0 ? [] : [`requests write permissions (${writes.join(', ')})`];
}

/** Runner labels a job may use; expressions are resolved from a literal matrix when possible. */
function runnerLabels(job: Json): { labels: string[]; resolved: boolean } {
  const runsOn = job['runs-on'];
  if (isObject(runsOn)) {
    // `{ group, labels }`: runner groups belong to organizations' own runners.
    return { labels: strings(runsOn.labels).concat(strings(runsOn.group)), resolved: false };
  }
  const raw = strings(runsOn);
  const labels: string[] = [];
  let resolved = raw.length > 0;
  const matrix =
    isObject(job.strategy) && isObject(job.strategy.matrix) ? job.strategy.matrix : null;
  for (const label of raw) {
    const expression = /^\$\{\{\s*matrix\.([A-Za-z0-9_-]+)\s*\}\}$/.exec(label.trim());
    if (expression === null) {
      if (label.includes('${{')) resolved = false;
      labels.push(label);
      continue;
    }
    const values = matrix === null ? [] : strings(matrix[expression[1]!]);
    if (values.length === 0) resolved = false;
    labels.push(...values);
  }
  return { labels, resolved };
}

const isLinuxLabel = (label: string) => /^ubuntu(?:-|$)/i.test(label) || /^linux$/i.test(label);
const isOtherHosted = (label: string) => /^(?:macos|windows)(?:-|$)/i.test(label);

function classify(reasons: { unsupported: string[]; partial: string[]; unknown: string[] }): {
  compatibility: WorkflowCompatibility;
  reasons: string[];
} {
  if (reasons.unsupported.length > 0) {
    return { compatibility: 'UNSUPPORTED', reasons: [...reasons.unsupported, ...reasons.partial] };
  }
  if (reasons.unknown.length > 0) {
    return { compatibility: 'UNKNOWN', reasons: [...reasons.unknown, ...reasons.partial] };
  }
  if (reasons.partial.length > 0) {
    return { compatibility: 'PARTIALLY_COMPATIBLE', reasons: reasons.partial };
  }
  return { compatibility: 'COMPATIBLE', reasons: ['Runs on a Linux runner `act` can emulate.'] };
}

function summarizeJob(id: string, job: Json, workflowEnvironment: string): WorkflowJobSummary {
  const unsupported: string[] = [];
  const partial: string[] = [];
  const unknown: string[] = [];
  const dangers = new Set<string>();

  const uses = typeof job.uses === 'string' ? job.uses : null;
  const steps = Array.isArray(job.steps) ? job.steps.filter(isObject) : [];
  const actions = [
    ...new Set(steps.map((step) => step.uses).filter((value) => typeof value === 'string')),
  ] as string[];
  const scripts = steps.map((step) => step.run).filter((value) => typeof value === 'string');
  const services = isObject(job.services) ? Object.keys(job.services) : [];
  const container =
    typeof job.container === 'string'
      ? job.container
      : isObject(job.container) && typeof job.container.image === 'string'
        ? job.container.image
        : null;
  const environment =
    typeof job.environment === 'string'
      ? job.environment
      : isObject(job.environment) && typeof job.environment.name === 'string'
        ? job.environment.name
        : null;
  const needs = strings(job.needs);
  const hasMatrix = isObject(job.strategy) && job.strategy.matrix !== undefined;
  const secrets = secretsIn(JSON.stringify(job) + workflowEnvironment);

  if (uses !== null) {
    partial.push(
      uses.startsWith('./')
        ? `Calls the reusable workflow ${uses}; \`act\` supports it only in part.`
        : `Calls the remote reusable workflow ${uses}; it is downloaded and support is partial.`,
    );
  } else {
    const { labels, resolved } = runnerLabels(job);
    if (labels.some((label) => /^self-hosted$/i.test(label))) {
      unsupported.push('Needs a self-hosted runner.');
    } else if (labels.length > 0 && labels.every(isOtherHosted)) {
      unsupported.push(`Needs a ${labels.join(' / ')} runner; \`act\` runs Linux containers only.`);
    } else if (labels.some(isOtherHosted)) {
      partial.push(
        `Runs on ${labels.join(', ')}; only the Linux entries can run locally (use a matrix filter).`,
      );
    } else if (!resolved || labels.length === 0) {
      unknown.push('The runner could not be determined from the file.');
    } else if (!labels.every(isLinuxLabel)) {
      unknown.push(
        `Unknown runner label ${labels.filter((label) => !isLinuxLabel(label)).join(', ')}.`,
      );
    }
  }
  if (needs.length > 0) {
    partial.push(
      `Needs the jobs ${needs.join(', ')}; their outputs may be missing when run alone.`,
    );
  }
  if (services.length > 0) {
    partial.push(
      `Starts service containers (${services.join(', ')}); support in \`act\` is partial.`,
    );
  }
  if (secrets.length > 0) {
    partial.push(
      `Uses secrets (${secrets.join(', ')}); ATLAS does not pass secrets, so it is blocked.`,
    );
  }
  if (actions.some((action) => HOSTED_STORAGE.test(action))) {
    partial.push('Uses GitHub-hosted artifacts or caches, which `act` only emulates.');
  }
  if (environment !== null) {
    partial.push(`Targets the deployment environment "${environment}".`);
    dangers.add(`targets the deployment environment "${environment}"`);
  }

  for (const reason of permissionDangers(job.permissions)) dangers.add(reason);
  for (const action of actions) for (const reason of actionDangers(action)) dangers.add(reason);
  if (uses !== null) for (const reason of actionDangers(uses)) dangers.add(reason);
  for (const script of scripts) for (const reason of commandDangers(script)) dangers.add(reason);

  const { compatibility, reasons } = classify({ unsupported, partial, unknown });
  return {
    id,
    name: typeof job.name === 'string' ? job.name : id,
    runsOn: uses === null ? runnerLabels(job).labels : [],
    needs,
    uses,
    hasMatrix,
    services,
    container,
    environment,
    actions,
    secrets,
    compatibility,
    compatibilityReasons: reasons,
    dangerReasons: [...dangers],
  };
}

/** The worst job classification: one unsupported job makes the whole workflow partial. */
function workflowCompatibility(jobs: WorkflowJobSummary[]): WorkflowCompatibility {
  if (jobs.length === 0) return 'UNKNOWN';
  const all = (value: WorkflowCompatibility) => jobs.every((job) => job.compatibility === value);
  if (all('COMPATIBLE')) return 'COMPATIBLE';
  if (all('UNSUPPORTED')) return 'UNSUPPORTED';
  if (jobs.some((job) => job.compatibility === 'UNKNOWN')) return 'UNKNOWN';
  return 'PARTIALLY_COMPATIBLE';
}

const failedWorkflow = (workflowPath: string, parseError: string): WorkflowSummary => ({
  path: workflowPath,
  name: workflowPath,
  triggers: [],
  jobs: [],
  compatibility: 'UNKNOWN',
  parseError,
});

/** A workflow file that could not be read (missing, unreadable or too large). */
export const unreadableWorkflow = (workflowPath: string): WorkflowSummary =>
  failedWorkflow(workflowPath, 'The file could not be read or is too large.');

/** Reads one workflow file's text. Never throws: unreadable files carry `parseError`. */
export function summarizeWorkflow(workflowPath: string, text: string): WorkflowSummary {
  const failed = (parseError: string) => failedWorkflow(workflowPath, parseError);
  if (Buffer.byteLength(text, 'utf8') > MAX_WORKFLOW_BYTES) return failed('The file is too large.');
  let document: unknown;
  try {
    // Aliases are limited so a crafted file cannot expand without bound.
    document = parse(text, { maxAliasCount: 100, uniqueKeys: false });
  } catch {
    return failed('The file is not valid YAML.');
  }
  if (!isObject(document) || !isObject(document.jobs)) {
    return failed('The file has no jobs.');
  }
  // `on` may be read as the boolean key `true` by YAML 1.1 parsers; YAML 1.2 keeps it.
  const triggers = triggersOf(document.on ?? document.true);
  const workflowEnvironment = JSON.stringify(document.env ?? {});
  const permissions = permissionDangers(document.permissions);
  const jobs = Object.entries(document.jobs)
    .filter((entry): entry is [string, Json] => isObject(entry[1]))
    .map(([id, job]) => {
      const summary = summarizeJob(id, job, workflowEnvironment);
      // Workflow-wide permissions apply to every job that does not set its own.
      if (job.permissions === undefined && permissions.length > 0) {
        summary.dangerReasons = [...new Set([...summary.dangerReasons, ...permissions])];
      }
      return summary;
    });
  return {
    path: workflowPath,
    name: typeof document.name === 'string' ? document.name : workflowPath,
    triggers,
    jobs,
    compatibility: workflowCompatibility(jobs),
    parseError: null,
  };
}
