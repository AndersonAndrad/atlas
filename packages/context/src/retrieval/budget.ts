import {
  ContextBudgetSettingsSchema,
  UpdateContextBudgetSettingsSchema,
  parseInput,
  type AgentRole,
  type AiProvider,
  type BudgetSource,
  type ContextBudgetSettings,
  type ExecutionProfile,
} from '@atlas/contracts';
import { noopLogger, type Logger } from '@atlas/shared';

export const CONTEXT_BUDGETS_KEY = 'context.budgets';

/** Application settings storage (`application_settings`). */
export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

export interface BudgetRequest {
  /** Explicit budget of this request (e.g. the CLI `--budget`). */
  requested?: number;
  task?: { budgetTokens: number | null } | null;
  profile?: ExecutionProfile;
  role: AgentRole;
  provider: AiProvider | 'generic';
}

/**
 * Most specific first (FR-603): request, task override, execution profile, agent role,
 * provider, then the global default. Every value is an estimated token count.
 */
export function resolveBudget(
  settings: ContextBudgetSettings,
  request: BudgetRequest,
): { tokens: number; source: BudgetSource } {
  if (request.requested !== undefined) return { tokens: request.requested, source: 'request' };
  const task = request.task?.budgetTokens ?? null;
  if (task !== null) return { tokens: task, source: 'task' };
  const profile = request.profile === undefined ? undefined : settings.profiles[request.profile];
  if (profile !== undefined) return { tokens: profile, source: 'profile' };
  const role = settings.roles[request.role];
  if (role !== undefined) return { tokens: role, source: 'role' };
  const provider = settings.providers[request.provider];
  if (provider !== undefined) return { tokens: provider, source: 'provider' };
  return { tokens: settings.defaultTokens, source: 'default' };
}

/** Context budgets stored as JSON in the application settings. */
export class ContextBudgetStore {
  constructor(
    private readonly store: KeyValueStore,
    private readonly logger: Logger = noopLogger,
  ) {}

  async get(): Promise<ContextBudgetSettings> {
    const raw = await this.store.get(CONTEXT_BUDGETS_KEY);
    if (raw === null) return ContextBudgetSettingsSchema.parse({});
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      value = undefined;
    }
    const parsed = ContextBudgetSettingsSchema.safeParse(value);
    if (!parsed.success) {
      this.logger.warn('Stored context budgets are invalid; using defaults');
      return ContextBudgetSettingsSchema.parse({});
    }
    return parsed.data;
  }

  /** Replaces the given groups; a group passed as `{}` removes its overrides. */
  async update(input: unknown): Promise<ContextBudgetSettings> {
    const changes = parseInput(UpdateContextBudgetSettingsSchema, input);
    const next = ContextBudgetSettingsSchema.parse({ ...(await this.get()), ...changes });
    await this.store.set(CONTEXT_BUDGETS_KEY, JSON.stringify(next));
    return next;
  }
}
