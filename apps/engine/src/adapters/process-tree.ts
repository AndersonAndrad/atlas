import { spawn } from 'node:child_process';
import type { Writable } from 'node:stream';

/** Default grace period between SIGTERM and SIGKILL. */
export const DEFAULT_KILL_GRACE_MS = 5000;
/** How long a process may take to exit after SIGKILL before it is given up on. */
export const KILL_WAIT_MS = 2000;

export interface ProcessTreeOptions {
  file: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
  platform: NodeJS.Platform;
  /** Grace period between SIGTERM and SIGKILL when stopping the tree. */
  killGraceMs?: number;
  /** Arguments are passed to cmd.exe as written (Windows shell commands only). */
  windowsVerbatimArguments?: boolean;
  /** `pipe` gives the process a standard input to write to (debug adapters); default `ignore`. */
  stdin?: 'ignore' | 'pipe';
  /** Replaces `child_process.spawn`, e.g. to test the Windows branch on any platform. */
  spawn?: typeof spawn;
}

export interface ProcessTreeEvents {
  onData(stream: 'out' | 'err', chunk: Buffer): void;
  /** The root process exited (its descendants may still run). */
  onExit(code: number | null, signal: NodeJS.Signals | null): void;
  /** The process could not start. `finished` resolves right after. */
  onError(error: NodeJS.ErrnoException): void;
}

export interface ProcessTree {
  /**
   * Stops the whole tree: SIGTERM, then SIGKILL after the grace period. Idempotent.
   * `finished` resolves once the process closed, or `KILL_WAIT_MS` after SIGKILL.
   */
  stop(): void;
  readonly finished: Promise<void>;
  /** The process's standard input when started with `stdin: 'pipe'`, else null. */
  readonly input: Writable | null;
  /** The root process id, once started. */
  readonly pid: number | undefined;
}

/**
 * Starts a process in its own process group (POSIX), so stopping it stops everything it
 * started (a dev server and its children), not only the root. On Windows the tree is
 * stopped with `taskkill /t` while its root is still alive, since descendants cannot be
 * found once the root has exited; after the root exited its PID may already belong to an
 * unrelated process, so nothing is signalled. Once the root's output closes, remaining
 * POSIX descendants are killed: they may have closed their pipes while ignoring SIGTERM.
 */
export function startProcessTree(
  options: ProcessTreeOptions,
  events: ProcessTreeEvents,
): ProcessTree {
  const spawnProcess = options.spawn ?? spawn;
  const windows = options.platform === 'win32';
  const child = spawnProcess(options.file, [...options.args], {
    cwd: options.cwd,
    env: options.env,
    detached: !windows,
    stdio: [options.stdin ?? 'ignore', 'pipe', 'pipe'],
    windowsHide: true,
    windowsVerbatimArguments: options.windowsVerbatimArguments ?? false,
  });
  let rootExited = false;
  let stopping = false;
  let settled = false;
  const timers: ReturnType<typeof setTimeout>[] = [];
  let resolveFinished!: () => void;
  const finished = new Promise<void>((resolve) => {
    resolveFinished = resolve;
  });
  const finish = () => {
    if (settled) return;
    settled = true;
    for (const timer of timers) clearTimeout(timer);
    resolveFinished();
  };

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

  child.stdout?.on('data', (chunk: Buffer) => events.onData('out', chunk));
  child.stderr?.on('data', (chunk: Buffer) => events.onData('err', chunk));
  child.on('error', (error: NodeJS.ErrnoException) => {
    events.onError(error);
    finish();
  });
  child.on('exit', (code, signal) => {
    rootExited = true;
    events.onExit(code, signal);
  });
  child.on('close', () => {
    // Descendants may have closed their pipes while ignoring SIGTERM.
    // Do not clear the escalation timer and leave those processes behind.
    if (!windows) signalTree('SIGKILL');
    finish();
  });

  // A write to a process that already exited must not crash the Engine.
  child.stdin?.on('error', () => undefined);

  return {
    finished,
    input: child.stdin ?? null,
    pid: child.pid,
    stop: () => {
      if (stopping || settled) return;
      stopping = true;
      signalTree('SIGTERM');
      timers.push(
        setTimeout(() => {
          signalTree('SIGKILL');
          // Do not wait forever for a process that ignores SIGKILL (e.g. stuck in I/O).
          timers.push(setTimeout(finish, KILL_WAIT_MS));
        }, options.killGraceMs ?? DEFAULT_KILL_GRACE_MS),
      );
    },
  };
}
