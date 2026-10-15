import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { Chat, User } from 'grammy/types';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prompts } from '../src/cli/prompts.js';
import { runInteractiveSetup } from '../src/cli/setup/interactive-setup.js';
import { NotFoundError } from '../src/common/errors.js';
import { resolveBootstrapConfig } from '../src/config/bootstrap-config.js';
import { initWorkspace } from '../src/config/workspace-skeleton.js';
import {
  type ControlClient,
  createControlClient,
} from '../src/control/client.js';
import { type Daemon, startDaemon } from '../src/daemon/daemon.js';
import { Channel } from '../src/persistence/entities/channel.entity.js';
import { ChannelSender } from '../src/channels/channel-sender.js';
import { TelegramAdapter } from '../src/telegram/telegram-adapter.js';
import { SpeechService } from '../src/speech/speech.service.js';
import { Session } from '../src/persistence/entities/session.entity.js';
import {
  FakeBotApi,
  type UpdateBody,
} from '../src/telegram/testing/fake-bot-api.js';
import { readFile } from 'node:fs/promises';

const TOKEN = '123456789:AAEhBOweik6ad9r_QXMENQjcrGbqCr4K-bs';

const FORUM: Chat.SupergroupChat = {
  id: -1001234567890,
  type: 'supergroup',
  title: 'Household',
  is_forum: true,
};
const DIRECT: Chat.PrivateChat = {
  id: 1234,
  type: 'private',
  first_name: 'Ada',
};
const OWNER: User = { id: 1234, is_bot: false, first_name: 'Ada' };

