import { Test, type TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentChannelTurns } from '../channels/agent-channel-turns.js';
import { AllowedChatsService } from '../channels/allowed-chats.service.js';
import { ChannelRouter } from '../channels/channel-router.js';
import { ChannelSender } from '../channels/channel-sender.js';
import { FileDelivery } from '../channels/file-delivery.js';
import { ChannelTurns } from '../channels/channel-stages.js';
import { ChannelsModule } from '../channels/channels.module.js';
import {
  FakeChannelAdapter,
  inboundMessage,
  privateChat,
} from '../channels/testing/fake-channel-adapter.js';
import { ConflictError, NotFoundError } from '../common/errors.js';
import { ComponentHealth } from '../health/component-health.js';
import { MessageHistory } from '../history/message-history.service.js';
import { Channel } from '../persistence/entities/channel.entity.js';
import { Message } from '../persistence/entities/message.entity.js';
import { Notification } from '../persistence/entities/notification.entity.js';
import { WorkflowRun } from '../persistence/entities/workflow-run.entity.js';
import { SpeechService } from '../speech/speech.service.js';
import { FakeSpeech } from '../speech/testing/fake-speech.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { AGENT_RUNTIMES } from '../runtimes/agent-runtimes.js';
import { FakeAgentRuntime } from '../runtimes/testing/fake-agent-runtime.js';
import { Definitions } from '../system/definitions.js';
import { TestWorkspace } from '../system/testing/test-workspace.js';
import { WorkflowExecutor } from '../workflows/workflow-executor.js';
import { WorkflowRuns } from '../workflows/workflow-runs.service.js';
import { WorkflowsModule } from '../workflows/workflows.module.js';
import {
  MAX_DELIVERY_ATTEMPTS,
  NOT_ALLOWED,
  NotificationDelivery,
  retryDelay,
} from './notification-delivery.js';
import { NotificationViews } from './notification-views.service.js';
import { NotificationsModule } from './notifications.module.js';

const OWNER = privateChat('1234');

/** What run `brief` posts: the Workflow's title over the echoed input. */
const SUGGESTION = 'Brief\n\necho: Suggest one thing.';

