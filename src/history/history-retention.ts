import type { Dirent } from 'node:fs';
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type BeforeApplicationShutdown,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { Message } from '../persistence/entities/message.entity.js';
import { inTransaction } from '../persistence/transaction.js';
import { workspaceLayout } from '../config/workspace-layout.js';
import { Definitions } from '../system/definitions.js';
import { SystemNotes } from '../system/system-notes.service.js';

/** How often older messages are looked for. */
export const RETENTION_TICK_MS = 60 * 60_000;

/** The most messages one transaction deletes, so intake never waits long. */
export const RETENTION_BATCH_SIZE = 1_000;

const DAY_MS = 24 * 60 * 60_000;

/**
 * Deletes the messages the `history-retention-days` setting no longer
 * keeps, and the files people sent with them: once at startup and every
 * hour, so a changed setting applies within the hour. Unset, it keeps all
 * of them. Only message history is deleted; runs and Notifications keep
 * their text.
 */
@Injectable()
export class HistoryRetention
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger('History');
  /** The pass under way, if any. */
  private current: Promise<void> | null = null;
  private stopping = false;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly definitions: Definitions,
    private readonly notes: SystemNotes,
  ) {}

  /** Not awaited, so a long first pass does not hold up readiness. */
  onApplicationBootstrap(): void {
    void this.poll();
  }

  /** Lets a pass under way finish its batch before the database closes. */
  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    await this.current;
  }

  @Interval('history-retention', RETENTION_TICK_MS)
  onInterval(): void {
    void this.poll();
  }

  /**
   * Deletes every message sent before `now` less the retention, in
   * batches, and resolves to how many it deleted; 0 while the setting is
   * unset.
   */
  async prune(now: Date = new Date()): Promise<number> {
    const { historyRetentionDays: days } = this.definitions.defaults();
    if (days === null) return 0;
    const cutoff = new Date(now.getTime() - days * DAY_MS);
    let deleted = 0;
    while (!this.stopping) {
      const count = await inTransaction(this.dataSource, async (manager) => {
        const messages = manager.getRepository(Message);
        const rows = await messages
          .createQueryBuilder('message')
          .select('message.id', 'id')
          .where('message.createdAt < :cutoff', { cutoff })
          .orderBy('message.id', 'ASC')
          .limit(RETENTION_BATCH_SIZE)
          .getRawMany<{ id: number }>();
        if (rows.length > 0) await messages.delete(rows.map(({ id }) => id));
        return rows.length;
      });
      deleted += count;
      if (count < RETENTION_BATCH_SIZE) break;
    }
    if (deleted > 0) {
      this.logger.log(
        `Deleted ${deleted} ${deleted === 1 ? 'message' : 'messages'} older than ${days} ${days === 1 ? 'day' : 'days'}`,
      );
    }
    const files = this.stopping ? 0 : await this.pruneAttachments(cutoff);
    if (files > 0) {
      this.logger.log(
        `Deleted ${files} saved ${files === 1 ? 'file' : 'files'} older than ${days} ${days === 1 ? 'day' : 'days'}`,
      );
    }
    return deleted;
  }

  /**
   * Deletes the files people sent, images and others, saved under
   * `.pero/attachments/`, that were saved before `cutoff`, and resolves to
   * how many.
   */
  private async pruneAttachments(cutoff: Date): Promise<number> {
    const root = workspaceLayout(this.notes.folders().workspace).attachments;
    let folders: Dirent[];
    try {
      folders = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw error;
    }
    let deleted = 0;
    for (const folder of folders) {
      if (!folder.isDirectory()) continue;
      const dir = join(root, folder.name);
      for (const name of await readdir(dir)) {
        const path = join(dir, name);
        if ((await stat(path)).mtime < cutoff) {
          await rm(path, { force: true, recursive: true });
          deleted++;
        }
      }
    }
    return deleted;
  }

  /** One pass at a time, skipped while stopping; never throws. */
  private poll(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    this.current ??= this.prune()
      .then(() => undefined)
      .catch((error: unknown) => {
        this.logger.error(
          `Could not delete older messages: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      })
      .finally(() => {
        this.current = null;
      });
    return this.current;
  }
}
