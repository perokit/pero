import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { Bot, GrammyError, HttpError, InputFile } from 'grammy';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { responseChunks, saveStream } from '../common/file-transfer.js';
import { HostConfigService } from '../host-config/host-config.service.js';
import type { InlineKeyboardMarkup, Update, UserFromGetMe } from 'grammy/types';
import type { ChatKind } from '../persistence/entities/sql.js';
import {
  InvalidInputError,
  NotFoundError,
  parseInput,
} from '../common/errors.js';
import { topicNameSchema } from './topic-input.js';
import { AllowedChatsService } from '../channels/allowed-chats.service.js';
import {
  type ButtonRows,
  type ChannelAdapter,
  type ChannelAddress,
  type ChannelEvent,
  type ChannelHandlers,
  type CreatedTopic,
  type InboundMessage,
  MAX_BUTTON_ID_BYTES,
  type OutboundMessage,
  type OutboundVoice,
  type OutboundFile,
  type SentMessage,
} from '../channels/channel-adapter.js';
import { ChannelRouter } from '../channels/channel-router.js';
import { COMMANDS } from '../channels/commands/command-list.js';
import { MediaGroups } from './media-groups.js';
import { splitText } from './split-text.js';
import { markdownToTelegramHtml, splitMarkdown } from './telegram-markdown.js';
import {
  TELEGRAM_OPTIONS,
  TelegramCredentials,
  type TelegramOptions,
} from './telegram-credentials.service.js';
import { type ChatAccess, TelegramStatus } from './telegram-status.js';
import {
  describeChat,
  membershipStatus,
  parseAddress,
  toInbound,
} from './telegram-updates.js';

/** What Telegram says about a chat when asked by its ID. */
export interface ChatLookup {
  kind: ChatKind;
  title: string | null;
  /** Whether a group has topics; false for a direct chat. */
  topics: boolean;
  /** A group's public username, by which anyone can find and join it. */
  username: string | null;
}

/** The Bot API server Pero talks to unless told otherwise. */
export const DEFAULT_TELEGRAM_API_ROOT = 'https://api.telegram.org';

/**
 * The updates Pero asks for; forum topic service messages are messages, and
 * callback queries are presses of Pero's buttons.
 */
const ALLOWED_UPDATES = [
  'message',
  'my_chat_member',
  'callback_query',
] as const;

/** Calls whose failure means Telegram can't be reached. */
const CONNECTION_METHODS = new Set(['getMe', 'deleteWebhook', 'getUpdates']);

/**
 * The reaction on a message while Pero answers it; Telegram lets bots
 * react only with its standard emoji, and has no read status for them.
 */
const WORKING_REACTION = '👀';

/** How often a send waits out Telegram's flood limit before giving up. */
const MAX_FLOOD_RETRIES = 3;
const MAX_FLOOD_WAIT_S = 60;

/** Waits between attempts to start polling after a failure. */
const RESTART_DELAYS_MS = [1_000, 5_000, 15_000, 60_000, 300_000];

/** How long looking up a chat for the owner may take. */
const LOOKUP_TIMEOUT_MS = 3_000;

/** How long stopping may wait for Telegram to confirm the last update. */
const STOP_TIMEOUT_MS = 5_000;

/** How long downloading a file a message came with may take. */

interface Connection {
  bot: Bot;
  /** Ends the connection's attempts to start and its waits between them. */
  abort: AbortController;
  /** Settles once polling has ended for good. */
  running: Promise<void>;
}

/**
 * The Telegram Channel adapter: long polling through grammY, replies to
 * the chat and topic a Channel's address names, and the Telegram component
 * of `pero status`. It follows the bot token, restarting when it changes.
 */
@Injectable()
export class TelegramAdapter implements ChannelAdapter, OnApplicationBootstrap {
  readonly kind = 'telegram' as const;
  private readonly logger = new Logger('Telegram');
  private apiRoot: string;
  private readonly apiRootOverride: string | undefined;
  private handlers: ChannelHandlers | null = null;
  private connection: Connection | null = null;
  private unsubscribe: (() => void) | null = null;
  /** Connects and disconnects one at a time, in order. */
  private switching: Promise<void> = Promise.resolve();
  private readonly pendingMessages = new Set<Promise<void>>();
  /** Albums waiting for the rest of their parts. */
  private readonly albums = new MediaGroups((message) => this.handOn(message));

