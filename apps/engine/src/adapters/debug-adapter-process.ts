import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import type {
  AdapterLaunch,
  AdapterLauncher,
  AdapterProcess,
  AdapterProcessEvents,
  DebugFileSystem,
} from '@atlas/debugger';
import { startProcessTree } from './process-tree.js';

/** Grace period between SIGTERM and SIGKILL for an adapter that ignores `disconnect`. */
const ADAPTER_KILL_GRACE_MS = 2000;

/**
 * The environment an adapter gets: the Engine's, without Electron and ATLAS internals.
 * The debugged program's environment is sent in the `launch` request instead.
 */
export function adapterEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || name.startsWith('ELECTRON_') || name.startsWith('ATLAS_')) continue;
    result[name] = value;
  }
  return result;
}

/**
 * Debug adapters as process trees (SDD-016 Task 01): no shell, standard input and output
 * piped for DAP, the whole tree stopped on `stop`.
 */
export class ProcessTreeAdapterLauncher implements AdapterLauncher {
  constructor(
    private readonly env: NodeJS.ProcessEnv,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  launch(spec: AdapterLaunch, events: AdapterProcessEvents): AdapterProcess {
    let exited = false;
    const exit = (code: number | null, signal: string | null, error: Error | null) => {
      if (exited) return;
      exited = true;
      events.onExit(code, signal, error);
    };
    const tree = startProcessTree(
      {
        file: spec.command,
        args: spec.args,
        cwd: spec.cwd,
        env: adapterEnvironment(this.env),
        platform: this.platform,
        stdin: 'pipe',
        killGraceMs: ADAPTER_KILL_GRACE_MS,
      },
      {
        onData: (stream, chunk) =>
          stream === 'out' ? events.onStdout(chunk) : events.onStderr(chunk),
        onExit: (code, signal) => exit(code, signal, null),
        onError: (error) => exit(null, null, error),
      },
    );
    return {
      write: (data) => {
        if (tree.input !== null && !tree.input.destroyed) tree.input.write(data);
      },
      stop: () => tree.stop(),
      finished: tree.finished,
      get pid() {
        return tree.pid;
      },
    };
  }
}

/** Real paths of executables and folders for the session manager's checks. */
export class NodeDebugFileSystem implements DebugFileSystem {
  async executable(absolutePath: string): Promise<string | null> {
    try {
      const real = await realpath(absolutePath);
      if (!(await stat(real)).isFile()) return null;
      await access(real, constants.X_OK);
      return real;
    } catch {
      return null;
    }
  }

  async directory(absolutePath: string): Promise<string | null> {
    try {
      const real = await realpath(absolutePath);
      return (await stat(real)).isDirectory() ? real : null;
    } catch {
      return null;
    }
  }
}
