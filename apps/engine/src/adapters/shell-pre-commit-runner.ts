import type { spawn } from 'node:child_process';
import type { PreCommitStep } from '@atlas/contracts';
import { redactTail, type PreCommitStepOutcome, type PreCommitStepRunner } from '@atlas/git';
import { DEFAULT_KILL_GRACE_MS, KILL_WAIT_MS, startProcessTree } from './process-tree.js';

export { DEFAULT_KILL_GRACE_MS, KILL_WAIT_MS } from './process-tree.js';

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

  run(
    step: PreCommitStep,
    { cwd, signal, env }: { cwd: string; signal: AbortSignal; env?: Record<string, string> },
  ) {
    const stepEnv = env ?? this.options.env;
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
    const windows = platform === 'win32';
    // Verbatim arguments skip Node's quoting, so wrap the command the way Node does
    // for `shell: true`: cmd /s strips exactly these outer quotes.
    const [file, args] = windows
      ? [stepEnv.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${step.command}"`]]
      : [this.options.shell, [...(platform === 'darwin' ? ['-l'] : []), '-c', step.command]];
    const started = Date.now();

    return new Promise<PreCommitStepOutcome>((resolve) => {
      let output = '';
      let outcome: Omit<PreCommitStepOutcome, 'output' | 'durationMs'> | null = null;
      let finished = false;
      const timers: ReturnType<typeof setTimeout>[] = [];

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
        tree.stop();
      };
      const onAbort = () => settle({ status: 'cancelled', exitCode: null, detail: 'cancelled' });

      // Its callbacks run asynchronously, once `tree` and the handlers above exist.
      const tree = startProcessTree(
        {
          file,
          args,
          cwd,
          // CI=1 keeps tools non-interactive (no watch modes or prompts) unless set already.
          env: { ...stepEnv, CI: stepEnv.CI ?? '1' },
          platform,
          windowsVerbatimArguments: windows,
          ...(this.options.killGraceMs === undefined
            ? {}
            : { killGraceMs: this.options.killGraceMs }),
          ...(this.options.spawn ? { spawn: this.options.spawn } : {}),
        },
        {
          onData: (_stream, chunk) => {
            output = (output + chunk.toString('utf8')).slice(-RAW_OUTPUT_CHARS);
            if (step.mode === 'start' && step.readyText && output.includes(step.readyText)) {
              settle({
                status: 'passed',
                exitCode: null,
                detail: `printed "${step.readyText}" and was stopped`,
              });
            }
          },
          onError: (error) =>
            settle({
              status: 'failed',
              exitCode: null,
              detail:
                error.code === 'ENOENT' ? 'the shell was not found' : 'the command could not start',
            }),
          onExit: (code, closeSignal) => {
            if (outcome !== null) return;
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
          },
        },
      );
      void tree.finished.then(done);
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });

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
    });
  }
}
