import path from 'node:path';
import {
  ExecuteTaskSchema,
  type AiProvider,
  type AiSession,
  type ContextTarget,
  type CreateNotificationInput,
  type ExecuteTaskInput,
  type LlmWrapperStatus,
  type ParsedExecuteTaskInput,
  type TaskExecution,
  type TaskExecutionOptions,
  type TaskTerminalBlocker,
  type TaskTerminalOption,
  type TerminalSession,
  type UsageProfile,
  NOTIFICATION_MESSAGE_MAX,
  NOTIFICATION_TITLE_MAX,
  TERMINAL_TITLE_MAX_LENGTH,
  parseInput,
} from '@atlas/contracts';
import type { ResolvedTarget, SharedContextService, TaskExecutionTracker } from '@atlas/context';
import { AtlasError, describeError, type Logger } from '@atlas/shared';
import type { TerminalService } from '@atlas/terminal';

export const PROVIDER_NAMES: Record<AiProvider, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
};

/** Where each CLI reads its account configuration (the usage profile's directory). */
const PROFILE_VARIABLES: Record<AiProvider, string> = {
  claude: 'CLAUDE_CONFIG_DIR',
  codex: 'CODEX_HOME',
};

/** Shells whose line editor ATLAS can clear before typing (Ctrl+E, Ctrl+U). */
const LINE_EDITING_SHELLS = new Set(['zsh', 'bash']);
/** Ctrl+E (end of line) then Ctrl+U (kill line): text the user left at the prompt goes. */
const CLEAR_LINE = '\x05\x15';
const CTRL_C = '\x03';
/** Claude Code and Codex stop on a second Ctrl+C; the pause lets the first one land. */
const SECOND_INTERRUPT_DELAY_MS = 400;

/** What the Engine prepared for a provider: its session and the line to type. */
export interface PreparedAiLaunch {
  session: AiSession;
  /** Shell text that starts the provider with the private prompt file. */
  command: string;
}

export interface TaskExecutionServiceDependencies {
  tracker: TaskExecutionTracker;
  context: SharedContextService;
  resolveContextTarget: (target: ContextTarget) => Promise<ResolvedTarget>;
  terminals: () => TerminalService;
  projectName: (projectId: string) => Promise<string | null>;
  wrapperStatus: (target: ResolvedTarget) => Promise<Record<AiProvider, LlmWrapperStatus>>;
  profiles: () => Promise<UsageProfile[]>;
  /** The first message: the task's context with the selection the dialog previewed. */
  buildPrompt: (input: {
    target: ResolvedTarget;
    request: ParsedExecuteTaskInput;
  }) => Promise<string | null>;
  /** Records the managed AI session and writes the prompt to its private file. */
  prepareLaunch: (input: {
    target: ResolvedTarget;
    request: ParsedExecuteTaskInput;
    terminal: TerminalSession;
    prompt: string | null;
  }) => Promise<PreparedAiLaunch>;
  /** Acknowledges the terminal's tab status (explicit review). */
  markTerminalReviewed: (terminalId: string) => Promise<void>;
  publishNotification: (input: CreateNotificationInput) => Promise<void>;
  /** Refreshes what depends on the owner's context (e.g. the project's context file). */
  contextChanged: (target: ResolvedTarget) => Promise<void>;
  generateId: () => string;
  logger: Logger;
}

const shellName = (session: TerminalSession) =>
  path
    .basename(session.shell.name || session.shell.path)
    .replace(/^-/, '')
    .replace(/\.exe$/i, '')
    .toLowerCase();

const isPowerShell = (session: TerminalSession) => /pwsh|powershell/i.test(session.shell.name);

