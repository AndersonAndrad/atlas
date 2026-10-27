import type { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { DockerCliResult, DockerCliStream, DockerRunner } from '@atlas/docker';
import { findExecutable } from './preflight-executor.js';
import { startProcessTree } from './process-tree.js';

/** Variables the Docker CLI needs (contexts, credential helpers, SSH contexts). */
const DOCKER_ENVIRONMENT = [
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
  'SSH_AUTH_SOCK',
  'XDG_CONFIG_HOME',
  'XDG_RUNTIME_DIR',
  'SystemRoot',
  'ComSpec',
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
  'ProgramData',
] as const;
/** Output kept per call; listing thousands of containers stays well below it. */
const MAX_OUTPUT_CHARS = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

export interface DockerCliRunnerOptions {
  /** Where `docker` is looked up: the Engine PATH, then the login shell PATH. */
  searchPath: () => Promise<string>;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  /** Replaces `child_process.spawn` in tests. */
  spawn?: typeof spawn;
  killGraceMs?: number;
}

/**
 * The Docker CLI as a process with an argument list (SDD-013): never a shell, a minimal
 * environment, a timeout, and the whole process tree stopped on timeout or close.
 */
export class DockerCliRunner implements DockerRunner {
  private resolved: { at: number; file: Promise<string | null> } | null = null;

  constructor(private readonly options: DockerCliRunnerOptions) {}

  async available(): Promise<boolean> {
    return (await this.executable()) !== null;
  }

  async run(
    args: readonly string[],
    options: { timeoutMs?: number } = {},
  ): Promise<DockerCliResult> {
    const launch = await this.launch();
    if (launch === null)
      return { exitCode: null, stdout: '', stderr: 'docker: not found', timedOut: false };
    return new Promise<DockerCliResult>((resolve) => {
      const output = { out: '', err: '' };
      const decoders = { out: new StringDecoder('utf8'), err: new StringDecoder('utf8') };
      let exitCode: number | null = null;
      let timedOut = false;
      let startError: string | null = null;
      const tree = startProcessTree(
        { ...launch, args: [...args] },
        {
          onData: (stream, chunk) => {
            if (output[stream].length < MAX_OUTPUT_CHARS)
              output[stream] += decoders[stream].write(chunk);
          },
          onExit: (code) => {
            exitCode = code;
          },
          onError: (error) => {
            startError = error.message;
          },
        },
      );
      const timer = setTimeout(() => {
        timedOut = true;
        tree.stop();
      }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      void tree.finished.then(() => {
        clearTimeout(timer);
        resolve({
          exitCode: timedOut ? null : exitCode,
          stdout: output.out + decoders.out.end(),
          stderr: startError ?? output.err + decoders.err.end(),
          timedOut,
        });
      });
    });
  }

  stream(
    args: readonly string[],
    onData: (stream: 'out' | 'err', chunk: string) => void,
  ): DockerCliStream {
    let stopRequested = false;
    let tree: { stop(): void } | null = null;
    const done = this.launch().then(
      (launch) =>
        new Promise<number | null>((resolve) => {
          if (launch === null || stopRequested) {
            resolve(null);
            return;
          }
          const decoders = { out: new StringDecoder('utf8'), err: new StringDecoder('utf8') };
          let exitCode: number | null = null;
          const started = startProcessTree(
            { ...launch, args: [...args] },
            {
              onData: (stream, chunk) => onData(stream, decoders[stream].write(chunk)),
              onExit: (code) => {
                exitCode = code;
              },
              onError: () => undefined,
            },
          );
          tree = started;
          void started.finished.then(() => resolve(exitCode));
        }),
    );
    return {
      done,
      stop: () => {
        stopRequested = true;
        tree?.stop();
      },
    };
  }

  async withPrivateFile<T>(content: string, use: (file: string) => Promise<T>): Promise<T> {
    const folder = await mkdtemp(path.join(os.tmpdir(), 'atlas-docker-'));
    try {
      const file = path.join(folder, 'values');
      await writeFile(file, content, { mode: 0o600 });
      return await use(file);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  }

  /** Found once a minute, so installing Docker is noticed without restarting ATLAS. */
  private executable(): Promise<string | null> {
    if (this.resolved !== null && Date.now() - this.resolved.at < 60_000) return this.resolved.file;
    const file = this.options
      .searchPath()
      .then((searchPath) => findExecutable('docker', searchPath, this.options.platform))
      .catch(() => null);
    this.resolved = { at: Date.now(), file };
    return file;
  }

  private async launch() {
    const file = await this.executable();
    if (file === null) return null;
    const searchPath = await this.options.searchPath();
    const env: Record<string, string> = {
      PATH: searchPath,
      // No tips or update notices mixed into the output.
      DOCKER_CLI_HINTS: 'false',
    };
    for (const name of DOCKER_ENVIRONMENT) {
      const value = this.options.env[name];
      if (value !== undefined) env[name] = value;
    }
    return {
      file,
      cwd: this.options.env.HOME ?? os.homedir(),
      env,
      platform: this.options.platform,
      ...(this.options.killGraceMs === undefined ? {} : { killGraceMs: this.options.killGraceMs }),
      ...(this.options.spawn ? { spawn: this.options.spawn } : {}),
    };
  }
}
