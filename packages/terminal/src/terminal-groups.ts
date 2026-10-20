import {
  TERMINAL_GROUPS_MAX_COUNT,
  TerminalGroupIdSchema,
  TerminalGroupNameSchema,
  parseInput,
  type TerminalGroup,
} from '@atlas/contracts';
import { AtlasError, noopLogger, type Logger } from '@atlas/shared';
import type { TerminalGroupRepository } from './ports.js';
import type { TerminalService } from './terminal-service.js';
import type { TerminalSettings } from './terminal-settings.js';

export interface TerminalGroupsDependencies {
  groups: TerminalGroupRepository;
  terminals: TerminalService;
  settings: TerminalSettings;
  clock: { now(): Date };
  generateId: () => string;
  logger?: Logger;
}

/**
 * User-defined collections of terminals. Groups only organize terminals: no
 * group operation starts, restarts or stops a process unless the user explicitly
 * asks to terminate the terminals of a deleted group.
 */
export class TerminalGroups {
  private readonly logger: Logger;

  constructor(private readonly deps: TerminalGroupsDependencies) {
    this.logger = deps.logger ?? noopLogger;
  }

  list(): Promise<TerminalGroup[]> {
    return this.deps.groups.findAll();
  }

  async exists(id: string): Promise<boolean> {
    return (await this.list()).some((group) => group.id === id);
  }

  async create(name: string): Promise<TerminalGroup> {
    const parsedName = parseInput(TerminalGroupNameSchema, name);
    const groups = await this.list();
    if (groups.length >= TERMINAL_GROUPS_MAX_COUNT) {
      throw new AtlasError('VALIDATION_FAILED', 'Too many terminal groups.', {
        issues: [{ field: 'name', message: `At most ${TERMINAL_GROUPS_MAX_COUNT} groups.` }],
      });
    }
    const group: TerminalGroup = {
      id: this.deps.generateId(),
      name: parsedName,
      position: groups.length,
      collapsed: false,
      createdAt: this.deps.clock.now().toISOString(),
    };
    await this.deps.groups.save(group);
    this.logger.info('Terminal group created', { groupId: group.id });
    await this.publish();
    return group;
  }

  async rename(id: string, name: string): Promise<TerminalGroup> {
    const group = await this.get(id);
    group.name = parseInput(TerminalGroupNameSchema, name);
    await this.deps.groups.save(group);
    await this.publish();
    return group;
  }

  async setCollapsed(id: string, collapsed: boolean): Promise<TerminalGroup> {
    const group = await this.get(id);
    group.collapsed = collapsed;
    await this.deps.groups.save(group);
    await this.publish();
    return group;
  }

  /** Moves a group to `position` in the display order. */
  async move(id: string, position: number): Promise<TerminalGroup[]> {
    const groups = await this.list();
    const index = groups.findIndex((group) => group.id === id);
    if (index === -1) throw notFound(id);
    const [group] = groups.splice(index, 1);
    groups.splice(Math.min(Math.max(position, 0), groups.length), 0, group!);
    groups.forEach((item, order) => (item.position = order));
    await this.deps.groups.saveAll(groups);
    await this.publish();
    return groups;
  }

  /**
   * Deletes a group. Its terminals become ungrouped and keep running, unless
   * `terminateTerminals` is set (the user confirmed): then they are closed.
   */
  async delete(id: string, options: { terminateTerminals: boolean }): Promise<void> {
    const group = await this.get(id);
    const members = this.deps.terminals.list().filter((session) => session.groupId === group.id);
    if (options.terminateTerminals) {
      for (const session of members) await this.deps.terminals.dismiss(session.id);
    } else {
      await this.deps.terminals.ungroupAll(group.id);
    }
    await this.deps.groups.delete(group.id);
    await this.deps.settings.deleteLayout(group.id);
    const remaining = await this.list();
    remaining.forEach((item, order) => (item.position = order));
    await this.deps.groups.saveAll(remaining);
    this.logger.info('Terminal group deleted', {
      groupId: group.id,
      terminals: members.length,
      terminated: options.terminateTerminals,
    });
    await this.publish();
  }

  private async get(id: string): Promise<TerminalGroup> {
    const parsedId = TerminalGroupIdSchema.safeParse(id);
    const group = parsedId.success
      ? (await this.list()).find((item) => item.id === parsedId.data)
      : undefined;
    if (group === undefined) throw notFound(id);
    return group;
  }

  private async publish(): Promise<void> {
    this.deps.terminals.publish({ type: 'groups', groups: await this.list() });
  }
}

function notFound(id: string): AtlasError {
  return new AtlasError('VALIDATION_FAILED', 'The terminal group does not exist.', {
    details: { groupId: id },
    issues: [{ field: 'groupId', message: 'The terminal group does not exist.' }],
  });
}