  constructor(
    @Inject(TELEGRAM_OPTIONS) options: TelegramOptions,
    private readonly credentials: TelegramCredentials,
    private readonly status: TelegramStatus,
    private readonly allowedChats: AllowedChatsService,
    private readonly router: ChannelRouter,
    private readonly hostConfig: HostConfigService,
  ) {
    this.apiRoot =
      options.apiRoot ??
      this.hostConfig.files().telegramApiRoot ??
      DEFAULT_TELEGRAM_API_ROOT;
    this.apiRootOverride = options.apiRoot;
  }

  /** Connected with or without a token, since a token may come later. */
  async onApplicationBootstrap(): Promise<void> {
    this.apiRoot =
      this.apiRootOverride ??
      this.hostConfig.files().telegramApiRoot ??
      DEFAULT_TELEGRAM_API_ROOT;
    await this.router.connect(this);
  }

  /** Begins polling in the background; readiness never waits on Telegram. */
  start(handlers: ChannelHandlers): Promise<void> {
    this.handlers = handlers;
    this.unsubscribe = this.credentials.onChange((token) =>
      this.switchTo(token),
    );
    this.switchTo(this.credentials.token());
    return Promise.resolve();
  }

  async stop(): Promise<void> {
    // An album that arrived in full is answered like any message before.
    await this.albums.flushAll();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.handlers = null;
    this.switchTo(null);
    await this.switching;
    await Promise.all(this.pendingMessages);
  }

  /**
   * Sends `message`, split into as many messages as Telegram needs, and
   * returns the first one's ID. Buttons go under the last part. Markdown
   * is shown as Telegram's formatting.
   */
  async send(
    address: ChannelAddress,
    message: OutboundMessage,
  ): Promise<SentMessage> {
    const bot = this.connection?.bot;
    if (!bot) throw new Error('Telegram bot token is not set');
    const target = parseAddress(address);
    const thread =
      target.messageThreadId === undefined
        ? {}
        : { message_thread_id: Number(target.messageThreadId) };
    const parts = message.markdown
      ? splitMarkdown(message.text)
      : splitText(message.text);
    let chatId = target.chatId;
    let first: string | null = null;
    try {
      for (const [index, part] of parts.entries()) {
        const options =
          index === parts.length - 1 && message.buttons?.length
            ? { ...thread, reply_markup: keyboard(message.buttons) }
            : thread;
        const sent = await this.formatted(
          part,
          message.markdown,
          (text, format) =>
            this.withRetries(chatId, (id) => {
              chatId = id;
              return bot.api.sendMessage(id, text, { ...options, ...format });
            }),
        );
        first ??= String(sent.message_id);
      }
    } catch (error) {
      // grammY's own message names only the method; say what went wrong.
      if (error instanceof HttpError) {
        throw new Error(`Telegram is unreachable: ${this.describe(error)}`);
      }
      throw error;
    }
    return { messageId: first! };
  }

  /**
   * Sends `voice` as a voice message; as an audio file to a person who
   * doesn't take voice messages from bots, a Telegram privacy setting.
   */
  async sendVoice(
    address: ChannelAddress,
    voice: OutboundVoice,
  ): Promise<SentMessage> {
    const bot = this.connection?.bot;
    if (!bot) throw new Error('Telegram bot token is not set');
    const target = parseAddress(address);
    const options = {
      ...(target.messageThreadId === undefined
        ? {}
        : { message_thread_id: Number(target.messageThreadId) }),
      ...(voice.durationS === null ? {} : { duration: voice.durationS }),
    };
    const file = () =>
      new InputFile(
        voice.audio,
        voice.type === 'audio/mpeg' ? 'voice.mp3' : 'voice.ogg',
      );
    try {
      try {
        const sent = await this.withRetries(target.chatId, (id) =>
          bot.api.sendVoice(id, file(), options),
        );
        return { messageId: String(sent.message_id) };
      } catch (error) {
        if (
          !(error instanceof GrammyError) ||
          !error.description.includes('VOICE_MESSAGES_FORBIDDEN')
        ) {
          throw error;
        }
        const sent = await this.withRetries(target.chatId, (id) =>
          bot.api.sendAudio(id, file(), { ...options, title: 'Pero' }),
        );
        return { messageId: String(sent.message_id) };
      }
    } catch (error) {
      if (error instanceof HttpError) {
        throw new Error(`Telegram is unreachable: ${this.describe(error)}`);
      }
      throw error;
    }
  }

