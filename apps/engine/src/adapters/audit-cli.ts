import type { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import {
  AUDIT_REPORT_JSON_SCHEMA,
  AUDIT_PROVIDER_NAMES,
  emptyAuditMetrics,
  type AuditProviderAvailability,
  type AuditProviderRunner,
  type AuditRunOutcome,
  type AuditRunRequest,
} from '@atlas/audit';
import type { AiProvider, AuditMetrics } from '@atlas/contracts';
import { findExecutable } from './preflight-executor.js';
import { startProcessTree } from './process-tree.js';
import { profileEnvironment } from './usage-cli.js';

/** `--help` answers within this time, or the CLI is reported unavailable. */
const HELP_TIMEOUT_MS = 15_000;
/** A larger answer is not an audit report; the CLI is stopped. */
const MAX_STDOUT_BYTES = 16 * 1024 * 1024;
const MAX_HELP_BYTES = 1024 * 1024;

/**
 * The only tools Claude Code gets: reading and searching files. `--restricted` removes the
 * tools that run commands or code, ignores user and project settings (and their hooks),
 * confines the file tools to the working directory and refuses bypassing permissions;
 * `dontAsk` denies anything not allowed here instead of asking.
 */
const CLAUDE_READ_TOOLS = 'Read,Grep,Glob';

/** Options each CLI must offer for ATLAS to start a read-only audit with it (FR-006). */
const REQUIRED_OPTIONS: Record<AiProvider, readonly string[]> = {
  claude: [
    '--restricted',
    '--tools',
    '--allowedTools',
    '--permission-mode',
    'dontAsk',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--output-format',
    '--json-schema',
  ],
  codex: [
    '--sandbox',
    'read-only',
    '--ephemeral',
    '--json',
    '--output-schema',
    '--output-last-message',
  ],
};

const HELP_ARGUMENTS: Record<AiProvider, readonly string[]> = {
  claude: ['--help'],
  codex: ['exec', '--help'],
};

export function claudeAuditArguments(): string[] {
  return [
    '-p',
    '--restricted',
    '--tools',
    CLAUDE_READ_TOOLS,
    '--allowedTools',
    CLAUDE_READ_TOOLS,
    '--permission-mode',
    'dontAsk',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(AUDIT_REPORT_JSON_SCHEMA),
  ];
}

/** Codex in its read-only sandbox (no writes, no network), never asking for approval. */
export function codexAuditArguments(input: {
  cwd: string;
  schemaFile: string;
  answerFile: string;
}): string[] {
  return [
    'exec',
    '--sandbox',
    'read-only',
    '-c',
    'approval_policy="never"',
    '--ephemeral',
    '--skip-git-repo-check',
    '--color',
    'never',
    '--json',
    '--output-schema',
    input.schemaFile,
    '--output-last-message',
    input.answerFile,
    '-C',
    input.cwd,
    // The prompt comes from standard input.
    '-',
  ];
}

const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

const sum = (...values: (number | null)[]): number | null =>
  values.every((value) => value === null)
    ? null
    : values.reduce<number>((total, value) => total + (value ?? 0), 0);

/** Claude Code's `--output-format json` result: the answer and what the run used. */
export function parseClaudeResult(
  stdout: string,
):
  | { kind: 'answer'; answer: unknown; metrics: AuditMetrics }
  | { kind: 'error'; detail: string; metrics: AuditMetrics | null }
  | null {
  let value: unknown;
  try {
    value = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const result = value as Record<string, unknown>;
  const usage = (
    typeof result.usage === 'object' && result.usage !== null ? result.usage : {}
  ) as Record<string, unknown>;
  const metrics: AuditMetrics = {
    inputTokens: sum(
      count(usage.input_tokens),
      count(usage.cache_creation_input_tokens),
      count(usage.cache_read_input_tokens),
    ),
    outputTokens: count(usage.output_tokens),
    costUsd: count(result.total_cost_usd),
    durationMs: count(result.duration_ms),
  };
  if (result.is_error === true || (result.subtype !== undefined && result.subtype !== 'success')) {
    const subtype = typeof result.subtype === 'string' ? result.subtype : 'error';
    return { kind: 'error', detail: subtype.replace(/[^a-z_-]/gi, '').slice(0, 60), metrics };
  }
  const answer =
    result.structured_output !== undefined && result.structured_output !== null
      ? result.structured_output
      : result.result;
  return { kind: 'answer', answer, metrics };
}

/** Totals of a Codex `--json` event stream, and the commands it ran. */
export class CodexEventReader {
  private inputTokens: number | null = null;
  private outputTokens: number | null = null;
  private failure: string | null = null;
  private partial = '';

  constructor(
    private readonly onCommand: (command: string) => void,
    private readonly onError: () => void = () => undefined,
  ) {}

  push(chunk: string): void {
    const lines = (this.partial + chunk).split('\n');
    this.partial = lines.pop() ?? '';
    for (const line of lines) this.line(line);
  }

  end(): void {
    if (this.partial !== '') this.line(this.partial);
    this.partial = '';
  }

  get metrics(): AuditMetrics {
    return {
      ...emptyAuditMetrics(),
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
    };
  }

  /** Codex reported a failed turn or an error event. */
  get failed(): string | null {
    return this.failure;
  }

  private line(line: string): void {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof event !== 'object' || event === null) return;
    const { type, usage, item } = event as { type?: unknown; usage?: unknown; item?: unknown };
    if (type === 'turn.completed' && typeof usage === 'object' && usage !== null) {
      const values = usage as Record<string, unknown>;
      this.inputTokens = sum(this.inputTokens, count(values.input_tokens));
      this.outputTokens = sum(this.outputTokens, count(values.output_tokens));
    } else if (type === 'turn.failed') {
      this.failure = 'Codex reported that the audit failed.';
    } else if (type === 'error') {
      // Codex may recover (e.g. a reconnection); only the exit and its answer decide.
      this.onError();
    } else if (
      type === 'item.started' &&
      typeof item === 'object' &&
      item !== null &&
      (item as { type?: unknown }).type === 'command_execution' &&
      typeof (item as { command?: unknown }).command === 'string'
    ) {
      this.onCommand((item as { command: string }).command);
    }
  }
}

export interface CliAuditRunnerOptions {
  platform: NodeJS.Platform;
  home: string;
  /** PATH directories to search (the Engine's and the user's login shell). */
  searchPath: () => Promise<string>;
  /** The ATLAS wrappers' folder: never used, the real CLI is needed. */
  excludeDirectory: string;
  /** Environment of the CLIs: what a new terminal gets. */
  env: () => Record<string, string>;
  /** Private folder for the schema and answer files of Codex runs. */
  tempDirectory: string;
  killGraceMs?: number;
  spawn?: typeof spawn;
}

interface ProcessResult {
  kind: 'exited' | 'cancelled' | 'timed-out' | 'start-failed';
  exitCode: number | null;
  stdout: string;
  /** Standard output went past the limit and the process was stopped. */
  overflow: boolean;
}

/**
 * Runs Claude Code or Codex without a terminal for project audits (SDD-026 FR-006). The
 * prompt goes through standard input, arguments never go through a shell, and each CLI
 * runs with its own read-only restrictions; a CLI without them is reported unavailable.
 */
export class CliAuditRunner implements AuditProviderRunner {
  /** Help checks by executable and modification time. */
  private readonly checked = new Map<string, AuditProviderAvailability>();

  constructor(private readonly options: CliAuditRunnerOptions) {}

  async availability(provider: AiProvider): Promise<AuditProviderAvailability> {
    const name = AUDIT_PROVIDER_NAMES[provider];
    const file = await this.executable(provider);
    if (file === null) {
      return { available: false, reason: `${name} was not found. Install it to audit with it.` };
    }
    const modified = (await stat(file).catch(() => null))?.mtimeMs ?? 0;
    const key = `${file}\0${modified}`;
    const cached = this.checked.get(key);
    if (cached !== undefined) return cached;
    const help = await this.spawnCollect(file, HELP_ARGUMENTS[provider], {
      cwd: this.options.home,
      env: this.options.env(),
      timeoutMs: HELP_TIMEOUT_MS,
      signal: new AbortController().signal,
      stdin: null,
      maxStdout: MAX_HELP_BYTES,
      onStdout: () => undefined,
      onStderr: () => undefined,
    });
    if (help.kind !== 'exited' || help.exitCode !== 0) {
      // Not cached: the next check tries again.
      return { available: false, reason: `${name} did not answer. Check its installation.` };
    }
    const missing = REQUIRED_OPTIONS[provider].filter((option) => !help.stdout.includes(option));
    const result: AuditProviderAvailability =
      missing.length === 0
        ? { available: true, reason: null }
        : {
            available: false,
            reason: `This version of ${name} cannot run a read-only audit (missing ${missing.join(', ')}). Update it.`,
          };
    this.checked.set(key, result);
    return result;
  }

  async run(request: AuditRunRequest): Promise<AuditRunOutcome> {
    const name = AUDIT_PROVIDER_NAMES[request.provider];
    // Checked again: the CLI may have changed since the audit was queued.
    const availability = await this.availability(request.provider);
    const file = await this.executable(request.provider);
    if (!availability.available || file === null) {
      return {
        kind: 'failed',
        summary: availability.reason ?? `${name} was not found.`,
        metrics: null,
      };
    }
    const base = this.options.env();
    const env =
      request.profileDirectory === null
        ? base
        : profileEnvironment(request.provider, request.profileDirectory, base, this.options.home);
    return request.provider === 'claude'
      ? this.runClaude(file, env, request)
      : this.runCodex(file, env, request);
  }

  private async runClaude(
    file: string,
    env: Record<string, string>,
    request: AuditRunRequest,
  ): Promise<AuditRunOutcome> {
    const result = await this.spawnCollect(file, claudeAuditArguments(), {
      cwd: request.cwd,
      env,
      timeoutMs: request.timeoutMs,
      signal: request.signal,
      stdin: request.prompt,
      maxStdout: MAX_STDOUT_BYTES,
      onStdout: () => undefined,
      onStderr: (chunk) => request.output(chunk),
    });
    const ended = this.ended(result, 'Claude Code');
    if (ended !== null) return ended;
    const parsed = parseClaudeResult(result.stdout);
    if (parsed === null) {
      return {
        kind: 'failed',
        summary:
          result.exitCode === 0
            ? 'Claude Code did not answer with a result.'
            : `Claude Code exited with code ${result.exitCode}.`,
        metrics: null,
      };
    }
    if (parsed.kind === 'error') {
      return {
        kind: 'failed',
        summary: `Claude Code could not finish the audit (${parsed.detail}).`,
        metrics: parsed.metrics,
      };
    }
    return { kind: 'completed', answer: parsed.answer, metrics: parsed.metrics };
  }

  private async runCodex(
    file: string,
    env: Record<string, string>,
    request: AuditRunRequest,
  ): Promise<AuditRunOutcome> {
    await mkdir(this.options.tempDirectory, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(path.join(this.options.tempDirectory, 'codex-'));
    try {
      const schemaFile = path.join(directory, 'schema.json');
      const answerFile = path.join(directory, 'answer.json');
      await writeFile(schemaFile, JSON.stringify(AUDIT_REPORT_JSON_SCHEMA), { mode: 0o600 });
      const events = new CodexEventReader(
        (command) => request.log(`Codex ran: ${command.replace(/\s+/g, ' ').slice(0, 500)}`),
        () => request.log('Codex reported an error event.'),
      );
      const result = await this.spawnCollect(
        file,
        codexAuditArguments({ cwd: request.cwd, schemaFile, answerFile }),
        {
          cwd: request.cwd,
          env,
          timeoutMs: request.timeoutMs,
          signal: request.signal,
          stdin: request.prompt,
          // Events are read as they arrive; nothing is kept.
          maxStdout: 0,
          onStdout: (chunk) => events.push(chunk),
          onStderr: (chunk) => request.output(chunk),
        },
      );
      events.end();
      const ended = this.ended(result, 'Codex');
      if (ended !== null) return ended;
      if (result.exitCode !== 0 || events.failed !== null) {
        return {
          kind: 'failed',
          summary: events.failed ?? `Codex exited with code ${result.exitCode}.`,
          metrics: events.metrics,
        };
      }
      const answer = await readFile(answerFile, 'utf8').catch(() => null);
      if (answer === null || answer.length > MAX_STDOUT_BYTES) {
        return {
          kind: 'failed',
          summary: 'Codex did not answer with a result.',
          metrics: events.metrics,
        };
      }
      return { kind: 'completed', answer, metrics: events.metrics };
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** The outcome of a process that did not exit by itself, or null when it did. */
  private ended(result: ProcessResult, name: string): AuditRunOutcome | null {
    switch (result.kind) {
      case 'cancelled':
        return { kind: 'cancelled' };
      case 'timed-out':
        return { kind: 'timed-out' };
      case 'start-failed':
        return { kind: 'failed', summary: `${name} could not start.`, metrics: null };
      case 'exited':
        return result.overflow
          ? { kind: 'failed', summary: `${name} answered with too much output.`, metrics: null }
          : null;
    }
  }

  private async executable(provider: AiProvider): Promise<string | null> {
    return findExecutable(
      provider,
      await this.options.searchPath(),
      this.options.platform,
      this.options.excludeDirectory,
    );
  }

  /** Runs a CLI without a shell; `maxStdout` 0 streams standard output without keeping it. */
  private spawnCollect(
    file: string,
    args: readonly string[],
    execution: {
      cwd: string;
      env: Record<string, string>;
      timeoutMs: number;
      signal: AbortSignal;
      stdin: string | null;
      maxStdout: number;
      onStdout: (chunk: string) => void;
      onStderr: (chunk: string) => void;
    },
  ): Promise<ProcessResult> {
    return new Promise<ProcessResult>((resolve) => {
      const decoders = { out: new StringDecoder('utf8'), err: new StringDecoder('utf8') };
      let stdout = '';
      let overflow = false;
      let kind: ProcessResult['kind'] | null = null;
      let exitCode: number | null = null;
      const settle = (result: ProcessResult['kind'], code: number | null = null) => {
        if (kind !== null) return;
        kind = result;
        exitCode = code;
        clearTimeout(timer);
        execution.signal.removeEventListener('abort', onAbort);
        tree.stop();
      };
      const onAbort = () => settle('cancelled');
      const timer = setTimeout(() => settle('timed-out'), execution.timeoutMs);
      const emit = (stream: 'out' | 'err', text: string) => {
        if (text === '') return;
        if (stream === 'err') {
          execution.onStderr(text);
          return;
        }
        execution.onStdout(text);
        if (execution.maxStdout === 0) return;
        stdout += text;
        if (stdout.length > execution.maxStdout) {
          overflow = true;
          stdout = '';
          settle('exited');
        }
      };
      const tree = startProcessTree(
        {
          file,
          args,
          cwd: execution.cwd,
          env: execution.env,
          platform: this.options.platform,
          stdin: execution.stdin === null ? 'ignore' : 'pipe',
          ...(this.options.killGraceMs === undefined
            ? {}
            : { killGraceMs: this.options.killGraceMs }),
          ...(this.options.spawn ? { spawn: this.options.spawn } : {}),
        },
        {
          onData: (stream, chunk) => emit(stream, decoders[stream].write(chunk)),
          onError: () => settle('start-failed'),
          onExit: (code) => settle('exited', code),
        },
      );
      if (execution.stdin !== null) tree.input?.end(execution.stdin, 'utf8');
      if (execution.signal.aborted) onAbort();
      else execution.signal.addEventListener('abort', onAbort, { once: true });
      void tree.finished.then(() => {
        for (const stream of ['out', 'err'] as const) emit(stream, decoders[stream].end());
        resolve({ kind: kind ?? 'cancelled', exitCode, stdout, overflow });
      });
    });
  }
}
