import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ContextTask, ExecuteTaskInput, TerminalEvent } from '@atlas/contracts';
import {
  FakeMirrorFactory,
  FakePtySpawner,
  FakeShellProvider,
} from '../../../tests/support/fake-terminal.js';
import { createTempDir } from '../../../tests/support/temp.js';
import { createEngine, type Engine } from '../src/index.js';

const CLEAR_LINE = '\x05\x15';

/**
 * Task execution through the Engine (SDD-025 Task 02): real SQLite, real wrapper event
 * files and a real zsh resolving a fake `claude`; terminals are fake PTYs that record what
 * is typed. `codex` is not installed.
 */
describe.skipIf(process.platform === 'win32' || !existsSync('/bin/zsh'))(
  'task execution in the Engine',
  () => {
    let temp: ReturnType<typeof createTempDir>;
    let dataDir: string;
    let workspace: string;
    let otherWorkspace: string;
    let realDir: string;
    let spawner: FakePtySpawner;
    let engine: Engine;
    let projectId: string;
    let otherProjectId: string;
    let task: ContextTask;
    let events: TerminalEvent[];
    let runs = 0;
    let requests = 0;

    const open = async () => {
      spawner = new FakePtySpawner();
      engine = createEngine({
        dataDir,
        component: 'test',
        env: {
          ...process.env,
          HOME: path.join(temp.dir, 'home'),
          SHELL: '/bin/zsh',
          PATH: [realDir, '/usr/bin', '/bin'].join(':'),
        },
        terminals: {
          spawner,
          mirrors: new FakeMirrorFactory(),
          shells: new FakeShellProvider(),
        },
      });
      await engine.initialize();
      events = [];
      engine.terminals!.onEvent((event) => events.push(event));
    };
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
    const newRun = () => `20261027T1300${String((runs += 1)).padStart(2, '0')}-${3000 + runs}`;
    const requestId = () => `00000000-0000-4000-9000-${String((requests += 1)).padStart(12, '0')}`;
    const execute = (overrides: Partial<ExecuteTaskInput> = {}) =>
      engine.executeTask({
        requestId: requestId(),
        target: { projectId },
        taskId: task.id,
        provider: 'claude',
        mode: 'new-terminal',
        ...overrides,
      } as ExecuteTaskInput);
    const typed = (terminalId: string) =>
      spawner.spawned
        .find((pty) => pty.options.env?.ATLAS_TERMINAL_ID === terminalId)!
        .written.join('');
    const ptyOf = (terminalId: string) =>
      spawner.spawned.find((pty) => pty.options.env?.ATLAS_TERMINAL_ID === terminalId)!;

    beforeEach(async () => {
      temp = createTempDir();
      mkdirSync(path.join(temp.dir, 'home'));
      realDir = path.join(temp.dir, 'real-bin');
      mkdirSync(realDir);
      writeFileSync(path.join(realDir, 'claude'), '#!/bin/sh\nexit 0\n');
      chmodSync(path.join(realDir, 'claude'), 0o755);
      dataDir = path.join(temp.dir, 'data');
      workspace = path.join(temp.dir, 'workspace');
      otherWorkspace = path.join(temp.dir, 'other');
      mkdirSync(workspace);
      mkdirSync(otherWorkspace);
      await open();
      projectId = (await engine.projects.create({ name: 'API', workspacePath: workspace })).id;
      otherProjectId = (
        await engine.projects.create({ name: 'Web', workspacePath: otherWorkspace })
      ).id;
      task = await engine.context.createTask(await engine.resolveContextTarget({ projectId }), {
        title: 'Add JWT authentication',
        objective: 'Validate signature, expiration and audience.',
      });
    });

    afterEach(async () => {
      await engine.shutdown();
      temp.cleanup();
    });

    it('offers available providers, profiles and terminals with their readiness', async () => {
      const same = await engine.terminals!.create({ projectId });
      const busy = await engine.terminals!.create({ projectId });
      ptyOf(busy.id).foregroundProcess = 'vim';
      const other = await engine.terminals!.create({ projectId: otherProjectId });
      const options = await engine.taskExecutionOptions({ projectId }, task.id);
      expect(options.providers).toEqual([
        { provider: 'claude', availability: 'wrapped' },
        { provider: 'codex', availability: 'missing' },
      ]);
      expect(options.atlasTeamsAvailable).toBe(false);
      expect(options.directory).toBe(workspace);
      const byId = new Map(options.terminals.map((item) => [item.terminalId, item]));
      expect(byId.get(same.id)).toMatchObject({ sameProject: true, blocker: null });
      expect(byId.get(busy.id)).toMatchObject({ blocker: 'busy', processName: 'vim' });
      expect(byId.get(other.id)).toMatchObject({
        sameProject: false,
        projectName: 'Web',
        blocker: null,
      });
    });

    it('runs a task in a new terminal and asks for review when it ends', async () => {
      const execution = await execute();
      expect(execution).toMatchObject({
        status: 'LAUNCHING',
        mode: 'new-terminal',
        taskId: task.id,
        projectId,
      });
      const terminal = engine.terminals!.getById(execution.terminalId);
      expect(terminal).toMatchObject({ projectId, title: 'Claude Code · Add JWT authentication' });
      const command = typed(terminal.id);
      expect(command).toMatch(/^claude "\$\(cat '.+\.md'\)"\r$/);
      // The task's objective reaches the provider only through the private prompt file.
      expect(command).not.toContain('signature');
      const file = /cat '(.+)'/.exec(command)![1]!;
      expect(readFileSync(file, 'utf8')).toContain('Validate signature, expiration and audience.');

      // A repeated confirmation returns the same run and opens nothing.
      const repeated = await engine.executeTask({
        requestId: execution.requestId,
        target: { projectId },
        taskId: task.id,
        provider: 'claude',
        mode: 'new-terminal',
      });
      expect(repeated.id).toBe(execution.id);
      expect(spawner.spawned).toHaveLength(1);
      await expect(execute()).rejects.toMatchObject({ code: 'TASK_EXECUTION_ACTIVE' });

      const run = newRun();
      await wrapper('start', run, terminal.id);
      await wrapper('end', run, terminal.id, 0);
      const [finished] = await engine.taskExecutions({ projectId }, task.id);
      expect(finished).toMatchObject({ status: 'REVIEW_REQUIRED', runRef: run, exitCode: 0 });
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'task-execution',
          execution: expect.objectContaining({ status: 'RUNNING' }),
        }),
      );
      // The task is never completed by the run.
      const target = await engine.resolveContextTarget({ projectId });
      expect((await engine.context.getTask(target, task.id)).status).toBe('open');

      const { items: notifications } = await engine.notifications.list();
      const notification = notifications.filter((item) => item.taskId === execution.id);
      expect(notification).toHaveLength(1);
      expect(notification[0]).toMatchObject({
        type: 'ACTION_REQUIRED',
        category: 'AGENT',
        action: {
          type: 'task-execution',
          executionId: execution.id,
          taskId: task.id,
          terminalId: terminal.id,
        },
      });

      const reviewed = await engine.reviewTaskExecution({ projectId }, execution.id);
      expect(reviewed.reviewedAt).not.toBeNull();
      const summary = (await engine.terminalActivities()).find(
        (item) => item.terminalId === terminal.id,
      );
      expect(summary?.activities).toEqual([]);
      expect(summary?.reviewed?.ref).toBe(run);
    });

    it('types into an idle terminal of the project after clearing its prompt line', async () => {
      const terminal = await engine.terminals!.create({ projectId });
      const execution = await execute({ mode: 'existing-terminal', terminalId: terminal.id });
      expect(execution).toMatchObject({ terminalId: terminal.id, mode: 'existing-terminal' });
      const command = typed(terminal.id);
      expect(command.startsWith(CLEAR_LINE)).toBe(true);
      expect(command.slice(CLEAR_LINE.length)).toMatch(/^claude "\$\(cat '.+'\)"\r$/);
      expect(spawner.spawned).toHaveLength(1);
      // Now the terminal hosts a run: a second task cannot be sent to it.
      const second = await engine.context.createTask(
        await engine.resolveContextTarget({ projectId }),
        { title: 'Second', objective: 'Other work.' },
      );
      await expect(
        execute({ taskId: second.id, mode: 'existing-terminal', terminalId: terminal.id }),
      ).rejects.toMatchObject({ code: 'TASK_EXECUTION_TERMINAL_UNAVAILABLE' });
    });

    it('frees an existing terminal for the next task once the run ends', async () => {
      const terminal = await engine.terminals!.create({ projectId });
      const first = await execute({ mode: 'existing-terminal', terminalId: terminal.id });
      const run = newRun();
      await wrapper('start', run, terminal.id);
      await wrapper('end', run, terminal.id, 0);
      // The project does not keep context: the run's managed AI session ends with the run.
      expect(await engine.context.sessionForTerminal(terminal.id)).toBeNull();
      await engine.reviewTaskExecution({ projectId }, first.id);
      const second = await engine.context.createTask(
        await engine.resolveContextTarget({ projectId }),
        { title: 'Second', objective: 'Other work.' },
      );
      const next = await execute({
        taskId: second.id,
        mode: 'existing-terminal',
        terminalId: terminal.id,
      });
      expect(next.status).toBe('LAUNCHING');
    });

    it('refuses busy, disconnected and unsupported terminals without typing', async () => {
      const busy = await engine.terminals!.create({ projectId });
      ptyOf(busy.id).foregroundProcess = 'npm';
      await expect(
        execute({ mode: 'existing-terminal', terminalId: busy.id }),
      ).rejects.toMatchObject({
        code: 'TASK_EXECUTION_TERMINAL_UNAVAILABLE',
        issues: [expect.objectContaining({ message: expect.stringContaining('npm') })],
      });
      const unknown = await engine.terminals!.create({ projectId });
      ptyOf(unknown.id).foregroundProcess = undefined;
      await expect(
        execute({ mode: 'existing-terminal', terminalId: unknown.id }),
      ).rejects.toMatchObject({ code: 'TASK_EXECUTION_TERMINAL_UNAVAILABLE' });
      const ended = await engine.terminals!.create({ projectId });
      await engine.terminals!.terminate(ended.id);
      await expect(
        execute({ mode: 'existing-terminal', terminalId: ended.id }),
      ).rejects.toMatchObject({ code: 'TASK_EXECUTION_TERMINAL_UNAVAILABLE' });
      expect(typed(busy.id)).toBe('');
      expect(typed(unknown.id)).toBe('');
      expect(await engine.taskExecutions({ projectId }, task.id)).toEqual([]);
    });

    it('asks before running in a terminal of another project', async () => {
      const other = await engine.terminals!.create({ projectId: otherProjectId });
      await expect(
        execute({ mode: 'existing-terminal', terminalId: other.id }),
      ).rejects.toMatchObject({ code: 'TASK_EXECUTION_CONFIRMATION_REQUIRED' });
      expect(typed(other.id)).toBe('');
      const execution = await execute({
        mode: 'existing-terminal',
        terminalId: other.id,
        acknowledgeOtherProject: true,
      });
      expect(execution.terminalId).toBe(other.id);
      expect(typed(other.id).startsWith(CLEAR_LINE)).toBe(true);
    });

    it('refuses an unavailable provider, a foreign profile and closed tasks', async () => {
      await expect(execute({ provider: 'codex' })).rejects.toMatchObject({
        code: 'TASK_EXECUTION_PROVIDER_UNAVAILABLE',
      });
      await expect(
        execute({ profileId: '00000000-0000-4000-8000-0000000000ee' }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      const target = await engine.resolveContextTarget({ projectId });
      await engine.context.updateTask(target, task.id, { status: 'done' });
      await expect(execute()).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(
        engine.executeTask({
          requestId: requestId(),
          target: { projectId: otherProjectId },
          taskId: task.id,
          provider: 'claude',
          mode: 'new-terminal',
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(spawner.spawned).toHaveLength(0);
    });

    it('runs with the chosen account profile', async () => {
      const directory = path.join(temp.dir, 'home', ".claude-it's work");
      mkdirSync(directory);
      const profile = await engine.usage.addProfile({ providerId: 'claude', directory }, true);
      const execution = await execute({ profileId: profile.id });
      expect(execution.profileId).toBe(profile.id);
      expect(typed(execution.terminalId)).toContain(
        `CLAUDE_CONFIG_DIR='${directory.replace(/'/g, `'\\''`)}' claude "$(cat`,
      );
    });

    it('records failures, cancellations and interrupted runs', async () => {
      const failed = await execute();
      const failedRun = newRun();
      await wrapper('start', failedRun, failed.terminalId);
      await wrapper('end', failedRun, failed.terminalId, 1);
      expect((await engine.taskExecutions({ projectId }, task.id))[0]).toMatchObject({
        status: 'FAILED',
        exitCode: 1,
      });

      const cancelled = await execute();
      const cancelledRun = newRun();
      await wrapper('start', cancelledRun, cancelled.terminalId);
      const pending = await engine.cancelTaskExecution({ projectId }, cancelled.id);
      expect(pending.cancelRequestedAt).not.toBeNull();
      expect(typed(cancelled.terminalId).endsWith('\x03')).toBe(true);
      await wrapper('end', cancelledRun, cancelled.terminalId, 130);
      expect((await engine.taskExecutions({ projectId }, task.id))[0]).toMatchObject({
        id: cancelled.id,
        status: 'CANCELLED',
      });

      const interrupted = await execute();
      await wrapper('start', newRun(), interrupted.terminalId);
      await engine.terminals!.terminate(interrupted.terminalId);
      await expect
        .poll(async () => (await engine.taskExecutions({ projectId }, task.id))[0]?.status)
        .toBe('INTERRUPTED');

      // Published right after the status is saved.
      await expect
        .poll(async () =>
          (await engine.notifications.list()).items
            .filter((item) => item.category === 'AGENT')
            .map((item) => [item.taskId, item.type])
            .sort(),
        )
        .toEqual(
          [
            [failed.id, 'ERROR'],
            [interrupted.id, 'WARNING'],
          ].sort(),
        );
      // Another owner's request cannot reach the execution.
      await expect(
        engine.cancelTaskExecution({ projectId: otherProjectId }, interrupted.id),
      ).rejects.toMatchObject({ code: 'TASK_EXECUTION_NOT_FOUND' });
    });

    it('keeps history across a restart and interrupts what was running', async () => {
      const execution = await execute();
      await wrapper('start', newRun(), execution.terminalId);
      await engine.shutdown();
      await open();
      const [restored] = await engine.taskExecutions({ projectId }, task.id);
      expect(restored).toMatchObject({
        id: execution.id,
        status: 'INTERRUPTED',
        endReason: 'engine-restart',
      });
      // The task can run again; nothing was re-run automatically.
      expect(spawner.spawned).toHaveLength(0);
      const again = await execute();
      expect(again.status).toBe('LAUNCHING');
    });
  },
);
