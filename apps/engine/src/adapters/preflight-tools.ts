import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { PreflightEnvironmentStatus, PreflightToolStatus } from '@atlas/contracts';
import type { PreflightTools } from '@atlas/preflight';
import { findExecutable } from './preflight-executor.js';

/** Answers are reused this long unless a refresh is requested. */
export const TOOLS_CACHE_MS = 30_000;
const PROBE_TIMEOUT_MS = 10_000;

export interface PreflightToolsOptions {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  home: string;
  searchPath: () => Promise<string>;
  excludeDirectory?: string;
  now?: () => Date;
  /** Replaces running a probe, for tests: resolves with its standard output. */
  probe?: (file: string, args: string[], env: Record<string, string>) => Promise<string>;
}

function runProbe(file: string, args: string[], env: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { env, timeout: PROBE_TIMEOUT_MS, maxBuffer: 64 * 1024, windowsHide: true },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

/**
 * Detects `act` and a running Docker engine (FR-707) by asking each for its version.
 * Nothing is installed or started; a missing tool is reported with what to do.
 */
export class ActDockerTools implements PreflightTools {
  private cached: { at: number; status: Promise<PreflightEnvironmentStatus> } | null = null;

  constructor(private readonly options: PreflightToolsOptions) {}

  status(refresh: boolean): Promise<PreflightEnvironmentStatus> {
    const now = (this.options.now ?? (() => new Date()))();
    if (!refresh && this.cached !== null && now.getTime() - this.cached.at < TOOLS_CACHE_MS) {
      return this.cached.status;
    }
    const status = this.detect(now);
    this.cached = { at: now.getTime(), status };
    return status;
  }

  async actConfigFiles(workspacePath: string): Promise<string[]> {
    const { env, home, platform } = this.options;
    const candidates = [
      path.join(home, '.actrc'),
      path.join(env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'act', 'actrc'),
      ...(platform === 'darwin'
        ? [path.join(home, 'Library', 'Application Support', 'act', 'actrc')]
        : []),
      path.join(workspacePath, '.actrc'),
    ];
    const found: string[] = [];
    for (const candidate of candidates) {
      if ((await stat(candidate).catch(() => null))?.isFile()) {
        found.push(candidate.startsWith(home) ? `~${candidate.slice(home.length)}` : candidate);
      }
    }
    return found;
  }

  private async detect(now: Date): Promise<PreflightEnvironmentStatus> {
    const searchPath = await this.options.searchPath();
    const env: Record<string, string> = { PATH: searchPath };
    for (const name of [
      'HOME',
      'USER',
      'DOCKER_HOST',
      'DOCKER_CONTEXT',
      'DOCKER_CONFIG',
      'SystemRoot',
    ]) {
      const value = this.options.env[name];
      if (value !== undefined) env[name] = value;
    }
    const probe = this.options.probe ?? runProbe;
    const find = (name: string) =>
      findExecutable(
        name,
        searchPath,
        this.options.platform,
        this.options.excludeDirectory ?? null,
      );

    const [act, docker] = await Promise.all([
      (async (): Promise<PreflightToolStatus> => {
        const file = await find('act');
        if (file === null) return { available: false, detail: 'not installed (see nektosact.com)' };
        try {
          const output = await probe(file, ['--version'], env);
          const version = /(\d+\.\d+\.\d+)/.exec(output)?.[1];
          return { available: true, detail: version ?? 'installed' };
        } catch {
          return { available: false, detail: 'installed but did not answer' };
        }
      })(),
      (async (): Promise<PreflightToolStatus> => {
        const file = await find('docker');
        if (file === null) return { available: false, detail: 'not installed' };
        try {
          const output = await probe(file, ['version', '--format', '{{.Server.Version}}'], env);
          const version = output.trim().split(/\s+/)[0];
          return version
            ? { available: true, detail: version }
            : { available: false, detail: 'the Docker engine is not running' };
        } catch {
          return { available: false, detail: 'the Docker engine is not running' };
        }
      })(),
    ]);
    return { act, docker, checkedAt: now.toISOString() };
  }
}
