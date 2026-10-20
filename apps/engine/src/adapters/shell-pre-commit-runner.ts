import { spawn } from 'node:child_process';
import type { PreCommitStep } from '@atlas/contracts';
import { redactTail, type PreCommitStepOutcome, type PreCommitStepRunner } from '@atlas/git';

export interface ShellPreCommitRunnerOptions {
  platform: NodeJS.Platform;
  /** Shell used for POSIX commands, e.g. the user's $SHELL. */
  shell: string;
  /** Environment of the steps; the same one terminals get. */
  env: Record<string, string>;
  /** Grace period between SIGTERM and SIGKILL when stopping a step. */
  killGraceMs?: number;
  /** Replaces `child_process.spawn`, e.g. to test the Windows branch on any platform. */
  spawn?: typeof spawn;
}

/** Default grace period between SIGTERM and SIGKILL. */
export const DEFAULT_KILL_GRACE_MS = 5000;
/** How long a step may take to exit after SIGKILL before it is reported anyway. */
export const KILL_WAIT_MS = 2000;

/** Longest time a step can take to settle once it is cancelled. */
export function preCommitStopTimeoutMs(killGraceMs = DEFAULT_KILL_GRACE_MS): number {
  return killGraceMs + KILL_WAIT_MS;
}

/** Output kept per step; only the tail is useful to explain a failure. */
const MAX_OUTPUT_CHARS = 64 * 1024;
/** Raw output buffered beyond the limit, so redaction sees keys the limit would cut. */
const RAW_OUTPUT_CHARS = MAX_OUTPUT_CHARS + 4 * 1024;

/**
 * Runs a project's pre-commit command through the user's shell (a login shell on
 * macOS, like terminals), so PATH matches what the user sees in a terminal. Each
 * step runs in its own process group: stopping a step stops everything it started
 * (a dev server and its children), not only the shell. On Windows the tree is
 * stopped with `taskkill /t` while its root is still alive, since descendants
 * cannot be found once the root has exited; after the root exited its PID may
 * already belong to an unrelated process, so nothing is signalled.
 */
export class ShellPreCommitRunner implements PreCommitStepRunner {
  constructor(private readonly options: ShellPreCommitRunnerOptions) {}

  run(step: PreCommitStep, { cwd, signal }: { cwd: string; signal: AbortSignal }) {
    if (signal.aborted) {
      return Promise.resolve<PreCommitStepOutcome>({
        status: 'cancelled',
        exitCode: null,
        detail: 'cancelled',
        output: '',
        durationMs: 0,
      });
    }
    const { platform } = this.options;
    const spawnProcess = this.options.spawn ?? spawn;
    const windows = platform === 'win32';
    // Verbatim arguments skip Node's quoting, so wrap the command the way Node does
    // for `shell: true`: cmd /s strips exactly these outer quotes.
    const [file, args] = windows
      ? [this.options.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${step.command}"`]]
      : [this.options.shell, [...(platform === 'darwin' ? ['-l'] : []), '-c', step.command]];
    const started = Date.now();

    return new Promise<PreCommitStepOutcome>((resolve) => {
      const child = spawnProcess(file, args, {
        cwd,
        // CI=1 keeps tools non-interactive (no watch modes or prompts) unless set already.
        env: { ...this.options.env, CI: this.options.env.CI ?? '1' },
        detached: !windows,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        windowsVerbatimArguments: windows,
      });
      let output = '';
      let outcome: Omit<PreCommitStepOutcome, 'output' | 'durationMs'> | null = null;
      let finished = false;
      let rootExited = false;
      const timers: ReturnType<typeof setTimeout>[] = [];

      /** Best effort: the tree may already be gone. */
      const signalTree = (name: NodeJS.Signals) => {
        if (child.pid === undefined) return;
        if (windows && rootExited) return;
        try {
          if (!windows) {
            process.kill(-child.pid, name);
            return;
          }
          const killer = spawnProcess('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
            stdio: 'ignore',
            windowsHide: true,
          });
          // Without taskkill (or when it fails), at least stop the root process.
          killer.on('error', () => child.kill(name));
          killer.on('exit', (code) => {
            if (code !== 0) child.kill(name);
          });
        } catch {
          // Already gone.
        }
      };
      const done = () => {
        if (finished) return;
        finished = true;
        for (const timer of timers) clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        resolve({
          ...outcome!,
          output: redactTail(output, MAX_OUTPUT_CHARS),
          durationMs: Date.now() - started,
        });
      };
      /**
       * Records the result, then stops the process tree before waiting for it to exit
       * (on abort, timeout or a start step's stop the root is still running; on POSIX
       * the process group outlives its root, so background descendants are stopped).
       */
      const settle = (result: NonNullable<typeof outcome>) => {
        if (outcome !== null) return;
        outcome = result;
        signalTree('SIGTERM');
        timers.push(
          setTimeout(() => {
            signalTree('SIGKILL');
            // Do not wait forever for a process that ignores SIGKILL (e.g. stuck in I/O).
            timers.push(setTimeout(done, KILL_WAIT_MS));
          }, this.options.killGraceMs ?? DEFAULT_KILL_GRACE_MS),
        );
      };
      const onAbort = () => settle({ status: 'cancelled', exitCode: null, detail: 'cancelled' });
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });

      const onData = (chunk: Buffer) => {
        output = (output + chunk.toString('utf8')).slice(-RAW_OUTPUT_CHARS);
        if (step.mode === 'start' && step.readyText && output.includes(step.readyText)) {
          settle({
            status: 'passed',
            exitCode: null,
            detail: `printed "${step.readyText}" and was stopped`,
          });
        }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);

      if (step.mode === 'complete') {
        timers.push(
          setTimeout(
            () =>
              settle({
                status: 'failed',
                exitCode: null,
                detail: `timed out after ${step.timeoutSeconds} s`,
              }),
            step.timeoutSeconds * 1000,
          ),
        );
      } else if (step.readyText) {
        timers.push(
          setTimeout(
            () =>
              settle({
                status: 'failed',
                exitCode: null,
                detail: `did not print "${step.readyText}" within ${step.timeoutSeconds} s`,
              }),
            step.timeoutSeconds * 1000,
          ),
        );
      } else {
        timers.push(
          setTimeout(
            () =>
              settle({
                status: 'passed',
                exitCode: null,
                detail: `kept running for ${step.readyAfterSeconds} s and was stopped`,
              }),
            step.readyAfterSeconds * 1000,
          ),
        );
      }

      child.on('error', (error: NodeJS.ErrnoException) => {
        settle({
          status: 'failed',
          exitCode: null,
          detail:
            error.code === 'ENOENT' ? 'the shell was not found' : 'the command could not start',
        });
        done();
      });
      child.on('exit', (code, closeSignal) => {
        rootExited = true;
        if (outcome === null) {
          settle(
            code === 0 && step.mode === 'complete'
              ? { status: 'passed', exitCode: 0, detail: 'exited with code 0' }
              : {
                  status: 'failed',
                  exitCode: code,
                  detail:
                    code === 0
                      ? 'exited before becoming ready'
                      : code === null
                        ? `stopped by ${closeSignal ?? 'a signal'}`
                        : `exited with code ${code}`,
                },
          );
        }
      });
      child.on('close', () => {
        // Descendants may have closed their pipes while ignoring SIGTERM.
        // Do not clear the escalation timer and leave those processes behind.
        if (!windows) signalTree('SIGKILL');
        done();
      });
    });
  }
}
