import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { saveStream } from '../common/file-transfer.js';
import { fileReply } from './file-reply.js';
import { FileDelivery } from './file-delivery.js';
import { InvalidInputError, NotFoundError } from '../common/errors.js';
import { topicReply } from './topic-reply.js';
import {
  type Author,
  MessageHistory,
} from '../history/message-history.service.js';
import type { Channel } from '../persistence/entities/channel.entity.js';
import type { IntegrationKind } from '../persistence/entities/sql.js';
import { SpeechService } from '../speech/speech.service.js';
import { answerParts } from '../speech/voice-reply.js';
import type {
  ChannelAdapter,
  ChannelAddress,
  CreatedTopic,
  OutboundMessage,
  OutboundVoice,
  SentMessage,
} from './channel-adapter.js';

/** What sending an answer did. */
export interface SentAnswer {
  /** The first message sent. */
  sent: SentMessage;
  /** The answer as the Channel's history keeps it. */
  text: string;
}

/** Starts a voice message's words in the history. */
export const VOICE_LINE = '[Voice message]';

/** The connected adapters, one per integration, and sending through them. */
@Injectable()
export class ChannelSender {
  private readonly logger = new Logger('Channels');
  private readonly adapters = new Map<IntegrationKind, ChannelAdapter>();
  private readonly topicRequests = new Map<
    string,
    {
      kind: IntegrationKind;
      address: string;
      messageId: string;
      name: string;
      expires: number;
    }
  >();

  constructor(
    private readonly history: MessageHistory,
    private readonly speech: SpeechService,
    private readonly files: FileDelivery,
  ) {}

  add(adapter: ChannelAdapter): void {
    if (this.adapters.has(adapter.kind)) {
      throw new Error(`A ${adapter.kind} adapter is already connected`);
    }
    this.adapters.set(adapter.kind, adapter);
  }

  all(): ChannelAdapter[] {
    return [...this.adapters.values()];
  }

  async createTopic(
    kind: IntegrationKind,
    address: ChannelAddress,
    name: string,
  ): Promise<CreatedTopic> {
    const adapter = this.adapter(kind);
    if (adapter.createTopic === undefined) {
      throw new InvalidInputError('This integration cannot create topics');
    }
    return adapter.createTopic(address, name);
  }

  /** Claims a proposal once, only from the message and topic it was sent in. */
  async confirmTopic(
    kind: IntegrationKind,
    address: ChannelAddress,
    messageId: string,
    id: string,
    allow: boolean,
  ): Promise<CreatedTopic | null> {
    const request = this.topicRequests.get(id);
    if (
      request === undefined ||
      request.expires <= Date.now() ||
      request.kind !== kind ||
      request.address !== addressKey(address) ||
      request.messageId !== messageId
    ) {
      throw new NotFoundError('This topic request has expired; ask Pero again');
    }
    this.topicRequests.delete(id);
    return allow ? this.createTopic(kind, address, request.name) : null;
  }

  async send(
    kind: IntegrationKind,
    address: ChannelAddress,
    message: OutboundMessage,
  ): Promise<SentMessage> {
    return this.adapter(kind).send(address, message);
  }

  /** Sends `voice` through `kind` as a voice message. */
  async sendVoice(
    kind: IntegrationKind,
    address: ChannelAddress,
    voice: OutboundVoice,
  ): Promise<SentMessage> {
    return this.adapter(kind).sendVoice(address, voice);
  }

  /**
   * Sends an agent's `answer`, part by part in order: the text as
   * Markdown, shown as the integration's formatting, and each `<voice>`
   * block recorded and sent as a voice message. A block that can't be
   * recorded goes out as text, saying why. An answer without blocks is
   * sent as one text. Throws when a send fails; the parts before
   * it are out by then.
   */
  async sendAnswer(
    kind: IntegrationKind,
    address: ChannelAddress,
    answer: string,
    workingDirectory?: string,
  ): Promise<SentAnswer> {
    const reply = topicReply(answer);
    if (reply.names.length > 0) {
      let first: SentMessage | undefined;
      const texts: string[] = [];
      if (reply.text !== '') {
        const body = await this.sendBody(
          kind,
          address,
          reply.text,
          workingDirectory,
        );
        first = body.sent;
        texts.push(body.text);
      }
      for (const name of reply.names) {
        for (const [id, request] of this.topicRequests) {
          if (request.expires <= Date.now()) this.topicRequests.delete(id);
        }
        if (this.topicRequests.size >= 1000) {
          throw new InvalidInputError(
            'Too many pending topic requests; try again later',
          );
        }
        const id = randomBytes(12).toString('base64url');
        const text = `Create topic: ${name}?`;
        const sent = await this.send(kind, address, {
          text,
          buttons: [
            [
              { id: `/topic_confirm ${id} yes`, label: 'Create topic' },
              { id: `/topic_confirm ${id} no`, label: 'Cancel' },
            ],
          ],
        });
        this.topicRequests.set(id, {
          kind,
          address: addressKey(address),
          messageId: sent.messageId,
          name,
          expires: Date.now() + 15 * 60_000,
        });
        first ??= sent;
        texts.push(text);
      }
      return { sent: first!, text: texts.join('\n\n') };
    }
    return this.sendBody(kind, address, answer, workingDirectory);
  }