  chatKey(address: ChannelAddress): string {
    return parseAddress(address).chatId;
  }

  async sendFile(
    address: ChannelAddress,
    file: OutboundFile,
  ): Promise<SentMessage> {
    const bot = this.connection?.bot;
    if (!bot) throw new Error('Telegram bot token is not set');
    const limit =
      this.apiRoot === DEFAULT_TELEGRAM_API_ROOT
        ? 50 * 1024 * 1024
        : 2000 * 1024 * 1024;
    if (
      file.size > Math.min(limit, this.hostConfig.files().maxMb * 1024 * 1024)
    ) {
      throw new Error(
        'Result exceeds the upload limit; use a local Bot API for files over 50 MiB, or produce smaller parts',
      );
    }
    const target = parseAddress(address);
    const options = {
      caption: file.caption.slice(0, 900),
      ...(target.messageThreadId === undefined
        ? {}
        : { message_thread_id: Number(target.messageThreadId) }),
    };
    const input = () => new InputFile(file.source(), file.name);
    const send = (kind: OutboundFile['kind']) =>
      this.withRetries<{ message_id: number }>(target.chatId, (id) => {
        switch (kind) {
          case 'photo':
            return bot.api.sendPhoto(id, input(), options);
          case 'audio':
            return bot.api.sendAudio(id, input(), options);
          case 'voice':
            return bot.api.sendVoice(id, input(), options);
          case 'video':
            return bot.api.sendVideo(id, input(), options);
          default:
            return bot.api.sendDocument(id, input(), options);
        }
      });
    const kind =
      file.kind === 'photo' && file.size > 10 * 1024 * 1024
        ? 'document'
        : file.kind;
    try {
      return { messageId: String((await send(kind)).message_id) };
    } catch (error) {
      // Only explicit media rejection is safe to fall back; a network timeout is ambiguous.
      if (
        kind !== 'document' &&
        error instanceof GrammyError &&
        error.error_code === 400 &&
        /PHOTO_INVALID|IMAGE_PROCESS_FAILED|wrong (?:file|type)|VOICE_MESSAGES_FORBIDDEN|VIDEO_CONTENT_TYPE_INVALID/i.test(
          error.description,
        )
      ) {
        return { messageId: String((await send('document')).message_id) };
      }
      throw new Error(this.describe(error));
    }
  }

