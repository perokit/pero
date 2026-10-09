import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentsModule } from '../agents/agents.module.js';
import { Channel } from '../persistence/entities/channel.entity.js';
import { InboundUpdate } from '../persistence/entities/inbound-update.entity.js';
import { Message } from '../persistence/entities/message.entity.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { SpeechService } from '../speech/speech.service.js';
import { FakeSpeech } from '../speech/testing/fake-speech.js';
import { Definitions } from '../system/definitions.js';
import { TestWorkspace } from '../system/testing/test-workspace.js';
import { AllowedChatsService } from './allowed-chats.service.js';
import type { InboundChat } from './channel-adapter.js';
import { ChannelRouter, pairingHint } from './channel-router.js';
import { ChannelOnboarding, ChannelTurns, routeOf } from './channel-stages.js';
import { ChannelsModule } from './channels.module.js';
import {
  PAIRING_HINT_INTERVAL_MS,
  PairingRequests,
} from './pairing-requests.js';
import {
  FakeChannelAdapter,
  groupChat,
  inboundMessage,
  membershipChanged,
  privateChat,
  topicCreated,
} from './testing/fake-channel-adapter.js';

// Beyond Number.MAX_SAFE_INTEGER, like real supergroup IDs can be.
const GROUP = groupChat('-1009007199254740993', 'Household');
const STRANGER = groupChat('-100555', 'Somewhere else');
const OWNER = privateChat('1234');

