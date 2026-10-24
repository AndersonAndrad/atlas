import type { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { PreflightActSettings } from '@atlas/contracts';
import type {
  CheckExecution,
  CheckInvocation,
  CheckOutcome,
  PreflightExecutor,
} from '@atlas/preflight';
import { startProcessTree } from './process-tree.js';

/** Variables `act` itself needs; nothing else of the user's environment reaches it. */
const ACT_ENVIRONMENT = [
  'HOME',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'DOCKER_HOST',
  'DOCKER_CONTEXT',
  'DOCKER_CONFIG',
  'DOCKER_CERT_PATH',
  'DOCKER_TLS_VERIFY',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_RUNTIME_DIR',
  'SystemRoot',
  'ComSpec',
] as const;

/** Files `act` reads by default for secrets, variables, inputs and `.env`; replaced by empty ones. */
const ACT_DEFAULT_FILES = ['--secret-file', '--var-file', '--env-file', '--input-file'] as const;

export async function isExecutableFile(file: string): Promise<boolean> {
  try {
    await access(file, constants.X_OK);
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/** Finds an executable on a PATH string (with Windows extensions). */
export async function findExecutable(
  name: string,
  searchPath: string,
  platform: NodeJS.Platform,
  exclude: string | null = null,
): Promise<string | null> {
  const extensions = platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const directory of searchPath.split(path.delimiter)) {
    if (
      directory === '' ||
      (exclude !== null && path.resolve(directory) === path.resolve(exclude))
    ) {
      continue;
    }
    for (const extension of extensions) {
      const candidate = path.join(directory, `${name}${extension}`);
      if (await isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

/** POSIX single-quoting: the value is never interpreted by the shell. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The `act` arguments of a check; each value is one argument, never parsed by a shell. */
export function actArguments(
  workflowPath: string,
  job: string | null,
  settings: PreflightActSettings,
  env: Record<string, string>,
  emptyFile: string,
): string[] {
  const containerOptions = [
    settings.cpus === null ? null : `--cpus=${settings.cpus}`,
    settings.memoryMb === null ? null : `--memory=${settings.memoryMb}m`,
  ].filter((value): value is string => value !== null);
  return [
    settings.event,
    '-W',
    workflowPath,
    ...(job === null ? [] : ['-j', job]),
    '--rm',
    // Job containers do not get the host's Docker socket (it would control the host).
    '--container-daemon-socket',
    '-',
    ...ACT_DEFAULT_FILES.flatMap((flag) => [flag, emptyFile]),
    ...settings.matrix.flatMap((filter) => ['--matrix', filter]),
    ...settings.platforms.flatMap(({ label, image }) => ['-P', `${label}=${image}`]),
    ...(settings.containerArchitecture === null
      ? []
      : ['--container-architecture', settings.containerArchitecture]),
    ...(containerOptions.length === 0 ? [] : ['--container-options', containerOptions.join(' ')]),
    ...Object.entries(env).flatMap(([name, value]) => ['--env', `${name}=${value}`]),
  ];
}

export interface ShellPreflightExecutorOptions {
  platform: NodeJS.Platform;
  /** The user's shell for commands and package scripts. */
  shell: string;
  /** Environment of commands: what a new terminal gets. */
  env: Record<string, string>;
  /** PATH to find tools on (the Engine's and the user's login shell). */
  searchPath: () => Promise<string>;
  /** Folder for the empty files given to `act`. */
  dataDir: string;
  /** The ATLAS wrappers' folder, skipped when looking for tools. */
  excludeDirectory?: string;
  killGraceMs?: number;
  spawn?: typeof spawn;
}

/**
 * Runs Preflight checks (SDD-007 FR-714). Commands and package scripts run in the user's
 * shell (a login shell on macOS, like terminals) with the terminal environment: exactly
 * what typing them in a terminal does, without any sandbox. `act` runs without a shell,
 * with a minimal environment and empty secret, variable, input and `.env` files.
 */
export class ShellPreflightExecutor implements PreflightExecutor {
  readonly shellLabel: string;

  constructor(private readonly options: ShellPreflightExecutorOptions) {
    this.shellLabel =
      options.platform === 'win32' ? 'Local shell (cmd.exe)' : `Local shell (${options.shell})`;
  }

  async hasTool(name: string): Promise<boolean> {
    return (await this.resolve(name)) !== null;
  }

  async run(execution: CheckExecution): Promise<CheckOutcome> {
    if (execution.signal.aborted) return { kind: 'cancelled', exitCode: null, detail: 'cancelled' };
    let command: { file: string; args: string[]; env: Record<string, string>; verbatim: boolean };
    try {
      command = await this.command(execution.invocation, execution.env);
    } catch (error) {
      return {
        kind: 'start-failed',
        exitCode: null,
        detail: error instanceof Error ? error.message : 'the check could not start',
      };
    }
    return new Promise<CheckOutcome>((resolve) => {
      let outcome: CheckOutcome | null = null;
      const decoders = { out: new StringDecoder('utf8'), err: new StringDecoder('utf8') };
      const settle = (result: CheckOutcome) => {
        if (outcome !== null) return;
        outcome = result;
        clearTimeout(timer);
        execution.signal.removeEventListener('abort', onAbort);
        // Stops descendants still running after the root exited, too.
        tree.stop();
      };
      const onAbort = () => settle({ kind: 'cancelled', exitCode: null, detail: 'cancelled' });
      const timer = setTimeout(
        () =>
          settle({
            kind: 'timed-out',
            exitCode: null,
            detail: `timed out after ${Math.round(execution.timeoutMs / 1000)} s`,
          }),
        execution.timeoutMs,
      );
      // Its callbacks run asynchronously, once `tree` and the handlers above exist.
      const tree = startProcessTree(
        {
          file: command.file,
          args: command.args,
          cwd: execution.cwd,
          env: command.env,
          platform: this.options.platform,
          windowsVerbatimArguments: command.verbatim,
          ...(this.options.killGraceMs === undefined
            ? {}
            : { killGraceMs: this.options.killGraceMs }),
          ...(this.options.spawn ? { spawn: this.options.spawn } : {}),
        },
        {
          onData: (stream, chunk) => execution.onOutput(stream, decoders[stream].write(chunk)),
          onError: (error) =>
            settle({
              kind: 'start-failed',
              exitCode: null,
              detail:
                error.code === 'ENOENT'
                  ? `${path.basename(command.file)} was not found`
                  : 'the check could not start',
            }),
          onExit: (code, signal) =>
            settle({
              kind: 'exited',
              exitCode: code,
              detail:
                code === null ? `stopped by ${signal ?? 'a signal'}` : `exited with code ${code}`,
            }),
        },
      );
      execution.signal.addEventListener('abort', onAbort, { once: true });
      void tree.finished.then(() => {
        for (const stream of ['out', 'err'] as const) {
          const rest = decoders[stream].end();
          if (rest !== '') execution.onOutput(stream, rest);
        }
        resolve(outcome ?? { kind: 'cancelled', exitCode: null, detail: 'stopped' });
      });
    });
  }

  private async resolve(name: string): Promise<string | null> {
    return findExecutable(
      name,
      await this.options.searchPath(),
      this.options.platform,
      this.options.excludeDirectory ?? null,
    );
  }

  private async command(
    invocation: CheckInvocation,
    variables: Record<string, string>,
  ): Promise<{ file: string; args: string[]; env: Record<string, string>; verbatim: boolean }> {
    const { platform } = this.options;
    if (invocation.kind === 'act') {
      const act = await this.resolve('act');
      if (act === null) throw new Error('act was not found');
      const emptyFile = await this.emptyFile();
      const env: Record<string, string> = { PATH: await this.options.searchPath() };
      for (const name of ACT_ENVIRONMENT) {
        const value = this.options.env[name];
        if (value !== undefined) env[name] = value;
      }
      return {
        file: act,
        args: actArguments(
          invocation.workflowPath,
          invocation.job,
          invocation.settings,
          variables,
          emptyFile,
        ),
        env,
        verbatim: false,
      };
    }
    let text: string;
    if (invocation.kind === 'shell') {
      text = invocation.command;
    } else if (platform === 'win32') {
      // cmd.exe has no quoting that is safe for every name, so only plain names run.
      if (!/^[A-Za-z0-9_.:@/-]+$/.test(invocation.script)) {
        throw new Error('this script name cannot be run safely by cmd.exe');
      }
      text = `${invocation.manager} run ${invocation.script}`;
    } else {
      text = `${invocation.manager} run ${shellQuote(invocation.script)}`;
    }
    // CI=1 keeps tools non-interactive (no watch modes or prompts) unless set already.
    const env = { ...this.options.env, ...variables };
    env.CI ??= '1';
    if (platform === 'win32') {
      // Verbatim arguments skip Node's quoting: cmd /s strips exactly these outer quotes.
      return {
        file: env.ComSpec ?? 'cmd.exe',
        args: ['/d', '/s', '/c', `"${text}"`],
        env,
        verbatim: true,
      };
    }
    return {
      file: this.options.shell,
      args: [...(platform === 'darwin' ? ['-l'] : []), '-c', text],
      env,
      verbatim: false,
    };
  }

  private async emptyFile(): Promise<string> {
    const folder = path.join(this.options.dataDir, 'preflight');
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const file = path.join(folder, 'act-empty');
    await writeFile(file, '', { mode: 0o600 });
    return file;
  }
}
