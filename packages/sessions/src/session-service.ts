import {
  AtlasSessionIdSchema,
  CreateSessionInputSchema,
  CreateSessionTaskInputSchema,
  EXECUTING_SESSION_STATUSES,
  ListSessionsInputSchema,
  SESSION_EVENTS_PAGE_SIZE,
  SESSION_TASKS_MAX_COUNT,
  SessionActionSchema,
  SessionTaskIdSchema,
  UpdateSessionInputSchema,
  UpdateSessionTaskInputSchema,
  isExecutingSessionStatus,
  isFinalSessionStatus,
  parseInput,
  type AtlasSession,
  type AtlasSessionDetails,
  type AtlasSessionListItem,
  type AtlasSessionStatus,
  type SessionChangedEvent,
  type SessionEvent,
  type SessionEventMetadata,
  type SessionTask,
  type SessionWorkspace,
} from '@atlas/contracts';
import { AtlasError, describeError, noopLogger, type Logger } from '@atlas/shared';
import type {
  SessionChange,
  SessionRepository,
  SessionWorkspaces,
  StoredSession,
  StoredSessionTask,
} from './ports.js';
import {
  availableSessionActions,
  canArchive,
  canTransitionTask,
  isFinalTaskStatus,
  nextSessionStatus,
  tasksEditable,
  transitionEventType,
  type SessionTrigger,
  type TransitionContext,
} from './state-machine.js';
import { assertValidTaskGraph } from './task-graph.js';

export interface SessionServiceDependencies {
  sessions: SessionRepository;
  workspaces: SessionWorkspaces;
  clock: { now(): Date };
  generateId: () => string;
  logger?: Logger;
}

export type SessionChangeListener = (event: SessionChangedEvent) => void;

/** Why the Engine interrupted sessions whose work was in flight. */
export type InterruptionReason = 'engine-restart' | 'engine-shutdown';

const SYSTEM_RETRIES = 3;

/**
 * Manages ATLAS Sessions: persistent orchestration records with a validated
 * lifecycle, a task graph and an event history. No AI execution happens here; a
 * started session waits for an execution adapter (SDD-004) instead of pretending
 * to run.
 */
export class SessionService {
  private readonly logger: Logger;
  private readonly listeners = new Set<SessionChangeListener>();
  /** No execution adapter exists before SDD-004. */
  private readonly context: TransitionContext = { executorAvailable: false };

  constructor(private readonly deps: SessionServiceDependencies) {
    this.logger = deps.logger ?? noopLogger;
  }

