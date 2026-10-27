import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { terminalIndicator, type TerminalEvent } from '@atlas/contracts';
import {
  FakeMirrorFactory,
  FakePtySpawner,
  FakeShellProvider,
} from '../../../tests/support/fake-terminal.js';
import { createTempDir } from '../../../tests/support/temp.js';
import { createEngine, type Engine } from '../src/index.js';

/** Terminal tab status from AI wrapper and terminal lifecycle events (SDD-023 Task A02). */
describe('terminal activity in the Engine', () => {
  let temp: ReturnType<typeof createTempDir>;
  let dataDir: string;
  let engine: Engine;
  let projectId: string;
  let events: TerminalEvent[];
  let runs = 0;

  const open = async () => {
    engine = createEngine({
      dataDir,
      component: 'test',
      env: { ...process.env, HOME: path.join(temp.dir, 'home') },
      terminals: {
        spawner: new FakePtySpawner(),
        mirrors: new FakeMirrorFactory(),
        shells: new FakeShellProvider(),
      },
    });
    await engine.initialize();
    events = [];
    engine.terminals!.onEvent((event) => events.push(event));
  };
  /** Writes an event as the wrapper does, then lets the Engine process it. */
  const wrapper = async (
    kind: 'start' | 'end',
    run: string,
    terminalId: string,
    exitCode: number | null = kind === 'end' ? 0 : null,
  ) => {
    writeFileSync(
      path.join(dataDir, 'context', 'events', `${run}.${kind}.json`),
      JSON.stringify({
        event: kind,
        provider: 'claude',
        run,
        terminalId,
        projectId,
        exitCode,
        head: '',
      }),
    );
    engine.llmSessions.schedule();
    await engine.llmSessions.idle();
  };
  const newRun = () => `20261027T1200${String((runs += 1)).padStart(2, '0')}-${2000 + runs}`;
  const indicator = async (terminalId: string) => {
    const session = engine.terminals!.getById(terminalId);
    const summary = (await engine.terminalActivities()).find(
      (item) => item.terminalId === terminalId,
    );
    return terminalIndicator(session.status, summary);
  };

  beforeEach(async () => {
    temp = createTempDir();
    mkdirSync(path.join(temp.dir, 'home'));
    dataDir = path.join(temp.dir, 'data');
    const workspace = path.join(temp.dir, 'workspace');
    mkdirSync(workspace);
    await open();
    // No keepContext: the tab status does not depend on shared context.
    projectId = (await engine.projects.create({ name: 'API', workspacePath: workspace })).id;
  });

  afterEach(async () => {
    await engine.shutdown();
    temp.cleanup();
  });

  it('starts idle, shows a running AI, then waits for review until marked as reviewed', async () => {
    const terminal = await engine.terminals!.create({ projectId });
    expect(await indicator(terminal.id)).toBe('IDLE');
    const run = newRun();
    await wrapper('start', run, terminal.id);
    expect(await indicator(terminal.id)).toBe('AI_RUNNING');
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'terminal-activity',
        summary: expect.objectContaining({ terminalId: terminal.id }),
      }),
    );
    await wrapper('end', run, terminal.id);
    expect(await indicator(terminal.id)).toBe('ATTENTION_REQUIRED');

    const reviewed = await engine.markTerminalReviewed(terminal.id);
    expect(reviewed.activities).toEqual([]);
    expect(await indicator(terminal.id)).toBe('REVIEWED');
  });

  it('reports a failed AI run and keeps unreviewed results across a restart', async () => {
    const terminal = await engine.terminals!.create({ projectId });
    const failed = newRun();
    await wrapper('start', failed, terminal.id);
    await wrapper('end', failed, terminal.id, 1);
    expect(await indicator(terminal.id)).toBe('FAILED');
    const running = newRun();
    await wrapper('start', running, terminal.id);

    await engine.shutdown();
    await open();
    const [summary] = await engine.terminalActivities();
    expect(summary?.activities.map((item) => [item.ref, item.state])).toEqual([
      [failed, 'FAILED'],
      [running, 'INTERRUPTED'],
    ]);
  });

  it('interrupts a running AI when its terminal ends and forgets closed terminals', async () => {
    const terminal = await engine.terminals!.create({ projectId });
    const run = newRun();
    await wrapper('start', run, terminal.id);
    await engine.terminals!.terminate(terminal.id);
    await expect
      .poll(async () => (await engine.terminalActivities())[0]?.activities[0]?.state)
      .toBe('INTERRUPTED');
    await engine.terminals!.dismiss(terminal.id);
    expect(await engine.terminalActivities()).toEqual([]);
  });

  it('ignores wrappers outside ATLAS terminals and refuses unknown terminals', async () => {
    await wrapper('start', newRun(), '');
    expect(await engine.terminalActivities()).toEqual([]);
    await expect(
      engine.markTerminalReviewed('00000000-0000-4000-8000-0000000000ff'),
    ).rejects.toMatchObject({ code: 'TERMINAL_NOT_FOUND' });
  });
});