  /** Downloads a file a message came with; `ref` is its Telegram file ID. */
  async download(ref: string): Promise<Uint8Array> {
    const folder = await mkdtemp(join(tmpdir(), 'pero-download-'));
    const path = join(folder, 'file');
    try {
      await this.downloadTo(
        ref,
        path,
        this.hostConfig.files().maxMb * 1024 * 1024,
      );
      return new Uint8Array(await readFile(path));
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  }

  async downloadTo(
    ref: string,
    path: string,
    maxBytes: number,
    stopped?: AbortSignal,
  ): Promise<number> {
    const bot = this.connection?.bot;
    if (!bot) throw new Error('Telegram bot token is not set');
    try {
      const timeoutMs = this.hostConfig.files().downloadTimeoutSeconds * 1000;
      const signal = AbortSignal.any([
        AbortSignal.timeout(timeoutMs),
        ...(stopped === undefined ? [] : [stopped]),
      ]);
      const file = await bot.api.getFile(
        ref,
        signal as Parameters<Bot['api']['getFile']>[1],
      );
      if (file.file_path === undefined) {
        throw new Error('Telegram has no file to download');
      }
      if ((file.file_size ?? 0) > maxBytes)
        throw new Error('File exceeds the configured download limit');
      if (isAbsolute(file.file_path)) {
        const configured = this.hostConfig.files().telegramLocalFileRoot;
        if (configured === null || this.apiRoot === DEFAULT_TELEGRAM_API_ROOT)
          throw new Error(
            'Local Bot API file paths require files.telegram-local-file-root',
          );
        const root = await realpath(resolve(configured));
        const source = await realpath(file.file_path);
        const within = relative(root, source);
        if (within.startsWith('..') || isAbsolute(within))
          throw new Error('Local Bot API file is outside the configured root');
        return await saveStream(
          path,
          createReadStream(source, { signal }),
          maxBytes,
        );
      }
      if (
        file.file_path.split('/').some((part) => part === '..') ||
        file.file_path.includes('\\')
      )
        throw new Error('Invalid Telegram file path');
      const response = await fetch(
        `${this.apiRoot}/file/bot${bot.token}/${file.file_path}`,
        { signal, redirect: 'error' },
      );
      if (!response.ok) {
        throw new Error(`Telegram answered ${response.status}`);
      }
      if (Number(response.headers.get('content-length') ?? 0) > maxBytes) {
        await response.body?.cancel();
        throw new Error('File exceeds the configured download limit');
      }
      return await saveStream(path, responseChunks(response), maxBytes);
    } catch (error) {
      // Never with the bot token, which the file's URL holds.
      throw new Error(
        error instanceof GrammyError &&
          /file is too big/i.test(error.description)
          ? 'Telegram cloud downloads are limited to 20 MiB; configure a local Bot API for larger files'
          : error instanceof GrammyError
            ? error.description
            : this.describe(error),
      );
    }
  }

  async edit(
    address: ChannelAddress,
    messageId: string,
    message: OutboundMessage,
  ): Promise<void> {
    const bot = this.connection?.bot;
    if (!bot) throw new Error('Telegram bot token is not set');
    const { chatId } = parseAddress(address);
    try {
      await this.formatted(message.text, message.markdown, (text, format) =>
        this.withRetries(chatId, (id) =>
          bot.api.editMessageText(id, Number(messageId), text, {
            ...format,
            reply_markup: keyboard(message.buttons ?? []),
          }),
        ),
      );
    } catch (error) {
      // Editing a message into what it already says is no failure.
      if (
        error instanceof GrammyError &&
        error.description.includes('message is not modified')
      ) {
        return;
      }
      throw error;
    }
  }

  /**
   * Reacts to message `messageId` with `WORKING_REACTION`, or removes the
   * reaction. Not retried: a mark that comes late is no use.
   */
  async showWorking(
    address: ChannelAddress,
    messageId: string,
    working: boolean,
  ): Promise<void> {
    const bot = this.connection?.bot;
    if (!bot) throw new Error('Telegram bot token is not set');
    const { chatId } = parseAddress(address);
    await bot.api.setMessageReaction(
      chatId,
      Number(messageId),
      working ? [{ type: 'emoji', emoji: WORKING_REACTION }] : [],
    );
  }

  /**
   * Checks whether the bot can see every message in allowed group
   * `chatKey`, and whether it has topics, and reports it when the bot
   * cannot see everything. Records the group's name when it has none yet.
   */
  async checkChat(chatKey: string): Promise<void> {
    const bot = this.connection?.bot;
    if (!bot?.isInited()) return;
    const chat = await this.allowedChats.find('telegram', chatKey);
    if (chat === null || chat.kind !== 'group') {
      this.status.forgetAccess(chatKey);
      return;
    }
    let status: ChatAccess['status'];
    let reason: string | null = null;
    try {
      const member = await bot.api.getChatMember(chatKey, bot.botInfo.id);
      status = membershipStatus(member);
    } catch (error) {
      status = 'unknown';
      reason = this.describe(error);
    }
    const found = await this.lookUpChat(chatKey);
    const title = chat.title ?? found?.title ?? null;
    if (chat.title === null) {
      await this.allowedChats.refreshTitle(chat, found?.title ?? null);
    }
    if (this.connection?.bot !== bot) return;
    this.status.setAccess(
      access(
        chatKey,
        title,
        status,
        found?.topics ?? null,
        found?.username ?? null,
        bot.botInfo,
        reason,
      ),
    );
  }

  /**
   * What Telegram says about chat `chatKey`; null while disconnected, when
   * the bot cannot see the chat, or when Telegram does not answer quickly.
   */
  async lookUpChat(chatKey: string): Promise<ChatLookup | null> {
    const bot = this.connection?.bot;
    if (!bot?.isInited()) return null;
    try {
      const chat = await bot.api.getChat(
        chatKey,
        // grammY types the signal as its polyfill's, which Node's satisfies.
        AbortSignal.timeout(LOOKUP_TIMEOUT_MS) as Parameters<
          Bot['api']['getChat']
        >[1],
      );
      const described = describeChat(chat);
      return (
        described && {
          ...described,
          topics: chat.is_forum === true,
          username: described.kind === 'group' ? (chat.username ?? null) : null,
        }
      );
    } catch (error) {
      this.logger.debug(
        `Failed to look up Telegram chat ${chatKey}: ${this.describe(error)}`,
      );
      return null;
    }
  }

  /** Creates a topic once; a transport failure is not safe to retry. */
  async createTopic(
    address: ChannelAddress,
    input: string,
  ): Promise<CreatedTopic> {
    const name = parseInput(topicNameSchema, input);
    const { chatId } = parseAddress(address);
    const allowed = await this.allowedChats.find('telegram', chatId);
    if (allowed === null)
      throw new NotFoundError(`Telegram chat ${chatId} is not allowed`);
    if (allowed.kind !== 'group') {
      throw new InvalidInputError(
        'Topics can only be created in a Telegram forum group',
      );
    }
    const bot = this.connection?.bot;
    if (!bot?.isInited() || this.handlers === null) {
      throw new InvalidInputError(
        'Telegram is not connected; try again when the bot is ready',
      );
    }
    let chat;
    let member;
    try {
      chat = await bot.api.getChat(
        chatId,
        AbortSignal.timeout(LOOKUP_TIMEOUT_MS) as Parameters<
          Bot['api']['getChat']
        >[1],
      );
      member = await bot.api.getChatMember(
        chatId,
        bot.botInfo.id,
        AbortSignal.timeout(LOOKUP_TIMEOUT_MS) as Parameters<
          Bot['api']['getChatMember']
        >[2],
      );
    } catch (error) {
      throw new InvalidInputError(
        `Could not check the group: ${this.describe(error)}`,
      );
    }
    if (chat.type !== 'supergroup' || chat.is_forum !== true) {
      throw new InvalidInputError(
        'Turn on Topics in this Telegram group first',
      );
    }
    if (
      member.status !== 'administrator' ||
      member.can_manage_topics !== true
    ) {
      throw new InvalidInputError(
        'Give the bot administrator access with Manage Topics permission',
      );
    }
    // Recheck after network calls: the owner may have denied the chat meanwhile.
    if (!(await this.allowedChats.find('telegram', chatId))) {
      throw new NotFoundError(`Telegram chat ${chatId} is not allowed`);
    }
    if (this.connection?.bot !== bot) {
      throw new InvalidInputError('Telegram connection changed; try again');
    }
    let topic;
    try {
      topic = await bot.api.createForumTopic(
        chatId,
        name,
        {},
        AbortSignal.timeout(30_000) as Parameters<
          Bot['api']['createForumTopic']
        >[3],
      );
    } catch (error) {
      const detail = this.describe(error);
      throw new InvalidInputError(
        `Could not confirm topic creation: ${detail}. Check the group's topics before retrying.`,
      );
    }
    const topicId = String(topic.message_thread_id);
    await this.handlers?.onEvent({
      type: 'topic-created',
      integrationKind: 'telegram',
      updateId: `${bot.botInfo.id}:created-topic:${chatId}:${topicId}`,
      chat: {
        key: chatId,
        kind: 'group',
        title: chat.title,
        address: { chatId },
      },
      channel: {
        key: `${chatId}:${topicId}`,
        title: topic.name,
        address: { chatId, messageThreadId: topicId },
        topicId,
      },
    });
    return {
      topicId,
      title: topic.name,
      url: /^-100\d+$/.test(chatId)
        ? `https://t.me/c/${chatId.slice(4)}/${topicId}`
        : null,
    };
  }

  /** Replaces the connection with one for `token`, or none when null. */
  private switchTo(token: string | null): void {
    this.switching = this.switching.then(async () => {
      await this.disconnect();
      if (token !== null && this.handlers !== null) this.connect(token);
      else this.status.setConnection(null);
    });
  }

  private connect(token: string): void {
    const bot = new Bot(token, {
      client: {
        apiRoot: this.apiRoot,
        timeoutSeconds: this.hostConfig.files().uploadTimeoutSeconds,
      },
    });
    const abort = new AbortController();
    bot.api.config.use(async (prev, method, payload, signal) => {
      try {
        const result = await prev(method, payload, signal);
        if (CONNECTION_METHODS.has(method)) {
          if (result.ok) this.reachable(bot);
          else if (result.error_code >= 500) {
            this.unreachable(abort, `Telegram answered ${result.error_code}`);
          }
        }
        return result;
      } catch (error) {
        if (CONNECTION_METHODS.has(method) && error instanceof HttpError) {
          this.unreachable(abort, this.describe(error));
        }
        throw error;
      }
    });
    bot.use((ctx) => this.dispatch(bot, ctx.update, ctx.me));
    bot.catch((error) => {
      this.logger.error(
        `Failed to handle Telegram update ${error.ctx.update.update_id}: ` +
          this.describe(error.error),
      );
    });
    this.status.setConnection({ state: 'connecting' });
    const running = this.run(bot, abort.signal);
    this.connection = { bot, abort, running };
  }

  private async disconnect(): Promise<void> {
    const connection = this.connection;
    if (connection === null) return;
    this.connection = null;
    connection.abort.abort();
    try {
      await Promise.race([
        connection.bot.stop(),
        new Promise((resolve) => setTimeout(resolve, STOP_TIMEOUT_MS).unref()),
      ]);
    } catch (error) {
      // Only the last update's confirmation is lost; it comes again, and
      // deduplication drops it.
      this.logger.warn(
        `Failed to stop polling cleanly: ${this.describe(error)}`,
      );
    }
    await connection.running;
  }

  /** Polls until stopped, starting again after failures that may pass. */
  private async run(bot: Bot, signal: AbortSignal): Promise<void> {
    for (let attempt = 0; !signal.aborted; attempt++) {
      try {
        // Retries network failures itself; an abort ends it. grammY types
        // the signal as its polyfill's, which Node's own satisfies.
        await bot.init(signal as Parameters<Bot['init']>[0]);
        await bot.start({
          allowed_updates: ALLOWED_UPDATES,
          drop_pending_updates: false,
          onStart: (me) => this.onStart(bot, me),
        });
        return;
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof GrammyError && error.error_code === 401) {
          this.logger.warn('Telegram rejected the bot token');
          this.status.setConnection({ state: 'rejected' });
          return;
        }
        if (error instanceof GrammyError && error.error_code === 409) {
          this.status.setConnection({ state: 'conflict' });
        } else {
          this.unreachable(null, this.describe(error));
        }
        const wait =
          RESTART_DELAYS_MS[Math.min(attempt, RESTART_DELAYS_MS.length - 1)]!;
        this.logger.warn(
          `Telegram polling stopped (${this.describe(error)}); ` +
            `starting again in ${wait / 1000} s`,
        );
        await delay(wait, signal);
      }
    }
  }

