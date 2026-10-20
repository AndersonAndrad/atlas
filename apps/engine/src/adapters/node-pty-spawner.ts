import { createRequire } from 'node:module';
import type { PtyProcess, PtySpawnOptions, PtySpawner } from '@atlas/terminal';
import type * as NodePty from 'node-pty';

const require = createRequire(import.meta.url);

let nodePty: typeof NodePty | undefined;
/** Loads the native module lazily so CLI-only Engine usage never loads it. */
function loadNodePty(): typeof NodePty {
  nodePty ??= require('node-pty') as typeof NodePty;
  return nodePty;
}

/** PtySpawner backed by node-pty (forkpty on macOS/Linux, ConPTY on Windows). */
export class NodePtySpawner implements PtySpawner {
  spawn(options: PtySpawnOptions): PtyProcess {
    const pty = loadNodePty().spawn(options.file, options.args, {
      name: options.env.TERM ?? 'xterm-256color',
      cwd: options.cwd,
      env: options.env,
      cols: options.columns,
      rows: options.rows,
      encoding: 'utf8',
    });
    return new NodePtyProcess(pty);
  }
}

class NodePtyProcess implements PtyProcess {
  constructor(private readonly pty: NodePty.IPty) {}

  get pid(): number {
    return this.pty.pid;
  }

  get foregroundProcess(): string | undefined {
    // On Windows node-pty reports the shell name regardless of what runs in it.
    if (process.platform === 'win32') return undefined;
    try {
      return this.pty.process || undefined;
    } catch {
      return undefined;
    }
  }

  write(data: string): void {
    this.pty.write(data);
  }

  resize(columns: number, rows: number): void {
    try {
      this.pty.resize(columns, rows);
    } catch {
      // The process may have exited between the status check and the resize.
    }
  }

  pause(): void {
    this.pty.pause();
  }

  resume(): void {
    this.pty.resume();
  }

  kill(signal?: 'SIGHUP' | 'SIGKILL'): void {
    try {
      if (process.platform === 'win32') this.pty.kill();
      else this.pty.kill(signal);
    } catch {
      // Already exited.
    }
  }

  onData(listener: (data: string) => void): void {
    this.pty.onData(listener);
  }

  onExit(listener: (exit: { exitCode: number; signal?: number }) => void): void {
    this.pty.onExit(({ exitCode, signal }) =>
      listener(signal === undefined ? { exitCode } : { exitCode, signal }),
    );
  }
}
