import { describe, expect, it } from 'vitest';
import { assertValidTaskGraph, findCycle } from '../src/index.js';

const node = (id: string, ...dependencies: string[]) => ({ id, dependencies });

describe('task graph', () => {
  it('accepts acyclic graphs, including diamonds', () => {
    const tasks = [node('a'), node('b', 'a'), node('c', 'a'), node('d', 'b', 'c')];
    expect(findCycle(tasks)).toBeNull();
    expect(() => assertValidTaskGraph(tasks)).not.toThrow();
  });

  it('detects direct and indirect cycles', () => {
    expect(findCycle([node('a', 'b'), node('b', 'a')])).toEqual(['a', 'b']);
    expect(findCycle([node('x'), node('a', 'c'), node('b', 'a'), node('c', 'b')])).toEqual([
      'a',
      'c',
      'b',
    ]);
    expect(() => assertValidTaskGraph([node('a', 'b'), node('b', 'a')])).toThrow(
      expect.objectContaining({ code: 'SESSION_TASK_CYCLE' }),
    );
  });

  it('rejects self-dependencies and unknown tasks', () => {
    expect(() => assertValidTaskGraph([node('a', 'a')])).toThrow(
      expect.objectContaining({ code: 'VALIDATION_FAILED' }),
    );
    expect(() => assertValidTaskGraph([node('a', 'missing')])).toThrow(
      expect.objectContaining({ code: 'VALIDATION_FAILED' }),
    );
  });

  it('handles long dependency chains without recursion limits', () => {
    const chain = Array.from({ length: 20_000 }, (_, index) =>
      index === 0 ? node('t0') : node(`t${index}`, `t${index - 1}`),
    );
    expect(findCycle(chain)).toBeNull();
    chain[0] = node('t0', 't19999');
    expect(findCycle(chain)).toHaveLength(20_000);
  });
});