  private onStart(bot: Bot, me: UserFromGetMe): void {
    this.logger.log(`Connected to Telegram as @${me.username}`);
    this.status.setConnection({ state: 'connected', username: me.username });
    void this.listCommands(bot);
    void this.checkChats(bot);
  }

  /**
   * Shows Pero's commands in Telegram's command menu, in every chat; a
   * failure is only logged, since typed commands work without it.
   */
  private async listCommands(bot: Bot): Promise<void> {
    try {
      await bot.api.setMyCommands(
        COMMANDS.map(({ name, description }) => ({
          command: name,
          description,
        })),
      );
    } catch (error) {
      this.logger.warn(
        `Failed to list Pero's commands in Telegram's menu: ${this.describe(error)}`,
      );
    }
  }

  /** Checks every allowed group; failures are only logged. */
  private async checkChats(bot: Bot): Promise<void> {
    try {
      const chats = await this.allowedChats.list('telegram');
      this.status.setAllowedChats(chats.length);
      for (const chat of chats) {
        if (this.connection?.bot !== bot) return;
        if (chat.kind === 'group') await this.checkChat(chat.chatKey);
      }
    } catch (error) {
      this.logger.warn(
        `Failed to check allowed chats: ${this.describe(error)}`,
      );
    }
  }

  /** Hands one update to the router; the router never throws. */
  private async dispatch(
    bot: Bot,
    update: Update,
    me: UserFromGetMe,
  ): Promise<void> {
    const handlers = this.handlers;
    const inbound = toInbound(update, me);
    if (handlers === null || inbound === null) return;
    if ('actionId' in inbound) {
      const { notice } = await handlers.onAction(inbound);
      await this.answerPress(bot, update.callback_query!.id, notice);
      return;
    }
    if (!('type' in inbound)) {
      const album = update.message?.media_group_id;
      if (album === undefined) {
        const task = handlers
          .onMessage(inbound)
          .catch((error: unknown) =>
            this.logger.warn(
              `Message processing failed: ${this.describe(error)}`,
            ),
          );
        this.pendingMessages.add(task);
        void task.finally(() => this.pendingMessages.delete(task));
      } else this.albums.add(album, inbound);
      return;
    }
    await handlers.onEvent(inbound);
    await this.follow(bot, inbound, me);
  }

