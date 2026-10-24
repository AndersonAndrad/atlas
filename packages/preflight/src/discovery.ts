import type {
  DiscoveredCommand,
  DiscoveredScript,
  PackageManager,
  PreflightCheckCategory,
  PreflightDiscovery,
} from '@atlas/contracts';
import { MAX_WORKFLOW_BYTES, summarizeWorkflow, unreadableWorkflow } from './workflows.js';

/** Read-only access to the workspace; paths are relative to it. */
export interface WorkspaceFiles {
  /** The file's text, or null when it does not exist or is larger than `maxBytes`. */
  readText(relativePath: string, maxBytes: number): Promise<string | null>;
  /** File names in a folder (not recursive); empty when it does not exist. */
  list(relativePath: string): Promise<string[]>;
  exists(relativePath: string): Promise<boolean>;
}

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_WORKFLOWS = 50;
const MAX_MAKE_TARGETS = 50;

const CATEGORY_RULES: readonly (readonly [RegExp, PreflightCheckCategory])[] = [
  [/(?:^|[:_-])(?:e2e|playwright|cypress)(?:$|[:_-])/i, 'E2E_TEST'],
  [/(?:^|[:_-])integration(?:$|[:_-])/i, 'INTEGRATION_TEST'],
  [/(?:^|[:_-])(?:typecheck|type-check|types|tsc)(?:$|[:_-])/i, 'TYPECHECK'],
  [/(?:^|[:_-])(?:format|fmt|prettier)(?:$|[:_-])/i, 'FORMAT'],
  [/(?:^|[:_-])(?:lint|eslint|stylelint|check)(?:$|[:_-])/i, 'LINT'],
  [/(?:^|[:_-])(?:audit|security|snyk)(?:$|[:_-])/i, 'SECURITY'],
  [/(?:^|[:_-])(?:test|tests|unit|spec|vitest|jest)(?:$|[:_-])/i, 'UNIT_TEST'],
  [/(?:^|[:_-])(?:build|compile|package|dist)(?:$|[:_-])/i, 'BUILD'],
];

/** A best guess from the name; the user confirms it before a check is created. */
export function categorize(name: string): PreflightCheckCategory {
  for (const [pattern, category] of CATEGORY_RULES) if (pattern.test(name)) return category;
  return 'CUSTOM';
}

/** Scripts that start servers or watchers never finish, so they are not suggested. */
const LONG_RUNNING = /^(?:dev|start|serve|watch|preview)(?:$|[:_-])|(?:^|[:_-])watch$/i;
/** npm lifecycle hooks run by other scripts, not on their own. */
const LIFECYCLE = /^(?:pre|post)|^(?:prepare|prepublish|prepublishOnly|install|postinstall)$/;

async function packageManager(
  files: WorkspaceFiles,
  manifest: Record<string, unknown> | null,
): Promise<PackageManager | null> {
  const declared = typeof manifest?.packageManager === 'string' ? manifest.packageManager : '';
  const match = /^(npm|pnpm|yarn)@/.exec(declared);
  if (match) return match[1] as PackageManager;
  if (await files.exists('pnpm-lock.yaml')) return 'pnpm';
  if (await files.exists('yarn.lock')) return 'yarn';
  if (manifest !== null) return 'npm';
  return null;
}