  onChange(listener: SessionChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async create(input: unknown): Promise<AtlasSession> {
    const parsed = parseInput(CreateSessionInputSchema, input);
    const workspace = await this.resolveWorkspace(
      parsed.projectId ?? null,
      parsed.workspacePath ?? null,
    );
    const now = this.now();
    const session: AtlasSession = {
      id: this.deps.generateId(),
      name: parsed.name,
      objective: parsed.objective,
      projectId: workspace.projectId,
      workspacePath: workspace.workspacePath,
      status: 'DRAFT',
      executionProfile: parsed.executionProfile,
      constraints: parsed.constraints,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null,
      endedAt: null,
      archivedAt: null,
    };
    await this.deps.sessions.insert(session, [
      { type: 'SESSION_CREATED', occurredAt: now, metadata: { to: 'DRAFT' } },
    ]);
    this.logger.info('Session created', { sessionId: session.id });
    this.emit(session.id);
    return session;
  }

  async list(input: unknown = {}): Promise<AtlasSessionListItem[]> {
    const filter = parseInput(ListSessionsInputSchema, input);
    const sessions = await this.deps.sessions.findAll({
      includeArchived: filter.includeArchived ?? false,
      ...(filter.projectId !== undefined ? { projectId: filter.projectId } : {}),
    });
    const counts = await this.deps.sessions.countTasks(sessions.map((session) => session.id));
    const names = new Map<string, string | null>();
    for (const projectId of new Set(sessions.map((session) => session.projectId))) {
      if (projectId === null) continue;
      names.set(projectId, (await this.deps.workspaces.findProject(projectId))?.name ?? null);
    }
    return sessions.map((session) => ({
      session,
      projectName: session.projectId === null ? null : (names.get(session.projectId) ?? null),
      taskCounts: counts.get(session.id) ?? { total: 0, completed: 0 },
    }));
  }

  async get(id: string): Promise<AtlasSession> {
    return (await this.require(id)).session;
  }

  async getDetails(id: string): Promise<AtlasSessionDetails> {
    const { session } = await this.require(id);
    const archived = session.archivedAt !== null;
    const [workspace, tasks, pendingApprovals] = await Promise.all([
      this.describeWorkspace(session),
      this.tasks(session.id),
      this.deps.sessions.findPendingApprovals(session.id),
    ]);
    return {
      session,
      workspace,
      tasks,
      pendingApprovals,
      availableActions: availableSessionActions(session.status, archived, this.context),
      tasksEditable: tasksEditable(session.status, archived),
      executorAvailable: this.context.executorAvailable,
      executing: isExecutingSessionStatus(session.status),
    };
  }

  /** Edits a draft. Other statuses must return to draft first. */
  async update(id: string, input: unknown): Promise<AtlasSession> {
    const stored = await this.require(id);
    const changes = parseInput(UpdateSessionInputSchema, input);
    const current = stored.session;
    if (current.status !== 'DRAFT' || current.archivedAt !== null) {
      throw new AtlasError('SESSION_TRANSITION_INVALID', 'Only draft sessions can be edited.', {
        details: { sessionId: id, status: current.status },
      });
    }
    let { projectId, workspacePath } = current;
    if (changes.projectId !== undefined || changes.workspacePath !== undefined) {
      const resolved = await this.resolveWorkspace(
        changes.projectId !== undefined ? changes.projectId : null,
        changes.workspacePath !== undefined ? changes.workspacePath : null,
      );
      ({ projectId, workspacePath } = resolved);
    }
    const next: AtlasSession = {
      ...current,
      ...(changes.name !== undefined ? { name: changes.name } : {}),
      ...(changes.objective !== undefined ? { objective: changes.objective } : {}),
      ...(changes.executionProfile !== undefined
        ? { executionProfile: changes.executionProfile }
        : {}),
      ...(changes.constraints !== undefined ? { constraints: changes.constraints } : {}),
      projectId,
      workspacePath,
    };
    const fields = changedFields(current, next);
    if (fields.length === 0) return current;
    next.updatedAt = this.now();
    await this.commit({
      sessionId: id,
      expectedRevision: stored.revision,
      session: next,
      events: [{ type: 'SESSION_UPDATED', occurredAt: next.updatedAt, metadata: { fields } }],
    });
    return next;
  }

  /** Applies a user-requested lifecycle action. */
  async perform(id: string, action: unknown): Promise<AtlasSession> {
    const parsedAction = parseInput(SessionActionSchema, action);
    const stored = await this.require(id);
    const { session } = stored;
    const now = this.now();

    if (parsedAction === 'archive') {
      if (!canArchive(session.status, session.archivedAt !== null)) {
        throw invalidTransition(session, parsedAction);
      }
      const next = { ...session, archivedAt: now, updatedAt: now };
      await this.commit({
        sessionId: id,
        expectedRevision: stored.revision,
        session: next,
        events: [{ type: 'SESSION_ARCHIVED', occurredAt: now, metadata: {} }],
      });
      return next;
    }

    if (session.archivedAt !== null) throw invalidTransition(session, parsedAction);
    const to = nextSessionStatus(session.status, parsedAction, this.context);
    if (to === null) throw invalidTransition(session, parsedAction);
    // Workspace access is checked before a session is prepared for execution.
    if (parsedAction === 'markReady' || parsedAction === 'start' || parsedAction === 'resume') {
      await this.assertWorkspaceUsable(session);
    }
    return this.transition(stored, parsedAction, to, now);
  }

  async tasks(id: string): Promise<SessionTask[]> {
    const { session } = await this.require(id);
    return withBlockedBy(await this.deps.sessions.findTasks(session.id));
  }

  async events(id: string): Promise<SessionEvent[]> {
    const { session } = await this.require(id);
    return this.deps.sessions.findEvents(session.id, SESSION_EVENTS_PAGE_SIZE);
  }

  async addTask(id: string, input: unknown): Promise<SessionTask> {
    const stored = await this.requireEditableTasks(id);
    const parsed = parseInput(CreateSessionTaskInputSchema, input);
    const tasks = await this.deps.sessions.findTasks(stored.session.id);
    if (tasks.length >= SESSION_TASKS_MAX_COUNT) {
      throw new AtlasError('VALIDATION_FAILED', 'Too many tasks.', {
        issues: [{ field: 'title', message: `At most ${SESSION_TASKS_MAX_COUNT} tasks.` }],
      });
    }
    const now = this.now();
    const task: StoredSessionTask = {
      id: this.deps.generateId(),
      sessionId: stored.session.id,
      title: parsed.title,
      description: parsed.description,
      status: 'PENDING',
      dependencies: parsed.dependencies,
      assignedAgentId: null,
      validationCriteria: parsed.validationCriteria,
      position: tasks.reduce((max, item) => Math.max(max, item.position + 1), 0),
      createdAt: now,
      updatedAt: now,
    };
    assertValidTaskGraph([...tasks, task]);
    await this.commit({
      sessionId: stored.session.id,
      expectedRevision: stored.revision,
      session: { ...stored.session, updatedAt: now },
      upsertTasks: [task],
      events: [{ type: 'TASK_CREATED', occurredAt: now, metadata: { taskId: task.id } }],
    });
    return withBlockedBy([...tasks, task]).find((item) => item.id === task.id)!;
  }

  async updateTask(id: string, taskId: string, input: unknown): Promise<SessionTask> {
    const stored = await this.requireEditableTasks(id);
    const changes = parseInput(UpdateSessionTaskInputSchema, input);
    const tasks = await this.deps.sessions.findTasks(stored.session.id);
    const current = requireTask(tasks, taskId);
    if (current.status !== 'PENDING' && current.status !== 'INTERRUPTED') {
      throw new AtlasError('SESSION_TRANSITION_INVALID', 'Only pending tasks can be edited.', {
        details: { taskId: current.id, status: current.status },
      });
    }
    const next: StoredSessionTask = {
      ...current,
      ...(changes.title !== undefined ? { title: changes.title } : {}),
      ...(changes.description !== undefined ? { description: changes.description } : {}),
      ...(changes.dependencies !== undefined ? { dependencies: changes.dependencies } : {}),
      ...(changes.validationCriteria !== undefined
        ? { validationCriteria: changes.validationCriteria }
        : {}),
    };
    const fields = changedFields(current, next);
    if (fields.length === 0) return withBlockedBy(tasks).find((item) => item.id === current.id)!;
    const updatedTasks = tasks.map((task) => (task.id === next.id ? next : task));
    assertValidTaskGraph(updatedTasks);
    const now = this.now();
    next.updatedAt = now;
    await this.commit({
      sessionId: stored.session.id,
      expectedRevision: stored.revision,
      session: { ...stored.session, updatedAt: now },
      upsertTasks: [next],
      events: [{ type: 'TASK_UPDATED', occurredAt: now, metadata: { taskId: next.id, fields } }],
    });
    return withBlockedBy(updatedTasks).find((item) => item.id === next.id)!;
  }

  async removeTask(id: string, taskId: string): Promise<void> {
    const stored = await this.requireEditableTasks(id);
    const tasks = await this.deps.sessions.findTasks(stored.session.id);
    const task = requireTask(tasks, taskId);
    if (task.status === 'IN_PROGRESS') {
      throw new AtlasError('SESSION_TRANSITION_INVALID', 'A task in progress cannot be removed.', {
        details: { taskId: task.id },
      });
    }
    if (tasks.some((other) => other.dependencies.includes(task.id))) {
      throw new AtlasError('VALIDATION_FAILED', 'Other tasks depend on this task.', {
        issues: [{ field: 'dependencies', message: 'Remove the dependencies on this task first.' }],
        details: { taskId: task.id },
      });
    }
    const now = this.now();
    await this.commit({
      sessionId: stored.session.id,
      expectedRevision: stored.revision,
      session: { ...stored.session, updatedAt: now },
      removeTaskIds: [task.id],
      events: [{ type: 'TASK_REMOVED', occurredAt: now, metadata: { taskId: task.id } }],
    });
  }

  async cancelTask(id: string, taskId: string): Promise<SessionTask> {
    const stored = await this.requireEditableTasks(id);
    const tasks = await this.deps.sessions.findTasks(stored.session.id);
    const task = requireTask(tasks, taskId);
    // A task in progress belongs to an executor, which must stop it first.
    if (task.status === 'IN_PROGRESS' || !canTransitionTask(task.status, 'CANCELLED')) {
      throw new AtlasError('SESSION_TRANSITION_INVALID', 'This task cannot be cancelled.', {
        details: { taskId: task.id, status: task.status },
      });
    }
    const now = this.now();
    const next: StoredSessionTask = { ...task, status: 'CANCELLED', updatedAt: now };
    await this.commit({
      sessionId: stored.session.id,
      expectedRevision: stored.revision,
      session: { ...stored.session, updatedAt: now },
      upsertTasks: [next],
      events: [{ type: 'TASK_CANCELLED', occurredAt: now, metadata: { taskId: task.id } }],
    });
    return withBlockedBy(tasks.map((item) => (item.id === next.id ? next : item))).find(
      (item) => item.id === next.id,
    )!;
  }

  /**
   * A registered project is being removed: its sessions keep working in the same
   * directory, without the association.
   */
  async detachProject(projectId: string, workspacePath: string): Promise<number> {
    let detached = 0;
    for (const initial of await this.deps.sessions.findByProject(projectId)) {
      const changed = await this.retrySystemChange(initial.session.id, (stored) => {
        if (stored.session.projectId !== projectId) return null;
        const now = this.now();
        return {
          sessionId: stored.session.id,
          expectedRevision: stored.revision,
          session: { ...stored.session, projectId: null, workspacePath, updatedAt: now },
          events: [
            {
              type: 'SESSION_PROJECT_DETACHED',
              occurredAt: now,
              metadata: { reason: 'project-removed' },
            },
          ],
        };
      });
      if (changed) detached += 1;
    }
    if (detached > 0) this.logger.info('Sessions detached from removed project', { detached });
    return detached;
  }

  /**
   * Marks sessions whose work was in flight as INTERRUPTED. Called by the Engine
   * host when it starts (after a crash or kill) and when it stops. Interrupted
   * sessions are never resumed automatically and never reported as completed.
   */
  async reconcile(reason: InterruptionReason): Promise<number> {
    let interrupted = 0;
    for (const initial of await this.deps.sessions.findByStatuses(EXECUTING_SESSION_STATUSES)) {
      try {
        const changed = await this.retrySystemChange(initial.session.id, async (stored) => {
          const to = nextSessionStatus(stored.session.status, 'interrupt', this.context);
          if (to === null) return null;
          const now = this.now();
          const tasks = await this.deps.sessions.findTasks(stored.session.id);
          const interruptedTasks = tasks
            .filter((task) => task.status === 'IN_PROGRESS')
            .map((task) => ({ ...task, status: 'INTERRUPTED' as const, updatedAt: now }));
          return {
            sessionId: stored.session.id,
            expectedRevision: stored.revision,
            session: { ...stored.session, status: to, updatedAt: now },
            upsertTasks: interruptedTasks,
            events: [
              {
                type: 'SESSION_INTERRUPTED',
                occurredAt: now,
                metadata: {
                  from: stored.session.status,
                  to,
                  reason,
                  taskCount: interruptedTasks.length,
                },
              },
            ],
          };
        });
        if (changed) interrupted += 1;
      } catch (error) {
        this.logger.error('Failed to reconcile session', {
          sessionId: initial.session.id,
          error: describeError(error),
        });
      }
    }
    if (interrupted > 0) this.logger.warn('Interrupted sessions', { interrupted, reason });
    return interrupted;
  }

  private async transition(
    stored: StoredSession,
    trigger: SessionTrigger,
    to: AtlasSessionStatus,
    now: string,
  ): Promise<AtlasSession> {
    const { session } = stored;
    const final = isFinalSessionStatus(to);
    const next: AtlasSession = {
      ...session,
      status: to,
      updatedAt: now,
      ...(to === 'RUNNING' && session.startedAt === null ? { startedAt: now } : {}),
      ...(to === 'COMPLETED' ? { completedAt: now } : {}),
      ...(final ? { endedAt: now } : {}),
    };
    const metadata: SessionEventMetadata = { from: session.status, to };
    let upsertTasks: StoredSessionTask[] | undefined;
    if (to === 'CANCELLED') {
      const tasks = await this.deps.sessions.findTasks(session.id);
      upsertTasks = tasks
        .filter((task) => !isFinalTaskStatus(task.status))
        .map((task) => ({ ...task, status: 'CANCELLED' as const, updatedAt: now }));
      metadata.taskCount = upsertTasks.length;
    }
    await this.commit({
      sessionId: session.id,
      expectedRevision: stored.revision,
      session: next,
      ...(upsertTasks !== undefined ? { upsertTasks } : {}),
      events: [{ type: transitionEventType(trigger, to), occurredAt: now, metadata }],
    });
    this.logger.info('Session status changed', { sessionId: session.id, from: session.status, to });
    return next;
  }

  private async resolveWorkspace(
    projectId: string | null,
    workspacePath: string | null,
  ): Promise<{ projectId: string | null; workspacePath: string | null }> {
    if (projectId !== null) {
      if ((await this.deps.workspaces.findProject(projectId)) === null) {
        throw new AtlasError('PROJECT_NOT_FOUND', undefined, { details: { projectId } });
      }
      return { projectId, workspacePath: null };
    }
    if (workspacePath !== null) {
      return {
        projectId: null,
        workspacePath: await this.deps.workspaces.resolveDirectory(workspacePath),
      };
    }
    return { projectId: null, workspacePath: null };
  }

  private async describeWorkspace(session: AtlasSession): Promise<SessionWorkspace> {
    if (session.projectId !== null) {
      const project = await this.deps.workspaces.findProject(session.projectId);
      if (project !== null) {
        return {
          kind: 'project',
          projectId: project.id,
          projectName: project.name,
          path: project.workspacePath,
          available: await this.deps.workspaces.isAvailable(project.workspacePath),
        };
      }
    }
    if (session.workspacePath !== null) {
      return {
        kind: 'directory',
        path: session.workspacePath,
        available: await this.deps.workspaces.isAvailable(session.workspacePath),
      };
    }
    return { kind: 'none' };
  }

  private async assertWorkspaceUsable(session: AtlasSession): Promise<void> {
    if (session.projectId !== null) {
      const project = await this.deps.workspaces.findProject(session.projectId);
      if (project === null) {
        throw new AtlasError('PROJECT_NOT_FOUND', undefined, {
          details: { projectId: session.projectId },
        });
      }
      await this.deps.workspaces.assertUsable(project.workspacePath);
      return;
    }
    if (session.workspacePath !== null) {
      await this.deps.workspaces.assertUsable(session.workspacePath);
    }
  }

  private async require(id: string): Promise<StoredSession> {
    const sessionId = parseInput(AtlasSessionIdSchema, id);
    const stored = await this.deps.sessions.findById(sessionId);
    if (stored === null) {
      throw new AtlasError('SESSION_NOT_FOUND', undefined, { details: { sessionId } });
    }
    return stored;
  }

  private async requireEditableTasks(id: string): Promise<StoredSession> {
    const stored = await this.require(id);
    if (!tasksEditable(stored.session.status, stored.session.archivedAt !== null)) {
      throw new AtlasError(
        'SESSION_TRANSITION_INVALID',
        'Tasks of a finished session cannot change.',
        { details: { sessionId: stored.session.id, status: stored.session.status } },
      );
    }
    return stored;
  }

  private async commit(change: SessionChange): Promise<void> {
    if (!(await this.deps.sessions.commit(change))) {
      throw new AtlasError('SESSION_CONFLICT', undefined, {
        details: { sessionId: change.sessionId },
      });
    }
    this.emit(change.sessionId);
  }

  /** Engine-initiated changes re-read and retry when another writer got there first. */
  private async retrySystemChange(
    sessionId: string,
    build: (stored: StoredSession) => SessionChange | null | Promise<SessionChange | null>,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < SYSTEM_RETRIES; attempt += 1) {
      const stored = await this.deps.sessions.findById(sessionId);
      if (stored === null) return false;
      const change = await build(stored);
      if (change === null) return false;
      if (await this.deps.sessions.commit(change)) {
        this.emit(sessionId);
        return true;
      }
    }
    throw new AtlasError('SESSION_CONFLICT', undefined, { details: { sessionId } });
  }