  /** Hands a joined album to the router, if intake hasn't ended. */
  private async handOn(message: InboundMessage): Promise<void> {
    try {
      await this.handlers?.onMessage(message);
    } catch (error) {
      this.logger.error(
        `Failed to handle Telegram update ${message.updateId}: ` +
          this.describe(error),
      );
    }
  }

  /**
   * Stops Telegram's progress indicator on a pressed button, showing the
   * presser `notice` when there is one. Failures are only logged: a press
   * Telegram has given up on cannot be answered.
   */
  private async answerPress(
    bot: Bot,
    queryId: string,
    notice: string | null,
  ): Promise<void> {
    try {
      await bot.api.answerCallbackQuery(
        queryId,
        notice === null ? {} : { text: notice },
      );
    } catch (error) {
      this.logger.debug(
        `Failed to answer a Telegram button press: ${this.describe(error)}`,
      );
    }
  }

  /** Keeps the administrator check current as the bot's chats change. */
  private async follow(
    bot: Bot,
    event: ChannelEvent,
    me: UserFromGetMe,
  ): Promise<void> {
    if (event.type === 'chat-migrated') {
      this.status.forgetAccess(event.chat.key);
      await this.checkChat(event.newChatKey);
      return;
    }
    // Topics can be turned on in a supergroup without a new chat ID.
    if (event.type === 'topic-created') {
      this.status.markTopics(event.chat.key);
      return;
    }
    if (event.type !== 'membership-changed' || event.chat.kind !== 'group') {
      return;
    }
    const chat = await this.allowedChats.find('telegram', event.chat.key);
    if (chat === null || this.connection?.bot !== bot) return;
    const known = this.status
      .access()
      .find((candidate) => candidate.chatKey === chat.chatKey);
    this.status.setAccess(
      access(
        chat.chatKey,
        event.chat.title ?? chat.title,
        event.status,
        known?.topics ?? null,
        known?.username ?? null,
        me,
        null,
      ),
    );
  }

