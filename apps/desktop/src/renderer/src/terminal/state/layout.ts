import type {
  TerminalLayoutNode,
  TerminalPaneNode,
  TerminalWorkspaceLayout,
} from '@atlas/contracts';

/** Mirrors TERMINAL_MAX_PANES in @atlas/contracts (kept local to avoid bundling Zod twice). */
export const MAX_PANES = 6;

export type SplitDirection = 'row' | 'column';

export type IdFactory = () => string;

export const EMPTY_LAYOUT: TerminalWorkspaceLayout = { version: 1, root: null, activePaneId: null };

/** Panes in reading order (depth-first, first child before second). */
export function listPanes(node: TerminalLayoutNode | null): TerminalPaneNode[] {
  if (node === null) return [];
  if (node.type === 'pane') return [node];
  return [...listPanes(node.children[0]), ...listPanes(node.children[1])];
}

export function findPaneBySession(
  layout: TerminalWorkspaceLayout,
  sessionId: string,
): TerminalPaneNode | undefined {
  return listPanes(layout.root).find((pane) => pane.sessionId === sessionId);
}

export function activePane(layout: TerminalWorkspaceLayout): TerminalPaneNode | undefined {
  const panes = listPanes(layout.root);
  return panes.find((pane) => pane.id === layout.activePaneId) ?? panes[0];
}

/**
 * Shows `sessionId`: focuses the pane already showing it, otherwise displays it
 * in the active pane (the session previously shown there keeps running hidden).
 */
export function showSession(
  layout: TerminalWorkspaceLayout,
  sessionId: string,
  newId: IdFactory,
): TerminalWorkspaceLayout {
  const visible = findPaneBySession(layout, sessionId);
  if (visible) return { ...layout, activePaneId: visible.id };
  const target = activePane(layout);
  if (target === undefined) {
    const pane: TerminalPaneNode = { type: 'pane', id: newId(), sessionId };
    return { ...layout, root: pane, activePaneId: pane.id };
  }
  return {
    ...layout,
    root: mapNode(layout.root!, (node) =>
      node.type === 'pane' && node.id === target.id ? { ...node, sessionId } : node,
    ),
    activePaneId: target.id,
  };
}

/** Splits the active pane; the new pane shows `sessionId` and becomes active. */
export function splitActivePane(
  layout: TerminalWorkspaceLayout,
  direction: SplitDirection,
  sessionId: string,
  newId: IdFactory,
): TerminalWorkspaceLayout {
  if (findPaneBySession(layout, sessionId)) return layout;
  const target = activePane(layout);
  if (target === undefined) return showSession(layout, sessionId, newId);
  if (!canSplit(layout)) return layout;
  const pane: TerminalPaneNode = { type: 'pane', id: newId(), sessionId };
  const root = mapNode(layout.root!, (node) =>
    node.type === 'pane' && node.id === target.id
      ? { type: 'split', id: newId(), direction, ratio: 50, children: [node, pane] }
      : node,
  );
  return { ...layout, root, activePaneId: pane.id };
}

export function canSplit(layout: TerminalWorkspaceLayout): boolean {
  return listPanes(layout.root).length < MAX_PANES;
}

/**
 * Removes a pane from the layout. Its session is not affected: closing a pane
 * only hides the terminal.
 */
export function closePane(
  layout: TerminalWorkspaceLayout,
  paneId: string,
): TerminalWorkspaceLayout {
  if (layout.root === null) return layout;
  const panes = listPanes(layout.root);
  const index = panes.findIndex((pane) => pane.id === paneId);
  if (index === -1) return layout;
  const root = removeNode(layout.root, paneId);
  const remaining = listPanes(root);
  const activeStillThere = remaining.some((pane) => pane.id === layout.activePaneId);
  const nextActive = activeStillThere
    ? layout.activePaneId
    : (remaining[Math.min(index, remaining.length - 1)]?.id ?? null);
  return { ...layout, root, activePaneId: nextActive };
}

/**
 * Removes a session that no longer exists. Its pane shows `replacementId`
 * when given (another hidden session), otherwise the pane is closed.
 */
