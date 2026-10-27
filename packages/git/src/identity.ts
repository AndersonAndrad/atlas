import {
  SetGlobalGitIdentitySchema,
  SetProjectGitIdentitySchema,
  parseInput,
  type GitConfigScope,
  type GitConfigValue,
  type GitIdentityEnvironmentOverride,
  type GitIdentityValues,
  type ProjectGitIdentity,
} from '@atlas/contracts';
import { AtlasError } from '@atlas/shared';
import { GitCommandError, type GitExecutor } from './runner.js';

export interface GitIdentityServiceOptions {
  exec: GitExecutor;
  /** Working directory of global commands (no repository is involved). */
  homeDirectory: string;
  /**
   * Environment of a new terminal in `directory` (the user's shell); null when it cannot be
   * read. Used only to report variables that override the identity of terminal commits.
   */
  shellEnvironment?: (directory: string) => Promise<Record<string, string> | null>;
  /** Called after a repository's (or every repository's) configuration changed. */
  onChanged?: (repositoryRoot: string | null) => void;
  timeoutMs?: number;
}

const KEYS = { name: 'user.name', email: 'user.email' } as const;
const SCOPES: readonly GitConfigScope[] = ['local', 'worktree', 'global', 'system', 'command'];
/** `git config --get` exits with 1 when the key is not set, `--unset` with 5. */
const NOT_SET = [0, 1];

/**
 * Author identity in Git's own configuration (SDD-024 Task 03). Values are read the way Git
 * resolves them (scopes, includes, command line) and written only on explicit request,
 * globally or to one repository resolved by the Engine. Arguments only, never a shell; `--`
 * ends the options, so a value such as `--file=…` is stored as text.
 * Commits and history are never touched.
 */
export class GitIdentityService {
  private readonly timeoutMs: number;

  constructor(private readonly options: GitIdentityServiceOptions) {
    this.timeoutMs = options.timeoutMs ?? 5000;
  }

  /** Global values (`git config --global`), with the file they come from. */
  async global(): Promise<GitIdentityValues> {
    const read = async (key: string): Promise<GitConfigValue | null> => {
      const fields = await this.read(this.options.homeDirectory, [
        'config',
        '-z',
        '--global',
        '--show-origin',
        '--get',
        '--',
        key,
      ]);
      if (fields === null) return null;
      const [origin = '', value = ''] = fields;
      return { value, scope: 'global', origin: originPath(origin) };
    };
    const [name, email] = await Promise.all([read(KEYS.name), read(KEYS.email)]);
    return { name, email };
  }

  async setGlobal(input: unknown): Promise<GitIdentityValues> {
    const { name, email } = parseInput(SetGlobalGitIdentitySchema, input);
    await this.write(this.options.homeDirectory, ['config', '--global', '--', KEYS.name, name]);
    await this.write(this.options.homeDirectory, ['config', '--global', '--', KEYS.email, email]);
    this.options.onChanged?.(null);
    return this.global();
  }

  /** The identity Git uses in `repositoryRoot`, its local overrides and shell variables. */
  async project(projectId: string, repositoryRoot: string): Promise<ProjectGitIdentity> {
    const effective = async (key: string): Promise<GitConfigValue | null> => {
      const fields = await this.read(repositoryRoot, [
        'config',
        '-z',
        '--show-scope',
        '--show-origin',
        '--get',
        '--',
        key,
      ]);
      if (fields === null) return null;
      const [scope = '', origin = '', value = ''] = fields;
      return {
        value,
        scope: (SCOPES as readonly string[]).includes(scope)
          ? (scope as GitConfigScope)
          : 'unknown',
        origin: originPath(origin),
      };
    };
    const local = async (key: string) =>
      (await this.read(repositoryRoot, ['config', '-z', '--local', '--get', '--', key]))?.[0] ??
      null;
    const [name, email, localName, localEmail, shell] = await Promise.all([
      effective(KEYS.name),
      effective(KEYS.email),
      local(KEYS.name),
      local(KEYS.email),
      this.options.shellEnvironment?.(repositoryRoot).catch(() => null) ?? Promise.resolve(null),
    ]);
    return {
      projectId,
      repositoryRoot,
      effective: { name, email },
      local: { name: localName, email: localEmail },
      environment: shell === null ? [] : identityOverrides(shell),
      environmentChecked: shell !== null,
    };
  }

