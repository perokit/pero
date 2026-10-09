import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Chat, Update, UserFromGetMe } from 'grammy/types';

/** One call the fake received. */
export interface FakeBotApiCall {
  token: string;
  method: string;
  payload: Record<string, unknown>;
}

/** An error answer, as the Bot API sends one. */
export interface FakeBotApiError {
  error_code: number;
  description: string;
  parameters?: { retry_after?: number; migrate_to_chat_id?: number };
}

/** An update without its ID, which the fake assigns in order. */
export type UpdateBody = Omit<Update, 'update_id'>;

interface HeldPoll {
  offset: number;
  limit: number;
  respond(updates: Update[]): void;
}

/**
 * An in-process Telegram Bot API over real HTTP, so tests exercise grammY's
 * own client. `push` queues updates for long polling; `calls` records every
 * request. Answers can be scripted per method with `failNext`, a token
 * rejected with `rejectToken`, and the whole server made unreachable with
 * `down`.
 */
export class FakeBotApi {
  readonly calls: FakeBotApiCall[] = [];
  me: UserFromGetMe = {
    id: 7000001,
    is_bot: true,
    first_name: 'Pero',
    username: 'pero_test_bot',
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
    has_topics_enabled: false,
    allows_users_to_create_topics: false,
    can_manage_bots: false,
    supports_join_request_queries: false,
  };
  /** The bot's status in each chat; `administrator` when not listed. */
  readonly memberStatus = new Map<string, string>();
  /** Whether the bot has the topic management permission in each group. */
  readonly manageTopics = new Map<string, boolean>();
  /** Chats that became supergroups: sending there names the new ID. */
  readonly migrated = new Map<string, number>();
  /** What `getChat` answers, by chat ID; any other chat is not found. */
  readonly chats = new Map<string, Chat>();
  /** Files the bot can download, by file ID; any other ID is invalid. */
  readonly files = new Map<string, Uint8Array>();
  readonly filePaths = new Map<string, string>();

  private server: Server | null = null;
  private readonly updates: Update[] = [];
  private nextUpdateId = 1;
  private nextMessageId = 1;
  private readonly held = new Set<HeldPoll>();
  private readonly failures = new Map<string, FakeBotApiError[]>();
  private readonly rejected = new Set<string>();
  private isDown = false;

  /** The API root to hand grammY, without a trailing slash. */
  get url(): string {
    const address = this.server?.address() as AddressInfo | null;
    if (!address) throw new Error('The fake Bot API is not listening');
    return `http://127.0.0.1:${address.port}`;
  }

  async listen(): Promise<void> {
    const server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    this.server = server;
  }

