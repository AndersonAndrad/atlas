import { hasPendingReview } from '@atlas/contracts';
import { CheckCheck } from 'lucide-react';
import type { ReactNode } from 'react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { markTerminalReviewed, useTerminalActivity } from '../state/terminal-activity';

/**
 * Right-click (or the context-menu key) on a terminal tab: "Mark as reviewed" acknowledges
 * its finished results (SDD-023 Task A02). Nothing is ever acknowledged automatically.
 */
export function ReviewContextMenu({
  sessionId,
  title,
  children,
}: {
  sessionId: string;
  title: string;
  children: ReactNode;
}) {
  const pending = hasPendingReview(useTerminalActivity(sessionId));
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent data-testid="terminal-tab-menu">
        <ContextMenuItem
          disabled={!pending}
          onSelect={() => void markTerminalReviewed(sessionId).catch(() => undefined)}
          aria-label={`Mark ${title} as reviewed`}
        >
          <CheckCheck />
          Mark as reviewed
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
