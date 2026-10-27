import { z } from 'zod';
import { RelativeFilePathSchema } from './files.js';
import { ProjectIdSchema } from './project.js';

// ---------------------------------------------------------------------------
// Debugger foundation: Debug Adapter Protocol sessions (SDD-016 Task 01, PLAN-044)
// ---------------------------------------------------------------------------

export const DEBUG_SESSION_STATUSES = [
  'CREATED',
  'STARTING',
  'RUNNING',
  'PAUSED',
  'TERMINATING',
  'TERMINATED',
  'FAILED',
] as const;
export type DebugSessionStatus = (typeof DEBUG_SESSION_STATUSES)[number];

/** States a session never leaves. */
export const DEBUG_FINAL_STATUSES: readonly DebugSessionStatus[] = ['TERMINATED', 'FAILED'];

export const DebugSessionIdSchema = z.uuid();

export const DebugAdapterIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9.-]{0,63}$/, 'Use a debugger id such as node or python.');

const ArgumentText = z
  .string()
  .max(4096)
  .regex(/^[^\0]*$/, 'Arguments cannot contain NUL.');

/** JSON values an adapter-specific option may hold, bounded when serialized. */
const AdapterOptionsSchema = z
  .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/), z.json())
  .refine((value) => Object.keys(value).length <= 64, 'Too many debugger options.')
  .refine((value) => JSON.stringify(value).length <= 64 * 1024, 'Debugger options are too large.');

/**
 * What to debug and how (§2). Built by the user in ATLAS: repository files such as
 * `launch.json` are never read or run automatically.
 */
export const DebugConfigurationSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  adapterId: DebugAdapterIdSchema,
  request: z.enum(['launch', 'attach']),
  projectId: ProjectIdSchema,
  /** Working folder, relative to the project folder ('' is the project folder). */
  cwd: RelativeFilePathSchema.default(''),
  /** Passed to the adapter as written. */
  program: ArgumentText.nullable().default(null),
  args: z.array(ArgumentText).max(256).default([]),
  /** Environment of the program being debugged, not of the adapter. */
  env: z
    .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/), z.string().max(32_768))
    .refine((value) => Object.keys(value).length <= 100, 'Too many environment variables.')
    .default({}),
  stopOnEntry: z.boolean().default(false),
  /** Adapter-specific launch or attach arguments; they cannot replace the ones above. */
  options: AdapterOptionsSchema.default({}),
});
export type DebugConfiguration = z.output<typeof DebugConfigurationSchema>;
export type DebugConfigurationInput = z.input<typeof DebugConfigurationSchema>;

/** A debug adapter ATLAS knows how to start. Only the Engine registers adapters. */
export interface DebugAdapter {
  id: string;
  label: string;
  /** Absolute path of the adapter executable; started without a shell. */
  command: string;
  args: string[];
  /** Monaco language ids the adapter debugs. */
  languages: string[];
}

export interface DebugFailure {
  code: string;
  message: string;
  /** What the adapter said, trimmed and without control characters, when it said anything. */
  adapterMessage: string | null;
}

export interface DebugSession {
  id: string;
  name: string;
  adapterId: string;
  projectId: string;
  request: 'launch' | 'attach';
  status: DebugSessionStatus;
  /** Adapter capabilities from `initialize`, once known. */
  capabilities: Record<string, unknown> | null;
  failure: DebugFailure | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
}

/** What a session's owner is told (FR: subscribe to session events). */
export type DebugEvent =
  | { type: 'status'; sessionId: string; status: DebugSessionStatus; failure: DebugFailure | null }
  | {
      type: 'stopped';
      sessionId: string;
      reason: string;
      threadId: number | null;
      description: string | null;
    }
  | { type: 'output'; sessionId: string; category: string; output: string }
  /** Any other DAP event; `body` is dropped when it is too large. */
  | { type: 'adapter-event'; sessionId: string; event: string; body: unknown };