describe('Telegram chats and pairing (e2e)', () => {
  let tmp: string;
  let workspace: string;
  let client: ControlClient;
  let daemon: Daemon | undefined;
  let api: FakeBotApi;
  let nextMessageId: number;

  beforeEach(async () => {
    api = new FakeBotApi();
    api.chats.set(String(FORUM.id), FORUM);
    await api.listen();
    // Short: macOS limits socket paths to 104 bytes.
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'pero-')));
    workspace = join(tmp, 'ws');
    initWorkspace(workspace, tmp);
    client = createControlClient(join(workspace, '.pero', 'run', 'pero.sock'));
    nextMessageId = 1;
  });

  it('delivers generated audio, images and documents to their topic over multipart HTTP', async () => {
    await start();
    writeFileSync(join(workspace, 'song.mp3'), 'audio-content');
    writeFileSync(join(workspace, 'design.png'), 'image-content');
    writeFileSync(join(workspace, 'report.pdf'), 'document-content');
    const target = { chatId: String(FORUM.id), messageThreadId: '42' };
    const sender = daemon!.app.get(ChannelSender);
    await sender.sendAnswer(
      'telegram',
      target,
      'Ready\n<file>song.mp3</file>\n<file>design.png</file>\n<file>report.pdf</file>',
    );
    for (const [method, field, expected] of [
      ['sendAudio', 'audio', 'audio-content'],
      ['sendPhoto', 'photo', 'image-content'],
      ['sendDocument', 'document', 'document-content'],
    ]) {
      const payload = api.callsOf(method!)[0]!.payload;
      expect(String(payload.message_thread_id)).toBe('42');
      expect(String(payload.chat_id)).toBe(String(FORUM.id));
      const file = payload[field!] as { bytes: Uint8Array };
      expect(Buffer.from(file.bytes).toString()).toBe(expected);
    }
    api.failNext('sendPhoto', {
      error_code: 400,
      description: 'Bad Request: IMAGE_PROCESS_FAILED',
    });
    await sender.sendAnswer('telegram', target, '<file>design.png</file>');
    expect(api.callsOf('sendDocument')).toHaveLength(2);
  });

  it('streams a ZIP larger than the cloud limit through a custom Bot API with actual-byte enforcement', async () => {
    await start();
    const bytes = new Uint8Array(22 * 1024 * 1024).fill(7);
    api.files.set('large-zip', bytes);
    const adapter = daemon!.app.get(TelegramAdapter);
    const file = join(tmp, 'archive.zip');
    expect(await adapter.downloadTo('large-zip', file, bytes.length)).toBe(
      bytes.length,
    );
    expect((await readFile(file)).length).toBe(bytes.length);
    await expect(
      adapter.downloadTo(
        'large-zip',
        join(tmp, 'too-large.zip'),
        bytes.length - 1,
      ),
    ).rejects.toThrow(/limit/);
  });

  afterEach(async () => {
    await daemon?.stop('test finished');
    daemon = undefined;
    await api.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  /** A daemon on the fake Bot API whose turns answer with an echo. */
  async function start(overrideApi = true) {
    daemon = await startDaemon({
      config: resolveBootstrapConfig({ workspace, env: {} }),
      foreground: false,
      env: {
        ...(overrideApi ? { PERO_TELEGRAM_API_ROOT: api.url } : {}),
        PERO_FAKE_RUNTIME: 'echo',
      },
    });
    await client.call('telegram.token', { token: TOKEN });
    await vi.waitFor(async () =>
      expect((await client.call('telegram.chats')).bot).toBe('pero_test_bot'),
    );
  }

  it('loads a custom endpoint at bootstrap and restricts absolute local Bot API paths', async () => {
    writeFileSync(
      join(workspace, '.pero/config.yaml'),
      `files:\n  telegram-api-root: ${api.url}\n  telegram-local-file-root: ${workspace}\n`,
    );
    await start(false);
    const inside = join(workspace, 'uploaded.zip');
    const outside = join(tmp, 'outside.zip');
    writeFileSync(inside, 'allowed');
    writeFileSync(outside, 'refused');
    api.files.set('inside', new Uint8Array(7));
    api.files.set('outside', new Uint8Array(7));
    api.filePaths.set('inside', inside);
    api.filePaths.set('outside', outside);
    const adapter = daemon!.app.get(TelegramAdapter);
    expect(
      await adapter.downloadTo('inside', join(tmp, 'saved.zip'), 100),
    ).toBe(7);
    await expect(
      adapter.downloadTo('outside', join(tmp, 'refused.zip'), 100),
    ).rejects.toThrow(/outside/);
  });

  it('continues polling for commands while a recording is processing and cancels it with /stop', async () => {
    await start();
    await client.call('telegram.allow', { chatId: String(FORUM.id) });
    api.push(message(FORUM, 'Initialize'));
    await sentTexts(2);
    const speech = daemon!.app.get(SpeechService);
    const transcribe = vi.spyOn(speech, 'transcribe').mockImplementation(
      (_file, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => reject(new Error('was stopped')),
            { once: true },
          );
        }),
    );
    api.files.set('long-audio', new Uint8Array([1]));
    api.push({
      message: {
        message_id: nextMessageId++,
        date: 0,
        chat: FORUM,
        from: OWNER,
        audio: {
          file_id: 'long-audio',
          file_unique_id: 'unique',
          duration: 300,
          file_size: 1,
          mime_type: 'audio/mpeg',
          file_name: 'long.mp3',
        },
      },
    });
    try {
      await vi.waitFor(() => expect(transcribe).toHaveBeenCalledOnce());
      api.push(command(FORUM, '/files'));
      await vi.waitFor(() =>
        expect(
          api.sent().some((p) => String(p.text).startsWith('File limit:')),
        ).toBe(true),
      );
      api.push(command(FORUM, '/stop'));
      await vi.waitFor(() =>
        expect(transcribe.mock.calls[0]![1]?.aborted).toBe(true),
      );
    } finally {
      await daemon!.stop('cancel recording');
      daemon = undefined;
      transcribe.mockRestore();
    }
  });

  /** The Channel notes, by file name. */
  function channelNotes(): string[] {
    return readdirSync(join(workspace, 'data', 'System', 'Channels')).sort();
  }

  function db(): DataSource {
    return daemon!.app.get<DataSource>(getDataSourceToken());
  }

  function message(chat: Chat, text: string): UpdateBody {
    return {
      message: {
        message_id: nextMessageId++,
        date: 0,
        chat,
        from: OWNER,
        text,
      } as never,
    };
  }

  /** A command, marked as Telegram marks one. */
  function command(chat: Chat, text: string): UpdateBody {
    const update = message(chat, text);
    const length = text.split(' ')[0]!.length;
    Object.assign(update.message as object, {
      entities: [{ type: 'bot_command', offset: 0, length }],
    });
    return update;
  }

  /** The texts Telegram has been asked to send, once there are `count`. */
  async function sentTexts(count: number): Promise<string[]> {
    await vi.waitFor(() => expect(api.sent()).toHaveLength(count));
    return api.sent().map((payload) => String(payload.text));
  }

  it('lists, allows, and denies chats, resuming a Channel allowed again', async () => {
    await start();

    api.push(message(FORUM, 'Anyone there?'));
    expect(await sentTexts(1)).toEqual([
      expect.stringContaining('pero telegram allow -1001234567890'),
    ]);
    expect(await client.call('telegram.chats')).toMatchObject({
      allowed: [],
      pairing: [
        { chatId: '-1001234567890', kind: 'group', title: 'Household' },
      ],
    });

    const allowed = await client.call('telegram.allow', {
      chatId: '-1001234567890',
    });
    expect(allowed).toMatchObject({
      alreadyAllowed: false,
      chat: { kind: 'group', title: 'Household', bot: 'administrator' },
    });
    expect(await client.call('telegram.chats')).toMatchObject({
      allowed: [{ chatId: '-1001234567890', topics: true }],
      pairing: [],
    });
    await vi.waitFor(async () =>
      expect(
        (await client.status()).components.find((c) => c.name === 'telegram'),
      ).toMatchObject({ state: 'ok', detail: 'Connected as @pero_test_bot' }),
    );

    // The General topic is answered from Default.md.
    api.push(message(FORUM, 'One'));
    expect((await sentTexts(3)).at(-1)).toBe('echo: One');
    const [session] = await db().getRepository(Session).find();

    await client.call('telegram.deny', { chatId: '-1001234567890' });
    await expect(
      client.call('telegram.deny', { chatId: '-1001234567890' }),
    ).rejects.toThrow(NotFoundError);
    const denied = api.push(message(FORUM, 'Two'));
    // Handled once the next poll confirms it: no reply, since the chat had
    // its pairing hint this hour, and nothing reached a turn.
    await vi.waitFor(() =>
      expect(
        api
          .callsOf('getUpdates')
          .some((call) => Number(call.payload.offset) > denied),
      ).toBe(true),
    );
    expect(api.sent()).toHaveLength(3);

    await client.call('telegram.allow', { chatId: '-1001234567890' });
    api.push(message(FORUM, 'Three'));
    expect((await sentTexts(4)).at(-1)).toBe('echo: Three');

    expect(await db().getRepository(Session).find()).toEqual([
      expect.objectContaining({
        id: session!.id,
        status: 'active',
        providerSessionId: session!.providerSessionId,
      }),
    ]);
    expect(await db().getRepository(Channel).count()).toBe(1);
    expect(channelNotes()).toEqual(['Default.md']);
  });

  it('creates topics through the control endpoint and the real CLI', async () => {
    api.chats.set(String(FORUM.id), FORUM);
    await start();
    await client.call('telegram.allow', { chatId: String(FORUM.id) });
    const topic = await client.call('telegram.topic', {
      chatId: String(FORUM.id),
      name: 'Projects',
    });
    expect(topic.title).toBe('Projects');
    expect(channelNotes()).toContain('Projects.md');
    const { stdout } = await promisify(execFile)(process.execPath, [
      join(import.meta.dirname, '../bin/pero.js'),
      'telegram',
      'topic',
      String(FORUM.id),
      'Задачи и планы',
      '--workspace',
      workspace,
    ]);
    expect(stdout).toContain('Created topic: Задачи и планы');
    expect(channelNotes()).toContain('Задачи и планы.md');
    expect(api.callsOf('createForumTopic')).toHaveLength(2);
    await expect(
      client.call('telegram.topic', { chatId: String(FORUM.id), name: ' ' }),
    ).rejects.toThrow('name');
    await client.call('telegram.deny', { chatId: String(FORUM.id) });
    await expect(
      client.call('telegram.topic', {
        chatId: String(FORUM.id),
        name: 'Denied',
      }),
    ).rejects.toThrow(NotFoundError);
    expect(api.callsOf('createForumTopic')).toHaveLength(2);
  });

  it('allows a chat that sends its first message during interactive setup', async () => {
    await start();
    const asked: string[] = [];
    const prompts: Prompts = {
      input: ({ message: text, signal }) => {
        asked.push(text);
        if (!text.startsWith('Waiting for a message')) {
          // Provider sign-in, which this test skips.
          return Promise.resolve('s');
        }
        api.push(message(DIRECT, 'Hello Pero'));
        return new Promise((_, reject) =>
          signal?.addEventListener('abort', () =>
            reject(
              Object.assign(new Error('aborted'), {
                name: 'AbortPromptError',
              }),
            ),
          ),
        );
      },
      password: () => Promise.reject(new Error('not asked')),
      confirm: ({ message: text }) => {
        asked.push(text);
        return Promise.resolve(true);
      },
      select: <T extends string>({ message: text }: { message: string }) => {
        asked.push(text);
        return Promise.resolve('direct' as T);
      },
    };

    await runInteractiveSetup(
      {
        client,
        prompts,
        print: () => undefined,
        pollIntervalMs: 20,
      },
      {
        status: await client.status(),
        settings: await client.call('settings.get'),
      },
    );

    // Provider sign-in comes first, if at all.
    expect(asked.filter((text) => !text.startsWith('Sign in'))).toEqual([
      'Where will you talk to Pero?',
      'Waiting for a message to @pero_test_bot (Enter to skip)',
      'Allow direct chat "Ada" (1234)?',
    ]);
    expect((await client.call('telegram.chats')).allowed).toEqual([
      expect.objectContaining({ chatId: '1234', kind: 'private' }),
    ]);
    // The chat was told, by Pero and not a turn, to confirm here, then
    // given the first steps once allowed.
    expect(api.sent()).toEqual([
      expect.objectContaining({
        chat_id: '1234',
        text: expect.stringContaining('confirm in the terminal'),
      }),
      expect.objectContaining({
        chat_id: '1234',
        text: expect.stringMatching(
          /^Pero answers in this chat with .+\n\nFirst steps:\n/,
        ),
      }),
    ]);

    api.push(message(DIRECT, 'Again'));
    await vi.waitFor(() =>
      expect(api.sent().at(-1)).toMatchObject({
        chat_id: '1234',
        text: 'echo: Again',
      }),
    );
    expect(api.sent()).toHaveLength(3);
  });

  it("answers Pero's commands itself, and /new starts the conversation over", async () => {
    await start();
    await vi.waitFor(() =>
      expect(api.callsOf('setMyCommands')[0]?.payload).toMatchObject({
        commands: expect.arrayContaining([
          expect.objectContaining({ command: 'new' }),
        ]),
      }),
    );
    await client.call('telegram.allow', { chatId: String(DIRECT.id) });

    // The first message gets the first steps, then the answer.
    api.push(message(DIRECT, 'One'));
    expect((await sentTexts(2)).at(-1)).toBe('echo: One');
    api.push(command(DIRECT, '/status'));
    expect((await sentTexts(3)).at(-1)).toMatch(
      /^Channel Ada\nState: idle · last answer .*\nConfig: data\/System\/Channels\/Default\.md\n/,
    );

    api.push(command(DIRECT, '/new'));
    expect((await sentTexts(4)).at(-1)).toBe(
      "Started over: Pero's next answer here begins a new conversation.",
    );
    // A fresh Session would carry the conversation over, but not past /new.
    api.push(message(DIRECT, 'Two'));
    expect((await sentTexts(5)).at(-1)).toBe('echo: Two');

    const sessions = await db()
      .getRepository(Session)
      .find({ order: { id: 'ASC' } });
    expect(sessions.map((session) => session.status)).toEqual([
      'closed',
      'active',
    ]);
    const history = await client.call('channels.history', {
      id: sessions[0]!.channelId,
      limit: 50,
    });
    // Commands and their answers stay out of the history.
    expect(history.messages.map((m) => m.text)).toEqual([
      expect.stringContaining('First steps'),
      'One',
      'echo: One',
      'Two',
      'echo: Two',
    ]);
  });

  it("changes the Channel's effort from a /effort button", async () => {
    await start();
    await client.call('telegram.allow', { chatId: String(DIRECT.id) });
    api.push(message(DIRECT, 'One'));
    await sentTexts(2);

    api.push(command(DIRECT, '/effort'));
    await sentTexts(3);
    expect(api.sent().at(-1)?.reply_markup).toMatchObject({
      inline_keyboard: expect.arrayContaining([
        [
          { text: 'low', callback_data: '/effort low' },
          { text: 'medium', callback_data: '/effort medium' },
          { text: 'high', callback_data: '/effort high' },
        ],
      ]),
    });
    api.push({
      callback_query: {
        id: 'query-1',
        from: OWNER,
        chat_instance: 'instance',
        data: '/effort low',
        message: { message_id: 77, date: 1, chat: DIRECT, text: 'Pick' },
      } as never,
    });

    await vi.waitFor(() =>
      expect(api.callsOf('editMessageText')[0]?.payload).toMatchObject({
        message_id: 77,
        text: expect.stringMatching(
          /^This Channel now uses effort low, from the next answer\.\nConfig: data\/System\/Channels\/Default\.md\n/,
        ),
      }),
    );
    expect(api.callsOf('answerCallbackQuery')[0]?.payload).toMatchObject({
      text: 'Effort set',
    });
    const [channel] = await db().getRepository(Channel).find();
    expect(
      await client.call('channels.get', { id: channel!.id }),
    ).toMatchObject({
      settings: { name: 'default', effort: 'low', origins: { effort: 'note' } },
    });
  });

  it('runs a Workflow picked from the /run menu', async () => {
    writeFileSync(
      join(workspace, 'data', 'System', 'Workflows', 'Daily brief.md'),
      'Sum up the day.\n',
    );
    await start();
    await client.call('telegram.allow', { chatId: String(DIRECT.id) });
    api.push(message(DIRECT, 'One'));
    await sentTexts(2);

    api.push(command(DIRECT, '/run'));
    expect((await sentTexts(3)).at(-1)).toMatch(
      /^Which Workflow should run now\?\n• Daily brief — by hand only$/,
    );
    api.push({
      callback_query: {
        id: 'query-2',
        from: OWNER,
        chat_instance: 'instance',
        data: '/run daily-brief',
        message: { message_id: 78, date: 1, chat: DIRECT, text: 'Which' },
      } as never,
    });

    await vi.waitFor(() =>
      expect(api.callsOf('editMessageText')[0]?.payload).toMatchObject({
        message_id: 78,
        text: 'Queued run #1 of Daily brief.\n— Ada',
      }),
    );
    await vi.waitFor(async () =>
      expect(await client.call('runs.list', { limit: 5 })).toMatchObject({
        runs: [{ id: 1, workflow: 'daily-brief', status: 'completed' }],
      }),
    );
  });
});
