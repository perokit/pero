import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentManager, TurnError } from '../agents/agent-manager.js';
import { AgentChannelTurns } from '../channels/agent-channel-turns.js';
import { AllowedChatsService } from '../channels/allowed-chats.service.js';
import { ChannelRouter } from '../channels/channel-router.js';
import { ChannelTurns } from '../channels/channel-stages.js';
import { ChannelsModule } from '../channels/channels.module.js';
import {
  FakeChannelAdapter,
  groupChat,
  inboundMessage,
  privateChat,
} from '../channels/testing/fake-channel-adapter.js';
import {
  ConflictError,
  InvalidInputError,
  NotFoundError,
} from '../common/errors.js';
import { HostConfigService } from '../host-config/host-config.service.js';
import { Channel } from '../persistence/entities/channel.entity.js';
import { Message } from '../persistence/entities/message.entity.js';
import { Notification } from '../persistence/entities/notification.entity.js';
import { Session } from '../persistence/entities/session.entity.js';
import { WorkflowRun } from '../persistence/entities/workflow-run.entity.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { inTransaction } from '../persistence/transaction.js';
import type { RunView } from '../control/protocol.js';
import { AGENT_RUNTIMES } from '../runtimes/agent-runtimes.js';
import type { RuntimeRequest } from '../runtimes/agent-runtime.js';
import { FakeAgentRuntime } from '../runtimes/testing/fake-agent-runtime.js';
import { Definitions } from '../system/definitions.js';
import type { TestNoteProperties } from '../system/testing/test-workspace.js';
import { TestWorkspace } from '../system/testing/test-workspace.js';
import type { HistoryRead } from './execution-snapshot.js';
import { finishRun } from './finish-run.js';
import { CANCELLED, WorkflowExecutor } from './workflow-executor.js';
import { WorkflowRuns } from './workflow-runs.service.js';
import { WorkflowsModule } from './workflows.module.js';

const OWNER = privateChat('1234');
const HOME = groupChat('-100777', 'Home');