export function removeSession(
  layout: TerminalWorkspaceLayout,
  sessionId: string,
  replacementId?: string,
): TerminalWorkspaceLayout {
  const pane = findPaneBySession(layout, sessionId);
  if (pane === undefined) return layout;
  if (replacementId !== undefined && findPaneBySession(layout, replacementId) === undefined) {
    return {
      ...layout,
      root: mapNode(layout.root!, (node) =>
        node.type === 'pane' && node.id === pane.id ? { ...node, sessionId: replacementId } : node,
      ),
    };
  }
  return closePane(layout, pane.id);
}

/** Replaces a session id (e.g. after a restart) wherever it is displayed. */
export function replaceSession(
  layout: TerminalWorkspaceLayout,
  previousId: string,
  nextId: string,
): TerminalWorkspaceLayout {
  if (layout.root === null) return layout;
  return {
    ...layout,
    root: mapNode(layout.root, (node) =>
      node.type === 'pane' && node.sessionId === previousId ? { ...node, sessionId: nextId } : node,
    ),
  };
}

/** Keeps only the active pane ("restore single pane"). */
export function collapseToActivePane(layout: TerminalWorkspaceLayout): TerminalWorkspaceLayout {
  const pane = activePane(layout);
  if (pane === undefined) return layout;
  return { ...layout, root: pane, activePaneId: pane.id };
}

export function focusPane(
  layout: TerminalWorkspaceLayout,
  paneId: string,
): TerminalWorkspaceLayout {
  return listPanes(layout.root).some((pane) => pane.id === paneId)
    ? { ...layout, activePaneId: paneId }
    : layout;
}

/** Moves focus to the next (`offset` 1) or previous (`offset` -1) pane, wrapping around. */
export function focusAdjacentPane(
  layout: TerminalWorkspaceLayout,
  offset: 1 | -1,
): TerminalWorkspaceLayout {
  const panes = listPanes(layout.root);
  if (panes.length === 0) return layout;
  const current = Math.max(
    0,
    panes.findIndex((pane) => pane.id === layout.activePaneId),
  );
  const next = panes[(current + offset + panes.length) % panes.length]!;
  return { ...layout, activePaneId: next.id };
}

export function setSplitRatio(
  layout: TerminalWorkspaceLayout,
  splitId: string,
  ratio: number,
): TerminalWorkspaceLayout {
  if (layout.root === null) return layout;
  const clamped = Math.min(90, Math.max(10, Math.round(ratio * 10) / 10));
  return {
    ...layout,
    root: mapNode(layout.root, (node) =>
      node.type === 'split' && node.id === splitId ? { ...node, ratio: clamped } : node,
    ),
  };
}

/**
 * Repairs a persisted layout against the sessions that exist now: panes of
 * missing sessions are removed and a session is shown in one pane at most.
 */
export function reconcileLayout(
  layout: TerminalWorkspaceLayout | null,
  sessionIds: readonly string[],
): TerminalWorkspaceLayout {
  if (layout === null || layout.root === null) return { ...EMPTY_LAYOUT };
  const known = new Set(sessionIds);
  const seen = new Set<string>();
  let result: TerminalWorkspaceLayout = layout;
  for (const pane of listPanes(layout.root)) {
    if (!known.has(pane.sessionId) || seen.has(pane.sessionId)) {
      result = closePane(result, pane.id);
    } else {
      seen.add(pane.sessionId);
    }
  }
  const panes = listPanes(result.root);
  if (!panes.some((pane) => pane.id === result.activePaneId)) {
    result = { ...result, activePaneId: panes[0]?.id ?? null };
  }
  return result;
}

function mapNode(
  node: TerminalLayoutNode,
  transform: (node: TerminalLayoutNode) => TerminalLayoutNode,
): TerminalLayoutNode {
  const mapped =
    node.type === 'split'
      ? {
          ...node,
          children: [
            mapNode(node.children[0], transform),
            mapNode(node.children[1], transform),
          ] as [TerminalLayoutNode, TerminalLayoutNode],
        }
      : node;
  return transform(mapped);
}

/** Removes a pane; its sibling takes the place of the parent split. */
function removeNode(node: TerminalLayoutNode, paneId: string): TerminalLayoutNode | null {
  if (node.type === 'pane') return node.id === paneId ? null : node;
  const first = removeNode(node.children[0], paneId);
  const second = removeNode(node.children[1], paneId);
  if (first === null) return second;
  if (second === null) return first;
  return { ...node, children: [first, second] };
}
