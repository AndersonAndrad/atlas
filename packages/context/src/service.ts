import {
  TOKEN_ESTIMATE_METHOD,
  type AgentRole,
  type AiProvider,
  type AiSession,
  type BundleSkill,
  type ContextBundle,
  type ContextEntry,
  type ContextFreshness,
  type ContextHandoffDraft,
  type ContextHandoff,
  type ContextHealthReport,
  type ContextOverview,
  type ContextOwner,
  type ContextQuery,
  type ContextRevision,
  type ContextSnapshot,
  type ContextTask,
  type CreateContextEntryInput,
  type DecisionRecord,
  type DecisionStatus,
  type ExecutionProfile,
  type SessionEvidence,
  type UpdateContextEntryInput,
  type UpdateContextTaskInput,
} from '@atlas/contracts';
import { AtlasError, noopLogger, type Logger } from '@atlas/shared';
import { buildBundle, handoffMarkdown, type BundleProvider } from './bundle.js';
import type { ContextRepository, RepositoryInspector } from './ports.js';
import { ContextBudgetStore, resolveBudget, type KeyValueStore } from './retrieval/budget.js';
import { LruCache } from './retrieval/cache.js';
import {
  findConflicts,
  findDuplicates,
  missingSources,
  pendingOfClosedTasks,
} from './retrieval/consistency.js';
import { queryTerms } from './retrieval/scoring.js';

/** A context owner the Engine resolved and authorized (a project or a repository root). */
export interface ResolvedTarget {
  owner: ContextOwner;
  /** Directory inspected for repository evidence. */
  directory: string;
  /** Project name or folder name, used in bundles. */
  label: string;
}

export interface SharedContextServiceOptions {
  repository: ContextRepository;
  inspector: RepositoryInspector;
  clock: { now(): Date };
  generateId: () => string;
  /** Removes credentials before anything is stored. */
  redact: (text: string) => string;
  /** Application settings holding the context budgets; defaults apply without it. */
  settings?: KeyValueStore;
  /** Active skills for a bundle's context (Skills Hub); none without it. */
  skills?: (request: {
    projectId: string | null;
    role: AgentRole;
    provider: BundleProvider;
    skillIds: string[];
  }) => Promise<BundleSkill[]>;
  logger?: Logger;
}

/** What a bundle is selected for (SDD-006 FR-601); all optional but the provider. */
export interface BundleRequest {
  taskId?: string | undefined;
  provider: BundleProvider;
  /** Explicit budget; otherwise resolved from task, profile, role, provider and default. */
  budgetTokens?: number | undefined;
  objective?: string | undefined;
  agentRole?: AgentRole | undefined;
  executionProfile?: ExecutionProfile | undefined;
  files?: string[] | undefined;
  keywords?: string[] | undefined;
  excludeIds?: string[] | undefined;
  detail?: 'essential' | 'full' | undefined;
  skillIds?: string[] | undefined;
}

/** Fields the user may adjust before a handoff is stored. */
export type HandoffDraft = ContextHandoffDraft;

export interface SessionSummary {
  summary: string;
  completed: string[];
  pending: string[];
  decisions: string[];
  nextActions: string[];
}

/** Commits listed as evidence when there is no task or session base commit. */
const RECENT_COMMITS = 10;

/** Checkpoint text kept per run (the database limit is 20,000 characters). */
const CHECKPOINT_TEXT_LIMIT = 20_000;

/** Bounds the number of Git processes a freshness check may start. */
const MAX_FRESHNESS_CHECKS = 100;

/** Stored records considered for one bundle: newest entries plus full-text matches. */
const BUNDLE_CANDIDATES = 500;
const SEARCH_CANDIDATES = 200;
/** Bundles' stored records kept in memory (FR-612). */
const BUNDLE_CACHE_SIZE = 32;
/** Budget large enough to estimate everything a bundle could include (Context Health). */
const UNBOUNDED_BUDGET_TOKENS = 100_000_000;

interface StoredBundleRecords {
  task: ContextTask | null;
  entries: ContextEntry[];
  globalEntries: ContextEntry[];
  decisions: DecisionRecord[];
  searchRanks: Map<string, number>;
}

const notFound = (what: string) =>
  new AtlasError('VALIDATION_FAILED', `${what} not found.`, {
    issues: [{ field: 'id', message: `The ${what.toLowerCase()} could not be found.` }],
  });

const invalid = (field: string, message: string) =>
  new AtlasError('VALIDATION_FAILED', message, { issues: [{ field, message }] });

const sameOwner = (a: ContextOwner, b: ContextOwner) =>
  a.projectId === b.projectId && a.workspacePath === b.workspacePath;

const GLOBAL_OWNER: ContextOwner = { projectId: null, workspacePath: null };

/**
 * Provider-independent shared context (SDD-005 FR-501–FR-513). Knowledge belongs to
 * a project or repository and outlives AI sessions and agents. Every operation is
 * scoped to an owner the Engine authorized; records of other owners are never
 * returned or changed. Stored content is data: it never becomes a command.
 */