  /** Sets (string) or removes (null) the repository's own values; absent ones are kept. */
  async setProject(
    projectId: string,
    repositoryRoot: string,
    input: unknown,
  ): Promise<ProjectGitIdentity> {
    const changes = parseInput(SetProjectGitIdentitySchema, input);
    for (const field of ['name', 'email'] as const) {
      const value = changes[field];
      if (value === undefined) continue;
      if (value === null) {
        // Exit code 5: nothing to remove.
        await this.write(
          repositoryRoot,
          ['config', '--local', '--unset-all', '--', KEYS[field]],
          [0, 5],
        );
      } else {
        await this.write(repositoryRoot, ['config', '--local', '--', KEYS[field], value]);
      }
    }
    this.options.onChanged?.(repositoryRoot);
    return this.project(projectId, repositoryRoot);
  }

  /** NUL-separated fields of a `git config -z` answer; null when the key is not set. */
  private async read(cwd: string, args: string[]): Promise<string[] | null> {
    const result = await this.run(cwd, args, NOT_SET);
    if (result.exitCode === 1) return null;
    const fields = result.stdout.split('\0');
    if (fields.at(-1) === '') fields.pop();
    // With -z, `--get` prints the value after its key-less fields; values never contain NUL.
    return fields.map((field) => field.replace(/\n$/, ''));
  }

  private async write(cwd: string, args: string[], ok: readonly number[] = [0]): Promise<void> {
    await this.run(cwd, args, ok);
  }

  private async run(cwd: string, args: string[], okExitCodes: readonly number[]) {
    try {
      return await this.options.exec(args, { cwd, timeoutMs: this.timeoutMs, okExitCodes });
    } catch (error) {
      if (error instanceof GitCommandError) {
        const reason =
          error.kind === 'not-installed'
            ? 'Git is not installed or not on the PATH.'
            : error.kind === 'unsafe-ownership'
              ? 'Git does not trust this repository (it belongs to another user).'
              : // e.g. an invalid configuration file or a locked one (config.lock).
                'Git could not read or write its configuration. Check the configuration file and try again.';
        throw new AtlasError('GIT_CONFIG_FAILED', reason, { cause: error });
      }
      throw error;
    }
  }
}

/** `file:/path` → `/path`; `command line:` stays as is. */
function originPath(origin: string): string | null {
  if (origin === '') return null;
  return origin.startsWith('file:') ? origin.slice('file:'.length) : origin;
}

const IDENTITY_VARIABLES: Record<string, 'name' | 'email'> = {
  GIT_AUTHOR_NAME: 'name',
  GIT_COMMITTER_NAME: 'name',
  GIT_AUTHOR_EMAIL: 'email',
  GIT_COMMITTER_EMAIL: 'email',
  EMAIL: 'email',
};
const CONFIG_VARIABLES = [
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_PARAMETERS',
];

/** Variables of a shell environment that change the identity of commits made there. */
export function identityOverrides(env: Record<string, string>): GitIdentityEnvironmentOverride[] {
  const found: GitIdentityEnvironmentOverride[] = [];
  for (const [variable, affects] of Object.entries(IDENTITY_VARIABLES)) {
    const value = env[variable];
    if (value !== undefined && value !== '') found.push({ variable, value, affects });
  }
  for (const variable of CONFIG_VARIABLES) {
    if (env[variable] !== undefined && env[variable] !== '') {
      found.push({ variable, value: null, affects: 'configuration' });
    }
  }
  return found;
}
