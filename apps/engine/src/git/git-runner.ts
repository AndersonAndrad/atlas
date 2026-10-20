import { execFile, spawn } from 'node:child_process';
import { GitCommandError, type GitExecutor, type GitRunner } from '@atlas/git';

/**
 * Options applied to every invocation:
 * - `core.fsmonitor=false`: a repository's config could otherwise make `git status`
 *   execute an arbitrary fsmonitor command.
 * - `--no-optional-locks`: inspection never writes the index or takes locks.
 */
const SAFE_PREFIX = ['-c', 'core.fsmonitor=false', '--no-optional-locks'];
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
/** Standard error is kept for diagnostics; progress lines are not accumulated beyond this. */
const MAX_STDERR_BYTES = 256 * 1024;

/** Environment for git: no inherited GIT_* overrides, no prompts, stable output. */
export function gitEnvironment(source: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && !name.startsWith('GIT_')) env[name] = value;
  }
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_OPTIONAL_LOCKS = '0';
  env.LC_ALL = 'C';
  return env;
}

function classify(
  stderr: string,
  exitCode: number | null,
  output: { stdout: string; stderr: string },
): GitCommandError {
  if (/dubious ownership/i.test(stderr)) {
    return new GitCommandError(
      'unsafe-ownership',
      'repository ownership not trusted',
      exitCode,
      output,
    );
  }
  if (/not a git repository/i.test(stderr)) {
    return new GitCommandError('not-repository', 'not a git repository', exitCode ?? 128, output);
  }
  return new GitCommandError('failed', `git exited with ${String(exitCode)}`, exitCode, output);
}

/**
 * Creates a runner that executes `git` without a shell: arguments are passed as
 * an array, so nothing is ever interpolated into a command line.
 */
export function createGitRunner(
  options: { executable?: string; env?: Record<string, string | undefined> } = {},
): GitRunner {
  const executable = options.executable ?? 'git';
  const env = gitEnvironment(options.env ?? process.env);
  return (args, { cwd, timeoutMs, signal }) =>
    new Promise((resolve, reject) => {
      execFile(
        executable,
        [...SAFE_PREFIX, ...args],
        {
          cwd,
          env,
          timeout: timeoutMs,
          killSignal: 'SIGKILL',
          maxBuffer: MAX_OUTPUT_BYTES,
          windowsHide: true,
          encoding: 'utf8',
          ...(signal ? { signal } : {}),
        },
        (error, stdout, stderr) => {
          if (!error) {
            resolve(stdout);
            return;
          }
          const failure = error as NodeJS.ErrnoException & { killed?: boolean; code?: unknown };
          if (failure.code === 'ENOENT') {
            reject(new GitCommandError('not-installed', 'git executable not found'));
          } else if (failure.killed || failure.name === 'AbortError') {
            reject(new GitCommandError('timeout', 'git command timed out'));
          } else {
            const exitCode = typeof failure.code === 'number' ? failure.code : null;
            reject(classify(stderr, exitCode, { stdout, stderr }));
          }
        },
      );
    });
}

/**
 * Creates an executor for any git command, mutations included. Like the runner it
 * never uses a shell. Standard input carries data such as commit messages, and
 * progress lines from standard error are reported as they arrive.
 */
export function createGitExecutor(
  options: { executable?: string; env?: Record<string, string | undefined> } = {},
): GitExecutor {
  const executable = options.executable ?? 'git';
  const env = gitEnvironment(options.env ?? process.env);
  return (args, { cwd, timeoutMs, signal, input, okExitCodes = [0], maxOutputBytes, onProgress }) =>
    new Promise((resolve, reject) => {
      const limit = maxOutputBytes ?? MAX_OUTPUT_BYTES;
      const child = spawn(executable, [...SAFE_PREFIX, ...args], {
        cwd,
        env,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const stdout: Buffer[] = [];
      let stdoutBytes = 0;
      let truncated = false;
      let stderr = '';
      let pendingLine = '';
      let ending: 'timeout' | 'cancelled' | 'truncated' | null = null;

      const stop = (reason: 'timeout' | 'cancelled' | 'truncated') => {
        if (ending !== null) return;
        ending = reason;
        child.kill('SIGKILL');
      };
      const timer = setTimeout(() => stop('timeout'), timeoutMs);
      const onAbort = () => stop('cancelled');
      if (signal?.aborted) onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });

      child.stdout.on('data', (chunk: Buffer) => {
        if (truncated) return;
        const room = limit - stdoutBytes;
        if (chunk.length > room) {
          stdout.push(chunk.subarray(0, room));
          stdoutBytes = limit;
          truncated = true;
          stop('truncated');
          return;
        }
        stdout.push(chunk);
        stdoutBytes += chunk.length;
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        if (stderr.length < MAX_STDERR_BYTES) stderr += chunk;
        if (!onProgress) return;
        // Git rewrites progress lines with carriage returns.
        const parts = (pendingLine + chunk).split(/[\r\n]/);
        pendingLine = parts.pop() ?? '';
        for (const line of parts) if (line.trim() !== '') onProgress(line);
      });
      child.stdin.on('error', () => {
        // The process may exit before reading its input; the exit code reports it.
      });
      child.stdin.end(input ?? '');

      child.on('error', (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(
          error.code === 'ENOENT'
            ? new GitCommandError('not-installed', 'git executable not found')
            : new GitCommandError('failed', error.message),
        );
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        const out = Buffer.concat(stdout).toString('utf8');
        if (ending === 'timeout') {
          reject(
            new GitCommandError('timeout', 'git command timed out', null, { stdout: out, stderr }),
          );
        } else if (ending === 'cancelled') {
          reject(
            new GitCommandError('cancelled', 'git command cancelled', null, {
              stdout: out,
              stderr,
            }),
          );
        } else if (ending === 'truncated') {
          // Only reading commands set a limit; their partial output is still useful.
          resolve({ stdout: out, stderr, exitCode: code ?? 0, truncated: true });
        } else if (code !== null && okExitCodes.includes(code)) {
          resolve({ stdout: out, stderr, exitCode: code, truncated });
        } else {
          reject(classify(stderr, code, { stdout: out, stderr }));
        }
      });
    });
}
