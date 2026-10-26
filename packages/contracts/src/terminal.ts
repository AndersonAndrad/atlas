import { z } from 'zod';
import { ProjectIdSchema, WorkspacePathSchema } from './project.js';
import type { GitOperation } from './git.js';
import type { AtlasNotification } from './notification.js';

export const TERMINAL_STATUSES = [
  'CREATED',
  'STARTING',
  'RUNNING',
  'EXITED',
  'FAILED',
  'TERMINATING',
  'TERMINATED',
] as const;

export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

/** Statuses after which a session can never run again. */
export const FINAL_TERMINAL_STATUSES: readonly TerminalStatus[] = [
  'EXITED',
  'FAILED',
  'TERMINATED',
];

export function isFinalTerminalStatus(status: TerminalStatus): boolean {
  return FINAL_TERMINAL_STATUSES.includes(status);
}

/**
 * Why a session ended:
 * - exited: the shell exited on its own (any exit code or signal).
 * - user: the user terminated it.
 * - engine-shutdown: the Engine stopped gracefully and terminated it.
 * - startup-failed: the shell could not be started.
 * - engine-lost: the Engine stopped without recording the end (crash or kill).
 */
export const TERMINAL_END_REASONS = [
  'exited',
  'user',
  'engine-shutdown',
  'startup-failed',
  'engine-lost',
] as const;

export type TerminalEndReason = (typeof TERMINAL_END_REASONS)[number];

export const TERMINAL_TITLE_MAX_LENGTH = 60;
export const TERMINAL_MIN_COLUMNS = 2;
export const TERMINAL_MAX_COLUMNS = 1000;
export const TERMINAL_MIN_ROWS = 1;
export const TERMINAL_MAX_ROWS = 500;
/** Upper bound for a single input chunk (large pastes arrive as one chunk). */
export const TERMINAL_INPUT_MAX_LENGTH = 1_000_000;

export const TerminalIdSchema = z.uuid({ message: 'Invalid terminal identifier.' });

export const ShellIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, 'Invalid shell identifier.');

export const TerminalTitleSchema = z
  .string()
  .trim()
  .min(1, 'Title is required.')
  .max(TERMINAL_TITLE_MAX_LENGTH, `Title must be at most ${TERMINAL_TITLE_MAX_LENGTH} characters.`)
  // eslint-disable-next-line no-control-regex
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), 'Title contains invalid characters.');

export const TerminalColumnsSchema = z
  .number()
  .int()
  .min(TERMINAL_MIN_COLUMNS)
  .max(TERMINAL_MAX_COLUMNS);
export const TerminalRowsSchema = z.number().int().min(TERMINAL_MIN_ROWS).max(TERMINAL_MAX_ROWS);

export const TerminalDimensionsSchema = z.strictObject({
  columns: TerminalColumnsSchema,
  rows: TerminalRowsSchema,
});

export type TerminalDimensions = z.infer<typeof TerminalDimensionsSchema>;

export const TerminalGroupIdSchema = z.uuid({ message: 'Invalid group identifier.' });

/**
 * A terminal starts either in a registered project (its directory comes from the
 * registry) or standalone: in `cwd` when given, otherwise in the configured
 * default working directory. `cwd` is validated by the Engine; desktop clients may
 * only pass directories chosen in the native picker.
 */
export const CreateTerminalInputSchema = z
  .strictObject({
    projectId: ProjectIdSchema.optional(),
    cwd: WorkspacePathSchema.optional(),
    shellId: ShellIdSchema.optional(),
    title: TerminalTitleSchema.optional(),
    groupId: TerminalGroupIdSchema.optional(),
    columns: TerminalColumnsSchema.optional(),
    rows: TerminalRowsSchema.optional(),
  })
  .refine((input) => input.projectId === undefined || input.cwd === undefined, {
    message: 'A terminal starts in a project or in a directory, not both.',
    path: ['cwd'],
  });

export type CreateTerminalInput = z.input<typeof CreateTerminalInputSchema>;

export const TerminalInputDataSchema = z.string().max(TERMINAL_INPUT_MAX_LENGTH);

export const ListTerminalsInputSchema = z
  .strictObject({ projectId: ProjectIdSchema.optional() })
  .default({});

/** `null` removes the custom name and restores the automatic one. */
export const TerminalCustomTitleSchema = TerminalTitleSchema.nullable();

export const TERMINAL_GROUP_NAME_MAX_LENGTH = 60;
export const TERMINAL_GROUPS_MAX_COUNT = 50;

export const TerminalGroupNameSchema = z
  .string()
  .trim()
  .min(1, 'Name is required.')
  .max(
    TERMINAL_GROUP_NAME_MAX_LENGTH,
    `Name must be at most ${TERMINAL_GROUP_NAME_MAX_LENGTH} characters.`,
  )
  // eslint-disable-next-line no-control-regex
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), 'Name contains invalid characters.');

/** A user-defined collection of terminals, possibly from different projects. */
export interface TerminalGroup {
  id: string;
  name: string;
  /** Zero-based display order. */
  position: number;
  collapsed: boolean;
  createdAt: string;
}

/** Where a terminal's working directory information comes from. */
export type TerminalCwdSource = 'detected' | 'initial';

export interface TerminalShellRef {
  id: string;
  name: string;
  path: string;
}

