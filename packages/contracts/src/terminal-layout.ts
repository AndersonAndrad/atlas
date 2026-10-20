import { z } from 'zod';
import { TerminalIdSchema } from './terminal.js';

/** Workspace whose layout is stored: a terminal group id or `ungrouped`. */
export const UNGROUPED_WORKSPACE = 'ungrouped';
export const TerminalWorkspaceKeySchema = z.union([
  z.literal(UNGROUPED_WORKSPACE),
  z.uuid({ message: 'Invalid workspace.' }),
]);

/** Maximum number of visible panes in one workspace. */
export const TERMINAL_MAX_PANES = 6;

const LayoutNodeIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'Invalid layout identifier.');

export interface TerminalPaneNode {
  type: 'pane';
  id: string;
  sessionId: string;
}

/**
 * `row` places children side by side (a vertical divider, "split right");
 * `column` stacks them (a horizontal divider, "split down").
 */
export interface TerminalSplitNode {
  type: 'split';
  id: string;
  direction: 'row' | 'column';
  /** Size of the first child as a percentage of the split. */
  ratio: number;
  children: [TerminalLayoutNode, TerminalLayoutNode];
}

export type TerminalLayoutNode = TerminalPaneNode | TerminalSplitNode;

export const TerminalLayoutNodeSchema: z.ZodType<TerminalLayoutNode> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.strictObject({
      type: z.literal('pane'),
      id: LayoutNodeIdSchema,
      sessionId: TerminalIdSchema,
    }),
    z.strictObject({
      type: z.literal('split'),
      id: LayoutNodeIdSchema,
      direction: z.enum(['row', 'column']),
      ratio: z.number().min(10).max(90),
      children: z.tuple([TerminalLayoutNodeSchema, TerminalLayoutNodeSchema]),
    }),
  ]),
);

function paneCount(node: TerminalLayoutNode): number {
  return node.type === 'pane' ? 1 : paneCount(node.children[0]) + paneCount(node.children[1]);
}

/** Presentation state of one project's terminal workspace, persisted by the Engine. */
export const TerminalWorkspaceLayoutSchema = z
  .strictObject({
    version: z.literal(1),
    root: TerminalLayoutNodeSchema.nullable(),
    activePaneId: LayoutNodeIdSchema.nullable(),
  })
  .refine((layout) => layout.root === null || paneCount(layout.root) <= TERMINAL_MAX_PANES, {
    message: `A workspace may contain at most ${TERMINAL_MAX_PANES} panes.`,
  });

export type TerminalWorkspaceLayout = z.output<typeof TerminalWorkspaceLayoutSchema>;