  private emit(sessionId: string): void {
    for (const listener of this.listeners) {
      try {
        listener({ type: 'session-changed', sessionId });
      } catch (error) {
        this.logger.warn('Session listener failed', { error: describeError(error) });
      }
    }
  }

  private now(): string {
    return this.deps.clock.now().toISOString();
  }
}

function invalidTransition(session: AtlasSession, action: string): AtlasError {
  return new AtlasError('SESSION_TRANSITION_INVALID', undefined, {
    details: {
      sessionId: session.id,
      status: session.status,
      archived: session.archivedAt !== null,
      action,
    },
  });
}

function requireTask(tasks: readonly StoredSessionTask[], taskId: string): StoredSessionTask {
  const id = parseInput(SessionTaskIdSchema, taskId);
  const task = tasks.find((item) => item.id === id);
  if (task === undefined) {
    throw new AtlasError('SESSION_TASK_NOT_FOUND', undefined, { details: { taskId: id } });
  }
  return task;
}

function withBlockedBy(tasks: readonly StoredSessionTask[]): SessionTask[] {
  const status = new Map(tasks.map((task) => [task.id, task.status]));
  return [...tasks]
    .sort((a, b) => a.position - b.position)
    .map(({ position: _position, ...task }) => ({
      ...task,
      blockedBy: task.dependencies.filter((dependency) => status.get(dependency) !== 'COMPLETED'),
    }));
}

/** Names of the top-level fields whose values differ. */
function changedFields<T extends object>(before: T, after: T): string[] {
  return (Object.keys(after) as (keyof T)[])
    .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
    .map(String);
}
