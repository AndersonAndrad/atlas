import type { BackgroundWork } from '@atlas/contracts';

const count = (value: number, singular: string, plural: string) =>
  `${value} ${value === 1 ? singular : plural}`;

/**
 * What quitting would stop: terminals, Git operations (e.g. a commit running its
 * pre-commit steps) and Preflight runs all end with the Engine, and unsaved editor
 * changes are lost. Null when nothing would be lost.
 */
export function quitWarning(
  runningTerminals: number,
  work: BackgroundWork,
  appName: string,
  unsavedFiles = 0,
): { message: string; detail: string } | null {
  const unsaved = unsavedFiles > 0 ? count(unsavedFiles, 'file has', 'files have') : null;
  const running = [
    runningTerminals > 0 ? count(runningTerminals, 'terminal', 'terminals') : null,
    work.gitOperations > 0 ? count(work.gitOperations, 'Git operation', 'Git operations') : null,
    work.preflightRuns > 0 ? count(work.preflightRuns, 'Preflight run', 'Preflight runs') : null,
  ].filter((part): part is string => part !== null);
  if (running.length === 0) {
    return unsaved === null
      ? null
      : {
          message: `${unsaved} unsaved changes.`,
          detail: `Quitting ${appName} discards the changes not saved in the editor.`,
        };
  }
  const total = runningTerminals + work.gitOperations + work.preflightRuns;
  const list =
    running.length === 1
      ? running[0]!
      : `${running.slice(0, -1).join(', ')} and ${running[running.length - 1]!}`;
  const details = [
    runningTerminals > 0 ? 'Every terminal process stops, including development servers.' : null,
    work.gitOperations > 0
      ? 'Running Git operations stop; a commit whose checks are still running is not created.'
      : null,
    work.preflightRuns > 0 ? 'Running Preflight checks are cancelled.' : null,
  ].filter((part): part is string => part !== null);
  return {
    message: `${list} ${total === 1 ? 'is' : 'are'} still running.${
      unsaved === null ? '' : ` ${unsaved} unsaved changes.`
    }`,
    detail: `Quitting ${appName} stops them. ${details.join(' ')}${
      unsaved === null ? '' : ' Changes not saved in the editor are discarded.'
    }`,
  };
}