  /**
   * Runs `send` with `text`, Markdown as Telegram HTML. Should Telegram
   * reject the HTML, sends the Markdown as it is written: the answer
   * matters more than its formatting.
   */
  private async formatted<T>(
    text: string,
    markdown: boolean | undefined,
    send: (text: string, format: { parse_mode?: 'HTML' }) => Promise<T>,
  ): Promise<T> {
    if (!markdown) return send(text, {});
    try {
      return await send(markdownToTelegramHtml(text), { parse_mode: 'HTML' });
    } catch (error) {
      if (
        !(error instanceof GrammyError) ||
        !/can't parse entities/i.test(error.description)
      ) {
        throw error;
      }
      this.logger.warn(
        `Telegram rejected an answer's formatting, so it is sent as written: ${error.description}`,
      );
      return send(text, {});
    }
  }

  /**
   * Runs `send` for `chatId`, waiting out Telegram's flood limit a few
   * times, and following a group that has moved to a new chat ID once.
   */
  private async withRetries<T>(
    chatId: string,
    send: (chatId: string) => Promise<T>,
  ): Promise<T> {
    let floodRetries = 0;
    let followed = false;
    for (;;) {
      try {
        return await send(chatId);
      } catch (error) {
        if (!(error instanceof GrammyError)) throw error;
        const { retry_after: retryAfter, migrate_to_chat_id: movedTo } =
          error.parameters;
        if (
          error.error_code === 429 &&
          retryAfter !== undefined &&
          floodRetries < MAX_FLOOD_RETRIES
        ) {
          floodRetries++;
          await delay(Math.min(retryAfter, MAX_FLOOD_WAIT_S) * 1000);
          continue;
        }
        if (movedTo !== undefined && !followed) {
          followed = true;
          chatId = String(movedTo);
          continue;
        }
        throw error;
      }
    }
  }

