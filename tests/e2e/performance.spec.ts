import type { TerminalSession } from '@atlas/contracts';
import { expect, test } from './fixtures';

// Ten concurrent shells (six visible panes, four hidden tabs) each print
// 500,000 lines. Measures how long the flood takes and whether the app stays
// responsive meanwhile. Numbers are logged and documented in docs/STATUS.md.
test('stays responsive with ten terminals under sustained output', async ({ atlas }) => {
  test.setTimeout(180_000);
  atlas.cli('project', 'add', atlas.workspace('perf'));
  const { app, page } = await atlas.launch();
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Terminals' })
    .click();

  const newButton = page.getByRole('button', { name: 'New terminal', exact: true }).first();
  for (let index = 0; index < 5; index += 1) {
    await newButton.click();
    await expect(page.getByTestId('terminal-tab')).toHaveCount(index + 1);
  }
  for (let index = 0; index < 5; index += 1) {
    await atlas.menu(app, index % 2 === 0 ? 'terminal.splitRight' : 'terminal.splitDown');
    await expect(page.getByTestId('terminal-tab')).toHaveCount(6 + index);
  }
  await expect(page.getByTestId('terminal-pane')).toHaveCount(6);
  await page.waitForTimeout(1500); // shells print their first prompt

  const result = await page.evaluate(async () => {
    type Api = {
      projects: { list(): Promise<unknown> };
      terminals: {
        list(): Promise<{ data: TerminalSession[] }>;
        write(id: string, data: string): void;
      };
    };
    const atlas = (window as unknown as { atlas: Api }).atlas;
    const sessions = (await atlas.terminals.list()).data;
    const ipc: number[] = [];
    let maxFrameGap = 0;
    let running = true;

    let last = performance.now();
    const frame = () => {
      const now = performance.now();
      maxFrameGap = Math.max(maxFrameGap, now - last);
      last = now;
      if (running) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);

    const started = performance.now();
    for (const session of sessions) atlas.terminals.write(session.id, 'seq 1 500000; exit 0\r');
    for (;;) {
      const before = performance.now();
      const list = (await atlas.terminals.list()).data;
      ipc.push(performance.now() - before);
      if (list.every((session) => session.status === 'EXITED')) break;
      if (performance.now() - started > 150_000) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const elapsed = performance.now() - started;
    running = false;
    ipc.sort((a, b) => a - b);
    const statuses = (await atlas.terminals.list()).data.map((session) => session.exitCode);
    return {
      sessions: sessions.length,
      elapsedMs: Math.round(elapsed),
      ipcSamples: ipc.length,
      ipcP50Ms: Math.round(ipc[Math.floor(ipc.length * 0.5)]!),
      ipcP95Ms: Math.round(ipc[Math.floor(ipc.length * 0.95)]!),
      ipcMaxMs: Math.round(ipc.at(-1)!),
      maxFrameGapMs: Math.round(maxFrameGap),
      exitCodes: statuses,
    };
  });

  const memory = await app.evaluate(({ app: electronApp }) =>
    electronApp.getAppMetrics().map((metric) => ({
      type: metric.serviceName ?? metric.type,
      mb: Math.round(metric.memory.workingSetSize / 1024),
    })),
  );
  // Printing the measurement is the purpose of this test (see docs/STATUS.md).
  // eslint-disable-next-line no-console
  console.log('Terminal performance', JSON.stringify({ ...result, memory }));

  expect(result.sessions).toBe(10);
  expect(result.exitCodes).toEqual(Array(10).fill(0));
  // Generous bounds: the point is that nothing blocks for seconds.
  expect(result.ipcP95Ms).toBeLessThan(500);
  expect(result.elapsedMs).toBeLessThan(120_000);
});