export class SharedContextService {
  private readonly repo: ContextRepository;
  private readonly logger: Logger;
  readonly budgets: ContextBudgetStore;
  private readonly cache = new LruCache<StoredBundleRecords>(BUNDLE_CACHE_SIZE);

  constructor(private readonly options: SharedContextServiceOptions) {
    this.repo = options.repository;
    this.logger = options.logger ?? noopLogger;
    this.budgets = new ContextBudgetStore(
      options.settings ?? { get: async () => null, set: async () => undefined },
      this.logger,
    );
  }

  private now(): string {
    return this.options.clock.now().toISOString();
  }

  // -------------------------------------------------------------------------
  // Entries
  // -------------------------------------------------------------------------

  async record(
    target: ResolvedTarget | null,
    input: CreateContextEntryInput,
    recordedBy: string,
  ): Promise<ContextEntry> {
    if ((input.scope === 'global') !== (target === null)) {
      throw invalid('scope', 'Global entries have no project; other entries need one.');
    }
    const owner = target?.owner ?? GLOBAL_OWNER;
    const taskId = await this.ownTaskId(owner, input.taskId);
    if (input.scope === 'task' && taskId === null) {
      throw invalid('taskId', 'Choose a task for task context.');
    }
    const refs = await this.fileReferences(target, input.files ?? []);
    const now = this.now();
    const entry: ContextEntry = {
      id: this.options.generateId(),
      scope: input.scope,
      ...owner,
      taskId,
      sessionId: null,
      category: input.category,
      title: this.options.redact(input.title),
      body: this.options.redact(input.body),
      status: 'active',
      verification: 'user',
      source: { kind: 'user', ref: null, recordedBy },
      refs,
      required: input.required ?? false,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    await this.repo.insertEntry(entry, this.revisionOf(entry, recordedBy, null));
    return entry;
  }

  async update(
    target: ResolvedTarget | null,
    id: string,
    input: UpdateContextEntryInput,
    changedBy: string,
  ): Promise<ContextEntry> {
    const current = await this.ownEntry(target, id);
    const edited =
      input.title !== undefined || input.body !== undefined || input.category !== undefined;
    const next: ContextEntry = {
      ...current,
      title: input.title === undefined ? current.title : this.options.redact(input.title),
      body: input.body === undefined ? current.body : this.options.redact(input.body),
      category: input.category ?? current.category,
      status: input.status ?? current.status,
      required: input.required ?? current.required,
      // A corrected entry is the user's statement, no longer the original evidence.
      verification: edited ? 'user' : current.verification,
      revision: current.revision + 1,
      updatedAt: this.now(),
    };
    // Revisions do not store the flag; the reason keeps its change in the history.
    const requiredChange =
      next.required === current.required
        ? null
        : next.required
          ? 'Marked as always included'
          : 'No longer always included';
    const reason =
      [input.reason?.trim() || null, requiredChange].filter(Boolean).join('; ') || null;
    await this.repo.updateEntry(next, this.revisionOf(next, changedBy, reason));
    return next;
  }

  async remove(target: ResolvedTarget | null, id: string): Promise<void> {
    await this.ownEntry(target, id);
    await this.repo.deleteEntry(id);
  }

  async list(target: ResolvedTarget, query: Omit<ContextQuery, 'target'>): Promise<ContextEntry[]> {
    if (query.taskId !== undefined) await this.ownTask(target.owner, query.taskId);
    const entries = await this.repo.listEntries({
      owner: target.owner,
      ...(query.taskId ? { taskId: query.taskId } : {}),
      ...(query.sessionId ? { sessionId: query.sessionId } : {}),
      ...(query.category ? { category: query.category } : {}),
      ...(query.search ? { search: query.search } : {}),
      includeObsolete: query.includeObsolete ?? false,
    });
    if (!query.includeGlobal) return entries;
    const global = await this.repo.listEntries({
      owner: GLOBAL_OWNER,
      ...(query.category ? { category: query.category } : {}),
      ...(query.search ? { search: query.search } : {}),
      includeObsolete: query.includeObsolete ?? false,
    });
    return [...entries, ...global];
  }

  listGlobal(search?: string): Promise<ContextEntry[]> {
    return this.repo.listEntries({ owner: GLOBAL_OWNER, ...(search ? { search } : {}) });
  }

  async history(target: ResolvedTarget | null, id: string): Promise<ContextRevision[]> {
    await this.ownEntry(target, id);
    return this.repo.listRevisions(id);
  }

  // -------------------------------------------------------------------------
  // Tasks
  // -------------------------------------------------------------------------

  async createTask(
    target: ResolvedTarget,
    input: { title: string; objective: string },
  ): Promise<ContextTask> {
    const state = await this.options.inspector.state(target.directory);
    const now = this.now();
    const task: ContextTask = {
      id: this.options.generateId(),
      ...target.owner,
      title: this.options.redact(input.title),
      objective: this.options.redact(input.objective),
      status: 'open',
      baseCommit: state.head,
      baseBranch: state.branch,
      budgetTokens: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.repo.insertTask(task);
    return task;
  }

  async updateTask(
    target: ResolvedTarget,
    id: string,
    input: UpdateContextTaskInput,
  ): Promise<ContextTask> {
    const task = await this.ownTask(target.owner, id);
    const next: ContextTask = {
      ...task,
      title: input.title === undefined ? task.title : this.options.redact(input.title),
      objective:
        input.objective === undefined ? task.objective : this.options.redact(input.objective),
      status: input.status ?? task.status,
      budgetTokens: input.budgetTokens === undefined ? task.budgetTokens : input.budgetTokens,
      updatedAt: this.now(),
    };
    await this.repo.updateTask(next);
    return next;
  }

  async deleteTask(target: ResolvedTarget, id: string): Promise<void> {
    await this.ownTask(target.owner, id);
    await this.repo.deleteTask(id);
  }

  listTasks(target: ResolvedTarget): Promise<ContextTask[]> {
    return this.repo.listTasks(target.owner);
  }

  // -------------------------------------------------------------------------
  // Decisions
  // -------------------------------------------------------------------------

  async createDecision(
    target: ResolvedTarget,
    input: {
      taskId?: string;
      question: string;
      decision: string;
      alternatives: string[];
      reasoning: string;
      evidence: string[];
      affected: string[];
      supersedes?: string;
    },
    author: string,
  ): Promise<DecisionRecord> {
    const taskId = await this.ownTaskId(target.owner, input.taskId);
    const replaced =
      input.supersedes === undefined ? null : await this.ownDecision(target, input.supersedes);
    const now = this.now();
    const redact = (items: string[]) => items.map((item) => this.options.redact(item));
    const decision: DecisionRecord = {
      id: this.options.generateId(),
      ...target.owner,
      taskId,
      question: this.options.redact(input.question),
      decision: this.options.redact(input.decision),
      alternatives: redact(input.alternatives),
      reasoning: this.options.redact(input.reasoning),
      evidence: redact(input.evidence),
      affected: input.affected,
      status: 'ACTIVE',
      supersededBy: null,
      author,
      createdAt: now,
      updatedAt: now,
    };
    await this.repo.insertDecision(decision);
    if (replaced) {
      // Superseded decisions are kept as history, never erased (FR-537).
      await this.repo.updateDecision({
        ...replaced,
        status: 'SUPERSEDED',
        supersededBy: decision.id,
        updatedAt: now,
      });
    }
    return decision;
  }

  async setDecisionStatus(
    target: ResolvedTarget,
    id: string,
    status: DecisionStatus,
  ): Promise<DecisionRecord> {
    const decision = await this.ownDecision(target, id);
    if (status === 'SUPERSEDED')
      throw invalid('status', 'Record the new decision to supersede this one.');
    const next = { ...decision, status, updatedAt: this.now() };
    await this.repo.updateDecision(next);
    return next;
  }

  listDecisions(target: ResolvedTarget, taskId?: string): Promise<DecisionRecord[]> {
    return this.repo.listDecisions(target.owner, taskId);
  }

  // -------------------------------------------------------------------------
  // Bundles and snapshots
  // -------------------------------------------------------------------------

  /**
   * Context selected for an objective, task and role within a budget (SDD-006
   * FR-601–FR-612). Stored records may come from the cache; repository freshness is
   * always checked now, so the cache never hides changed or removed files.
   */
  async bundle(target: ResolvedTarget, request: BundleRequest): Promise<ContextBundle> {
    const terms = queryTerms(request.objective ?? null, request.keywords ?? []);
    const { records, cache } = await this.bundleRecords(target, request.taskId, terms);
    const role = request.agentRole ?? 'generic';
    const budget = resolveBudget(await this.budgets.get(), {
      ...(request.budgetTokens === undefined ? {} : { requested: request.budgetTokens }),
      task: records.task,
      ...(request.executionProfile ? { profile: request.executionProfile } : {}),
      role,
      provider: request.provider,
    });
    const freshness = await this.freshness(
      target,
      [...records.entries, ...records.globalEntries],
      records.task,
    );
    const skills = await this.activeSkills(target, role, request.provider, request.skillIds ?? []);
    return buildBundle({
      label: target.label,
      provider: request.provider,
      budgetTokens: budget.tokens,
      budgetSource: budget.source,
      role,
      ...(request.objective ? { objective: request.objective } : {}),
      keywords: request.keywords ?? [],
      files: (request.files ?? []).map((file) => file.replace(/^\.\//, '')),
      excludeIds: request.excludeIds ?? [],
      detail: request.detail ?? 'full',
      searchRanks: records.searchRanks,
      skills,
      cache,
      freshness,
      task: records.task,
      entries: records.entries,
      globalEntries: records.globalEntries,
      decisions: records.decisions,
      generatedAt: this.now(),
    });
  }

  /** Skills never fail a bundle: without them the context is still useful. */
  private async activeSkills(
    target: ResolvedTarget,
    role: AgentRole,
    provider: BundleProvider,
    skillIds: string[],
  ): Promise<BundleSkill[]> {
    if (this.options.skills === undefined) return [];
    try {
      return await this.options.skills({
        projectId: target.owner.projectId,
        role,
        provider,
        skillIds,
      });
    } catch (error) {
      this.logger.warn('Skills could not be resolved for a context bundle', {
        error: error instanceof Error ? error.name : 'unknown',
      });
      return [];
    }
  }

  /** Stored candidates of a bundle, cached by owner, task, query and context revision. */
  private async bundleRecords(
    target: ResolvedTarget,
    taskId: string | undefined,
    terms: string[],
  ): Promise<{ records: StoredBundleRecords; cache: 'hit' | 'miss' }> {
    const key = JSON.stringify([
      target.owner.projectId,
      target.owner.workspacePath,
      target.directory,
      taskId ?? null,
      terms,
      await this.repo.revision(target.owner),
    ]);
    const cached = this.cache.get(key);
    if (cached !== undefined) return { records: cached, cache: 'hit' };

    const task = taskId === undefined ? null : await this.ownTask(target.owner, taskId);
    // Without a task, task-specific notes stay out; with one, only that task's notes.
    const inScope = (entry: ContextEntry) => entry.taskId === null || entry.taskId === task?.id;
    const searchRanks = new Map<string, number>();
    const matched: ContextEntry[] = [];
    if (terms.length > 0) {
      for (const owner of [target.owner, GLOBAL_OWNER]) {
        const ranked = await this.repo.rankEntries(owner, terms, SEARCH_CANDIDATES);
        ranked.forEach((entry, index) => {
          searchRanks.set(entry.id, index);
          matched.push(entry);
        });
      }
    }
    const newest = await this.repo.listEntries({ owner: target.owner, limit: BUNDLE_CANDIDATES });
    const globalNewest = await this.repo.listEntries({
      owner: GLOBAL_OWNER,
      limit: BUNDLE_CANDIDATES,
    });
    const unique = (items: ContextEntry[]) => [
      ...new Map(items.map((entry) => [entry.id, entry])).values(),
    ];
    const isGlobal = (entry: ContextEntry) => sameOwner(entry, GLOBAL_OWNER);
    const records: StoredBundleRecords = {
      task,
      entries: unique([...newest, ...matched.filter((entry) => !isGlobal(entry))]).filter(inScope),
      globalEntries: unique([...globalNewest, ...matched.filter(isGlobal)]),
      decisions: (await this.repo.listDecisions(target.owner)).filter(
        (decision) =>
          decision.status === 'ACTIVE' &&
          (decision.taskId === null || decision.taskId === task?.id),
      ),
      searchRanks,
    };
    this.cache.set(key, records);
    return { records, cache: 'miss' };
  }

  // -------------------------------------------------------------------------
  // Context Health (SDD-006 FR-608)
  // -------------------------------------------------------------------------

  /** Heuristic consistency signals; read-only. */
  async health(target: ResolvedTarget): Promise<ContextHealthReport> {
    const [entries, globalEntries, decisions, tasks, counts, last] = await Promise.all([
      this.repo.listEntries({ owner: target.owner, limit: 2000 }),
      this.repo.listEntries({ owner: GLOBAL_OWNER, limit: BUNDLE_CANDIDATES }),
      this.repo.listDecisions(target.owner),
      this.repo.listTasks(target.owner),
      this.repo.counts(target.owner),
      this.repo.lastReconciliation(target.owner),
    ]);
    const freshness = await this.freshness(target, entries, null);
    const generic = buildBundle({
      label: target.label,
      provider: 'generic',
      budgetTokens: UNBOUNDED_BUDGET_TOKENS,
      freshness,
      task: null,
      entries: entries.filter((entry) => entry.taskId === null),
      globalEntries,
      decisions: decisions.filter(
        (decision) => decision.status === 'ACTIVE' && decision.taskId === null,
      ),
      generatedAt: this.now(),
    });
    return {
      generatedAt: this.now(),
      tokenEstimateMethod: TOKEN_ESTIMATE_METHOD,
      repository: { branch: freshness.branch, head: freshness.head },
      totals: counts,
      estimatedRelevantTokens: generic.estimatedTokens,
      stale: freshness.stale,
      conflicts: findConflicts(entries, decisions),
      missingSources: missingSources(entries).map((entry) => ({
        id: entry.id,
        title: entry.title,
      })),
      duplicates: findDuplicates(entries).map((group) => ({
        keptId: group.kept.id,
        duplicateIds: group.duplicates.map((entry) => entry.id),
      })),
      pendingOfClosedTasks: pendingOfClosedTasks(entries, tasks).map(({ entry, task }) => ({
        id: entry.id,
        title: entry.title,
        taskId: task.id,
      })),
      checksTruncated: freshness.checksTruncated ?? false,
      lastReconciliation: last,
    };
  }

  /** Runs the health checks and records the run as the latest reconciliation. */
  async reconcile(target: ResolvedTarget): Promise<ContextHealthReport> {
    const report = await this.health(target);
    const run = {
      id: this.options.generateId(),
      at: report.generatedAt,
      head: report.repository.head,
      branch: report.repository.branch,
      stale: report.stale.length,
      conflicts: report.conflicts.length,
      duplicates: report.duplicates.length,
    };
    await this.repo.insertReconciliation(target.owner, run);
    return { ...report, lastReconciliation: run };
  }

  async snapshot(target: ResolvedTarget, taskId?: string): Promise<ContextSnapshot> {
    const bundle = await this.bundle(target, {
      ...(taskId ? { taskId } : {}),
      provider: 'generic',
      budgetTokens: 32_000,
    });
    const snapshot: ContextSnapshot = {
      id: this.options.generateId(),
      ...target.owner,
      taskId: taskId ?? null,
      markdown: bundle.markdown,
      head: bundle.freshness.head,
      createdAt: this.now(),
    };
    await this.repo.insertSnapshot(snapshot);
    return snapshot;
  }

  /**
   * Compares stored references with the repository now: files whose content changed
   * or disappeared and commits that are no longer on the current branch (FR-506).
   */
  async freshness(
    target: ResolvedTarget,
    entries: ContextEntry[],
    task: ContextTask | null,
  ): Promise<ContextFreshness> {
    const state = await this.options.inspector.state(target.directory);
    const result: ContextFreshness = {
      repositoryRoot: state.root,
      branch: state.branch,
      head: state.head,
      uncommittedFiles: state.uncommittedFiles,
      stale: [],
    };
    if (state.root === null || state.head === null) return result;
    const { root, head } = state;
    const isAncestor = (commit: string) => this.options.inspector.isAncestor(root, commit, head);
    if (task?.baseCommit && !(await isAncestor(task.baseCommit))) {
      result.stale.push({
        id: task.id,
        reason: `the task started on commit ${task.baseCommit.slice(0, 12)}, which is not on the current branch`,
      });
    }
    let checks = 0;
    for (const entry of entries) {
      if (entry.refs.commit === null && entry.refs.files.length === 0) continue;
      if (checks >= MAX_FRESHNESS_CHECKS) {
        result.checksTruncated = true;
        break;
      }
      if (entry.refs.commit !== null) {
        checks += 1;
        if (!(await isAncestor(entry.refs.commit))) {
          result.stale.push({
            id: entry.id,
            reason: `"${entry.title}" refers to commit ${entry.refs.commit.slice(0, 12)}, not on the current branch`,
          });
          continue;
        }
      }
      for (const file of entry.refs.files) {
        if (checks >= MAX_FRESHNESS_CHECKS) {
          result.checksTruncated = true;
          break;
        }
        checks += 1;
        const hash = await this.options.inspector.fileHash(root, file.path);
        if (hash !== file.hash) {
          result.stale.push({
            id: entry.id,
            reason:
              hash === null
                ? `"${entry.title}" refers to ${file.path}, which no longer exists`
                : `"${entry.title}" refers to ${file.path}, which changed since it was recorded`,
          });
          break;
        }
      }
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // Handoffs
  // -------------------------------------------------------------------------

  /** A handoff prefilled from stored context and Git evidence, for the user to review. */
  async prepareHandoff(
    target: ResolvedTarget,
    request: { taskId?: string; sourceSessionId?: string },
  ): Promise<HandoffDraft> {
    const task =
      request.taskId === undefined ? null : await this.ownTask(target.owner, request.taskId);
    const session =
      request.sourceSessionId === undefined
        ? null
        : await this.ownSession(target, request.sourceSessionId);
    const entries = (await this.repo.listEntries({ owner: target.owner })).filter(
      (entry) => task === null || entry.taskId === task.id || entry.taskId === null,
    );
    const decisions = (await this.repo.listDecisions(target.owner)).filter(
      (decision) =>
        decision.status === 'ACTIVE' &&
        (task === null || decision.taskId === task.id || decision.taskId === null),
    );
    const text = (entry: ContextEntry) =>
      entry.body.trim() ? `${entry.title}: ${entry.body.trim()}` : entry.title;
    const evidence = await this.gitEvidence(
      target,
      session?.startCommit ?? task?.baseCommit ?? null,
    );
    return {
      objective: task?.objective ?? '',
      completedWork: entries.filter((entry) => entry.category === 'progress').map(text),
      pendingWork: entries.filter((entry) => entry.category === 'next-action').map(text),
      blockers: entries
        .filter((entry) => entry.category === 'blocker' || entry.category === 'known-failure')
        .map(text),
      nextActions: entries.filter((entry) => entry.category === 'pending-decision').map(text),
      decisions: decisions.map((decision) => `${decision.question} → ${decision.decision}`),
      commits: evidence.commits.map((commit) => `${commit.hash.slice(0, 12)} ${commit.subject}`),
      changedFiles: evidence.changedFiles,
    };
  }

  async createHandoff(
    target: ResolvedTarget,
    input: {
      taskId?: string;
      sourceSessionId?: string;
      targetProvider: AiProvider | null;
      objective: string;
      completedWork: string[];
      pendingWork: string[];
      blockers: string[];
      nextActions: string[];
    },
  ): Promise<ContextHandoff> {
    const task = input.taskId === undefined ? null : await this.ownTask(target.owner, input.taskId);
    const session =
      input.sourceSessionId === undefined
        ? null
        : await this.ownSession(target, input.sourceSessionId);
    // Evidence is collected again now: the packet reflects the repository at creation.
    const evidence = await this.gitEvidence(
      target,
      session?.startCommit ?? task?.baseCommit ?? null,
    );
    const decisions = (await this.repo.listDecisions(target.owner)).filter(
      (decision) =>
        decision.status === 'ACTIVE' &&
        (task === null || decision.taskId === task.id || decision.taskId === null),
    );
    const entries = await this.repo.listEntries({ owner: target.owner });
    const redact = (items: string[]) => items.map((item) => this.options.redact(item));
    const handoff: ContextHandoff = {
      id: this.options.generateId(),
      ...target.owner,
      sourceSessionId: session?.id ?? null,
      targetProvider: input.targetProvider,
      taskId: task?.id ?? null,
      objective: this.options.redact(input.objective),
      completedWork: redact(input.completedWork),
      pendingWork: redact(input.pendingWork),
      decisions: decisions.map((decision) => `${decision.question} → ${decision.decision}`),
      blockers: redact(input.blockers),
      changedFiles: evidence.changedFiles,
      commits: evidence.commits.map((commit) => `${commit.hash.slice(0, 12)} ${commit.subject}`),
      // Only execution evidence may claim a result; none is captured yet (Milestone A1).
      validations: [],
      nextActions: redact(input.nextActions),
      sourceRevision: evidence.head,
      evidence: {
        entryIds: entries
          .filter((entry) => task === null || entry.taskId === task.id || entry.taskId === null)
          .map((entry) => entry.id),
        decisionIds: decisions.map((decision) => decision.id),
      },
      createdAt: this.now(),
    };
    await this.repo.insertHandoff(handoff);
    return handoff;
  }

  async getHandoff(target: ResolvedTarget, id: string): Promise<ContextHandoff> {
    const handoff = await this.repo.getHandoff(id);
    if (handoff === null || !sameOwner(handoff, target.owner)) throw notFound('Handoff');
    return handoff;
  }

  listHandoffs(target: ResolvedTarget): Promise<ContextHandoff[]> {
    return this.repo.listHandoffs(target.owner);
  }

  renderHandoff(target: ResolvedTarget, handoff: ContextHandoff): string {
    return handoffMarkdown(handoff, target.label);
  }

  // -------------------------------------------------------------------------
  // AI sessions
  // -------------------------------------------------------------------------

  async startSession(
    target: ResolvedTarget,
    input: {
      provider: AiSession['provider'];
      captureMode: AiSession['captureMode'];
      taskId?: string;
      terminalId: string | null;
      handoffId?: string;
      /**
       * The commit the session really started from (e.g. read by a wrapper before the CLI
       * ran); used only when it is HEAD or one of its ancestors in the target repository.
       */
      startCommit?: string;
    },
  ): Promise<AiSession> {
    const taskId = await this.ownTaskId(target.owner, input.taskId);
    if (input.handoffId !== undefined) await this.getHandoff(target, input.handoffId);
    if (input.terminalId !== null) {
      const tracked = await this.repo.activeSessionForTerminal(input.terminalId);
      if (tracked !== null)
        throw invalid('terminalId', 'This terminal already has an active AI session.');
    }
    const state = await this.options.inspector.state(target.directory);
    let startCommit = state.head;
    if (
      input.startCommit !== undefined &&
      state.root !== null &&
      state.head !== null &&
      (input.startCommit === state.head ||
        (await this.options.inspector.isAncestor(state.root, input.startCommit, state.head)))
    ) {
      startCommit = input.startCommit;
    }
    const session: AiSession = {
      id: this.options.generateId(),
      provider: input.provider,
      captureMode: input.captureMode,
      ...target.owner,
      taskId,
      terminalId: input.terminalId,
      handoffId: input.handoffId ?? null,
      startCommit,
      status: 'active',
      startedAt: this.now(),
      endedAt: null,
    };
    await this.repo.insertSession(session);
    return session;
  }

  async sessionEvidence(target: ResolvedTarget, id: string): Promise<SessionEvidence> {
    const session = await this.ownSession(target, id);
    return this.gitEvidence(target, session.startCommit);
  }

  /**
   * Ends a session with the user's summary. Commits and changed files come from
   * Git (verified); everything else is recorded as the user's statement.
   */
  async endSession(
    target: ResolvedTarget,
    id: string,
    summary: SessionSummary,
    recordedBy: string,
    options: { automatic?: boolean } = {},
  ): Promise<{ session: AiSession; entries: ContextEntry[] }> {
    const session = await this.ownSession(target, id);
    if (session.status === 'ended') throw invalid('id', 'This session has already ended.');
    const evidence = await this.gitEvidence(target, session.startCommit);
    const changed = evidence.commits.length > 0 || evidence.changedFiles.length > 0;
    if (options.automatic && !changed) {
      // Nothing happened in the repository: the session ends without a record.
      const ended: AiSession = { ...session, status: 'ended', endedAt: this.now() };
      await this.repo.updateSession(ended);
      return { session: ended, entries: [] };
    }
    const now = this.now();
    const created: ContextEntry[] = [];
    const add = async (
      fields: Pick<ContextEntry, 'scope' | 'category' | 'title' | 'body' | 'verification'> & {
        refs?: ContextEntry['refs'];
        sourceKind?: ContextEntry['source']['kind'];
      },
    ) => {
      const entry: ContextEntry = {
        id: this.options.generateId(),
        scope: fields.scope,
        ...target.owner,
        taskId: session.taskId,
        sessionId: session.id,
        category: fields.category,
        title: this.options.redact(fields.title).slice(0, 200),
        body: this.options.redact(fields.body).slice(0, 20_000),
        status: 'active',
        verification: fields.verification,
        source: { kind: fields.sourceKind ?? 'ai-session', ref: session.id, recordedBy },
        refs: fields.refs ?? { files: [], commit: null },
        required: false,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      await this.repo.insertEntry(entry, this.revisionOf(entry, recordedBy, null));
      created.push(entry);
    };
    const scope = session.taskId === null ? 'session' : 'task';
    const provider =
      session.provider === 'external' ? 'terminal session' : `${session.provider} session`;
    const body = [
      summary.summary.trim(),
      summary.completed.length
        ? `Completed:\n${summary.completed.map((item) => `- ${item}`).join('\n')}`
        : '',
      summary.pending.length
        ? `Pending:\n${summary.pending.map((item) => `- ${item}`).join('\n')}`
        : '',
    ]
      .filter((part) => part !== '')
      .join('\n\n');
    await add(
      options.automatic
        ? {
            // Only repository evidence: what changed, not why (PLAN-021).
            scope,
            category: 'summary',
            title: `Automatic record of ${provider} (${session.startedAt.slice(0, 10)})`,
            body:
              `${evidence.commits.length} commit(s) and ${evidence.changedFiles.length} ` +
              'changed file(s) recorded from Git when the session ended.',
            verification: 'verified',
            sourceKind: 'git',
          }
        : {
            scope,
            category: 'summary',
            title: `Summary of ${provider} (${session.startedAt.slice(0, 10)})`,
            body: body || 'No summary written.',
            verification: 'user',
          },
    );
    for (const item of summary.completed)
      await add({ scope, category: 'progress', title: item, body: '', verification: 'user' });
    for (const item of [...summary.pending, ...summary.nextActions]) {
      await add({ scope, category: 'next-action', title: item, body: '', verification: 'user' });
    }
    if (evidence.commits.length > 0) {
      await add({
        scope,
        category: 'commit',
        title: `${evidence.commits.length} commit(s) during the ${provider}`,
        body: evidence.commits
          .map((commit) => `${commit.hash.slice(0, 12)} ${commit.subject}`)
          .join('\n'),
        verification: 'verified',
        sourceKind: 'git',
        refs: { files: [], commit: evidence.head },
      });
    }
    if (evidence.changedFiles.length > 0) {
      await add({
        scope,
        category: 'files-changed',
        title: `${evidence.changedFiles.length} file(s) changed during the ${provider}`,
        body: evidence.changedFiles.slice(0, 200).join('\n'),
        verification: 'verified',
        sourceKind: 'git',
        refs: await this.fileReferences(target, evidence.changedFiles.slice(0, 50)),
      });
    }
    for (const text of summary.decisions) {
      await this.createDecision(
        target,
        {
          ...(session.taskId ? { taskId: session.taskId } : {}),
          question: text.slice(0, 500),
          decision: text.slice(0, 2000),
          alternatives: [],
          reasoning: '',
          evidence: [`Recorded at the end of ${provider} ${session.id}`],
          affected: [],
        },
        `${recordedBy} (${provider})`,
      );
    }
    const ended: AiSession = { ...session, status: 'ended', endedAt: now };
    await this.repo.updateSession(ended);
    return { session: ended, entries: created };
  }

  /**
   * Stores the checkpoint an LLM keeps while it works (PLAN-021): one entry per run,
   * updated with a new revision when the file changes. It is the LLM's own statement,
   * so it stays unverified; credentials are removed like any stored text.
   */
  async recordCheckpoint(
    target: ResolvedTarget,
    input: { runId: string; provider: string; sessionId: string | null; text: string },
  ): Promise<ContextEntry | null> {
    const text = this.options.redact(input.text.trim()).slice(0, CHECKPOINT_TEXT_LIMIT);
    if (text === '') return null;
    const ref = `run:${input.runId}`;
    const existing = (
      await this.repo.listEntries({
        owner: target.owner,
        category: 'checkpoint',
        includeObsolete: true,
        limit: 2000,
      })
    ).find((entry) => entry.source.ref === ref);
    const objective =
      /##\s*Objective\s*\n+\s*(?:[-*]\s*)?(.+)/i.exec(text)?.[1]?.trim() ??
      text
        .split('\n')
        .find((line) => line.trim() !== '' && !line.startsWith('#'))
        ?.trim() ??
      'work in progress';
    const title = `Work in progress (${input.provider}): ${objective}`.slice(0, 200);
    if (existing) {
      if (existing.body === text && existing.title === title) return existing;
      const next: ContextEntry = {
        ...existing,
        title,
        body: text,
        status: 'active',
        revision: existing.revision + 1,
        updatedAt: this.now(),
      };
      await this.repo.updateEntry(
        next,
        this.revisionOf(next, input.provider, 'Checkpoint updated'),
      );
      return next;
    }
    const sessionId =
      input.sessionId === null ? null : ((await this.repo.getSession(input.sessionId))?.id ?? null);
    const now = this.now();
    const entry: ContextEntry = {
      id: this.options.generateId(),
      scope: sessionId === null ? (target.owner.projectId ? 'project' : 'workspace') : 'session',
      ...target.owner,
      taskId: null,
      sessionId,
      category: 'checkpoint',
      title,
      body: text,
      status: 'active',
      verification: 'observed',
      source: { kind: 'agent', ref, recordedBy: input.provider },
      refs: { files: [], commit: null },
      required: false,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    await this.repo.insertEntry(entry, this.revisionOf(entry, input.provider, null));
    return entry;
  }

  listSessions(target: ResolvedTarget): Promise<AiSession[]> {
    return this.repo.listSessions(target.owner);
  }

  /** The active AI session hosted by a terminal, if any. */
  sessionForTerminal(terminalId: string): Promise<AiSession | null> {
    return this.repo.activeSessionForTerminal(terminalId);
  }

  overview(target: ResolvedTarget): Promise<ContextOverview> {
    return this.repo.overview(target.owner);
  }

  reassignProject(projectId: string, workspacePath: string): Promise<void> {
    return this.repo.reassignProject(projectId, workspacePath);
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private revisionOf(
    entry: ContextEntry,
    changedBy: string,
    reason: string | null,
  ): ContextRevision {
    return {
      entryId: entry.id,
      revision: entry.revision,
      title: entry.title,
      body: entry.body,
      category: entry.category,
      verification: entry.verification,
      status: entry.status,
      changedAt: entry.updatedAt,
      changedBy,
      reason,
    };
  }

  private async ownEntry(target: ResolvedTarget | null, id: string): Promise<ContextEntry> {
    const entry = await this.repo.getEntry(id);
    if (entry === null || !sameOwner(entry, target?.owner ?? GLOBAL_OWNER)) throw notFound('Entry');
    return entry;
  }

  private async ownTask(owner: ContextOwner, id: string): Promise<ContextTask> {
    const task = await this.repo.getTask(id);
    if (task === null || !sameOwner(task, owner)) throw notFound('Task');
    return task;
  }

  private async ownTaskId(owner: ContextOwner, id: string | undefined): Promise<string | null> {
    if (id === undefined) return null;
    return (await this.ownTask(owner, id)).id;
  }

  private async ownDecision(target: ResolvedTarget, id: string): Promise<DecisionRecord> {
    const decision = await this.repo.getDecision(id);
    if (decision === null || !sameOwner(decision, target.owner)) throw notFound('Decision');
    return decision;
  }

  private async ownSession(target: ResolvedTarget, id: string): Promise<AiSession> {
    const session = await this.repo.getSession(id);
    if (session === null || !sameOwner(session, target.owner)) throw notFound('Session');
    return session;
  }

  /** Paths are repository-relative; their current content is fingerprinted. */
  private async fileReferences(
    target: ResolvedTarget | null,
    paths: string[],
  ): Promise<ContextEntry['refs']> {
    if (target === null || paths.length === 0) return { files: [], commit: null };
    for (const file of paths) {
      if (file.startsWith('/') || /^[A-Za-z]:/.test(file) || file.split(/[\\/]/).includes('..')) {
        throw invalid('files', `"${file}" must be a path inside the repository.`);
      }
    }
    const state = await this.options.inspector.state(target.directory);
    if (state.root === null)
      return { files: paths.map((path) => ({ path, hash: null })), commit: null };
    const root = state.root;
    const files = await Promise.all(
      paths.map(async (path) => ({
        path,
        hash: await this.options.inspector.fileHash(root, path),
      })),
    );
    // The branch tells later bundles that these files were described on another line of work.
    return { files, commit: null, branch: state.branch };
  }

  private async gitEvidence(target: ResolvedTarget, base: string | null): Promise<SessionEvidence> {
    try {
      const state = await this.options.inspector.state(target.directory);
      if (state.root === null) return { commits: [], changedFiles: [], head: null };
      const [commits, changedFiles] = await Promise.all([
        // Without a task or session base, the latest commits are still useful evidence.
        this.options.inspector
          .commitsSince(state.root, base)
          .then((commits) => (base === null ? commits.slice(0, RECENT_COMMITS) : commits)),
        this.options.inspector.changedFilesSince(state.root, base),
      ]);
      return { commits, changedFiles, head: state.head };
    } catch (error) {
      this.logger.warn('Repository evidence unavailable for shared context', {
        error: error instanceof Error ? error.name : 'unknown',
      });
      return { commits: [], changedFiles: [], head: null };
    }
  }
}