  /** A successful call: back to connected if Telegram was unreachable. */
  private reachable(bot: Bot): void {
    if (this.connection?.bot !== bot) return;
    if (this.status.current()?.state === 'unreachable' && bot.isInited()) {
      this.status.setConnection({
        state: 'connected',
        username: bot.botInfo.username,
      });
    }
  }

  /** A failed call; ignored once the connection is being closed. */
  private unreachable(abort: AbortController | null, reason: string): void {
    if (abort?.signal.aborted) return;
    this.status.setConnection({ state: 'unreachable', reason });
  }

  /** An error's message, never with the bot token in it. */
  private describe(error: unknown): string {
    // A network failure's own error says what went wrong, deepest first.
    let inner: unknown = error instanceof HttpError ? error.error : error;
    while (inner instanceof Error && inner.cause instanceof Error) {
      inner = inner.cause;
    }
    const cause = inner instanceof Error ? inner.message : String(inner);
    const token = this.credentials.token();
    return token ? cause.replaceAll(token, '<token>') : cause;
  }
}

/**
 * The bot's standing in a group, with what to do when it can't see all,
 * and the danger of a group anyone can join.
 */
function access(
  chatKey: string,
  title: string | null,
  status: ChatAccess['status'],
  topics: boolean | null,
  username: string | null,
  me: UserFromGetMe,
  reason: string | null,
): ChatAccess {
  const name = title === null ? chatKey : `${title} (${chatKey})`;
  let problem: string | null = null;
  if (status === 'member' && !me.can_read_all_group_messages) {
    problem =
      `the bot isn't an administrator of ${name}, so Telegram shows it only ` +
      `commands, mentions, and replies: make it an administrator, or turn ` +
      `off privacy mode with @BotFather /setprivacy`;
  } else if (status === 'left') {
    problem = `the bot isn't in ${name}: add it as an administrator`;
  } else if (status === 'unknown') {
    problem = `couldn't check the bot's rights in ${name}: ${reason}`;
  }
  const danger =
    username === null
      ? null
      : `${name} is a public group (@${username}): anyone can find it, ` +
        `join, and talk to Pero; make it private in the group's ` +
        `settings (Group type)`;
  return {
    chatKey,
    title,
    status,
    topics,
    username,
    problem,
    danger,
    checkedAt: new Date(),
  };
}

/** `rows` as a keyboard; none removes a message's keyboard. */
function keyboard(rows: ButtonRows): InlineKeyboardMarkup {
  for (const button of rows.flat()) {
    if (Buffer.byteLength(button.id) > MAX_BUTTON_ID_BYTES) {
      throw new Error(
        `Button ID ${button.id} is longer than ${MAX_BUTTON_ID_BYTES} bytes`,
      );
    }
  }
  return {
    inline_keyboard: rows
      .filter((row) => row.length > 0)
      .map((row) =>
        row.map(({ id, label }) => ({ text: label, callback_data: id })),
      ),
  };
}

/** Waits `ms`; an abort ends the wait early without an error. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
  });
}
