import type { TerminalLayoutNode, TerminalPreferences, TerminalSession } from '@atlas/contracts';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { TerminalPane, type TerminalContextAction, type TerminalPaneHandle } from './TerminalPane';

export interface LayoutCallbacks {
  onFocusPane: (paneId: string) => void;
  onHidePane: (paneId: string) => void;
  onRestart: (sessionId: string) => void;
  onCloseTab: (sessionId: string) => void;
  onProjectInfo: (sessionId: string) => void;
  onOpenGit: (sessionId: string) => void;
  onOpenPreflight: (sessionId: string) => void;
  onContextAction: (sessionId: string, action: TerminalContextAction) => void;
  onRatio: (splitId: string, ratio: number) => void;
  registerHandle: (paneId: string, handle: TerminalPaneHandle | null) => void;
}

interface TerminalLayoutViewProps extends LayoutCallbacks {
  node: TerminalLayoutNode;
  sessions: Map<string, TerminalSession>;
  projectNames: Map<string, string>;
  preferences: TerminalPreferences;
  activePaneId: string | null;
  paneCount: number;
}

/** Renders the split tree. Each pane shows exactly one session. */
export function TerminalLayoutView(props: TerminalLayoutViewProps) {
  const { node, sessions, preferences, activePaneId, paneCount } = props;
  if (node.type === 'pane') {
    const session = sessions.get(node.sessionId);
    if (session === undefined) return null;
    return (
      <TerminalPane
        paneId={node.id}
        session={session}
        projectName={session.projectId ? props.projectNames.get(session.projectId) : undefined}
        preferences={preferences}
        active={node.id === activePaneId}
        onlyPane={paneCount === 1}
        onFocus={() => props.onFocusPane(node.id)}
        onHide={() => props.onHidePane(node.id)}
        onRestart={() => props.onRestart(session.id)}
        onCloseTab={() => props.onCloseTab(session.id)}
        onProjectInfo={() => props.onProjectInfo(session.id)}
        onOpenGit={() => props.onOpenGit(session.id)}
        onOpenPreflight={() => props.onOpenPreflight(session.id)}
        onContextAction={(action) => props.onContextAction(session.id, action)}
        registerHandle={props.registerHandle}
      />
    );
  }

  const firstId = `${node.id}-a`;
  return (
    // The panel library manages its own test ids, so the split is wrapped.
    <div className="h-full w-full" data-testid="terminal-split" data-direction={node.direction}>
      <ResizablePanelGroup
        orientation={node.direction === 'row' ? 'horizontal' : 'vertical'}
        onLayoutChanged={(layout, meta) => {
          const size = layout[firstId];
          if (meta.isUserInteraction && size !== undefined) props.onRatio(node.id, size);
        }}
      >
        <ResizablePanel id={firstId} defaultSize={`${node.ratio}`} minSize="10">
          <TerminalLayoutView {...props} key={node.children[0].id} node={node.children[0]} />
        </ResizablePanel>
        <ResizableHandle withHandle aria-label="Resize panes" />
        <ResizablePanel id={`${node.id}-b`} defaultSize={`${100 - node.ratio}`} minSize="10">
          <TerminalLayoutView {...props} key={node.children[1].id} node={node.children[1]} />
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