async function readManifest(files: WorkspaceFiles): Promise<Record<string, unknown> | null> {
  const text = await files.readText('package.json', MAX_MANIFEST_BYTES);
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * A package.json script and the `pre<name>` / `post<name>` hooks npm runs around it, or
 * null when the file or the script does not exist.
 */
export async function readScript(
  files: WorkspaceFiles,
  name: string,
): Promise<{ body: string; hooks: { name: string; body: string }[] } | null> {
  const scripts = (await readManifest(files))?.scripts;
  if (scripts === null || typeof scripts !== 'object') return null;
  const all = scripts as Record<string, unknown>;
  const body = all[name];
  if (typeof body !== 'string') return null;
  const hooks = [`pre${name}`, `post${name}`]
    .filter((hook) => typeof all[hook] === 'string')
    .map((hook) => ({ name: hook, body: all[hook] as string }));
  return { body, hooks };
}

function packageScripts(manifest: Record<string, unknown> | null): DiscoveredScript[] {
  const scripts = manifest?.scripts;
  if (scripts === null || typeof scripts !== 'object' || Array.isArray(scripts)) return [];
  return Object.entries(scripts as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .filter(([name]) => !LONG_RUNNING.test(name) && !LIFECYCLE.test(name) && name.length <= 200)
    .map(([name, body]) => ({ name, body: body.slice(0, 2000), category: categorize(name) }));
}

function makeTargets(makefile: string): DiscoveredCommand[] {
  const targets = new Set<string>();
  for (const line of makefile.split(/\r?\n/)) {
    const match = /^([A-Za-z][A-Za-z0-9_-]{0,63})\s*:(?!=)/.exec(line);
    if (match) targets.add(match[1]!);
    if (targets.size >= MAX_MAKE_TARGETS) break;
  }
  return [...targets]
    .filter((target) => !LONG_RUNNING.test(target) && !/^(?:all|install|clean|help)$/.test(target))
    .map((target) => ({
      name: `make ${target}`,
      command: `make ${target}`,
      category: categorize(target),
      source: 'Makefile',
    }));
}

async function buildToolCommands(files: WorkspaceFiles): Promise<DiscoveredCommand[]> {
  const commands: DiscoveredCommand[] = [];
  const gradle = (await files.exists('gradlew'))
    ? './gradlew'
    : (await files.exists('build.gradle')) || (await files.exists('build.gradle.kts'))
      ? 'gradle'
      : null;
  if (gradle !== null) {
    // Gradle's task list needs Gradle to run, so only its standard tasks are suggested.
    const source = gradle === './gradlew' ? 'gradlew' : 'build.gradle';
    commands.push(
      { name: 'Gradle check', command: `${gradle} check`, category: 'LINT', source },
      { name: 'Gradle test', command: `${gradle} test`, category: 'UNIT_TEST', source },
      { name: 'Gradle build', command: `${gradle} build`, category: 'BUILD', source },
    );
  }
  if (await files.exists('pom.xml')) {
    const maven = (await files.exists('mvnw')) ? './mvnw' : 'mvn';
    commands.push(
      { name: 'Maven test', command: `${maven} -B test`, category: 'UNIT_TEST', source: 'pom.xml' },
      { name: 'Maven verify', command: `${maven} -B verify`, category: 'BUILD', source: 'pom.xml' },
    );
  }
  return commands;
}

/** Workflow files directly in `.github/workflows`, sorted by name. */
export async function workflowFiles(files: WorkspaceFiles): Promise<string[]> {
  return (await files.list('.github/workflows'))
    .filter((name) => /^[A-Za-z0-9_.-]{1,200}\.ya?ml$/.test(name))
    .sort()
    .slice(0, MAX_WORKFLOWS)
    .map((name) => `.github/workflows/${name}`);
}

/**
 * Commands and workflows a project already declares (FR-703, FR-706). Only files are
 * read: no script, build tool or workflow is executed. The user picks what becomes a check.
 */
export async function discover(files: WorkspaceFiles): Promise<PreflightDiscovery> {
  const manifest = await readManifest(files);
  const makefile = await files.readText('Makefile', MAX_MANIFEST_BYTES);
  const workflows = await Promise.all(
    (await workflowFiles(files)).map(async (workflowPath) => {
      const text = await files.readText(workflowPath, MAX_WORKFLOW_BYTES);
      return text === null
        ? unreadableWorkflow(workflowPath)
        : summarizeWorkflow(workflowPath, text);
    }),
  );
  return {
    packageManager: await packageManager(files, manifest),
    scripts: packageScripts(manifest),
    commands: [
      ...(makefile === null ? [] : makeTargets(makefile)),
      ...(await buildToolCommands(files)),
    ],
    workflows,
  };
}
