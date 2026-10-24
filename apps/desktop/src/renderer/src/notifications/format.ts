import type { NotificationCategory, NotificationType } from '@atlas/contracts';
import {
  CircleAlert,
  CircleCheck,
  CircleX,
  Info,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';

export const TYPE_STYLES: Record<
  NotificationType,
  { icon: LucideIcon; tone: string; label: string; autoCloseMs: number | null }
> = {
  SUCCESS: {
    icon: CircleCheck,
    tone: 'text-success bg-success/10',
    label: 'Success',
    autoCloseMs: 5_000,
  },
  INFO: {
    icon: Info,
    tone: 'text-primary bg-primary/10',
    label: 'Information',
    autoCloseMs: 5_000,
  },
  WARNING: {
    icon: TriangleAlert,
    tone: 'text-warning bg-warning/10',
    label: 'Warning',
    autoCloseMs: 10_000,
  },
  ERROR: {
    icon: CircleX,
    tone: 'text-destructive bg-destructive/10',
    label: 'Error',
    autoCloseMs: 10_000,
  },
  // Stays until the user closes it (FR-910).
  ACTION_REQUIRED: {
    icon: CircleAlert,
    tone: 'text-warning bg-warning/10',
    label: 'Action required',
    autoCloseMs: null,
  },
};

export const CATEGORY_LABELS: Record<NotificationCategory, string> = {
  SYSTEM: 'System',
  PROJECT: 'Project',
  TERMINAL: 'Terminal',
  GIT: 'Git',
  PREFLIGHT: 'Preflight',
  AGENT: 'Agent',
  SESSION: 'Session',
  BACKGROUND_TASK: 'Background task',
};
