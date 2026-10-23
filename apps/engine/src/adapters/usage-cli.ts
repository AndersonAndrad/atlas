import { spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import path from 'node:path';
import type { AiProvider } from '@atlas/contracts';
import {
  PROFILE_ENV,
  UsageCollectionFailure,
  defaultProfileDirectory,
  parseClaudeAuthStatus,
  parseCodexAccount,
  parseCodexDailyTokens,
  parseCodexRateLimits,
  type AccountState,
  type ClaudeAuthReader,
  type CodexLimits,
  type CodexReader,
} from '@atlas/usage';

/** A provider CLI that does not answer within this time is stopped. */
export const USAGE_CLI_TIMEOUT_MS = 20_000;
/** More output than this is not a status answer; the CLI is stopped. */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export interface UsageCliOptions {
  /** Environment of the Engine; the CLIs run with it plus the profile directory. */
  env: Record<string, string | undefined>;
  home: string;
  /** PATH directories to search (e.g. the Engine's and the user's login shell). */
  searchPath: () => Promise<string>;
  /** The ATLAS wrappers' folder: never used, the real CLI is needed. */
  excludeDirectory: string;
  timeoutMs?: number;
  spawn?: typeof spawn;
}

async function isExecutable(file: string): Promise<boolean> {
  try {
    await access(file, constants.X_OK);
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/** The CLI's environment for one profile. The default profile runs without the variable. */
export function profileEnvironment(
  providerId: AiProvider,
  profileDirectory: string,
  env: Record<string, string | undefined>,
  home: string,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) if (value !== undefined) result[name] = value;
  const variable = PROFILE_ENV[providerId];
  // Claude Code keeps `.claude.json` in HOME only when CLAUDE_CONFIG_DIR is unset.
  if (path.resolve(profileDirectory) === defaultProfileDirectory(providerId, home)) {
    delete result[variable];
  } else {
    result[variable] = profileDirectory;
  }
  return result;
}

class UsageCli {
  constructor(protected readonly options: UsageCliOptions) {}

  protected async executable(name: string): Promise<string> {
    const directories = (await this.options.searchPath()).split(path.delimiter);
    for (const directory of directories) {
      if (
        directory === '' ||
        path.resolve(directory) === path.resolve(this.options.excludeDirectory)
      ) {
        continue;
      }
      const file = path.join(directory, name);
      if (await isExecutable(file)) return file;
    }
    throw new UsageCollectionFailure(
      'cli-not-found',
      `The ${name === 'claude' ? 'Claude Code' : 'Codex'} CLI was not found on this computer.`,
      'UNKNOWN',
    );
  }

  protected start(
    providerId: AiProvider,
    file: string,
    args: string[],
    profileDirectory: string,
  ): ChildProcess {
    return (this.options.spawn ?? spawn)(file, args, {
      // Never the profile folder: it may have been removed since it was registered.
      cwd: this.options.home,
      env: profileEnvironment(providerId, profileDirectory, this.options.env, this.options.home),
      stdio: ['pipe', 'pipe', 'ignore'],
    });
  }

  protected get timeoutMs(): number {
    return this.options.timeoutMs ?? USAGE_CLI_TIMEOUT_MS;
  }
}

type RpcResult = { result: unknown } | { error: unknown };

/**
 * Reads a Codex profile through `codex app-server` (JSON-RPC over stdio): the account,
 * its rate limits and its daily token usage. These calls never run a model.
 */
export class CodexAppServerReader extends UsageCli implements CodexReader {
  async read(profileDirectory: string) {
    const file = await this.executable('codex');
    const answers = await this.exchange(file, profileDirectory);
    const account = answers.get(2);
    if (account === undefined || !('result' in account)) {
      throw new UsageCollectionFailure('unexpected-response', 'Codex did not report the account.');
    }
    const state = this.parse(() => parseCodexAccount(account.result));
    if (state.status === 'AUTH_REQUIRED') {
      throw new UsageCollectionFailure(
        'auth-required',
        'Sign in to this Codex profile (codex login) to see its limits.',
        'AUTH_REQUIRED',
      );
    }
    const limitsAnswer = answers.get(3);
    const usageAnswer = answers.get(4);
    // An account without plan limits (e.g. an API key) answers these with an error.
    const limits: CodexLimits =
      limitsAnswer !== undefined && 'result' in limitsAnswer
        ? this.parse(() => parseCodexRateLimits(limitsAnswer.result, new Date().toISOString()))
        : { windows: [], plan: null, limited: false };
    const daily =
      usageAnswer !== undefined && 'result' in usageAnswer
        ? this.parse(() => parseCodexDailyTokens(usageAnswer.result))
        : [];
    return { account: state, limits, daily };
  }

  private parse<T>(read: () => T): T {
    try {
      return read();
    } catch {
      throw new UsageCollectionFailure(
        'unexpected-response',
        'Codex returned data ATLAS does not understand. Update ATLAS or Codex.',
      );
    }
  }

  private exchange(file: string, profileDirectory: string): Promise<Map<number, RpcResult>> {
    return new Promise((resolve, reject) => {
      const child = this.start('codex', file, ['app-server'], profileDirectory);
      const answers = new Map<number, RpcResult>();
      let buffer = '';
      let received = 0;
      let settled = false;
      const finish = (error: Error | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill();
        if (error === null) resolve(answers);
        else reject(error);
      };
      const timer = setTimeout(
        () => finish(new UsageCollectionFailure('timeout', 'Codex did not answer in time.')),
        this.timeoutMs,
      );
      const send = (message: Record<string, unknown>) =>
        child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
      child.on('error', () =>
        finish(new UsageCollectionFailure('cli-failed', 'Codex could not be started.')),
      );
      child.on('close', () =>
        finish(
          answers.size >= 3
            ? null
            : new UsageCollectionFailure('cli-failed', 'Codex stopped before answering.'),
        ),
      );
      child.stdin?.on('error', () => undefined);
      child.stdout?.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (received > MAX_OUTPUT_BYTES) {
          finish(new UsageCollectionFailure('unexpected-response', 'Codex answered too much.'));
          return;
        }
        buffer += chunk.toString('utf8');
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          let message: { id?: unknown; result?: unknown; error?: unknown };
          try {
            message = JSON.parse(line) as typeof message;
          } catch {
            continue; // Not a protocol message.
          }
          if (message.id === 1) {
            if (message.error !== undefined) {
              finish(new UsageCollectionFailure('cli-failed', 'Codex refused the connection.'));
              return;
            }
            send({ method: 'initialized' });
            send({ id: 2, method: 'account/read', params: { refreshToken: false } });
            send({ id: 3, method: 'account/rateLimits/read' });
            send({ id: 4, method: 'account/usage/read', params: {} });
          } else if (typeof message.id === 'number' && message.id >= 2 && message.id <= 4) {
            answers.set(
              message.id,
              message.error !== undefined ? { error: message.error } : { result: message.result },
            );
            if (answers.size === 3) finish(null);
          }
        }
      });
      send({
        id: 1,
        method: 'initialize',
        params: { clientInfo: { name: 'atlas', title: 'A.T.L.A.S', version: '1' } },
      });
    });
  }
}