describe('NotificationDelivery', () => {
  let ws: TestWorkspace;
  let moduleRef: TestingModule;
  let ds: DataSource;
  let delivery: NotificationDelivery;
  let adapter: FakeChannelAdapter;
  let claude: FakeAgentRuntime;
  let codex: FakeAgentRuntime;
  let speech: FakeSpeech;

  beforeEach(async () => {
    ws = TestWorkspace.create('pero-delivery-');
    await ws.pero();
    await ws.channel('Default');
    claude = new FakeAgentRuntime('claude');
    codex = new FakeAgentRuntime('codex');
    speech = new FakeSpeech();
    moduleRef = await Test.createTestingModule({
      imports: [
        PersistenceModule.forRoot({ database: ws.database }),
        ws.hostConfig(),
        ChannelsModule,
        WorkflowsModule,
        NotificationsModule,
      ],
    })
      .overrideProvider(AGENT_RUNTIMES)
      .useValue([claude, codex])
      .overrideProvider(SpeechService)
      .useValue(speech)
      .compile();
    await moduleRef.init();
    ds = moduleRef.get<DataSource>(getDataSourceToken());
    delivery = moduleRef.get(NotificationDelivery);
    ws.use(moduleRef);
    await ws.workflow('Brief', {}, 'Suggest one thing.');
    await moduleRef.get(AllowedChatsService).allow({
      integrationKind: 'telegram',
      chatKey: OWNER.key,
      kind: OWNER.kind,
      title: OWNER.title,
    });
    adapter = new FakeChannelAdapter();
    await moduleRef.get(ChannelRouter).connect(adapter);
  });

  afterEach(async () => {
    await moduleRef.close();
    ws.delete();
  });

  /** The owner's direct chat as a Channel `brief` notifies. */
  async function target(): Promise<Channel> {
    const channels = ds.getRepository(Channel);
    const channel = await channels.save(
      channels.create({
        integrationKind: 'telegram',
        externalKey: OWNER.key,
        address: OWNER.address,
        title: null,
      }),
    );
    await ws.editWorkflow('Brief', { channel: channel.id });
    return channel;
  }

  /** Runs `brief` to its end; its Notification, due when it finished. */
  async function finishedRun(): Promise<Notification> {
    const { id } = await moduleRef.get(WorkflowRuns).start('brief');
    await moduleRef.get(WorkflowExecutor).idle();
    return ds
      .getRepository(Notification)
      .findOneByOrFail({ workflowRunId: id });
  }

  function reload(notification: Notification): Promise<Notification> {
    return ds
      .getRepository(Notification)
      .findOneByOrFail({ id: notification.id });
  }

  function workflowMessages(): Promise<Message[]> {
    return ds
      .getRepository(Message)
      .find({ where: { origin: 'workflow' }, order: { id: 'ASC' } });
  }

  const after = (date: Date, ms: number) => new Date(date.getTime() + ms);

  it('delivers a pending Notification and records it in history once', async () => {
    const channel = await target();
    const notification = await finishedRun();
    const now = after(notification.nextAttemptAt!, 1);

    await delivery.tick(now);
    await delivery.tick(after(now, 24 * 60 * 60_000));

    expect(adapter.sent).toEqual([
      { address: OWNER.address, message: { text: SUGGESTION, markdown: true } },
    ]);
    expect(await reload(notification)).toMatchObject({
      status: 'delivered',
      attempt: 1,
      providerMessageId: '1',
      nextAttemptAt: null,
      lastError: null,
    });
    expect(await workflowMessages()).toEqual([
      expect.objectContaining({
        channelId: channel.id,
        agentName: null,
        sessionId: null,
        direction: 'out',
        externalMessageId: '1',
        senderId: null,
        text: SUGGESTION,
        notificationId: notification.id,
      }),
    ]);
    expect(await ds.getRepository(WorkflowRun).count()).toBe(1);
  });

  it("sends a run's voice blocks as voice messages, recording their words", async () => {
    const channel = await target();
    await ws.editWorkflow(
      'Brief',
      { channel: channel.id },
      'Say <voice>Good morning.</voice>',
    );
    const notification = await finishedRun();

    await delivery.tick(after(notification.nextAttemptAt!, 1));

    expect(adapter.sent).toEqual([
      {
        address: OWNER.address,
        message: { text: 'Brief\n\necho: Say', markdown: true },
      },
      {
        address: OWNER.address,
        message: { text: '' },
        voice: {
          audio: new TextEncoder().encode('Good morning.'),
          type: 'audio/ogg',
          durationS: 1,
        },
      },
    ]);
    expect(speech.spoken).toEqual(['Good morning.']);
    expect(await workflowMessages()).toEqual([
      expect.objectContaining({
        externalMessageId: '1',
        text: 'Brief\n\necho: Say\n\n[Voice message]\nGood morning.',
      }),
    ]);
  });

  it('sends nothing before a Notification is due', async () => {
    await target();
    const notification = await finishedRun();

    await delivery.tick(after(notification.nextAttemptAt!, -1_000));

    expect(adapter.sent).toEqual([]);
    expect(await reload(notification)).toMatchObject({
      status: 'pending',
      attempt: 0,
    });
  });

  it('retries a failed attempt after its backoff, without another run', async () => {
    await target();
    const notification = await finishedRun();
    const first = after(notification.nextAttemptAt!, 1);
    adapter.failSends = true;

    await delivery.tick(first);
    expect(await reload(notification)).toMatchObject({
      status: 'pending',
      attempt: 1,
      lastError: 'Service unreachable',
      nextAttemptAt: after(first, retryDelay(1)),
    });

    adapter.failSends = false;
    await delivery.tick(after(first, retryDelay(1) - 1_000));
    expect(adapter.sent).toEqual([]);

    await delivery.tick(after(first, retryDelay(1)));
    expect(adapter.sent).toHaveLength(1);
    expect(await reload(notification)).toMatchObject({
      status: 'delivered',
      attempt: 2,
      lastError: null,
    });
    expect(await workflowMessages()).toHaveLength(1);
    expect(await ds.getRepository(WorkflowRun).count()).toBe(1);
  });

  it('fails a Notification that runs out of attempts, and leaves it failed', async () => {
    await target();
    const notification = await finishedRun();
    adapter.failSends = true;
    let now = after(notification.nextAttemptAt!, 1);

    for (let attempt = 1; attempt <= MAX_DELIVERY_ATTEMPTS; attempt++) {
      await delivery.tick(now);
      now = after(now, retryDelay(attempt));
    }
    expect(await reload(notification)).toMatchObject({
      status: 'failed',
      attempt: MAX_DELIVERY_ATTEMPTS,
      nextAttemptAt: null,
      lastError: 'Service unreachable',
    });

    adapter.failSends = false;
    await delivery.tick(after(now, 7 * 24 * 60 * 60_000));
    expect(adapter.sent).toEqual([]);
    expect(await reload(notification)).toMatchObject({
      attempt: MAX_DELIVERY_ATTEMPTS,
    });
  });

  it('fails a Notification to a chat that is no longer allowed, without sending', async () => {
    await target();
    const notification = await finishedRun();
    await moduleRef.get(AllowedChatsService).deny('telegram', OWNER.key);

    await delivery.tick(after(notification.nextAttemptAt!, 1));

    expect(adapter.sent).toEqual([]);
    expect(await reload(notification)).toMatchObject({
      status: 'failed',
      attempt: 1,
      lastError: NOT_ALLOWED,
      nextAttemptAt: null,
    });
    expect(await workflowMessages()).toEqual([]);
  });

  it('sends a Notification once when ticks overlap', async () => {
    await target();
    const notification = await finishedRun();
    const now = after(notification.nextAttemptAt!, 1);

    await Promise.all([
      delivery.tick(now),
      delivery.tick(after(now, 60 * 60_000)),
    ]);

    expect(adapter.sent).toHaveLength(1);
    expect(await workflowMessages()).toHaveLength(1);
  });

  describe('retrying by hand', () => {
    it('gives a failed Notification fresh attempts and delivers it at once', async () => {
      await target();
      const notification = await finishedRun();
      await moduleRef.get(AllowedChatsService).deny('telegram', OWNER.key);
      await delivery.tick(after(notification.nextAttemptAt!, 1));
      expect((await reload(notification)).status).toBe('failed');
      await moduleRef.get(AllowedChatsService).allow({
        integrationKind: 'telegram',
        chatKey: OWNER.key,
        kind: OWNER.kind,
        title: OWNER.title,
      });

      await delivery.retry(notification.id);

      await vi.waitFor(async () =>
        expect(await reload(notification)).toMatchObject({
          status: 'delivered',
          attempt: 1,
          lastError: null,
        }),
      );
      expect(adapter.sent).toHaveLength(1);
      expect(await workflowMessages()).toHaveLength(1);
      expect(await ds.getRepository(WorkflowRun).count()).toBe(1);
    });

    it('keeps the last error of a failed Notification until its next attempt', async () => {
      await target();
      const notification = await finishedRun();
      await moduleRef.get(AllowedChatsService).deny('telegram', OWNER.key);
      await delivery.tick(after(notification.nextAttemptAt!, 1));

      // The worker is stopping, so nothing is attempted.
      await delivery.beforeApplicationShutdown();
      await delivery.retry(notification.id);

      const queued = await reload(notification);
      expect(queued).toMatchObject({
        status: 'pending',
        attempt: 0,
        lastError: NOT_ALLOWED,
      });
      expect(queued.nextAttemptAt!.getTime()).toBeLessThanOrEqual(Date.now());
    });

    it('makes a pending Notification due now, keeping its attempts', async () => {
      await target();
      const notification = await finishedRun();
      adapter.failSends = true;
      await delivery.tick(after(notification.nextAttemptAt!, 1));
      expect(await reload(notification)).toMatchObject({
        status: 'pending',
        attempt: 1,
      });
      adapter.failSends = false;

      await delivery.retry(notification.id);

      await vi.waitFor(async () =>
        expect(await reload(notification)).toMatchObject({
          status: 'delivered',
          attempt: 2,
        }),
      );
      expect(adapter.sent).toHaveLength(1);
    });

    it('delivers a Notification retried while a tick is under way once that tick ends', async () => {
      await target();
      const first = await finishedRun();
      const second = await finishedRun();
      await moduleRef.get(AllowedChatsService).deny('telegram', OWNER.key);
      await delivery.tick(after(second.nextAttemptAt!, 1));
      expect((await reload(second)).status).toBe('failed');
      await moduleRef.get(AllowedChatsService).allow({
        integrationKind: 'telegram',
        chatKey: OWNER.key,
        kind: OWNER.kind,
        title: OWNER.title,
      });
      const held = adapter.holdSends();
      await delivery.retry(first.id);
      await held.started;

      // The tick under way read what was due before this.
      await delivery.retry(second.id);
      held.release();

      await vi.waitFor(async () =>
        expect((await reload(second)).status).toBe('delivered'),
      );
      expect((await reload(first)).status).toBe('delivered');
      expect(adapter.sent).toHaveLength(2);
    });

    it('refuses a delivered Notification, and one that does not exist', async () => {
      await target();
      const notification = await finishedRun();
      await delivery.tick(after(notification.nextAttemptAt!, 1));

      await expect(delivery.retry(notification.id)).rejects.toThrow(
        new ConflictError(
          `Notification ${notification.id} has already been delivered`,
        ),
      );
      await expect(delivery.retry(99)).rejects.toThrow(
        new NotFoundError('No Notification with ID 99'),
      );
      expect(adapter.sent).toHaveLength(1);
    });
  });

  describe('views', () => {
    let views: NotificationViews;

    beforeEach(() => {
      views = moduleRef.get(NotificationViews);
    });

    it('lists the latest Notifications newest first, by status, Workflow, Channel, and run', async () => {
      const channel = await target();
      await ws.workflow('other', { channel: channel.id }, 'Other.');
      const first = await finishedRun();
      await delivery.tick(after(first.nextAttemptAt!, 1));
      const { id: otherRun } = await moduleRef.get(WorkflowRuns).start('other');
      await moduleRef.get(WorkflowExecutor).idle();
      const second = await ds
        .getRepository(Notification)
        .findOneByOrFail({ workflowRunId: otherRun });

      const ids = (filter: Partial<Parameters<typeof views.list>[0]>) =>
        views
          .list({ limit: 20, ...filter })
          .then((list) => list.map(({ id }) => id));
      expect(await ids({})).toEqual([second.id, first.id]);
      expect(await ids({ limit: 1 })).toEqual([second.id]);
      expect(await ids({ status: 'delivered' })).toEqual([first.id]);
      expect(await ids({ workflow: 'Other' })).toEqual([second.id]);
      expect(await ids({ channel: channel.id })).toEqual([second.id, first.id]);
      expect(await ids({ channel: channel.id + 1 })).toEqual([]);
      expect(await ids({ run: first.workflowRunId })).toEqual([first.id]);
      await expect(views.list({ limit: 20, workflow: 'nope' })).rejects.toThrow(
        NotFoundError,
      );
      expect((await views.list({ limit: 20 }))[1]).toMatchObject({
        id: first.id,
        runId: first.workflowRunId,
        workflow: 'brief',
        channel: { id: channel.id, key: OWNER.key, title: null },
        status: 'delivered',
        attempt: 1,
        maxAttempts: MAX_DELIVERY_ATTEMPTS,
        nextAttemptAt: null,
        lastError: null,
        providerMessageId: expect.any(String),
      });
    });

    it("shows a Notification's message and whether its chat is allowed", async () => {
      await target();
      const notification = await finishedRun();

      expect(await views.details(notification.id)).toMatchObject({
        id: notification.id,
        status: 'pending',
        text: SUGGESTION,
        chatAllowed: true,
        delivering: false,
      });

      await moduleRef.get(AllowedChatsService).deny('telegram', OWNER.key);
      expect((await views.details(notification.id)).chatAllowed).toBe(false);

      // What the integration's health reports while it is not ok.
      const health = moduleRef.get(ComponentHealth);
      health.report('telegram', 'unconfigured', 'Bot token is not set');
      expect((await views.details(notification.id)).integrationProblem).toBe(
        'Bot token is not set',
      );
      health.report('telegram', 'ok', 'Connected as @pero_bot');
      expect(
        (await views.details(notification.id)).integrationProblem,
      ).toBeNull();

      // An integration that is not connected cannot tell.
      const unconnected = new NotificationViews(
        ds,
        new ChannelSender(
          moduleRef.get(MessageHistory),
          moduleRef.get(SpeechService),
          moduleRef.get(FileDelivery),
        ),
        moduleRef.get(AllowedChatsService),
        delivery,
        moduleRef.get(ComponentHealth),
        moduleRef.get(Definitions),
      );
      expect((await unconnected.details(notification.id)).chatAllowed).toBe(
        null,
      );
      await expect(views.details(99)).rejects.toThrow(
        new NotFoundError('No Notification with ID 99'),
      );
    });

    it('says while a Notification is being delivered', async () => {
      await target();
      const notification = await finishedRun();
      const held = adapter.holdSends();

      const tick = delivery.tick(after(notification.nextAttemptAt!, 1));
      await held.started;
      expect(await views.details(notification.id)).toMatchObject({
        status: 'pending',
        attempt: 1,
        delivering: true,
      });
      held.release();
      await tick;
      expect(await views.details(notification.id)).toMatchObject({
        status: 'delivered',
        delivering: false,
      });
    });
  });

  describe('in the Channel afterwards', () => {
    let channel: Channel;

    /** A message from the owner, answered before this resolves. */
    async function say(text: string): Promise<void> {
      await adapter.deliver(inboundMessage(OWNER, { text }));
      await (moduleRef.get(ChannelTurns) as AgentChannelTurns).idle();
    }

    /** Runs `brief` and delivers what it posts to the owner's chat. */
    async function posted(): Promise<void> {
      const notification = await finishedRun();
      await delivery.tick(after(notification.nextAttemptAt!, 1));
      expect((await reload(notification)).status).toBe('delivered');
    }

    beforeEach(async () => {
      // Onboards the direct chat, with the main Agent.
      await say('Hello');
      channel = await ds
        .getRepository(Channel)
        .findOneByOrFail({ externalKey: OWNER.key });
      await ws.editWorkflow('Brief', { channel: channel.id });
    });

    it('gives the next turn what was posted since the last message, and the turn after it nothing', async () => {
      await posted();

      await say('Tell me more');
      const input = claude.requests.at(-1)!.input;
      expect(input).toMatch(
        /^\[Posted in this chat by Workflows since the last message here\]\n\d{4}-\d\d-\d\d \d\d:\d\d Workflow brief: Brief\n\necho: Suggest one thing\.\n\[End of posted messages\]\n\nTell me more$/,
      );
      expect(claude.requests.at(-1)!.providerSessionId).toBeDefined();

      await say('Thanks');
      expect(claude.requests.at(-1)!.input).toBe('Thanks');
    });

    it('gives a fresh Session the posted messages once, after the conversation it carries over', async () => {
      await posted();
      await ws.editChannel('Default', { provider: 'codex' });

      await say('Tell me more');
      const input = codex.requests.at(-1)!.input;
      expect(input).toContain('Pero: echo: Hello');
      expect(input.indexOf('[End of earlier conversation]')).toBeLessThan(
        input.indexOf('[Posted in this chat by Workflows'),
      );
      expect(input.split('Workflow brief: ')).toHaveLength(2);
      expect(input.endsWith('\n\nTell me more')).toBe(true);
    });

    it('carries over earlier Workflow messages into a fresh Session', async () => {
      await posted();
      await say('Tell me more');
      await ws.editChannel('Default', { provider: 'codex' });

      await say('And then?');
      const input = codex.requests.at(-1)!.input;
      expect(input).toMatch(
        /^\[Earlier conversation in this chat, from a previous session\]\n/,
      );
      expect(input).toContain('Workflow brief: Brief\n\necho:');
      // Nothing was posted since the last message, so no block of its own.
      expect(input.endsWith('[End of earlier conversation]\n\nAnd then?')).toBe(
        true,
      );
    });

    it("leaves Workflow messages out of a Workflow's history window", async () => {
      await posted();
      await ws.workflow(
        'review',
        {
          history: true,
          'history-channels': 'all',
          'history-hours': 24,
        },
        'Review:\n{{history}}',
      );

      await moduleRef.get(WorkflowRuns).start('review');
      await moduleRef.get(WorkflowExecutor).idle();

      const input = claude.requests.at(-1)!.input;
      expect(input).toContain('Hello');
      expect(input).not.toContain('Suggest one thing');
    });
  });
});
