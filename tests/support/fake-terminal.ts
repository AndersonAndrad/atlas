import type {
  PtyExit,
  PtyProcess,
  PtySpawnOptions,
  PtySpawner,
  ScreenMirror,
  ScreenMirrorFactory,
  ShellProvider,
} from '@atlas/terminal';
import type { ShellCatalog, ShellOption } from '@atlas/contracts';

/** Scriptable in-memory PTY used by unit tests (no real processes). */
export class FakePty implements PtyProcess {
  static nextPid = 1000;
  readonly pid = FakePty.nextPid++;
  foregroundProcess: string | undefined;
  readonly written: string[] = [];
  readonly resizes: [number, number][] = [];
  readonly kills: (string | undefined)[] = [];
  paused = false;
  private dataListeners: ((data: string) => void)[] = [];
  private exitListeners: ((exit: PtyExit) => void)[] = [];
  /** When true, kill() makes the process exit (like a shell receiving SIGHUP). */
  exitOnKill = true;

  constructor(readonly options: PtySpawnOptions) {
    this.foregroundProcess = options.file.split('/').pop();
  }

  write(data: string): void {
    this.written.push(data);
  }
  resize(columns: number, rows: number): void {
    this.resizes.push([columns, rows]);
  }
  pause(): void {
    this.paused = true;
  }
  resume(): void {
    this.paused = false;
  }
  kill(signal?: 'SIGHUP' | 'SIGKILL'): void {
    this.kills.push(signal);
    if (this.exitOnKill || signal === 'SIGKILL') {
      queueMicrotask(() => this.exit({ exitCode: 0, signal: signal === 'SIGKILL' ? 9 : 1 }));
    }
  }
  onData(listener: (data: string) => void): void {
    this.dataListeners.push(listener);
  }
  onExit(listener: (exit: PtyExit) => void): void {
    this.exitListeners.push(listener);
  }

  /** Simulates output from the process. */
  emit(data: string): void {
    for (const listener of this.dataListeners) listener(data);
  }
  /** Simulates the process exiting on its own. */
  exit(exit: PtyExit): void {
    const listeners = this.exitListeners;
    this.exitListeners = [];
    for (const listener of listeners) listener(exit);
  }
}

export class FakePtySpawner implements PtySpawner {
  readonly spawned: FakePty[] = [];
  failNext: Error | undefined;

  spawn(options: PtySpawnOptions): PtyProcess {
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = undefined;
      throw error;
    }
    const pty = new FakePty(options);
    this.spawned.push(pty);
    return pty;
  }

  last(): FakePty {
    const pty = this.spawned.at(-1);
    if (!pty) throw new Error('No PTY spawned');
    return pty;
  }
}

/** Mirror that records raw output; serialize() returns everything written since clear(). */
export class FakeMirror implements ScreenMirror {
  content = '';
  size: [number, number];
  disposed = false;
  constructor(columns: number, rows: number) {
    this.size = [columns, rows];
  }
  write(data: string, callback?: () => void): void {
    this.content += data;
    if (callback) queueMicrotask(callback);
  }
  resize(columns: number, rows: number): void {
    this.size = [columns, rows];
  }
  clear(): void {
    this.content = '';
  }
  serialize(): string {
    return this.content;
  }
  dispose(): void {
    this.disposed = true;
  }
}

export class FakeMirrorFactory implements ScreenMirrorFactory {
  readonly created: FakeMirror[] = [];
  create(columns: number, rows: number): ScreenMirror {
    const mirror = new FakeMirror(columns, rows);
    this.created.push(mirror);
    return mirror;
  }
}

export const FAKE_SHELLS: ShellOption[] = [
  { id: 'zsh', name: 'zsh', path: '/bin/zsh', args: ['-l'], source: 'system', isDefault: false },
  { id: 'bash', name: 'bash', path: '/bin/bash', args: ['-l'], source: 'system', isDefault: false },
];

export class FakeShellProvider implements ShellProvider {
  shells: ShellOption[] = FAKE_SHELLS.map((shell) => ({ ...shell }));
  async catalog(preferredId: string | null): Promise<ShellCatalog> {
    const shells = this.shells.map((shell) => ({ ...shell, isDefault: false }));
    const chosen = shells.find((shell) => shell.id === preferredId) ?? shells[0];
    if (chosen) chosen.isDefault = true;
    return { shells, configurationIssues: [] };
  }
}