/** Metadata of a terminal session. Runtime handles never leave the Engine. */
export interface TerminalSession {
  id: string;
  /** Associated registered project; `null` for standalone terminals. */
  projectId: string | null;
  /** Effective name: the custom name when set, otherwise the automatic one. */
  title: string;
  /** User-defined name; never overwritten by automatic naming. */
  customTitle: string | null;
  /** Generated name (from the current directory); kept even when a custom name exists. */
  autoTitle: string;
  groupId: string | null;
  /** Order inside its group (or among ungrouped terminals). */
  groupPosition: number;
  shell: TerminalShellRef;
  /** Working directory the shell was started in. */
  cwd: string;
  /** Last known working directory of the shell; equals `cwd` until detected. */
  currentCwd: string;
  /** `detected` when read from the operating system, `initial` otherwise. */
  cwdSource: TerminalCwdSource;
  status: TerminalStatus;
  pid?: number;
  exitCode?: number;
  signal?: number;
  endReason?: TerminalEndReason;
  /** User-safe explanation when the session failed to start. */
  failureMessage?: string;
  columns: number;
  rows: number;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
}

export interface ShellOption {
  id: string;
  name: string;
  path: string;
  args: string[];
  source: 'system' | 'custom';
  isDefault: boolean;
}

export interface ShellCatalog {
  shells: ShellOption[];
  /** Problems found in the custom shell configuration, safe to display. */
  configurationIssues: string[];
}

/** Whether closing a session would interrupt a program other than the idle shell. */
export interface TerminalCloseInfo {
  requiresConfirmation: boolean;
  /** Name of the foreground process when known. */
  processName?: string;
}

/** State needed to rebuild a terminal view after it was hidden or the renderer reloaded. */
export interface TerminalAttachment {
  session: TerminalSession;
  /** Serialized screen and scrollback (escape sequences). */
  snapshot: string;
  /** Output events with `seq` lower or equal to this value are included in the snapshot. */
  seq: number;
}

export type TerminalEvent =
  | { type: 'output'; sessionId: string; seq: number; data: string }
  | { type: 'session'; session: TerminalSession }
  | { type: 'removed'; sessionId: string; projectId: string | null }
  | { type: 'groups'; groups: TerminalGroup[] }
  /** Git state of a repository may have changed; clients re-request snapshots. */
  | { type: 'git'; repositoryRoot: string }
  /** Progress or outcome of a Git operation started by any client. */
  | { type: 'git-operation'; operation: GitOperation }
  /** Notifications changed; `created` is set when one was just published (for a toast). */
  | { type: 'notifications'; created: AtlasNotification | null }
  /** The LLM open in a terminal, or its account's usage, may have changed (PLAN-031). */
  | { type: 'llm-usage' }
  /** Project Hub notes changed in any client (SDD-010). */
  | { type: 'notes'; noteId: string }
  /**
   * Entries of watched folders changed on disk (SDD-011 FR-1107); `paths` are relative to
   * the project folder. Clients compare versions: the event alone does not mean new content.
   */
  | { type: 'files'; projectId: string; paths: string[] };

export const TERMINAL_FONT_FAMILIES = ['system', 'menlo', 'sf-mono', 'monaco', 'courier'] as const;
export type TerminalFontFamily = (typeof TERMINAL_FONT_FAMILIES)[number];

export const TERMINAL_FONT_SIZE_MIN = 8;
export const TERMINAL_FONT_SIZE_MAX = 32;
export const TERMINAL_SCROLLBACK_MIN = 500;
export const TERMINAL_SCROLLBACK_MAX = 50_000;

const FontSizeSchema = z.number().int().min(TERMINAL_FONT_SIZE_MIN).max(TERMINAL_FONT_SIZE_MAX);
const FontFamilySchema = z.enum(TERMINAL_FONT_FAMILIES);
const ScrollbackSchema = z.number().int().min(TERMINAL_SCROLLBACK_MIN).max(TERMINAL_SCROLLBACK_MAX);
/** `null` follows the operating system and $SHELL. */
const DefaultShellSchema = ShellIdSchema.nullable();
/** `null` uses the user's home directory. */
const DefaultWorkingDirectorySchema = WorkspacePathSchema.nullable();

export const TerminalPreferencesSchema = z.strictObject({
  fontSize: FontSizeSchema.default(13),
  fontFamily: FontFamilySchema.default('system'),
  scrollback: ScrollbackSchema.default(5000),
  defaultShellId: DefaultShellSchema.default(null),
  defaultWorkingDirectory: DefaultWorkingDirectorySchema.default(null),
});

export type TerminalPreferences = z.output<typeof TerminalPreferencesSchema>;

// Declared without defaults: a partial update must not reset omitted preferences.
export const UpdateTerminalPreferencesSchema = z
  .strictObject({
    fontSize: FontSizeSchema.optional(),
    fontFamily: FontFamilySchema.optional(),
    scrollback: ScrollbackSchema.optional(),
    defaultShellId: DefaultShellSchema.optional(),
    defaultWorkingDirectory: DefaultWorkingDirectorySchema.optional(),
  })
  .refine((input) => Object.values(input).some((value) => value !== undefined), {
    message: 'At least one preference must be provided.',
  });

export type UpdateTerminalPreferencesInput = z.input<typeof UpdateTerminalPreferencesSchema>;

const ShellArgumentSchema = z
  .string()
  .max(512)
  .refine((value) => !value.includes('\0'), 'Arguments cannot contain NUL characters.');

/** One user-configured shell in `<data dir>/shells.json`. */
export const CustomShellSchema = z.strictObject({
  id: ShellIdSchema,
  name: z.string().trim().min(1).max(60),
  path: z
    .string()
    .min(1)
    .max(4096)
    .refine((value) => !value.includes('\0'), 'The path contains invalid characters.'),
  args: z.array(ShellArgumentSchema).max(32).default([]),
});

export const CustomShellsFileSchema = z.strictObject({
  shells: z.array(CustomShellSchema).max(32),
});

export type CustomShell = z.output<typeof CustomShellSchema>;