describe('Workflow Runs and the executor', () => {
  let ws: TestWorkspace;
  let workspace: string;
  let moduleRef: TestingModule;
  let ds: DataSource;
  let runs: WorkflowRuns;
  let executor: WorkflowExecutor;
  let claude: FakeAgentRuntime;
  let codex: FakeAgentRuntime;

  async function boot() {
    moduleRef = await Test.createTestingModule({
      imports: [
        PersistenceModule.forRoot({ database: ws.database }),
        ws.hostConfig(),
        ChannelsModule,
        WorkflowsModule,
      ],
    })
      .overrideProvider(AGENT_RUNTIMES)
      .useValue([claude, codex])
      .compile();
    await moduleRef.init();
    ds = moduleRef.get<DataSource>(getDataSourceToken());
    ws.use(moduleRef);
    runs = moduleRef.get(WorkflowRuns);
    executor = moduleRef.get(WorkflowExecutor);
  }

  beforeEach(async () => {
    ws = TestWorkspace.create('pero-workflow-runs-');
    workspace = ws.root;
    await ws.pero();
    await ws.channel('Default');
    claude = new FakeAgentRuntime('claude');
    codex = new FakeAgentRuntime('codex');
    await boot();
  });

  afterEach(async () => {
    await moduleRef.close();
    ws.delete();
  });

  /** A Workflow run by hand, with Default.md's settings. */
  async function manualWorkflow(
    name: string,
    input = `Run ${name}.`,
  ): Promise<void> {
    await ws.workflow(name, {}, input);
  }

  /** Changes `properties` of the note of Workflow `name`. */
  function edit(name: string, properties: TestNoteProperties): Promise<void> {
    return ws.editWorkflow(name, properties);
  }

  function run(id: number): Promise<RunView> {
    return runs.get(id);
  }

  /** Lets queued promise callbacks and database work run. */
  function tick(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 20));
  }

  it("completes a run with the Agent's answer, in a provider session of its own", async () => {
    await manualWorkflow('brief', 'Summarize the day.');

    const queued = await runs.start('brief');
    expect(queued).toMatchObject({
      workflow: 'brief',
      status: 'pending',
      attempt: 1,
      startedAt: null,
      finishedAt: null,
      result: null,
      error: null,
    });
    expect(queued.triggerKey).toMatch(/^manual:[0-9a-f-]{36}$/);
    await executor.idle();

    const done = await run(queued.id);
    expect(done).toMatchObject({
      status: 'completed',
      result: 'echo: Summarize the day.',
      error: null,
    });
    expect(done.startedAt).not.toBeNull();
    expect(done.finishedAt).not.toBeNull();
    expect(claude.requests).toHaveLength(1);
    expect(claude.requests[0]).toMatchObject({
      input: 'Summarize the day.',
      workingDirectory: workspace,
      toolPolicy: { permissions: 'ask' },
    });
    expect(claude.requests[0]).not.toHaveProperty('providerSessionId');
    expect(claude.requests[0]).not.toHaveProperty('approve');
    const row = await ds
      .getRepository(WorkflowRun)
      .findOneByOrFail({ id: queued.id });
    expect(row.executionConfig).toMatchObject({
      agentName: 'default',
      provider: 'claude',
      workingDirectory: workspace,
      input: 'Summarize the day.',
    });
    expect(row.result).toEqual({
      text: 'echo: Summarize the day.',
      providerSessionId: 'fake-claude-1',
    });
  });

  it('records a failed run with the reason', async () => {
    await manualWorkflow('brief');
    claude.failNext();

    const { id } = await runs.start('brief');
    await executor.idle();

    expect(await run(id)).toMatchObject({
      status: 'failed',
      result: null,
      error: 'The model is overloaded',
    });
  });

  describe('concurrency', () => {
    it('runs no more than max-concurrent-runs at once', async () => {
      await ws.editPero({ 'max-concurrent-runs': 2 });
      for (const name of ['a', 'b', 'c']) await manualWorkflow(name);
      const held = [claude.hold(), claude.hold(), claude.hold()];

      const a = await runs.start('a');
      const b = await runs.start('b');
      const c = await runs.start('c');
      await held[0]!.started;
      await held[1]!.started;
      await tick();

      expect(executor.running).toBe(2);
      expect(claude.requests).toHaveLength(2);
      expect((await run(c.id)).status).toBe('pending');

      held[0]!.release();
      expect((await held[2]!.started).input).toBe('Run c.');
      expect((await run(a.id)).status).toBe('completed');
      expect((await run(c.id)).status).toBe('running');

      held[1]!.release();
      held[2]!.release();
      await executor.idle();
      for (const { id } of [a, b, c]) {
        expect((await run(id)).status).toBe('completed');
      }
    });

    it('applies a raised limit on the next wake, without a restart', async () => {
      await ws.editPero({ 'max-concurrent-runs': 1 });
      await manualWorkflow('a');
      await manualWorkflow('b');
      const held = [claude.hold(), claude.hold()];

      await runs.start('a');
      const b = await runs.start('b');
      await held[0]!.started;
      await tick();
      expect((await run(b.id)).status).toBe('pending');

      await ws.editPero({ 'max-concurrent-runs': 2 });
      await executor.wake();

      expect((await held[1]!.started).input).toBe('Run b.');
      expect(executor.running).toBe(2);
      held[0]!.release();
      held[1]!.release();
      await executor.idle();
    });

    it('runs one run of a Workflow at a time, and other Workflows alongside', async () => {
      await ws.editPero({ 'max-concurrent-runs': 3 });
      await manualWorkflow('a');
      await manualWorkflow('b');
      const held = [claude.hold(), claude.hold()];

      const first = await runs.start('a');
      const second = await runs.start('a');
      const other = await runs.start('b');
      await held[0]!.started;
      expect((await held[1]!.started).input).toBe('Run b.');
      await tick();

      expect(executor.running).toBe(2);
      expect((await run(second.id)).status).toBe('pending');

      held[0]!.release();
      held[1]!.release();
      await executor.idle();

      const [a1, a2, b1] = await Promise.all(
        [first, second, other].map(({ id }) => run(id)),
      );
      expect([a1!.status, a2!.status, b1!.status]).toEqual([
        'completed',
        'completed',
        'completed',
      ]);
      expect(Date.parse(a2!.startedAt!)).toBeGreaterThanOrEqual(
        Date.parse(a1!.finishedAt!),
      );
    });
  });

  it('runs with the settings captured when it started, whatever is edited meanwhile', async () => {
    await ws.instructions('Be kind.');
    await manualWorkflow('brief', 'First input.');
    const held = claude.hold();

    const { id } = await runs.start('brief');
    const request = await held.started;
    const own = join(ws.root, 'own');
    mkdirSync(own);
    await ws.editChannel(
      'Default',
      {
        provider: 'codex',
        model: 'gpt-6',
        effort: 'high',
        'working-directory': own,
      },
      'Be brief.',
    );
    await ws.instructions('Be blunt.');
    await ws.editWorkflow('brief', {}, 'Second input.');
    held.release();
    await executor.idle();

    const captured = {
      input: 'First input.',
      instructions: `${ws.channelContext('Default')}\n\nBe kind.`,
      providerOptions: { model: null, effort: null },
      workingDirectory: workspace,
    };
    expect(request).toMatchObject(captured);
    expect((await run(id)).result).toBe('echo: First input.');
    const row = await ds.getRepository(WorkflowRun).findOneByOrFail({ id });
    expect(row.executionConfig).toMatchObject({
      ...captured,
      provider: 'claude',
    });

    // A run started later takes the new settings.
    await runs.start('brief');
    await executor.idle();
    expect(codex.requests).toHaveLength(1);
    expect(codex.requests[0]).toMatchObject({
      input: 'Second input.',
      instructions: `${ws.channelContext('Default')}\n\nBe blunt.\n\nBe brief.`,
      providerOptions: { model: 'gpt-6', effort: 'high' },
      workingDirectory: own,
    });
  });

  it("never touches a Channel's Session or history", async () => {
    await moduleRef.get(AllowedChatsService).allow({
      integrationKind: 'telegram',
      chatKey: OWNER.key,
      kind: OWNER.kind,
      title: OWNER.title,
    });
    const adapter = new FakeChannelAdapter();
    await moduleRef.get(ChannelRouter).connect(adapter);
    const channelTurns = moduleRef.get(ChannelTurns) as AgentChannelTurns;
    const say = async (text: string) => {
      await adapter.deliver(inboundMessage(OWNER, { text }));
      await channelTurns.idle();
    };
    await say('Hello');
    const sessionsBefore = await ds.getRepository(Session).find();
    const messagesBefore = await ds.getRepository(Message).count();
    await manualWorkflow('review', 'Review the chat.');
    claude.askNext();

    const { id } = await runs.start('review');
    await executor.idle();

    const runRequest = claude.requests[1] as RuntimeRequest;
    expect(
      (await ds.getRepository(WorkflowRun).findOneByOrFail({ id }))
        .executionConfig,
    ).toMatchObject({ agentName: sessionsBefore[0]!.agentName });
    expect(runRequest).not.toHaveProperty('providerSessionId');
    expect(runRequest).not.toHaveProperty('approve');
    // No one is there to approve tools, so they are refused.
    expect((await run(id)).result).toBe(
      'echo: Review the chat. (Bash denied: no one can approve tools here)',
    );
    expect(await ds.getRepository(Session).find()).toEqual(sessionsBefore);
    expect(await ds.getRepository(Message).count()).toBe(messagesBefore);

    // The Channel's next turn resumes its own provider session.
    await say('Again');
    expect(claude.requests[2]).toMatchObject({
      input: 'Again',
      providerSessionId: sessionsBefore[0]!.providerSessionId,
    });
  });

  describe('recovery', () => {
    /**
     * Starts a run of `workflow` and stops Pero while its Agent works, as
     * `pero stop` does once the shutdown timeout has passed. Returns the
     * run's ID and the aborted request.
     */
    async function stopMidRun(
      workflow: string,
    ): Promise<{ id: number; request: RuntimeRequest }> {
      const held = claude.hold();
      const { id } = await runs.start(workflow);
      const request = await held.started;
      await moduleRef.get(AgentManager).drain(10);
      await executor.idle();
      return { id, request };
    }

    async function restart(): Promise<void> {
      await moduleRef.close();
      await boot();
      await executor.idle();
    }

    function allRuns(): Promise<WorkflowRun[]> {
      return ds.getRepository(WorkflowRun).find({ order: { id: 'ASC' } });
    }

    it('leaves a run Pero stopped for the next start, which records it interrupted', async () => {
      await manualWorkflow('brief');
      const { id, request } = await stopMidRun('brief');

      expect(request.signal.aborted).toBe(true);
      // Nothing is recorded while Pero stops.
      expect(await run(id)).toMatchObject({
        status: 'running',
        finishedAt: null,
        error: null,
      });
      await expect(
        moduleRef.get(AgentManager).runIsolated({
          note: 'default',
          provider: 'claude',
          request: {
            providerOptions: { model: null, effort: null },
            workingDirectory: workspace,
            instructions: '',
            toolPolicy: { permissions: 'ask' },
            skipGitRepoCheck: false,
          },
          input: 'Late',
          label: 'test',
        }),
      ).rejects.toThrow(TurnError);

      await restart();

      const interrupted = await run(id);
      expect(interrupted).toMatchObject({
        status: 'interrupted',
        error:
          'Pero stopped before the run finished; not retried: Workflow brief allows 1 attempt',
      });
      expect(interrupted.finishedAt).not.toBeNull();
      expect(await allRuns()).toHaveLength(1);
      expect(claude.requests).toHaveLength(1);
    });

    it('records a run left running by a crash interrupted', async () => {
      await manualWorkflow('brief');
      const repo = ds.getRepository(WorkflowRun);
      const { id } = await repo.save(
        repo.create({
          workflowName: 'brief',
          triggerKey: 'manual:crashed',
          status: 'running',
          attempt: 1,
          startedAt: new Date(),
        }),
      );

      await restart();

      expect(await run(id)).toMatchObject({
        status: 'interrupted',
        error:
          'Pero stopped before the run finished; not retried: Workflow brief allows 1 attempt',
      });
      expect(claude.requests).toHaveLength(0);
    });

    it('retries an interrupted run as a new run while the Workflow allows more attempts', async () => {
      await manualWorkflow('brief');
      await edit('brief', { 'max-attempts': 2 });
      const { id } = await stopMidRun('brief');

      await restart();

      const [original, retry] = await allRuns();
      expect(retry).toMatchObject({
        workflowName: original!.workflowName,
        triggerKey: `retry:${id}`,
        attempt: 2,
        status: 'completed',
      });
      expect(await run(id)).toMatchObject({
        status: 'interrupted',
        attempt: 1,
        error: `Pero stopped before the run finished; run ${retry!.id} retries it (attempt 2 of 2)`,
      });
      expect(claude.requests.map((request) => request.input)).toEqual([
        'Run brief.',
        'Run brief.',
      ]);
    });

    it('stops retrying once a run has had its attempts', async () => {
      await manualWorkflow('brief');
      await edit('brief', { 'max-attempts': 2 });
      const { id } = await stopMidRun('brief');
      // The retry is stopped as well.
      const held = claude.hold();
      await moduleRef.close();
      await boot();
      await held.started;
      await moduleRef.get(AgentManager).drain(10);
      await executor.idle();

      await restart();

      const [, retry, ...more] = await allRuns();
      expect(more).toEqual([]);
      expect(await run(retry!.id)).toMatchObject({
        status: 'interrupted',
        attempt: 2,
        error:
          'Pero stopped before the run finished; not retried: Workflow brief allows 2 attempts',
      });
      expect((await run(id)).status).toBe('interrupted');
    });

    it('does not retry while the Workflow or its Agent is disabled', async () => {
      await manualWorkflow('a');
      await manualWorkflow('b');
      await edit('a', { 'max-attempts': 3 });
      await edit('b', { 'max-attempts': 3 });
      const a = await stopMidRun('a');
      await edit('a', { enabled: false });
      await restart();
      const b = await stopMidRun('b');
      await ws.editChannel('Default', { enabled: false });

      await restart();

      expect((await run(a.id)).error).toBe(
        'Pero stopped before the run finished; not retried: Workflow a is disabled',
      );
      expect((await run(b.id)).error).toBe(
        'Pero stopped before the run finished; not retried: Channel note default is disabled',
      );
      expect(await allRuns()).toHaveLength(2);
    });

    it('queues one retry however often it recovers a run', async () => {
      await manualWorkflow('brief');
      await edit('brief', { 'max-attempts': 2 });
      const { id } = await stopMidRun('brief');
      await restart();
      const [, retry] = await allRuns();

      // As if recording the run had not been committed.
      await ds.getRepository(WorkflowRun).update(id, { status: 'running' });
      await executor.recover();

      expect(await allRuns()).toHaveLength(2);
      expect(await run(id)).toMatchObject({
        status: 'interrupted',
        error: `Pero stopped before the run finished; run ${retry!.id} retries it (attempt 2 of 2)`,
      });
    });
  });

  describe('cancelling', () => {
    it('cancels a pending run before it starts', async () => {
      await ws.editPero({ 'max-concurrent-runs': 1 });
      await manualWorkflow('a');
      await manualWorkflow('b');
      const held = claude.hold();
      await runs.start('a');
      const b = await runs.start('b');
      await held.started;

      const cancelled = await runs.cancel(b.id);
      held.release();
      await executor.idle();

      expect(cancelled).toMatchObject({
        status: 'cancelled',
        startedAt: null,
        error: CANCELLED,
      });
      expect(cancelled.finishedAt).not.toBeNull();
      expect(await run(b.id)).toMatchObject({ status: 'cancelled' });
      expect(claude.requests).toHaveLength(1);
    });

    it("aborts a running run's Agent and records it cancelled", async () => {
      await manualWorkflow('brief');
      const held = claude.hold();
      const first = await runs.start('brief');
      const second = await runs.start('brief');
      const request = await held.started;

      const cancelling = await runs.cancel(first.id);
      expect(cancelling.status).toBe('running');
      await executor.idle();

      // Cancellation reaches the runtime.
      expect(request.signal.aborted).toBe(true);
      expect(await run(first.id)).toMatchObject({
        status: 'cancelled',
        result: null,
        error: CANCELLED,
      });
      // The Workflow's next run starts once it is free.
      expect(await run(second.id)).toMatchObject({ status: 'completed' });
    });

    it('records a run cancelled while Pero stops cancelled, not left for recovery', async () => {
      await manualWorkflow('brief');
      const held = claude.hold();
      const { id } = await runs.start('brief');
      await held.started;

      const drained = moduleRef.get(AgentManager).drain(10_000);
      await runs.cancel(id);
      await drained;
      await executor.idle();

      expect((await run(id)).status).toBe('cancelled');
    });

    it('refuses a run that has finished, or does not exist', async () => {
      await manualWorkflow('brief');
      const { id } = await runs.start('brief');
      await executor.idle();

      await expect(runs.cancel(id)).rejects.toThrow(
        new ConflictError(`Run ${id} has already finished (completed)`),
      );
      await expect(runs.cancel(99)).rejects.toThrow(
        new NotFoundError('No run with ID 99'),
      );
    });
  });

  it('fails a run its schedule queued once the Workflow is disabled, but runs one started by hand', async () => {
    await ws.editPero({ 'max-concurrent-runs': 1 });
    await manualWorkflow('a');
    await manualWorkflow('b');
    const held = claude.hold();
    await runs.start('a');
    const repo = ds.getRepository(WorkflowRun);
    const scheduled = await repo.save(
      repo.create({
        workflowName: 'b',
        triggerKey: 'schedule:b:2026-01-01T09:00:00.000Z',
        status: 'pending',
        attempt: 1,
      }),
    );
    const byHand = await runs.start('b');
    await held.started;

    await edit('b', { enabled: false });
    held.release();
    await executor.idle();

    expect(await run(scheduled.id)).toMatchObject({
      status: 'failed',
      startedAt: null,
      error: 'Workflow b was disabled before the run started',
    });
    expect(await run(byHand.id)).toMatchObject({ status: 'completed' });
    expect(claude.requests).toHaveLength(2);
  });

  it('fails a queued run whose Channel note was disabled before it started', async () => {
    await ws.editPero({ 'max-concurrent-runs': 1 });
    await manualWorkflow('a');
    await manualWorkflow('b');
    const held = claude.hold();
    await runs.start('a');
    const b = await runs.start('b');
    await held.started;

    await ws.editChannel('Default', { enabled: false });
    held.release();
    await executor.idle();

    expect(await run(b.id)).toMatchObject({
      status: 'failed',
      startedAt: null,
      error: 'Channel note default was disabled before the run started',
    });
    expect(claude.requests).toHaveLength(1);
  });

  it('starts runs left pending when Pero last stopped', async () => {
    await manualWorkflow('brief');
    const repo = ds.getRepository(WorkflowRun);
    const { id } = await repo.save(
      repo.create({
        workflowName: 'brief',
        triggerKey: 'manual:left-over',
        status: 'pending',
        attempt: 1,
      }),
    );

    await moduleRef.close();
    await boot();
    await executor.idle();

    expect((await run(id)).status).toBe('completed');
  });

  describe('notifications', () => {
    /** The Channels each Workflow's note names in `channel`. */
    const targets = new Map<string, number[]>();

    beforeEach(() => {
      targets.clear();
    });

    /** Makes the note of `workflow` name Channel `id` in `channel`. */
    async function notify(workflow: string, id: number): Promise<void> {
      const ids = [...(targets.get(workflow) ?? []), id];
      targets.set(workflow, ids);
      await edit(workflow, { channel: ids });
    }

    /** A Channel `workflow` notifies, in a chat that is allowed. */
    async function target(workflow: string, key = '1234'): Promise<number> {
      moduleRef.get(HostConfigService).allow(key, null);
      const channels = ds.getRepository(Channel);
      const { id } = await channels.save(
        channels.create({
          integrationKind: 'telegram',
          externalKey: key,
          address: { chatId: key },
          title: null,
        }),
      );
      await notify(workflow, id);
      return id;
    }

    function notificationsOf(runId: number): Promise<Notification[]> {
      return ds
        .getRepository(Notification)
        .find({ where: { workflowRunId: runId }, order: { channelId: 'ASC' } });
    }

    function texts(notifications: Notification[]): unknown[] {
      return notifications.map(({ payload }) => payload.text);
    }

    it("creates a pending Notification of a completed run's answer for each Channel it notifies", async () => {
      await manualWorkflow('brief', 'Summarize the day.');
      await manualWorkflow('quiet');
      const first = await target('brief', '1234');
      const second = await target('brief', '-100777');

      const { id } = await runs.start('brief');
      const other = await runs.start('quiet');
      await executor.idle();

      const done = await ds.getRepository(WorkflowRun).findOneByOrFail({ id });
      const notifications = await notificationsOf(id);
      expect(notifications).toEqual([
        expect.objectContaining({
          channelId: first,
          status: 'pending',
          attempt: 0,
          providerMessageId: null,
          payload: { text: 'brief\n\necho: Summarize the day.' },
        }),
        expect.objectContaining({ channelId: second, status: 'pending' }),
      ]);
      // Due at once.
      expect(notifications[0]!.nextAttemptAt).toEqual(done.finishedAt);
      expect(await notificationsOf(other.id)).toEqual([]);
    });

    it('shows a run and its Notifications fully once its Workflow is gone', async () => {
      await manualWorkflow('brief', 'Summarize the day.');
      const channel = await target('brief');
      const { id } = await runs.start('brief');
      await executor.idle();

      await ws.removeWorkflow('brief');

      expect(await runs.get(id)).toMatchObject({
        workflow: 'brief',
        status: 'completed',
        result: 'echo: Summarize the day.',
        notifications: [
          expect.objectContaining({
            workflow: 'brief',
            channel: expect.objectContaining({ id: channel }),
          }),
        ],
      });
      expect(
        (await runs.list({ workflow: 'Brief', limit: 20 })).map(
          (listed) => listed.id,
        ),
      ).toEqual([id]);
    });

    it('shows the Notifications a run left, with how their delivery stands', async () => {
      await manualWorkflow('brief');
      const channel = await target('brief');

      const { id } = await runs.start('brief');
      await executor.idle();

      const details = await runs.get(id);
      expect(details).toMatchObject({ retriedBy: null, history: null });
      expect(details.notifications).toEqual([
        expect.objectContaining({
          runId: id,
          workflow: 'brief',
          channel: expect.objectContaining({ id: channel, key: '1234' }),
          status: 'pending',
          attempt: 0,
          maxAttempts: 10,
          lastError: null,
          providerMessageId: null,
        }),
      ]);
    });

    it('notifies no one of a run whose script found no data', async () => {
      await ws.workflow('alerts', { script: 'echo NO_DATA' }, 'Summarize.');
      await target('alerts');

      const { id } = await runs.start('alerts');
      await executor.idle();

      expect(await run(id)).toMatchObject({
        status: 'completed',
        result: 'NO_DATA',
      });
      expect(await notificationsOf(id)).toEqual([]);
    });

    it("notifies the answer to its script's output, and a script that failed", async () => {
      await ws.workflow('alerts', { script: 'echo disk full' }, 'Summarize.');
      await ws.workflow(
        'broken',
        { script: 'echo nope >&2; exit 3' },
        'Summarize.',
      );
      await target('alerts', '1234');
      await target('broken', '-100777');

      const answered = await runs.start('alerts');
      const failed = await runs.start('broken');
      await executor.idle();

      expect(texts(await notificationsOf(answered.id))).toEqual([
        'alerts\n\necho: Summarize.\n\n[Script output]\ndisk full\n[End of script output]',
      ]);
      expect(texts(await notificationsOf(failed.id))).toEqual([
        `Run ${failed.id} of Workflow broken failed: script failed: nope`,
      ]);
    });

    it('commits the final status and the Notifications together', async () => {
      await manualWorkflow('brief');
      await target('brief');
      const repo = ds.getRepository(WorkflowRun);
      const { id } = await repo.save(
        repo.create({
          workflowName: 'brief',
          triggerKey: 'manual:together',
          status: 'running',
          attempt: 1,
        }),
      );

      await expect(
        inTransaction(ds, async (manager) => {
          await finishRun(
            manager,
            id,
            moduleRef.get(Definitions).workflow('brief'),
            { status: 'completed', result: { text: 'Done' } },
          );
          expect(await manager.getRepository(Notification).count()).toBe(1);
          throw new Error('The transaction fails later');
        }),
      ).rejects.toThrow('The transaction fails later');

      expect((await run(id)).status).toBe('running');
      expect(await notificationsOf(id)).toEqual([]);
    });

    it('posts why a run failed, including one refused before it started', async () => {
      await ws.editPero({ 'max-concurrent-runs': 1 });
      await manualWorkflow('a');
      await manualWorkflow('b');
      await target('a');
      await target('b', '-100777');
      claude.failNext();
      const a = await runs.start('a');
      await executor.idle();
      const held = claude.hold();
      await runs.start('a');
      const b = await runs.start('b');
      await held.started;
      await ws.editChannel('Default', { enabled: false });
      held.release();
      await executor.idle();

      expect(texts(await notificationsOf(a.id))).toEqual([
        `Run ${a.id} of Workflow a failed: The model is overloaded`,
      ]);
      expect(texts(await notificationsOf(b.id))).toEqual([
        `Run ${b.id} of Workflow b failed: Channel note default was disabled before the run started`,
      ]);
    });

    it('posts an interrupted run only when it is not retried, and its retry when that finishes', async () => {
      await manualWorkflow('once');
      await manualWorkflow('twice');
      await edit('twice', { 'max-attempts': 2 });
      await target('once');
      await target('twice', '-100777');
      const repo = ds.getRepository(WorkflowRun);
      const left = async (workflow: string) =>
        (
          await repo.save(
            repo.create({
              workflowName: workflow,
              triggerKey: 'manual:crashed',
              status: 'running',
              attempt: 1,
              startedAt: new Date(),
            }),
          )
        ).id;
      const once = await left('once');
      const twice = await left('twice');

      await moduleRef.close();
      await boot();
      await executor.idle();

      expect(texts(await notificationsOf(once))).toEqual([
        `Run ${once} of Workflow once interrupted: Pero stopped before the run finished; not retried: Workflow once allows 1 attempt`,
      ]);
      expect(await notificationsOf(twice)).toEqual([]);
      const retry = await ds.getRepository(WorkflowRun).findOneByOrFail({
        triggerKey: `retry:${twice}`,
      });
      expect(retry.status).toBe('completed');
      expect(texts(await notificationsOf(retry.id))).toEqual([
        'twice\n\necho: Run twice.',
      ]);
    });

    it('posts nothing for a cancelled run', async () => {
      await manualWorkflow('brief');
      await target('brief');
      const held = claude.hold();
      const running = await runs.start('brief');
      const pending = await runs.start('brief');
      await held.started;

      await runs.cancel(pending.id);
      await runs.cancel(running.id);
      await executor.idle();

      expect(await run(running.id)).toMatchObject({ status: 'cancelled' });
      expect(await ds.getRepository(Notification).count()).toBe(0);
    });

    it('posts nothing for a run that answered just NO_REPLY', async () => {
      await manualWorkflow('breakfast');
      await target('breakfast');
      claude.answerNext('NO_REPLY');

      const { id } = await runs.start('breakfast');
      await executor.idle();

      expect(await run(id)).toMatchObject({
        status: 'completed',
        result: 'NO_REPLY',
      });
      expect(await notificationsOf(id)).toEqual([]);
    });

    it('reads the Channels to notify when the run finishes', async () => {
      await manualWorkflow('brief');
      const held = claude.hold();
      const { id } = await runs.start('brief');
      await held.started;

      const channel = await target('brief');
      held.release();
      await executor.idle();

      expect(
        (await notificationsOf(id)).map(({ channelId }) => channelId),
      ).toEqual([channel]);
    });

    it('records a run without its Notifications when they cannot be created, rather than leave it running', async () => {
      await manualWorkflow('brief');
      await target('brief');
      await ds.query(
        `CREATE TRIGGER "fail_notifications" BEFORE INSERT ON "notifications" ` +
          `BEGIN SELECT RAISE(ABORT, 'Notifications are broken'); END`,
      );
      const errors = vi
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);

      const first = await runs.start('brief');
      await executor.idle();

      expect(await run(first.id)).toMatchObject({
        status: 'completed',
        result: 'echo: Run brief.',
      });
      expect(await notificationsOf(first.id)).toEqual([]);
      expect(errors).toHaveBeenCalledWith(
        expect.stringMatching(
          new RegExp(
            `^Could not create the Notifications of run ${first.id}; it is recorded completed without them: .*Notifications are broken`,
          ),
        ),
      );
      errors.mockRestore();

      // The Workflow's next run starts, and notifies once they can be created.
      await ds.query(`DROP TRIGGER "fail_notifications"`);
      const second = await runs.start('brief');
      await executor.idle();
      expect(await run(second.id)).toMatchObject({ status: 'completed' });
      expect(await notificationsOf(second.id)).toHaveLength(1);
    });
  });

  describe('history input', () => {
    let adapter: FakeChannelAdapter;

    beforeEach(async () => {
      await ws.editPero({ timezone: 'UTC' });
      for (const chat of [OWNER, HOME]) {
        await moduleRef.get(AllowedChatsService).allow({
          integrationKind: 'telegram',
          chatKey: chat.key,
          kind: chat.kind,
          title: chat.title,
        });
      }
      adapter = new FakeChannelAdapter();
      await moduleRef.get(ChannelRouter).connect(adapter);
    });

    /** A message in the English topic, or `topic` of HOME, and its reply. */
    async function say(text: string, topic = '7'): Promise<void> {
      const title = topic === '7' ? 'English' : `Topic ${topic}`;
      await adapter.deliver(inboundMessage(HOME, { topic, title, text }));
      await (moduleRef.get(ChannelTurns) as AgentChannelTurns).idle();
    }

    async function channelId(key: string): Promise<number> {
      return (
        await ds.getRepository(Channel).findOneByOrFail({ externalKey: key })
      ).id;
    }

    /**
     * `review`, which reads every Channel's history, or as the
     * `history-…` properties `history` gives, run by hand.
     */
    async function historyWorkflow(
      history: TestNoteProperties = {},
    ): Promise<void> {
      await ws.workflow(
        'review',
        { history: true, 'history-channels': 'all', ...history },
        'Review:\n{{history}}',
      );
    }

    /**
     * Runs `review` once: the run, the input its Agent got (undefined when
     * it was not asked), and the window it read.
     */
    async function runReview(): Promise<{
      view: RunView;
      input: string | undefined;
      window: HistoryRead;
    }> {
      const asked = claude.requests.length;
      const { id } = await runs.start('review');
      await executor.idle();
      return {
        view: await run(id),
        input:
          claude.requests.length > asked
            ? claude.requests.at(-1)!.input
            : undefined,
        window: await windowOf(id),
      };
    }

    async function windowOf(id: number): Promise<HistoryRead> {
      const { executionConfig } = await ds
        .getRepository(WorkflowRun)
        .findOneByOrFail({ id });
      return executionConfig!.history as HistoryRead;
    }

    it('reads each message once across consecutive runs, in adjacent windows', async () => {
      await say('I goed home');
      await say('She have two cats');
      await historyWorkflow();

      const first = await runReview();
      expect(first.view.status).toBe('completed');
      const lines = first.input!.split('\n');
      expect(lines[0]).toBe('Review:');
      expect(lines[1]).toBe('[Chat history]');
      expect(lines[2]).toMatch(
        /^\d{4}-\d\d-\d\d \d\d:\d\d \[English\] User: I goed home$/,
      );
      expect(lines[3]).toMatch(/ \[English\] Pero: echo: I goed home$/);
      expect(lines[4]).toMatch(/ \[English\] User: She have two cats$/);
      expect(lines[5]).toMatch(/ \[English\] Pero: echo: She have two cats$/);
      expect(lines[6]).toBe('[End of chat history]');
      expect(lines).toHaveLength(7);
      expect(first.window).toMatchObject({
        channels: 'all',
        afterId: null,
        count: 4,
        dropped: 0,
      });
      expect(first.window.since).not.toBeNull();

      await say('We was late');
      const second = await runReview();
      expect(second.input).toContain('User: We was late');
      expect(second.input).not.toContain('goed');
      expect(second.input).not.toContain('two cats');
      expect(second.window).toMatchObject({
        afterId: first.window.untilId,
        since: null,
        count: 2,
      });
    });

    it('starts a renamed note on a history window of its own', async () => {
      await say('I goed home');
      await historyWorkflow();
      await runReview();

      await ws.removeWorkflow('review');
      await ws.workflow(
        'weekly',
        { history: true, 'history-channels': 'all' },
        'Review:\n{{history}}',
      );
      const { id } = await runs.start('weekly');
      await executor.idle();

      expect(claude.requests.at(-1)!.input).toContain('User: I goed home');
      expect(await windowOf(id)).toMatchObject({ afterId: null, count: 2 });
    });

    it('reads the last 24 hours on its first run', async () => {
      await say('Yesterday morning');
      await say('Just now');
      const messages = ds.getRepository(Message);
      for (const text of ['Yesterday morning', 'echo: Yesterday morning']) {
        const old = await messages.findOneByOrFail({ text });
        await messages.update(old.id, {
          createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
        });
      }
      await historyWorkflow();

      const { input } = await runReview();

      expect(input).toContain('User: Just now');
      expect(input).not.toContain('Yesterday morning');
    });

    it('reads a fixed window of hours on every run', async () => {
      await say('Once');
      await historyWorkflow({ 'history-hours': 1 });

      expect((await runReview()).input).toContain('User: Once');
      const second = await runReview();
      expect(second.input).toContain('User: Once');
      expect(second.window).toMatchObject({ afterId: null, count: 2 });
    });

    it("keeps to the Channels it names, with Pero's replies", async () => {
      await say('In English');
      await say('Buy milk', '8');
      const english = await channelId(`${HOME.key}:7`);
      await historyWorkflow({ 'history-channels': [english] });

      const { input, window } = await runReview();

      expect(input).toContain('[English] User: In English');
      expect(input).toContain('[English] Pero: echo: In English');
      expect(input).not.toContain('Buy milk');
      // Pero's own notices, such as the welcome, are left out.
      expect(input).not.toContain('pero agents edit');
      expect(window).toMatchObject({ channels: [english] });
      expect(window.count).toBe(2);
    });

    it('reads the Channels it posts to unless it names others', async () => {
      await say('In English');
      await say('Buy milk', '8');
      const english = await channelId(`${HOME.key}:7`);
      await ws.workflow(
        'review',
        { history: true, channel: [english] },
        'Review:\n{{history}}',
      );

      const { input, window } = await runReview();

      expect(input).toContain('[English] User: In English');
      expect(input).not.toContain('Buy milk');
      expect(window).toMatchObject({ channels: [english], count: 2 });
    });

    it('keeps the newest messages within the budget', async () => {
      await say(`first ${'a'.repeat(20_000)}`);
      await say(`second ${'b'.repeat(20_000)}`);
      await historyWorkflow();

      const { input, window } = await runReview();

      expect(input).toContain('[2 earlier messages left out to fit]');
      expect(input).toContain('User: second');
      expect(input).toContain('Pero: echo: second');
      expect(input).not.toContain('first');
      expect(window).toMatchObject({ count: 4, dropped: 2 });
    });

    it('runs its Agent on an empty window, and reads after it next time', async () => {
      await say('Before the Workflow');
      await historyWorkflow({ 'history-hours': null });
      // The first window is taken, so the next is empty.
      await runReview();

      const empty = await runReview();
      expect(empty.view).toMatchObject({ status: 'completed', error: null });
      expect(empty.input).toBe('Review:\n[No messages in this window]');
      expect(empty.window.count).toBe(0);

      await say('After it');
      const next = await runReview();
      expect(next.input).toContain('User: After it');
      expect(next.input).not.toContain('Before the Workflow');
      expect(next.window.afterId).toBe(empty.window.untilId);
    });

    it('reads again the messages of a run that failed', async () => {
      await say('One');
      await historyWorkflow();
      claude.failNext();
      expect((await runReview()).view.status).toBe('failed');

      await say('Two');
      const { input } = await runReview();
      expect(input).toContain('User: One');
      expect(input).toContain('User: Two');
    });

    it('gives a retry the window of the run it retries, ahead of runs queued before it', async () => {
      await say('Before the crash');
      await historyWorkflow();
      await edit('review', { 'max-attempts': 2 });
      const messages = ds.getRepository(Message);
      const crashedUntil = (
        await messages.findOneByOrFail({ text: 'echo: Before the crash' })
      ).id;
      await say('After the crash');
      const repo = ds.getRepository(WorkflowRun);
      // Queued first, so only the retry's attempt puts that ahead of it.
      const queued = await repo.save(
        repo.create({
          workflowName: 'review',
          triggerKey: 'manual:queued',
          status: 'pending',
          attempt: 1,
        }),
      );
      const crashed = await repo.save(
        repo.create({
          workflowName: 'review',
          triggerKey: 'manual:crashed',
          status: 'running',
          attempt: 1,
          startedAt: new Date(),
          executionConfig: {
            history: {
              channels: 'all',
              afterId: null,
              since: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
              untilId: crashedUntil,
              count: 2,
              dropped: 0,
            },
          },
        }),
      );
      const asked = claude.requests.length;

      await moduleRef.close();
      await boot();
      await executor.idle();

      const retry = await ds.getRepository(WorkflowRun).findOneByOrFail({
        triggerKey: `retry:${crashed.id}`,
      });
      expect(retry.status).toBe('completed');
      const retryWindow = await windowOf(retry.id);
      expect(retryWindow).toMatchObject({
        afterId: null,
        untilId: crashedUntil,
        count: 2,
      });
      const [retryInput, queuedInput] = claude.requests
        .slice(asked)
        .map((request) => request.input);
      expect(retryInput).toContain('User: Before the crash');
      expect(retryInput).not.toContain('After the crash');
      expect(queuedInput).toContain('User: After the crash');
      expect(queuedInput).not.toContain('Before the crash');
      expect(await windowOf(queued.id)).toMatchObject({
        afterId: crashedUntil,
      });
    });

    it('retries a failed run by hand with the window it read, naming a run completed since that read it too', async () => {
      await say('One');
      await historyWorkflow();
      claude.failNext();
      const failed = await runReview();
      expect(failed.view.status).toBe('failed');
      await say('Two');
      const later = await runReview();
      expect(later.input).toContain('User: One');

      const { run: retry, alsoReadBy } = await runs.retry(failed.view.id);
      await executor.idle();

      expect(alsoReadBy).toBe(later.view.id);
      expect(await run(retry.id)).toMatchObject({ status: 'completed' });
      const input = claude.requests.at(-1)!.input;
      expect(input).toContain('User: One');
      expect(input).not.toContain('Two');
      expect(await windowOf(retry.id)).toMatchObject({
        untilId: failed.window.untilId,
        count: 2,
      });
      // The next run starts after the latest window, not the retry's.
      await say('Three');
      const next = await runReview();
      expect(next.input).toContain('User: Three');
      expect(next.input).not.toContain('One');
    });

    it('names no run when none has read the window of the run retried', async () => {
      await say('One');
      await historyWorkflow();
      claude.failNext();
      const failed = await runReview();

      expect((await runs.retry(failed.view.id)).alsoReadBy).toBeNull();
      await executor.idle();
      expect(claude.requests.at(-1)!.input).toContain('User: One');
    });

    it('shows the history a run read', async () => {
      await say('One');
      await say('Two');
      await historyWorkflow();

      const { view } = await runReview();

      expect((await runs.get(view.id)).history).toEqual({
        channels: 'all',
        count: 4,
        dropped: 0,
      });
    });
  });

  describe('retrying by hand', () => {
    it('queues a failed run again as a new run with the next attempt, whatever the Workflow allows', async () => {
      await manualWorkflow('brief');
      claude.failNext();
      const { id } = await runs.start('brief');
      await executor.idle();

      const { run: retry, alsoReadBy } = await runs.retry(id);
      expect(retry).toMatchObject({
        workflow: 'brief',
        status: 'pending',
        attempt: 2,
        triggerKey: `retry:${id}`,
      });
      expect(alsoReadBy).toBeNull();
      await executor.idle();

      expect(await run(retry.id)).toMatchObject({
        status: 'completed',
        result: 'echo: Run brief.',
      });
      expect(await runs.get(id)).toMatchObject({
        status: 'failed',
        retriedBy: retry.id,
      });
      expect((await runs.get(retry.id)).retriedBy).toBeNull();
    });

    it('retries a cancelled run, and an interrupted one Pero did not retry', async () => {
      await ws.editPero({ 'max-concurrent-runs': 1 });
      await manualWorkflow('a');
      await manualWorkflow('b');
      const held = claude.hold();
      await runs.start('a');
      const b = await runs.start('b');
      await held.started;
      await runs.cancel(b.id);
      held.release();
      await executor.idle();
      const interrupted = await ds.getRepository(WorkflowRun).save(
        ds.getRepository(WorkflowRun).create({
          workflowName: 'a',
          triggerKey: 'manual:interrupted',
          status: 'interrupted',
          attempt: 1,
        }),
      );

      const cancelledRetry = await runs.retry(b.id);
      const interruptedRetry = await runs.retry(interrupted.id);
      await executor.idle();

      expect(await run(cancelledRetry.run.id)).toMatchObject({
        workflow: 'b',
        status: 'completed',
      });
      expect(await run(interruptedRetry.run.id)).toMatchObject({
        workflow: 'a',
        status: 'completed',
      });
    });

    it('refuses a run that has not finished, that completed, that is retried already, or that does not exist', async () => {
      await manualWorkflow('brief');
      const held = claude.hold();
      const running = await runs.start('brief');
      const pending = await runs.start('brief');
      await held.started;

      await expect(runs.retry(running.id)).rejects.toThrow(
        new ConflictError(
          `Run ${running.id} has not finished (running); pero runs cancel ${running.id} cancels it`,
        ),
      );
      await expect(runs.retry(pending.id)).rejects.toThrow(
        `Run ${pending.id} has not finished (pending)`,
      );
      held.release();
      await executor.idle();
      await expect(runs.retry(running.id)).rejects.toThrow(
        new ConflictError(
          `Run ${running.id} completed; pero workflows run brief starts another`,
        ),
      );

      claude.failNext();
      const failed = await runs.start('brief');
      await executor.idle();
      const { run: retry } = await runs.retry(failed.id);
      await expect(runs.retry(failed.id)).rejects.toThrow(
        new ConflictError(
          `Run ${failed.id} is already retried by run ${retry.id}; retry that one instead`,
        ),
      );
      await expect(runs.retry(99)).rejects.toThrow(
        new NotFoundError('No run with ID 99'),
      );
      await executor.idle();
    });

    it('retries a disabled Workflow, but not while its Agent is disabled', async () => {
      await manualWorkflow('brief');
      claude.failNext();
      const { id } = await runs.start('brief');
      await executor.idle();
      claude.failNext();
      const other = await runs.start('brief');
      await executor.idle();

      await edit('brief', { enabled: false });
      const { run: retry } = await runs.retry(id);
      await executor.idle();
      expect(await run(retry.id)).toMatchObject({ status: 'completed' });

      await ws.editChannel('Default', { enabled: false });
      await expect(runs.retry(other.id)).rejects.toThrow(
        new InvalidInputError(
          'Channel note default is disabled; enable it first (enabled: true in Channels/Default.md)',
        ),
      );
      expect(await ds.getRepository(WorkflowRun).count()).toBe(3);
    });
  });

  describe('listing runs', () => {
    it('lists the latest runs newest first, by Workflow and status', async () => {
      await manualWorkflow('a');
      await manualWorkflow('b');
      const first = await runs.start('a');
      await executor.idle();
      claude.failNext();
      const second = await runs.start('b');
      await executor.idle();
      const third = await runs.start('a');
      await executor.idle();

      const ids = (list: RunView[]) => list.map(({ id }) => id);
      expect(ids(await runs.list({ limit: 20 }))).toEqual([
        third.id,
        second.id,
        first.id,
      ]);
      expect(ids(await runs.list({ limit: 2 }))).toEqual([third.id, second.id]);
      expect(ids(await runs.list({ workflow: 'A', limit: 20 }))).toEqual([
        third.id,
        first.id,
      ]);
      expect(await runs.list({ status: 'failed', limit: 20 })).toEqual([
        expect.objectContaining({ id: second.id, workflow: 'b' }),
      ]);
      await expect(runs.list({ workflow: 'nope', limit: 20 })).rejects.toThrow(
        NotFoundError,
      );
    });
  });

  describe('scripts', () => {
    /** Settles once run `id` is running. */
    async function running(id: number): Promise<void> {
      while ((await run(id)).status !== 'running') await tick();
    }

    it("sends its script's output in place of {{script}}, and records it", async () => {
      await ws.workflow(
        'alerts',
        { script: 'printf "one\\ntwo\\n"' },
        'New alerts:\n\n{{script}}\n\nSummarize them.',
      );

      const { id } = await runs.start('alerts');
      await executor.idle();

      const input =
        'New alerts:\n\n[Script output]\none\ntwo\n[End of script output]\n\nSummarize them.';
      expect(claude.requests).toHaveLength(1);
      expect(claude.requests[0]!.input).toBe(input);
      expect(await run(id)).toMatchObject({
        status: 'completed',
        result: `echo: ${input}`,
      });
      const saved = await ds.getRepository(WorkflowRun).findOneByOrFail({ id });
      expect(saved.executionConfig).toMatchObject({
        script: 'printf "one\\ntwo\\n"',
        input,
      });
    });

    it('runs it in the working directory, naming the Workflow and run', async () => {
      await ws.workflow(
        'where',
        { script: 'echo "$PWD $PERO_WORKFLOW $PERO_RUN_ID"' },
        'Where?',
      );

      const { id } = await runs.start('where');
      await executor.idle();

      expect(claude.requests[0]!.input).toContain(
        `${realpathSync(workspace)} where ${id}\n`,
      );
    });

    it('completes a run without a turn when its script finds no data', async () => {
      await ws.workflow('alerts', { script: 'echo "  NO_DATA  "' });

      const { id } = await runs.start('alerts');
      await executor.idle();

      expect(await run(id)).toMatchObject({
        status: 'completed',
        result: 'NO_DATA',
        error: null,
      });
      expect(claude.requests).toEqual([]);
    });

    it('fails a run whose script fails, without a turn', async () => {
      await ws.workflow('alerts', { script: 'echo boom >&2; exit 2' });
      await ws.workflow('missing', { script: 'no-such-command-pero' });

      const failed = await runs.start('alerts');
      const missing = await runs.start('missing');
      await executor.idle();

      expect(await run(failed.id)).toMatchObject({
        status: 'failed',
        result: null,
        error: 'script failed: boom',
      });
      expect((await run(missing.id)).error).toMatch(
        /^script failed: .*no-such-command-pero/,
      );
      expect(claude.requests).toEqual([]);
    });

    it('stops a script when the run is cancelled', async () => {
      await ws.workflow('slow', { script: 'sleep 30' });
      const { id } = await runs.start('slow');
      await running(id);

      await runs.cancel(id);
      await executor.idle();

      expect(await run(id)).toMatchObject({
        status: 'cancelled',
        error: CANCELLED,
      });
      expect(claude.requests).toEqual([]);
    });

    it('stops a script when Pero stops, leaving the run for the next start', async () => {
      await ws.workflow('slow', { script: 'sleep 30' });
      const { id } = await runs.start('slow');
      await running(id);

      await executor.beforeApplicationShutdown();

      expect(await run(id)).toMatchObject({ status: 'running', error: null });
      await moduleRef.close();
      await boot();
      expect(await run(id)).toMatchObject({ status: 'interrupted' });
      expect(claude.requests).toEqual([]);
    });
  });

  describe('starting a run by hand', () => {
    it('refuses an unknown Workflow', async () => {
      await expect(runs.start('nope')).rejects.toThrow(NotFoundError);
    });

    it('runs any Workflow, with a schedule or without', async () => {
      await ws.workflow('brief', { hour: 9 }, 'Go.');
      await ws.workflow('quiet', {}, 'Hush.');

      const scheduled = await runs.start('BRIEF');
      const manual = await runs.start('quiet');
      await executor.idle();

      expect(await run(scheduled.id)).toMatchObject({
        workflow: 'brief',
        status: 'completed',
        result: 'echo: Go.',
      });
      expect(await run(manual.id)).toMatchObject({
        workflow: 'quiet',
        status: 'completed',
      });
    });

    it('runs a disabled Workflow, but not while its Channel note is disabled', async () => {
      await manualWorkflow('brief');

      await edit('brief', { enabled: false });
      const run1 = await runs.start('brief');
      await executor.idle();
      expect(await run(run1.id)).toMatchObject({ status: 'completed' });

      await ws.editChannel('Default', { enabled: false });
      await expect(runs.start('brief')).rejects.toThrow(
        'Channel note default is disabled; enable it first (enabled: true in Channels/Default.md)',
      );
      await ws.removeWorkflow('brief');
      await expect(runs.start('brief')).rejects.toThrow(
        new NotFoundError('No Workflow named brief'),
      );
      expect(await ds.getRepository(WorkflowRun).count()).toBe(1);
    });

    it('gives each run its own trigger key', async () => {
      await manualWorkflow('brief');

      const first = await runs.start('brief');
      const second = await runs.start('brief');
      await executor.idle();

      expect(first.triggerKey).toMatch(/^manual:[0-9a-f-]{36}$/);
      expect(first.triggerKey).not.toBe(second.triggerKey);
    });

    it('refuses an unknown run ID', async () => {
      await expect(runs.get(99)).rejects.toThrow(
        new NotFoundError('No run with ID 99'),
      );
    });
  });
});
