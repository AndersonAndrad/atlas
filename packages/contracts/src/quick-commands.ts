import { z } from 'zod';
import { ProjectIdSchema } from './project.js';
import { TERMINAL_TITLE_MAX_LENGTH, TerminalGroupIdSchema } from './terminal.js';

/**
 * Quick commands (PLAN-023): named shell commands the user keeps in ATLAS. Prioritized
 * ones become project actions, which open a terminal in the project and run them.
 */
export const QUICK_COMMAND_NAME_MAX_LENGTH = TERMINAL_TITLE_MAX_LENGTH;
export const QUICK_COMMAND_MAX_LENGTH = 1000;
export const QUICK_COMMANDS_MAX_COUNT = 100;

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
  /**
   * Prioritized commands appear in every project's action menu (each project can hide
   * them); the others only in projects that enable them.
   */
  prioritized: z.boolean(),
});
export type QuickCommandInput = z.infer<typeof QuickCommandInputSchema>;

export const QuickCommandSchema = QuickCommandInputSchema.extend({ id: QuickCommandIdSchema });
export type QuickCommand = z.infer<typeof QuickCommandSchema>;

export const QuickCommandMoveSchema = z.enum(['up', 'down']);
export type QuickCommandMove = z.infer<typeof QuickCommandMoveSchema>;

/**
 * A project's choice of quick commands: prioritized commands appear in every project
 * unless hidden there; other commands appear only in projects that enable them.
 */
export const ProjectQuickCommandSettingsSchema = z.strictObject({
  /** Prioritized commands not offered in this project. */
  hidden: z.array(QuickCommandIdSchema).max(QUICK_COMMANDS_MAX_COUNT),
  /** Commands that are not prioritized, offered in this project only. */
  enabled: z.array(QuickCommandIdSchema).max(QUICK_COMMANDS_MAX_COUNT),
});
export type ProjectQuickCommandSettings = z.infer<typeof ProjectQuickCommandSettingsSchema>;

export const RunQuickCommandSchema = z.strictObject({
  projectId: ProjectIdSchema,
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
