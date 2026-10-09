import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_FILES, DEFAULT_SPEECH } from '../config/host-config.js';
import type { HostConfigService } from '../host-config/host-config.service.js';
import type { ChannelAdapter, OutboundFile } from './channel-adapter.js';
import { FileDelivery } from './file-delivery.js';

describe('file result delivery', () => {
  it('streams intended files to the right topic and records bytes and elapsed time', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pero-delivery-'));
    try {
      await mkdir(join(root, 'data'));
      await writeFile(join(root, 'song.mp3'), 'mp3');
      const config = {
        folders: () => ({ workspace: root, dataFolder: join(root, 'data') }),
        files: () => ({ ...DEFAULT_FILES, previews: false }),
        speech: () => DEFAULT_SPEECH,
      } as HostConfigService;
      const calls: { file: OutboundFile; address: unknown; bytes: Buffer }[] =
        [];
      const adapter = {
        sendFile: async (address, file) => {
          const chunks: Buffer[] = [];
          for await (const chunk of file.source())
            chunks.push(Buffer.from(chunk));
          calls.push({ address, file, bytes: Buffer.concat(chunks) });
          return { messageId: '42' };
        },
      } as ChannelAdapter;
      const target = { chatId: '-100123', messageThreadId: '7' };
      const result = await new FileDelivery(config).deliver(
        adapter,
        target,
        'song.mp3',
      );
      expect(result.sent.messageId).toBe('42');
      expect(calls[0]?.address).toEqual(target);
      expect(calls[0]?.file.kind).toBe('audio');
      expect(calls[0]?.bytes.toString()).toBe('mp3');
      const event = JSON.parse(
        (await readFile(join(root, '.pero/file-events.jsonl'), 'utf8')).trim(),
      ) as {
        bytes: number;
        elapsedMs: number;
        operation: string;
        status: string;
      };
      expect(event).toMatchObject({
        bytes: 3,
        operation: 'upload',
        status: 'ok',
      });
      expect(event.elapsedMs).toBeGreaterThanOrEqual(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('rejects hidden/private files, traversal and symlinks outside the working folder', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pero-delivery-'));
    const other = await mkdtemp(join(tmpdir(), 'pero-secret-'));
    try {
      await mkdir(join(root, 'data'));
      await writeFile(join(root, '.env'), 'token');
      await writeFile(join(root, 'auth.json'), 'token');
      await writeFile(join(other, 'outside.txt'), 'private');
      await symlink(join(other, 'outside.txt'), join(root, 'public.txt'));
      const config = {
        folders: () => ({ workspace: root, dataFolder: join(root, 'data') }),
        files: () => DEFAULT_FILES,
      } as HostConfigService;
      const delivery = new FileDelivery(config);
      const adapter = {
        sendFile: () => Promise.resolve({ messageId: '1' }),
      } as unknown as ChannelAdapter;
      for (const name of [
        '.env',
        'auth.json',
        'public.txt',
        join(other, 'outside.txt'),
      ])
        await expect(delivery.deliver(adapter, {}, name)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(other, { recursive: true, force: true });
    }
  });
});