/** Reads `claude auth status --json` of a Claude Code profile (no model request). */
export class ClaudeAuthStatusReader extends UsageCli implements ClaudeAuthReader {
  async read(profileDirectory: string): Promise<AccountState> {
    const file = await this.executable('claude');
    const output = await new Promise<string>((resolve, reject) => {
      const child = this.start('claude', file, ['auth', 'status', '--json'], profileDirectory);
      child.stdin?.end();
      const chunks: Buffer[] = [];
      let size = 0;
      const timer = setTimeout(() => {
        child.kill();
        reject(new UsageCollectionFailure('timeout', 'Claude Code did not answer in time.'));
      }, this.timeoutMs);
      child.stdout?.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size <= MAX_OUTPUT_BYTES) chunks.push(chunk);
      });
      child.on('error', () => {
        clearTimeout(timer);
        reject(new UsageCollectionFailure('cli-failed', 'Claude Code could not be started.'));
      });
      // Signed-out profiles may exit with an error and still print their status.
      child.on('close', () => {
        clearTimeout(timer);
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
    });
    try {
      return parseClaudeAuthStatus(JSON.parse(output));
    } catch {
      throw new UsageCollectionFailure(
        'unexpected-response',
        'Claude Code returned a sign-in status ATLAS does not understand.',
      );
    }
  }
}