const isInside = (child: string, parent: string) => {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

const sameOwner = (execution: TaskExecution, target: ResolvedTarget) =>
  execution.projectId === target.owner.projectId &&
  execution.workspacePath === target.owner.workspacePath;

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

const truncate = (value: string, max: number) =>
  value.length <= max ? value : `${value.slice(0, max - 1)}…`;

/**
 * Explicit execution of shared-context tasks by Claude Code or Codex in a terminal
 * (SDD-025 Task 02). Every run follows the user's confirmation, reuses the managed AI
 * session launch, and is tracked by the wrapper events like the terminal tab status.
 * Existing terminals receive input only after a readiness check made here, never from
 * terminal output. A run never completes its task.
 */
export class TaskExecutionService {
  /** One start at a time: duplicate checks and launches never interleave. */
  private starting: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: TaskExecutionServiceDependencies) {}

  async options(rawTarget: ContextTarget, taskId: string): Promise<TaskExecutionOptions> {
    const target = await this.deps.resolveContextTarget(rawTarget);
    await this.deps.context.getTask(target, taskId);
    const [wrappers, profiles] = await Promise.all([
      this.deps.wrapperStatus(target),
      this.deps.profiles(),
    ]);
    const names = new Map<string, string | null>();
    const terminals: TaskTerminalOption[] = [];
    for (const session of this.deps.terminals().list()) {
      if (session.projectId !== null && !names.has(session.projectId)) {
        names.set(session.projectId, await this.deps.projectName(session.projectId));
      }
      const readiness = await this.readiness(session);
      terminals.push({
        terminalId: session.id,
        title: session.title,
        projectId: session.projectId,
        projectName: session.projectId === null ? null : (names.get(session.projectId) ?? null),
        currentCwd: session.currentCwd,
        shellName: shellName(session),
        connected: session.status === 'RUNNING',
        sameProject: this.sameProject(session, target),
        blocker: readiness.blocker,
        processName: readiness.processName,
      });
    }
    return {
      providers: (['claude', 'codex'] as const).map((provider) => ({
        provider,
        availability: wrappers[provider],
      })),
      profiles: profiles
        .filter((profile) => !profile.hidden)
        .map((profile) => ({
          id: profile.id,
          provider: profile.providerId,
          displayName: profile.displayName,
          status: profile.status,
          plan: profile.plan,
        })),
      terminals,
      directory: target.directory,
      // Teams run as sequences of task executions (SDD-026 Task 02).
      atlasTeamsAvailable: true,
    };
  }

  async list(rawTarget: ContextTarget, taskId: string): Promise<TaskExecution[]> {
    const target = await this.deps.resolveContextTarget(rawTarget);
    await this.deps.context.getTask(target, taskId);
    return this.deps.tracker.listForTask(taskId);
  }

  /**
   * `groupId` (Engine callers only, e.g. an ATLAS team) puts a new terminal in a terminal
   * group; it is not part of the request a client sends.
   */
  execute(raw: ExecuteTaskInput, options: { groupId?: string } = {}): Promise<TaskExecution> {
    const result = this.starting.then(() => this.start(raw, options));
    this.starting = result.catch(() => undefined);
    return result;
  }

  async cancel(rawTarget: ContextTarget, id: string): Promise<TaskExecution> {
    const execution = await this.owned(rawTarget, id);
    const cancelled = await this.deps.tracker.requestCancel(execution.id);
    // The same keys the user would press; a provider that keeps running stays RUNNING
    // (cancellation pending) until it ends or its terminal is closed.
    this.interrupt(execution.terminalId);
    return cancelled;
  }

  async review(rawTarget: ContextTarget, id: string): Promise<TaskExecution> {
    const execution = await this.owned(rawTarget, id);
    const reviewed = await this.deps.tracker.markReviewed(execution.id);
    try {
      await this.deps.markTerminalReviewed(execution.terminalId);
    } catch (error) {
      // The terminal may have been removed; the execution's review stands.
      this.deps.logger.debug('Terminal review skipped', { error: describeError(error) });
    }
    return reviewed;
  }

  /**
   * A run reached a final status: its managed AI session ends too, with what Git shows
   * changed, so the terminal can receive another task. Projects keeping context may have
   * ended it already at the wrapper's end; untracked runs end it when their terminal closes.
   */
  async settled(execution: TaskExecution): Promise<void> {
    if (execution.aiSessionId === null) return;
    const target = await this.ownerTarget(execution);
    const session = (await this.deps.context.listSessions(target)).find(
      (item) => item.id === execution.aiSessionId,
    );
    if (session === undefined || session.status === 'ended') return;
    await this.deps.context.endSession(
      target,
      session.id,
      { summary: '', completed: [], pending: [], decisions: [], nextActions: [] },
      'atlas',
      { automatic: true },
    );
    await this.deps.contextChanged(target);
  }

  /** Notification for an execution that ended by itself (once per execution). */
  async notifyFinished(execution: TaskExecution): Promise<void> {
    const target = await this.ownerTarget(execution);
    const task = await this.deps.context.getTask(target, execution.taskId);
    const provider = PROVIDER_NAMES[execution.provider];
    const quoted = `“${task.title}”`;
    const [type, title, message] =
      execution.status === 'REVIEW_REQUIRED'
        ? ([
            'ACTION_REQUIRED',
            `${provider} finished a task: review required`,
            `${quoted} ended in ${execution.terminalTitle}. Review the result before marking the task done.`,
          ] as const)
        : execution.status === 'FAILED'
          ? ([
              'ERROR',
              `${provider} task failed`,
              `${quoted} ended with exit code ${execution.exitCode ?? 'unknown'} in ${execution.terminalTitle}.`,
            ] as const)
          : ([
              'WARNING',
              `${provider} task interrupted`,
              `${quoted} stopped because its terminal ended before ${provider} finished.`,
            ] as const);
    await this.deps.publishNotification({
      type,
      category: 'AGENT',
      title: truncate(title, NOTIFICATION_TITLE_MAX),
      message: truncate(message, NOTIFICATION_MESSAGE_MAX),
      projectId: execution.projectId,
      sourceName: target.label,
      taskId: execution.id,
      action: {
        type: 'task-execution',
        executionId: execution.id,
        taskId: execution.taskId,
        projectId: execution.projectId,
        workspacePath: execution.workspacePath,
        terminalId: execution.terminalId,
      },
    });
  }

  private async start(
    raw: ExecuteTaskInput,
    options: { groupId?: string },
  ): Promise<TaskExecution> {
    const request = parseInput(ExecuteTaskSchema, raw);
    const target = await this.deps.resolveContextTarget(request.target);
    const task = await this.deps.context.getTask(target, request.taskId);

    // A repeated confirmation (double click, retry after a lost answer) never runs twice.
    const repeated = await this.deps.tracker.findByRequestId(request.requestId);
    if (repeated !== null) {
      if (repeated.taskId !== task.id || !sameOwner(repeated, target)) {
        throw invalid('requestId', 'This request was already used for another task.');
      }
      return repeated;
    }
    if (task.status !== 'open') {
      throw invalid('taskId', 'Only open tasks can be executed. Reopen the task first.');
    }
    if ((await this.deps.tracker.activeForTask(task.id)) !== null) {
      throw new AtlasError('TASK_EXECUTION_ACTIVE');
    }

    const availability = (await this.deps.wrapperStatus(target))[request.provider];
    if (availability === 'missing') {
      throw new AtlasError('TASK_EXECUTION_PROVIDER_UNAVAILABLE', undefined, {
        details: { provider: request.provider },
      });
    }
    const profile = await this.profile(request);
    const terminals = this.deps.terminals();
    // Built before any terminal opens: a context failure leaves nothing behind.
    const prompt = await this.deps.buildPrompt({ target, request });

    let terminal: TerminalSession;
    let created = false;
    if (request.mode === 'existing-terminal') {
      terminal = terminals.getById(request.terminalId!);
      const { blocker, processName } = await this.readiness(terminal);
      if (blocker !== null) {
        throw new AtlasError('TASK_EXECUTION_TERMINAL_UNAVAILABLE', undefined, {
          details: { blocker },
          issues: [{ field: 'terminalId', message: blockerMessage(blocker, processName) }],
        });
      }
      if (!this.sameProject(terminal, target) && !request.acknowledgeOtherProject) {
        throw new AtlasError('TASK_EXECUTION_CONFIRMATION_REQUIRED');
      }
    } else {
      terminal = await terminals.create({
        ...(target.owner.projectId !== null
          ? { projectId: target.owner.projectId }
          : { cwd: target.directory }),
        ...(options.groupId === undefined ? {} : { groupId: options.groupId }),
        title: truncate(
          `${PROVIDER_NAMES[request.provider]} · ${task.title}`,
          TERMINAL_TITLE_MAX_LENGTH,
        ),
      });
      created = true;
    }

    let prepared: PreparedAiLaunch;
    try {
      prepared = await this.deps.prepareLaunch({ target, request, terminal, prompt });
    } catch (error) {
      // Nothing was typed: a terminal opened only for this run is not left behind.
      if (created) await terminals.terminate(terminal.id).catch(() => undefined);
      throw error;
    }

    const prefix =
      profile === null
        ? ''
        : isPowerShell(terminal)
          ? `$env:${PROFILE_VARIABLES[request.provider]}='${profile.profileDirectory.replace(/'/g, "''")}'; `
          : `${PROFILE_VARIABLES[request.provider]}=${shellQuote(profile.profileDirectory)} `;
    const execution = await this.deps.tracker.create({
      id: this.deps.generateId(),
      requestId: request.requestId,
      taskId: task.id,
      ...target.owner,
      mode: request.mode,
      provider: request.provider,
      profileId: profile?.id ?? null,
      profileName: profile?.displayName ?? null,
      terminalId: terminal.id,
      terminalTitle: terminal.title,
      aiSessionId: prepared.session.id,
      // Without the wrapper (shadowed, Windows, PowerShell) no start or end is reported.
      tracked: availability === 'wrapped' && !isPowerShell(terminal),
    });
    try {
      const clear = request.mode === 'existing-terminal' ? CLEAR_LINE : '';
      terminals.write(terminal.id, `${clear}${prefix}${prepared.command}\r`);
    } catch (error) {
      await this.deps.tracker.launchFailed(execution.id);
      throw error;
    }
    this.deps.logger.info('Task execution started', {
      executionId: execution.id,
      taskId: task.id,
      provider: request.provider,
      mode: request.mode,
      tracked: execution.status === 'LAUNCHING',
    });
    return this.deps.tracker.get(execution.id);
  }

  private async profile(request: ParsedExecuteTaskInput): Promise<UsageProfile | null> {
    if (request.profileId === undefined) return null;
    const profile = (await this.deps.profiles()).find(
      (item) =>
        item.id === request.profileId && item.providerId === request.provider && !item.hidden,
    );
    if (profile === undefined) {
      throw invalid('profileId', 'Choose an account profile of this provider.');
    }
    return profile;
  }

  /** Whether the terminal can receive typed input now; never read from its output. */
  private async readiness(
    session: TerminalSession,
  ): Promise<{ blocker: TaskTerminalBlocker | null; processName: string | null }> {
    if (session.status !== 'RUNNING') return { blocker: 'disconnected', processName: null };
    if ((await this.deps.tracker.activeForTerminal(session.id)) !== null) {
      return { blocker: 'execution-active', processName: null };
    }
    if ((await this.deps.context.sessionForTerminal(session.id)) !== null) {
      return { blocker: 'ai-session-active', processName: null };
    }
    if (!LINE_EDITING_SHELLS.has(shellName(session))) {
      return { blocker: 'unsupported-shell', processName: null };
    }
    const info = this.deps.terminals().closeInfo(session.id);
    if (info.requiresConfirmation) {
      return info.processName === undefined
        ? { blocker: 'process-unknown', processName: null }
        : { blocker: 'busy', processName: info.processName };
    }
    return { blocker: null, processName: null };
  }

  /** In the task's project, or (for standalone terminals) inside its directory. */
  private sameProject(session: TerminalSession, target: ResolvedTarget): boolean {
    if (session.projectId !== null) return session.projectId === target.owner.projectId;
    return isInside(session.currentCwd, target.directory);
  }

  private ownerTarget(execution: TaskExecution): Promise<ResolvedTarget> {
    return this.deps.resolveContextTarget(
      execution.projectId !== null
        ? { projectId: execution.projectId }
        : { workspacePath: execution.workspacePath! },
    );
  }

  private async owned(rawTarget: ContextTarget, id: string): Promise<TaskExecution> {
    const target = await this.deps.resolveContextTarget(rawTarget);
    const execution = await this.deps.tracker.get(id);
    if (!sameOwner(execution, target)) throw new AtlasError('TASK_EXECUTION_NOT_FOUND');
    return execution;
  }

  private interrupt(terminalId: string): void {
    const send = () => {
      try {
        this.deps.terminals().write(terminalId, CTRL_C);
      } catch {
        // The terminal ended: its end already settles the execution.
      }
    };
    send();
    setTimeout(send, SECOND_INTERRUPT_DELAY_MS).unref?.();
  }
}

const invalid = (field: string, message: string) =>
  new AtlasError('VALIDATION_FAILED', message, { issues: [{ field, message }] });

export function blockerMessage(blocker: TaskTerminalBlocker, processName: string | null): string {
  switch (blocker) {
    case 'disconnected':
      return 'This terminal is no longer running.';
    case 'busy':
      return `This terminal is running ${processName ?? 'a program'}. Wait for it to finish or choose another terminal.`;
    case 'process-unknown':
      return 'ATLAS cannot tell whether this terminal is idle, so it will not type into it.';
    case 'unsupported-shell':
      return 'Tasks can be sent only to zsh or bash terminals. Open a new terminal instead.';
    case 'ai-session-active':
      return 'This terminal already has an active AI session.';
    case 'execution-active':
      return 'This terminal is already running a task.';
  }
}
