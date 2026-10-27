import type { ProjectAction } from '@atlas/contracts';
import {
  CirclePause,
  CirclePlay,
  Info,
  Play,
  RefreshCw,
  SquareTerminal,
  type LucideIcon,
} from 'lucide-react';
import { useCallback, useState } from 'react';
import { api, errorMessage, unwrap } from '@/api';
import { putProjectGitState, useProjectGitState } from '@/git/state/project-git-states';

type ProjectCommandAction = Extract<ProjectAction, { kind: 'run-command' }>;
type GitActionKind = 'refresh' | 'monitoring';

/** One action offered for a project, rendered by the drawer and by the palette. */
export interface ProjectActionEntry {
  key: string;
  label: string;
  /** Secondary text, such as the command line of a quick command. */
  detail?: string;
  icon: LucideIcon;
  spinning?: boolean;
  disabled: boolean;
  /** `close`: the surface closes first, then the action runs; `stay`: it runs in place. */
  mode: 'close' | 'stay';
  testId: string;
  run: () => void;
}

export interface ProjectActionHandlers {
  /** False when the project directory is unavailable: nothing can run in it. */
  available: boolean;
  onOpenTerminal: () => void;
  onProjectInfo: () => void;
  onRunCommand: (commandId: string) => void;
}

/**
 * The actions of a project (PLAN-023, PLAN-052): its quick commands, read from the Engine
 * on `load` so they are never outdated, and the Git refresh and monitoring toggle. Shared
 * by the Projects drawer and the project command palette.
 */
export function useProjectActions(projectId: string, handlers: ProjectActionHandlers) {
  const [actions, setActions] = useState<ProjectAction[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [gitBusy, setGitBusy] = useState<GitActionKind | null>(null);
  const gitState = useProjectGitState(projectId);

  const load = useCallback(() => {
    let cancelled = false;
    setActions(null);
    setError(null);
    unwrap(api().quickCommands.projectActions(projectId)).then(
      (list) => !cancelled && setActions(list),
      (caught: unknown) => {
        if (cancelled) return;
        setActions(null);
        setError(errorMessage(caught));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  /** Git actions keep their surface open, so their progress and errors stay visible. */
  function gitAction(kind: GitActionKind, run: (id: string) => Promise<void>) {
    if (gitBusy !== null) return;
    setError(null);
    setGitBusy(kind);
    run(projectId)
      .catch((caught: unknown) => setError(errorMessage(caught)))
      .finally(() => setGitBusy(null));
  }
  const refreshGit = () =>
    gitAction('refresh', async (id) => {
      putProjectGitState((await unwrap(api().git.refreshProject(id))).state);
    });
  const toggleMonitoring = () =>
    gitAction('monitoring', async (id) => {
      const enabled = !(gitState?.monitoringEnabled ?? true);
      putProjectGitState(await unwrap(api().git.setProjectMonitoring(id, enabled)));
    });

  const commands = (actions ?? []).filter(
    (action): action is ProjectCommandAction => action.kind === 'run-command',
  );

  const entries: ProjectActionEntry[] = [
    {
      key: 'open-terminal',
      label: 'Open terminal',
      icon: SquareTerminal,
      disabled: !handlers.available,
      mode: 'close',
      testId: 'project-action-open-terminal',
      run: handlers.onOpenTerminal,
    },
    {
      key: 'details',
      label: 'Project details',
      icon: Info,
      disabled: false,
      mode: 'close',
      testId: 'project-action-details',
      run: handlers.onProjectInfo,
    },
    {
      key: 'git-refresh',
      label: gitBusy === 'refresh' ? 'Refreshing Git status…' : 'Refresh Git status',
      icon: RefreshCw,
      spinning: gitBusy === 'refresh',
      disabled: gitBusy !== null,
      mode: 'stay',
      testId: 'project-action-git-refresh',
      run: refreshGit,
    },
    ...(gitState === undefined
      ? []
      : [
          {
            key: 'git-monitoring',
            label: gitState.monitoringEnabled ? 'Pause Git monitoring' : 'Resume Git monitoring',
            icon: gitState.monitoringEnabled ? CirclePause : CirclePlay,
            disabled: gitBusy !== null,
            mode: 'stay' as const,
            testId: 'project-action-git-monitoring',
            run: toggleMonitoring,
          },
        ]),
    ...commands.map((action) => ({
      key: `command:${action.commandId}`,
      label: action.name,
      detail: action.command,
      icon: Play,
      disabled: !handlers.available,
      mode: 'close' as const,
      testId: 'project-action-command',
      run: () => handlers.onRunCommand(action.commandId),
    })),
  ];

  return { entries, loaded: actions !== null, error, gitState, load };
}
