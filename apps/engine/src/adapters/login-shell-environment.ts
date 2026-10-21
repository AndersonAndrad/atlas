import { spawn } from 'node:child_process';
import { withoutDevToolingVariables } from './shell-environment.js';

/** Printed before `env -0`, so anything the shell's start-up files print is skipped. */
const MARKER = '__ATLAS_ENVIRONMENT__';
/** Start-up files that take longer than this are given up on (PLAN-018 R2). */
export const LOGIN_SHELL_TIMEOUT_MS = 8000;
/** Output beyond this is not an environment; the capture is abandoned. */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
/** Describe the capturing shell itself, not a new terminal. */
const SHELL_STATE = new Set(['_', 'SHLVL', 'PWD', 'OLDPWD']);
const BLOCKED_PREFIXES = ['ELECTRON_', 'CHROME_', 'VSCODE_'];

export interface LoginShellEnvironmentOptions {
  shell: string;
  platform: NodeJS.Platform;
  /** Environment a new ATLAS terminal starts from. */
  env: Record<string, string>;
  cwd: string;
  timeoutMs?: number;
  spawn?: typeof spawn;
}

/** Parses the output of `printf MARKER; env -0`. */
export function parseEnvironmentOutput(output: string): Record<string, string> | null {
  const start = output.indexOf(`${MARKER}\n`);
  if (start === -1) return null;
  const env: Record<string, string> = {};
  for (const entry of output.slice(start + MARKER.length + 1).split('\0')) {
    const separator = entry.indexOf('=');
    if (separator <= 0) continue;
    const name = entry.slice(0, separator);
    if (SHELL_STATE.has(name) || BLOCKED_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      continue;
    }
    env[name] = entry.slice(separator + 1);
  }
  return Object.keys(env).length === 0 ? null : withoutDevToolingVariables(env);
}

/**
 * The environment a new terminal would have now: the user's shell is started as an
 * interactive login shell (reading its profile and rc files, like a new ATLAS terminal)
 * and prints its environment. Nothing is cached, so profile changes apply to the next
 * commit. Runs without a controlling terminal and is stopped after the timeout.
 * Rejects when the environment cannot be read; callers fall back to their default.
 */
export function captureLoginShellEnvironment(
  options: LoginShellEnvironmentOptions,
): Promise<Record<string, string>> {
  if (options.platform === 'win32') return Promise.resolve(options.env);
  const spawnProcess = options.spawn ?? spawn;
  return new Promise((resolve, reject) => {
    const child = spawnProcess(
      options.shell,
      ['-i', '-l', '-c', `printf '%s\\n' ${MARKER}; command env -0`],
      {
        cwd: options.cwd,
        env: options.env,
        // Own session without a terminal: interactive start-up files cannot wait for input.
        detached: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const stop = () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    };
    const finish = (error: Error | null, env?: Record<string, string>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(env!);
    };
    const timer = setTimeout(() => {
      stop();
      finish(new Error('The shell start-up files took too long.'));
    }, options.timeoutMs ?? LOGIN_SHELL_TIMEOUT_MS);
    child.stdout?.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        stop();
        finish(new Error('The shell printed too much output.'));
        return;
      }
      chunks.push(chunk);
    });
    child.on('error', (error) => finish(error));
    child.on('close', () => {
      const env = parseEnvironmentOutput(Buffer.concat(chunks).toString('utf8'));
      if (env === null) finish(new Error('The shell did not report its environment.'));
      else finish(null, env);
    });
  });
}