describe('ChannelRouter', () => {
  let ws: TestWorkspace;
  let moduleRef: TestingModule;
  let ds: DataSource;
  let router: ChannelRouter;
  let allowedChats: AllowedChatsService;
  let adapter: FakeChannelAdapter;
  const turns = {
    handle: vi.fn(() => Promise.resolve()),
    drain: vi.fn(() => Promise.resolve()),
  };
  let speech: FakeSpeech;
  const onboarding = {
    onUnknownChannel: vi.fn((): Promise<Channel | null> =>
      Promise.resolve(null),
    ),
    onEvent: vi.fn(() => Promise.resolve()),
    // Routes as the real one does where it writes no note.
    answer: vi.fn((channel: Channel) =>
      routeOf(channel, moduleRef.get(Definitions)),
    ),
  };

  beforeEach(async () => {
    ws = TestWorkspace.create('pero-channels-');
    speech = new FakeSpeech();
    moduleRef = await Test.createTestingModule({
      imports: [
        PersistenceModule.forRoot({ database: ws.database }),
        ws.hostConfig(),
        AgentsModule,
        ChannelsModule,
      ],
    })
      .overrideProvider(ChannelTurns)
      .useValue(turns)
      .overrideProvider(ChannelOnboarding)
      .useValue(onboarding)
      .overrideProvider(SpeechService)
      .useValue(speech)
      .compile();
    await moduleRef.init();
    ds = moduleRef.get<DataSource>(getDataSourceToken());
    router = moduleRef.get(ChannelRouter);
    allowedChats = moduleRef.get(AllowedChatsService);
    ws.use(moduleRef);
    adapter = new FakeChannelAdapter();
    await router.connect(adapter);
  });

  afterEach(async () => {
    await moduleRef.close();
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.restoreAllMocks();
    ws.delete();
  });

  function allow(chat: InboundChat, title: string | null = chat.title) {
    return allowedChats.allow({
      integrationKind: 'telegram',
      chatKey: chat.key,
      kind: chat.kind,
      title,
    });
  }

  /**
   * A Channel answered with the Channel note named `noteName`: a topic's,
   * named as its `title`, or `Default.md` for a primary Channel.
   */
  async function channel(
    key: string,
    noteName: string,
    title: string | null = key.includes(':') ? noteTitle(noteName) : null,
  ) {
    await ws.channel(noteTitle(noteName));
    return ds.getRepository(Channel).save({
      integrationKind: 'telegram',
      externalKey: key,
      address: {},
      title,
    });
  }

  /** The title of the Channel note named `name`. */
  function noteTitle(name: string): string {
    return name.charAt(0).toUpperCase() + name.slice(1);
  }

  function messageCount(): Promise<number> {
    return ds.getRepository(Message).count();
  }

  function reachedNextStage(): boolean {
    return (
      turns.handle.mock.calls.length +
        onboarding.onUnknownChannel.mock.calls.length +
        onboarding.onEvent.mock.calls.length >
      0
    );
  }

  describe('a chat that is not allowed', () => {
    it('never reaches the next stage and gets the pairing hint where it wrote', async () => {
      const message = inboundMessage(STRANGER, { topic: '7' });

      await adapter.deliver(message);

      expect(reachedNextStage()).toBe(false);
      expect(await ds.getRepository(InboundUpdate).count()).toBe(0);
      expect(await messageCount()).toBe(0);
      expect(adapter.sent).toEqual([
        {
          address: message.channel.address,
          message: { text: pairingHint('telegram', STRANGER.key) },
        },
      ]);
      expect(adapter.sent[0]!.message.text).toContain(
        `pero telegram allow ${STRANGER.key}`,
      );
    });

    it('gets the hint at most once an hour, counted per chat', async () => {
      vi.useFakeTimers({
        now: new Date('2026-09-28T10:00:00Z'),
        toFake: ['Date'],
      });

      await adapter.deliver(inboundMessage(STRANGER));
      await adapter.deliver(inboundMessage(STRANGER));
      await adapter.deliver(inboundMessage(OWNER));
      expect(adapter.sent.map((s) => s.address)).toEqual([
        STRANGER.address,
        OWNER.address,
      ]);

      vi.setSystemTime(Date.now() + PAIRING_HINT_INTERVAL_MS - 1000);
      await adapter.deliver(inboundMessage(STRANGER));
      expect(adapter.sent).toHaveLength(2);

      vi.setSystemTime(Date.now() + 1000);
      await adapter.deliver(inboundMessage(STRANGER));
      expect(adapter.sent).toHaveLength(3);
      expect(reachedNextStage()).toBe(false);
    });

    it('is told to confirm in the terminal while pero run waits there', async () => {
      await adapter.deliver(inboundMessage(STRANGER));
      moduleRef.get(PairingRequests).watch('telegram');
      await adapter.deliver(inboundMessage(STRANGER));
      await adapter.deliver(inboundMessage(STRANGER));

      expect(adapter.sent.map((sent) => sent.message.text)).toEqual([
        pairingHint('telegram', STRANGER.key),
        pairingHint('telegram', STRANGER.key, 'confirm'),
      ]);
      expect(adapter.sent[1]!.message.text).toContain('terminal');
      expect(reachedNextStage()).toBe(false);
    });

    it('gets the hint in the chat itself when the bot is added', async () => {
      await adapter.emit(membershipChanged(STRANGER, 'member'));
      await adapter.emit(membershipChanged(OWNER, 'left'));
      await adapter.emit(topicCreated(STRANGER, '9'));

      expect(adapter.sent).toEqual([
        {
          address: STRANGER.address,
          message: { text: pairingHint('telegram', STRANGER.key) },
        },
      ]);
      expect(reachedNextStage()).toBe(false);
    });

    it('survives a hint that cannot be sent', async () => {
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      adapter.failSends = true;

      await expect(
        adapter.deliver(inboundMessage(STRANGER)),
      ).resolves.toBeUndefined();
      expect(reachedNextStage()).toBe(false);
    });
  });

  describe('an allowed chat', () => {
    beforeEach(async () => {
      await allow(GROUP);
      await allow(OWNER);
    });

    it('resolves a known key to its Channel and its note', async () => {
      const topic = await channel(`${GROUP.key}:7`, 'groceries');
      const primary = await channel(GROUP.key, 'default');
      const message = inboundMessage(GROUP, { topic: '7' });

      await adapter.deliver(message);
      await adapter.deliver(inboundMessage(GROUP));

      expect(turns.handle).toHaveBeenCalledTimes(2);
      expect(turns.handle).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          id: topic.id,
          note: expect.objectContaining({ name: 'groceries' }),
        }),
        message,
        expect.any(Number),
        [],
      );
      expect(turns.handle).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          id: primary.id,
          note: expect.objectContaining({ name: 'default' }),
        }),
        expect.anything(),
        expect.any(Number),
        [],
      );
      expect(onboarding.onUnknownChannel).not.toHaveBeenCalled();
      expect(adapter.sent).toEqual([]);
    });

    it('hands an unknown key to onboarding', async () => {
      await channel(GROUP.key, 'default');
      const message = inboundMessage(GROUP, { topic: '8' });

      await adapter.deliver(message);

      expect(onboarding.onUnknownChannel).toHaveBeenCalledExactlyOnceWith(
        message,
      );
      expect(turns.handle).not.toHaveBeenCalled();
    });

    it('passes a message on to the Channel onboarding returns', async () => {
      const onboarded = await channel(`${GROUP.key}:8`, 'groceries');
      onboarding.onUnknownChannel.mockResolvedValueOnce(onboarded);
      const message = inboundMessage(GROUP, { topic: '9' });

      await adapter.deliver(message);

      expect(turns.handle).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          id: onboarded.id,
          note: expect.objectContaining({ name: 'groceries' }),
        }),
        message,
        expect.any(Number),
        [],
      );
    });

    it('drops a message when onboarding returns a Channel whose note is disabled', async () => {
      const onboarded = await channel(`${GROUP.key}:8`, 'groceries');
      await ws.editChannel('Groceries', { enabled: false });
      onboarding.onUnknownChannel.mockResolvedValueOnce(onboarded);

      await adapter.deliver(inboundMessage(GROUP, { topic: '9' }));

      expect(turns.handle).not.toHaveBeenCalled();
      expect(await messageCount()).toBe(0);
    });

    it('records nothing when onboarding sets up no Channel', async () => {
      await adapter.deliver(inboundMessage(GROUP, { topic: '9' }));

      expect(await messageCount()).toBe(0);
      expect(await ds.getRepository(InboundUpdate).find()).toEqual([
        expect.objectContaining({ status: 'processed' }),
      ]);
    });

    it('passes a duplicate update on only once', async () => {
      await channel(OWNER.key, 'default');
      const message = inboundMessage(OWNER, { updateId: '100' });

      await adapter.deliver(message);
      await adapter.deliver({ ...message });
      await adapter.deliver(inboundMessage(GROUP, { updateId: '100' }));

      // The third shares the update ID, so it is a redelivery too.
      expect(turns.handle).toHaveBeenCalledOnce();
      expect(await messageCount()).toBe(1);
      expect(onboarding.onUnknownChannel).not.toHaveBeenCalled();
      expect(await ds.getRepository(InboundUpdate).find()).toEqual([
        expect.objectContaining({
          externalUpdateId: '100',
          status: 'processed',
        }),
      ]);
    });

    it('drops messages for a disabled note', async () => {
      await channel(`${GROUP.key}:7`, 'groceries');
      await channel(GROUP.key, 'default');
      await ws.editChannel('Groceries', { enabled: false });
      await ws.editChannel('Default', { enabled: false });

      await adapter.deliver(inboundMessage(GROUP, { topic: '7' }));
      await adapter.deliver(inboundMessage(GROUP));

      expect(reachedNextStage()).toBe(false);
      expect(await messageCount()).toBe(0);
    });

    it("learns a topic's title from a message, and keeps one it knows", async () => {
      const topic = await channel(`${GROUP.key}:7`, 'groceries', null);
      const primary = await channel(GROUP.key, 'default');
      const titleOf = async (id: number) =>
        (await ds.getRepository(Channel).findOneByOrFail({ id })).title;

      // A reply carries no title.
      await adapter.deliver(inboundMessage(GROUP, { topic: '7', title: null }));
      expect(await titleOf(topic.id)).toBeNull();
      await adapter.deliver(
        inboundMessage(GROUP, { topic: '7', title: 'Groceries' }),
      );
      expect(await titleOf(topic.id)).toBe('Groceries');
      // Messages carry the title a topic was created with; only a rename
      // changes a known one.
      await adapter.deliver(
        inboundMessage(GROUP, { topic: '7', title: 'Old' }),
      );
      expect(await titleOf(topic.id)).toBe('Groceries');

      await adapter.deliver(inboundMessage({ ...GROUP, title: 'Home' }));
      expect(await titleOf(primary.id)).toBe('Home');
    });

    it("records a message in its Channel's history as it hands it on", async () => {
      const topic = await channel(`${GROUP.key}:7`, 'groceries');
      const message = inboundMessage(GROUP, { topic: '7', text: 'Milk' });

      await adapter.deliver(message);

      const recorded = await ds.getRepository(Message).find();
      expect(recorded).toEqual([
        expect.objectContaining({
          channelId: topic.id,
          agentName: 'groceries',
          sessionId: null,
          direction: 'in',
          origin: 'user',
          externalMessageId: message.messageId,
          senderId: message.senderId,
          text: 'Milk',
        }),
      ]);
      expect(turns.handle).toHaveBeenCalledWith(
        expect.anything(),
        message,
        recorded[0]!.id,
        [],
      );
    });

    it('saves the images a message came with and names them in its text', async () => {
      const topic = await channel(`${GROUP.key}:7`, 'groceries');
      adapter.files.set('photo-1', new Uint8Array([1, 2, 3]));
      adapter.files.set('photo-2', new Uint8Array([4, 5]));
      const message = inboundMessage(GROUP, {
        topic: '7',
        text: 'Which is cheaper?',
        attachments: [
          { ref: 'photo-1', type: 'image/jpeg', name: null, size: 3 },
          { ref: 'photo-2', type: 'image/png', name: 'b.png', size: null },
        ],
      });

      await adapter.deliver(message);

      const folder = join(ws.stateFolder, 'attachments', String(topic.id));
      const [, , , images] = turns.handle.mock.calls[0] as unknown as [
        unknown,
        unknown,
        unknown,
        string[],
      ];
      expect(images).toEqual([
        expect.stringMatching(
          new RegExp(`^${folder}/\\d{8}-\\d{6}-${message.messageId}-1\\.jpg$`),
        ),
        expect.stringMatching(new RegExp(`-${message.messageId}-2\\.png$`)),
      ]);
      expect([...readFileSync(images[0]!)]).toEqual([1, 2, 3]);
      expect([...readFileSync(images[1]!)]).toEqual([4, 5]);
      expect(statSync(images[0]!).mode & 0o777).toBe(0o600);
      const text =
        `[Image attached, saved at ${images[0]}]\n` +
        `[Image attached, saved at ${images[1]}]\n` +
        'Which is cheaper?';
      const recorded = await ds.getRepository(Message).find();
      expect(recorded).toEqual([expect.objectContaining({ text })]);
      expect(turns.handle).toHaveBeenCalledWith(
        expect.anything(),
        { ...message, content: { ...message.content, text } },
        recorded[0]!.id,
        images,
      );
    });

    it('records an image sent without text by where it is saved', async () => {
      await channel(GROUP.key, 'default');
      adapter.files.set('photo', new Uint8Array([1]));

      await adapter.deliver(
        inboundMessage(GROUP, {
          text: '',
          attachments: [
            { ref: 'photo', type: 'image/jpeg', name: null, size: 1 },
          ],
        }),
      );

      const [recorded] = await ds.getRepository(Message).find();
      expect(recorded!.text).toMatch(/^\[Image attached, saved at \S+\.jpg\]$/);
    });

    it('records a voice message as its transcript, and hands no recording to the turn', async () => {
      await channel(GROUP.key, 'default');
      adapter.files.set('voice', new TextEncoder().encode('Buy milk.'));
      const message = inboundMessage(GROUP, {
        text: '',
        attachments: [
          {
            ref: 'voice',
            type: 'audio/ogg',
            name: null,
            size: 9,
            media: 'voice',
            durationS: 65,
          },
        ],
      });

      await adapter.deliver(message);

      const [recorded] = await ds.getRepository(Message).find();
      expect(recorded!.text).toMatch(
        /^\[Voice message, 1:05, saved at \S+\.ogg\. Transcript:\]\nBuy milk\.$/,
      );
      expect(turns.handle).toHaveBeenCalledWith(
        expect.anything(),
        { ...message, content: { ...message.content, text: recorded!.text } },
        recorded!.id,
        [],
      );
    });

    it('keeps commands responsive during transcription and /stop cancels that topic', async () => {
      await channel(GROUP.key, 'default');
      adapter.files.set('voice', new Uint8Array([1]));
      const transcribe = vi.spyOn(speech, 'transcribe').mockImplementation(
        (_file, signal) =>
          new Promise((_resolve, reject) => {
            signal!.addEventListener(
              'abort',
              () => reject(new Error('was stopped')),
              { once: true },
            );
          }),
      );
      const processing = adapter.deliver(
        inboundMessage(GROUP, {
          text: '',
          attachments: [
            {
              ref: 'voice',
              name: 'long.ogg',
              type: 'audio/ogg',
              size: 1,
              media: 'voice',
              durationS: 300,
            },
          ],
        }),
      );
      await vi.waitFor(() => expect(transcribe).toHaveBeenCalledOnce());
      const filesCommand = inboundMessage(GROUP, { text: '/files' });
      filesCommand.content.command = { name: 'files', args: '' };
      await adapter.deliver(filesCommand);
      expect(
        adapter.sent.some((sent) => sent.message.text.includes('512')),
      ).toBe(true);
      const stopCommand = inboundMessage(GROUP, { text: '/stop' });
      stopCommand.content.command = { name: 'stop', args: '' };
      await adapter.deliver(stopCommand);
      await processing;
      expect(turns.handle).not.toHaveBeenCalled();
    });

    it('answers the caption of a recording it could not transcribe, saying why', async () => {
      await channel(GROUP.key, 'default');
      speech.maxS = 60;
      adapter.files.set('talk', new Uint8Array([1]));
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      await adapter.deliver(
        inboundMessage(GROUP, {
          text: 'Summarize this',
          attachments: [
            {
              ref: 'talk',
              type: 'audio/mpeg',
              name: 'Talk.mp3',
              size: 1,
              media: 'audio',
              durationS: 3_600,
            },
          ],
        }),
      );

      expect(adapter.sent.map((sent) => sent.message.text)).toContain(
        "Pero couldn't transcribe the audio file you sent (it is longer " +
          'than 1:00). It answers the rest of your message without it.',
      );
      const inbound = await ds
        .getRepository(Message)
        .findOneByOrFail({ direction: 'in' });
      expect(inbound.text).toMatch(
        /^\[Audio file, Talk\.mp3, 60:00, saved at \S+-Talk\.mp3; not transcribed: it is longer than 1:00\]\nSummarize this$/,
      );
      expect(turns.handle).toHaveBeenCalledTimes(1);
    });

    it('says when an image could not be fetched, and runs no turn', async () => {
      await channel(GROUP.key, 'default');
      const message = inboundMessage(GROUP, {
        text: 'What is this?',
        attachments: [{ ref: 'gone', type: 'image/jpeg', name: null, size: 1 }],
      });
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      await adapter.deliver(message);
      await adapter.deliver(message);

      expect(turns.handle).not.toHaveBeenCalled();
      expect(adapter.sent.map((sent) => sent.message.text)).toEqual([
        "Pero couldn't get the image you sent (No file gone). Send it again.",
      ]);
      const recorded = await ds.getRepository(Message).find();
      expect(recorded).toEqual([
        expect.objectContaining({ origin: 'pero', direction: 'out' }),
      ]);
      expect(
        await ds.getRepository(InboundUpdate).findOneByOrFail({
          externalUpdateId: message.updateId,
        }),
      ).toMatchObject({ status: 'processed' });
    });

    it('saves other files under the names they were sent with and names them in its text', async () => {
      const topic = await channel(`${GROUP.key}:7`, 'groceries');
      adapter.files.set('pdf', new Uint8Array([1, 2]));
      adapter.files.set('csv', new Uint8Array([3]));
      adapter.files.set('blob', new Uint8Array([4]));
      adapter.files.set('scan', new Uint8Array([5]));
      const message = inboundMessage(GROUP, {
        topic: '7',
        text: 'Compare them',
        attachments: [
          {
            ref: 'pdf',
            type: 'application/pdf',
            name: 'Receipt May.pdf',
            size: 2,
          },
          { ref: 'csv', type: 'text/csv', name: '../../prices.csv', size: 1 },
          {
            ref: 'blob',
            type: 'application/octet-stream',
            name: null,
            size: 1,
          },
          { ref: 'scan', type: 'application/pdf', name: 'scan', size: 1 },
        ],
      });

      await adapter.deliver(message);

      const folder = join(ws.stateFolder, 'attachments', String(topic.id));
      const [, , , paths] = turns.handle.mock.calls[0] as unknown as [
        unknown,
        unknown,
        unknown,
        string[],
      ];
      expect(paths).toEqual([
        expect.stringMatching(
          new RegExp(
            `^${folder}/\\d{8}-\\d{6}-${message.messageId}-1-Receipt_May\\.pdf$`,
          ),
        ),
        expect.stringMatching(
          new RegExp(`^${folder}/\\S+-${message.messageId}-2-prices\\.csv$`),
        ),
        expect.stringMatching(
          new RegExp(`^${folder}/\\S+-${message.messageId}-3-file$`),
        ),
        expect.stringMatching(
          new RegExp(`^${folder}/\\S+-${message.messageId}-4-scan\\.pdf$`),
        ),
      ]);
      expect(paths.map((path) => [...readFileSync(path)])).toEqual([
        [1, 2],
        [3],
        [4],
        [5],
      ]);
      const [recorded] = await ds.getRepository(Message).find();
      expect(recorded!.text).toBe(
        `[File attached: Receipt May.pdf, saved at ${paths[0]}]\n` +
          `[File attached: ../../prices.csv, saved at ${paths[1]}]\n` +
          `[File attached, saved at ${paths[2]}]\n` +
          `[File attached: scan, saved at ${paths[3]}]\n` +
          'Compare them',
      );
    });

    it('says when files could not be fetched', async () => {
      await channel(GROUP.key, 'default');
      adapter.files.set('photo', new Uint8Array([1]));
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      await adapter.deliver(
        inboundMessage(GROUP, {
          attachments: [
            { ref: 'photo', type: 'image/jpeg', name: null, size: 1 },
            { ref: 'gone', type: 'application/pdf', name: 'a.pdf', size: 1 },
          ],
        }),
      );

      expect(turns.handle).not.toHaveBeenCalled();
      expect(adapter.sent.map((sent) => sent.message.text)).toEqual([
        "Pero couldn't get the files you sent (No file gone). Send them again.",
      ]);
    });

    it('forwards its events to onboarding, each once', async () => {
      const event = topicCreated(GROUP, '9', { updateId: '200' });

      await adapter.emit(event);
      await adapter.emit(event);
      await adapter.emit(membershipChanged(GROUP, 'administrator'));

      expect(onboarding.onEvent).toHaveBeenCalledTimes(2);
      expect(onboarding.onEvent).toHaveBeenNthCalledWith(1, event);
      expect(adapter.sent).toEqual([]);
    });

    it('remembers a new chat title without writing config.yaml', async () => {
      await allow(OWNER, null);
      const file = join(ws.stateFolder, 'config.yaml');
      const written = readFileSync(file, 'utf8');
      await adapter.deliver(inboundMessage(groupChat(GROUP.key, 'Home')));
      await adapter.deliver(inboundMessage(OWNER));

      const titles = await allowedChats.list('telegram');
      expect(titles.map((chat) => [chat.chatKey, chat.title])).toEqual([
        [GROUP.key, 'Home'],
        [OWNER.key, null],
      ]);
      expect(readFileSync(file, 'utf8')).toBe(written);
    });

    it('logs a failing stage and keeps routing', async () => {
      const error = vi
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      await channel(OWNER.key, 'default');
      turns.handle.mockRejectedValueOnce(new Error('Runtime exploded'));

      await expect(
        adapter.deliver(inboundMessage(OWNER, { text: 'secret plans' })),
      ).resolves.toBeUndefined();
      await adapter.deliver(inboundMessage(OWNER));

      expect(turns.handle).toHaveBeenCalledTimes(2);
      expect(error).toHaveBeenCalledOnce();
      expect(String(error.mock.calls[0]![0])).toContain('Runtime exploded');
      expect(String(error.mock.calls[0]![0])).not.toContain('secret plans');
    });
  });

  it('stops intake on shutdown, then drains the turns', async () => {
    expect(adapter.running).toBe(true);
    let runningAtDrain: boolean | null = null;
    turns.drain.mockImplementationOnce(() => {
      runningAtDrain = adapter.running;
      return Promise.resolve();
    });

    await moduleRef.close();

    expect(adapter.running).toBe(false);
    expect(runningAtDrain).toBe(false);
    // afterEach closes it again; a closed module ignores that.
  });

  it('refuses a second adapter of the same kind', async () => {
    await expect(router.connect(new FakeChannelAdapter())).rejects.toThrow(
      /already connected/,
    );
  });
});
