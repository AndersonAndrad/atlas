import { z } from 'zod';
import { ProjectIdSchema } from './project.js';
import { TERMINAL_TITLE_MAX_LENGTH, TerminalGroupIdSchema } from './terminal.js';

/**
 * Quick commands (PLAN-023, SDD-025 Task 03): named shell commands the user keeps in ATLAS.
 * Each is available in every project, or only in the projects selected for it; running one
 * opens a terminal and types it.
 */
export const QUICK_COMMAND_NAME_MAX_LENGTH = TERMINAL_TITLE_MAX_LENGTH;
export const QUICK_COMMAND_MAX_LENGTH = 1000;
export const QUICK_COMMANDS_MAX_COUNT = 100;
/** Projects one command can be limited to. */
export const QUICK_COMMAND_PROJECTS_MAX = 200;

/**
 * Where a command is available (SDD-025 Task 03). `ALL`: every project, and without a
 * project. `PROJECTS`: only the listed ones; with none left (its projects were removed) it
 * is available nowhere until projects are chosen again, never everywhere.
 */
export const QUICK_COMMAND_SCOPES = ['ALL', 'PROJECTS'] as const;
export type QuickCommandScope = (typeof QUICK_COMMAND_SCOPES)[number];

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export const QuickCommandIdSchema = z.uuid();

export const QuickCommandInputSchema = z.strictObject({
  name: z
    .string()
    .trim()
    .min(1, 'Name is required.')
    .max(
      QUICK_COMMAND_NAME_MAX_LENGTH,
      `Name must be at most ${QUICK_COMMAND_NAME_MAX_LENGTH} characters.`,
    )
    .refine((value) => !CONTROL_CHARACTERS.test(value), 'Name contains invalid characters.'),
  /** One line, typed into the project's terminal as if the user typed it. */
  command: z
    .string()
    .trim()
    .min(1, 'Command is required.')
    .max(
      QUICK_COMMAND_MAX_LENGTH,
      `Command must be at most ${QUICK_COMMAND_MAX_LENGTH} characters.`,
    )
    .refine(
      (value) => !CONTROL_CHARACTERS.test(value),
      'Command must be a single line without control characters.',
    ),
  /** Stable project ids; none selected makes the command available in every project. */
  projectIds: z
    .array(ProjectIdSchema)
    .max(QUICK_COMMAND_PROJECTS_MAX)
    .refine((ids) => new Set(ids).size === ids.length, 'Each project can be selected once.'),
});
export type QuickCommandInput = z.infer<typeof QuickCommandInputSchema>;

export interface QuickCommand {
  id: string;
  name: string;
  command: string;
  scope: QuickCommandScope;
  /** The projects of a `PROJECTS` command, in the user's selection order; empty for `ALL`. */
  projectIds: string[];
}

/** Whether a command is offered with this project selected (null: no project). */
export function quickCommandAvailableIn(command: QuickCommand, projectId: string | null): boolean {
  if (command.scope === 'ALL') return true;
  return projectId !== null && command.projectIds.includes(projectId);
}

export const QuickCommandMoveSchema = z.enum(['up', 'down']);
export type QuickCommandMove = z.infer<typeof QuickCommandMoveSchema>;

/** Adds a project to a command limited to projects, or removes it (project details). */
export const QuickCommandAssignmentSchema = z.strictObject({
  commandId: QuickCommandIdSchema,
  projectId: ProjectIdSchema,
  assigned: z.boolean(),
});
export type QuickCommandAssignmentInput = z.infer<typeof QuickCommandAssignmentSchema>;

export const RunQuickCommandSchema = z.strictObject({
  /**
   * The project to open the terminal in. Without one, only a command available in every
   * project runs, in a terminal in the default folder.
   */
  projectId: ProjectIdSchema.optional(),
  commandId: QuickCommandIdSchema,
  /** Terminal group to open the terminal in; the default group otherwise. */
  groupId: TerminalGroupIdSchema.optional(),
});
export type RunQuickCommandInput = z.infer<typeof RunQuickCommandSchema>;

/**
 * Something that can be done for a project from an action menu. Only terminals use the
 * actions today; other places can offer the same list later.
 */
export type ProjectAction =
  | { kind: 'open-terminal' }
  | { kind: 'run-command'; commandId: string; name: string; command: string };
