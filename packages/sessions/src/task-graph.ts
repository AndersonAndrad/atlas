import { AtlasError } from '@atlas/shared';

export interface TaskNode {
  id: string;
  dependencies: readonly string[];
}

/**
 * Validates the dependencies of a session's tasks: every dependency must be a
 * task of the same session, a task cannot depend on itself and the graph must be
 * acyclic. Throws VALIDATION_FAILED or SESSION_TASK_CYCLE.
 */
export function assertValidTaskGraph(tasks: readonly TaskNode[]): void {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  for (const task of tasks) {
    for (const dependency of task.dependencies) {
      if (dependency === task.id) {
        throw new AtlasError('VALIDATION_FAILED', 'A task cannot depend on itself.', {
          issues: [{ field: 'dependencies', message: 'A task cannot depend on itself.' }],
          details: { taskId: task.id },
        });
      }
      if (!byId.has(dependency)) {
        throw new AtlasError('VALIDATION_FAILED', 'Unknown task dependency.', {
          issues: [
            { field: 'dependencies', message: 'Dependencies must be tasks of this session.' },
          ],
          details: { taskId: task.id, dependency },
        });
      }
    }
  }
  const cycle = findCycle(tasks);
  if (cycle !== null) {
    throw new AtlasError('SESSION_TASK_CYCLE', undefined, {
      issues: [{ field: 'dependencies', message: 'Task dependencies cannot form a cycle.' }],
      details: { cycle },
    });
  }
}

/** Returns the task ids of one dependency cycle, or `null` when the graph is acyclic. */
export function findCycle(tasks: readonly TaskNode[]): string[] | null {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const state = new Map<string, 'visiting' | 'done'>();
  const path: string[] = [];

  // Iterative depth-first search, so long dependency chains cannot overflow the stack.
  for (const root of tasks) {
    if (state.has(root.id)) continue;
    const stack: { id: string; next: number }[] = [{ id: root.id, next: 0 }];
    state.set(root.id, 'visiting');
    path.push(root.id);
    while (stack.length > 0) {
      const frame = stack.at(-1)!;
      const dependencies = byId.get(frame.id)?.dependencies ?? [];
      if (frame.next >= dependencies.length) {
        state.set(frame.id, 'done');
        stack.pop();
        path.pop();
        continue;
      }
      const dependency = dependencies[frame.next++]!;
      if (!byId.has(dependency)) continue;
      const seen = state.get(dependency);
      if (seen === 'visiting') return path.slice(path.indexOf(dependency));
      if (seen === 'done') continue;
      state.set(dependency, 'visiting');
      path.push(dependency);
      stack.push({ id: dependency, next: 0 });
    }
  }
  return null;
}