  async close(): Promise<void> {
    for (const poll of this.held) poll.respond([]);
    const server = this.server;
    this.server = null;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** Queues `update` for the next poll and returns its update ID. */
  push(update: UpdateBody): number {
    const full = { ...update, update_id: this.nextUpdateId++ } as Update;
    this.updates.push(full);
    for (const poll of this.held) this.answerPoll(poll);
    return full.update_id;
  }

  /** Makes the next calls of `method` fail with `errors`, one each. */
  failNext(method: string, ...errors: FakeBotApiError[]): void {
    this.failures.set(method, [
      ...(this.failures.get(method) ?? []),
      ...errors,
    ]);
  }

  /** Answers every call made with `token` with 401 Unauthorized. */
  rejectToken(token: string): void {
    this.rejected.add(token);
  }

  /** Drops every connection, as an unreachable server would. */
  down(): void {
    this.isDown = true;
    for (const poll of this.held) poll.respond([]);
  }

  up(): void {
    this.isDown = false;
  }

  /** Every call of `method`, in order. */
  callsOf(method: string): FakeBotApiCall[] {
    return this.calls.filter((call) => call.method === method);
  }

  /** The payloads of every `sendMessage` call, in order. */
  sent(): Record<string, unknown>[] {
    return this.callsOf('sendMessage').map((call) => call.payload);
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    if (this.isDown) {
      req.socket.destroy();
      return;
    }
    const download = /^\/file\/bot([^/]+)\/files\/([^/]+)$/.exec(req.url ?? '');
    if (download) return this.download(res, download[1]!, download[2]!);
    const match = /^\/bot([^/]+)\/(\w+)$/.exec(req.url ?? '');
    if (!match) return this.reply(res, 404, { ok: false, error_code: 404 });
    const [, token, method] = match as unknown as [string, string, string];
    const payload = await readPayload(req);
    this.calls.push({ token, method, payload });

    if (this.rejected.has(token)) {
      return this.fail(res, { error_code: 401, description: 'Unauthorized' });
    }
    const failure = this.failures.get(method)?.shift();
    if (failure) return this.fail(res, failure);

    switch (method) {
      case 'getMe':
        return this.ok(res, this.me);
      case 'deleteWebhook':
        return this.ok(res, true);
      case 'getUpdates':
        return this.poll(req, res, payload);
      case 'getChatMember':
        return this.ok(res, {
          status:
            this.memberStatus.get(String(payload.chat_id)) ?? 'administrator',
          user: this.me,
          can_manage_topics:
            this.manageTopics.get(String(payload.chat_id)) ?? true,
        });
      case 'createForumTopic':
        return this.ok(res, {
          message_thread_id: this.nextMessageId++,
          name: payload.name,
          icon_color: 7322096,
        });
      case 'getChat':
        return this.getChat(res, payload);
      case 'getFile':
        return this.getFile(res, payload);
      case 'sendMessage':
        return this.sendMessage(res, payload);
      case 'sendVoice':
      case 'sendAudio':
      case 'sendPhoto':
      case 'sendDocument':
      case 'sendVideo':
        return this.sendMessage(res, payload);
      case 'editMessageText':
        return this.ok(res, {
          message_id: payload.message_id,
          date: Math.floor(Date.now() / 1000),
          chat: {
            id: Number(payload.chat_id),
            type: 'supergroup',
            title: 'Chat',
          },
          text: payload.text,
        });
      case 'answerCallbackQuery':
      case 'setMyCommands':
      case 'setMessageReaction':
        return this.ok(res, true);
      default:
        return this.fail(res, {
          error_code: 404,
          description: `Not Found: method ${method} not faked`,
        });
    }
  }

  private getChat(res: ServerResponse, payload: Record<string, unknown>) {
    const chat = this.chats.get(String(payload.chat_id));
    if (chat === undefined) {
      return this.fail(res, {
        error_code: 400,
        description: 'Bad Request: chat not found',
      });
    }
    return this.ok(res, {
      ...chat,
      accent_color_id: 0,
      max_reaction_count: 11,
    });
  }

  private getFile(res: ServerResponse, payload: Record<string, unknown>) {
    const fileId = String(payload.file_id);
    const file = this.files.get(fileId);
    if (file === undefined) {
      return this.fail(res, {
        error_code: 400,
        description: 'Bad Request: invalid file_id',
      });
    }
    return this.ok(res, {
      file_id: fileId,
      file_unique_id: `unique-${fileId}`,
      file_size: file.length,
      file_path: this.filePaths.get(fileId) ?? `files/${fileId}`,
    });
  }

  /** Serves a file `getFile` named, to the token that asked for it. */
  private download(res: ServerResponse, token: string, fileId: string) {
    const file = this.files.get(fileId);
    this.calls.push({
      token,
      method: 'download',
      payload: { file_id: fileId },
    });
    if (file === undefined || this.rejected.has(token)) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(file);
  }

  private sendMessage(res: ServerResponse, payload: Record<string, unknown>) {
    const chatId = String(payload.chat_id);
    const movedTo = this.migrated.get(chatId);
    if (movedTo !== undefined) {
      return this.fail(res, {
        error_code: 400,
        description:
          'Bad Request: group chat was upgraded to a supergroup chat',
        parameters: { migrate_to_chat_id: movedTo },
      });
    }
    return this.ok(res, {
      message_id: this.nextMessageId++,
      date: Math.floor(Date.now() / 1000),
      chat: { id: Number(chatId), type: 'supergroup', title: 'Chat' },
      text: payload.text,
      ...(payload.message_thread_id === undefined
        ? {}
        : { message_thread_id: payload.message_thread_id }),
    });
  }

  private poll(
    req: IncomingMessage,
    res: ServerResponse,
    payload: Record<string, unknown>,
  ) {
    const offset = Number(payload.offset ?? 0);
    const limit = Number(payload.limit ?? 100);
    const timeoutMs = Number(payload.timeout ?? 0) * 1000;
    // Updates before the offset are confirmed; Telegram forgets them.
    while (this.updates.length > 0 && this.updates[0]!.update_id < offset) {
      this.updates.shift();
    }
    let timer: NodeJS.Timeout | undefined;
    const poll: HeldPoll = {
      offset,
      limit,
      respond: (updates) => {
        if (!this.held.delete(poll)) return;
        clearTimeout(timer);
        if (this.isDown) req.socket.destroy();
        else this.ok(res, updates);
      },
    };
    this.held.add(poll);
    req.on('close', () => this.held.delete(poll));
    if (this.answerPoll(poll)) return;
    if (timeoutMs === 0) return poll.respond([]);
    timer = setTimeout(() => poll.respond([]), timeoutMs);
  }

  /** Answers `poll` when updates are waiting for it. */
  private answerPoll(poll: HeldPoll): boolean {
    const ready = this.updates
      .filter((update) => update.update_id >= poll.offset)
      .slice(0, poll.limit);
    if (ready.length === 0) return false;
    poll.respond(ready);
    return true;
  }

  private ok(res: ServerResponse, result: unknown) {
    this.reply(res, 200, { ok: true, result });
  }

  private fail(res: ServerResponse, error: FakeBotApiError) {
    this.reply(res, error.error_code, { ok: false, ...error });
  }

  private reply(res: ServerResponse, status: number, body: unknown) {
    if (res.writableEnded || res.destroyed) return;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }
}

/** A file uploaded with a call, as `payload` records it. */
export interface FakeUpload {
  name: string;
  bytes: Uint8Array;
}

/**
 * A call's parameters: from JSON, or from a multipart upload, whose files
 * become `FakeUpload`s and whose other fields stay the strings sent.
 */
async function readPayload(
  req: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks);
  const type = req.headers['content-type'] ?? '';
  const boundary = /^multipart\/form-data;\s*boundary=(.+)$/.exec(type)?.[1];
  if (boundary !== undefined) return readMultipart(body, boundary);
  const text = body.toString('utf8');
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

/**
 * grammY's multipart upload, read leniently: its part headers are not
 * quoted the way stricter parsers want. A field naming `attach://<part>`
 * becomes that part's file.
 */
function readMultipart(
  body: Buffer,
  boundary: string,
): Record<string, unknown> {
  const fields = new Map<string, string>();
  const files = new Map<string, FakeUpload>();
  const delimiter = Buffer.from(`--${boundary}`);
  let start = body.indexOf(delimiter);
  while (start !== -1) {
    const next = body.indexOf(delimiter, start + delimiter.length);
    if (next === -1) break;
    // Each part: CRLF, its headers, a blank line, its content, then CRLF.
    const part = body.subarray(start + delimiter.length + 2, next - 2);
    const split = part.indexOf('\r\n\r\n');
    const headers = part.subarray(0, split).toString('utf8');
    const content = part.subarray(split + 4);
    const name = /name="?([^";\r\n]+)"?/i.exec(headers)?.[1] ?? '';
    const filename = /filename="?([^";\r\n]+)"?/i.exec(headers)?.[1];
    if (filename === undefined) fields.set(name, content.toString('utf8'));
    else files.set(name, { name: filename, bytes: new Uint8Array(content) });
    start = next;
  }
  const payload: Record<string, unknown> = {};
  for (const [name, value] of fields) {
    const attached = /^attach:\/\/(.+)$/.exec(value)?.[1];
    payload[name] =
      attached === undefined ? value : (files.get(attached) ?? value);
  }
  return payload;
}