  private async sendBody(
    kind: IntegrationKind,
    address: ChannelAddress,
    answer: string,
    workingDirectory?: string,
  ): Promise<SentAnswer> {
    const reply = fileReply(answer);
    if (reply.paths.length === 0) return this.sendParts(kind, address, answer);
    let first: SentMessage | undefined;
    const kept: string[] = [];
    if (reply.text !== '') {
      const body = await this.sendParts(kind, address, reply.text);
      first = body.sent;
      kept.push(body.text);
    }
    for (const path of reply.paths) {
      try {
        const result = await this.files.deliver(
          this.adapter(kind),
          address,
          path,
          workingDirectory,
        );
        first ??= result.sent;
        kept.push(result.text);
        if (result.text.includes('unavailable;'))
          await this.send(kind, address, { text: result.text });
      } catch (error) {
        const text = `Pero couldn't send a result file: ${describe(error)}. Ask it to correct the file or produce a smaller preview.`;
        const sent = await this.send(kind, address, { text });
        first ??= sent;
        kept.push(text);
      }
    }
    return { sent: first!, text: kept.join('\n\n') };
  }

  private async sendParts(
    kind: IntegrationKind,
    address: ChannelAddress,
    answer: string,
  ): Promise<SentAnswer> {
    const parts = answerParts(answer);
    if (!parts.some((part) => part.kind === 'voice')) {
      return {
        sent: await this.send(kind, address, { text: answer, markdown: true }),
        text: answer,
      };
    }
    let first: SentMessage | null = null;
    const kept: string[] = [];
    for (const part of parts) {
      let sent: SentMessage;
      if (part.kind === 'text') {
        sent = await this.send(kind, address, {
          text: part.text,
          markdown: true,
        });
        kept.push(part.text);
      } else {
        let voice: OutboundVoice | null = null;
        let problem = '';
        try {
          voice = await this.speech.speak(part.text);
        } catch (error) {
          problem = describe(error).replace(/\.$/, '');
          this.logger.warn(`Failed to record a voice message: ${problem}`);
        }
        if (voice === null) {
          const text =
            `${part.text}\n\n` +
            `(Pero couldn't send this as a voice message: ${problem}.)`;
          sent = await this.send(kind, address, { text });
          kept.push(text);
        } else {
          sent = await this.sendVoice(kind, address, voice);
          kept.push(`${VOICE_LINE}\n${part.text}`);
        }
      }
      first ??= sent;
    }
    return { sent: first!, text: kept.join('\n\n') };
  }

  /**
   * Sends an agent's `answer` to `channel` as `sendAnswer` does, then
   * records it in the Channel's history, its voice messages as their
   * words. A failed record is only logged.
   */
  async postAnswer(
    channel: Pick<Channel, 'id' | 'integrationKind' | 'address'>,
    answer: string,
    author: Author,
    workingDirectory?: string,
  ): Promise<SentMessage> {
    const { sent, text } = await this.sendAnswer(
      channel.integrationKind,
      channel.address,
      answer,
      workingDirectory,
    );
    await this.record(channel, sent, text, author);
    return sent;
  }

  /** The key of the chat `address` belongs to; see `ChannelAdapter`. */
  chatKey(kind: IntegrationKind, address: ChannelAddress): string {
    return this.adapter(kind).chatKey(address);
  }

  /** The contents of a file a message from `kind` came with. */
  download(kind: IntegrationKind, ref: string): Promise<Uint8Array> {
    return this.adapter(kind).download(ref);
  }

  async downloadTo(
    kind: IntegrationKind,
    ref: string,
    path: string,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<number> {
    const adapter = this.adapter(kind);
    if (adapter.downloadTo !== undefined)
      return adapter.downloadTo(ref, path, maxBytes, signal);
    const data = await adapter.download(ref);
    signal?.throwIfAborted();
    return saveStream(
      path,
      (async function* () {
        yield data;
      })(),
      maxBytes,
    );
  }

  /** Replaces the text and buttons of a message sent through `kind`. */
  async edit(
    kind: IntegrationKind,
    address: ChannelAddress,
    messageId: string,
    message: OutboundMessage,
  ): Promise<void> {
    return this.adapter(kind).edit(address, messageId, message);
  }

  /**
   * Marks received message `messageId` in `channel` as being answered, or
   * clears the mark. Best-effort: a failure is only logged.
   */
  async showWorking(
    channel: Pick<Channel, 'id' | 'integrationKind' | 'address'>,
    messageId: string,
    working: boolean,
  ): Promise<void> {
    try {
      await this.adapter(channel.integrationKind).showWorking(
        channel.address,
        messageId,
        working,
      );
    } catch (error) {
      this.logger.debug(
        `Failed to ${working ? 'mark' : 'unmark'} message ${messageId} ` +
          `in Channel ${channel.id}: ${describe(error)}`,
      );
    }
  }

  /**
   * Sends `text` to `channel`, then records it in the Channel's history. A
   * failed send throws and records nothing; a failed record is only logged,
   * since the message is out by then.
   */
  async post(
    channel: Pick<Channel, 'id' | 'integrationKind' | 'address'>,
    text: string,
    author: Author,
  ): Promise<SentMessage> {
    const sent = await this.send(channel.integrationKind, channel.address, {
      text,
    });
    await this.record(channel, sent, text, author);
    return sent;
  }

  private async record(
    channel: Pick<Channel, 'id'>,
    sent: SentMessage,
    text: string,
    author: Author,
  ): Promise<void> {
    try {
      await this.history.recordOutbound({
        channelId: channel.id,
        externalMessageId: sent.messageId,
        text,
        author,
      });
    } catch (error) {
      this.logger.error(
        `Failed to record a message sent in Channel ${channel.id}: ` +
          describe(error),
      );
    }
  }

  private adapter(kind: IntegrationKind): ChannelAdapter {
    const adapter = this.adapters.get(kind);
    if (!adapter) throw new Error(`No ${kind} adapter is connected`);
    return adapter;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function addressKey(address: ChannelAddress): string {
  return JSON.stringify(
    Object.entries(address).sort(([a], [b]) => a.localeCompare(b)),
  );
}
