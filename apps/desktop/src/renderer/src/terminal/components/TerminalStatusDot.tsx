import {
  hasPendingReview,
  terminalIndicator,
  type TerminalIndicator,
  type TerminalSession,
} from '@atlas/contracts';
import { CircleAlert, CircleCheck, CircleX, Sparkles, Unplug } from 'lucide-react';
import { cn } from '@/lib/utils';
import { indicatorDescription } from '../format';
import { useTerminalActivity } from '../state/terminal-activity';

const ICONS: Partial<Record<TerminalIndicator, typeof Sparkles>> = {
  AI_RUNNING: Sparkles,
  FAILED: CircleX,
  ATTENTION_REQUIRED: CircleAlert,
  REVIEWED: CircleCheck,
  DISCONNECTED: Unplug,
};

const TONES: Record<TerminalIndicator, string> = {
  AI_RUNNING: 'text-sky-400 animate-pulse motion-reduce:animate-none',
  FAILED: 'text-destructive',
  ATTENTION_REQUIRED: 'text-warning',
  REVIEWED: 'text-success',
  DISCONNECTED: 'text-muted-foreground/70',
  IDLE: 'text-muted-foreground',
};

/**
 * Status of a terminal (SDD-023 Task A02): its connection and the tracked activities in it,
 * by precedence. Icons and a text label carry the meaning, not color alone. A live shell is
 * neutral; green only follows an explicit review.
 */
export function TerminalStatusDot({ session }: { session: TerminalSession }) {
  const summary = useTerminalActivity(session.id);
  const indicator = terminalIndicator(session.status, summary);
  // A disconnected terminal still shows that a result waits for review.
  const pending = indicator === 'DISCONNECTED' && hasPendingReview(summary);
  const Icon = ICONS[indicator];
  const description =
    indicatorDescription(indicator, summary) + (pending ? ' · review pending' : '');
  return (
    <span
      className={cn(
        'relative inline-flex size-3.5 shrink-0 items-center justify-center',
        TONES[indicator],
      )}
      data-status={session.status}
      data-indicator={indicator}
      data-pending-review={
        pending || indicator === 'ATTENTION_REQUIRED' || indicator === 'FAILED' ? 'true' : 'false'
      }
      data-testid="terminal-status"
      title={description}
    >
      {Icon ? (
        <Icon className="size-3.5" aria-hidden="true" />
      ) : (
        <span className="size-2 rounded-full bg-current" aria-hidden="true" />
      )}
      {pending && (
        <span
          className="bg-warning ring-background absolute -top-0.5 -right-0.5 size-1.5 rounded-full ring-1"
          aria-hidden="true"
        />
      )}
      <span className="sr-only">{description}</span>
    </span>
  );
}
