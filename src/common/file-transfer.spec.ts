import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { responseChunks, saveStream } from './file-transfer.js';

describe('bounded streamed files', () => {
  it('writes actual streamed bytes, owner-only, without buffering the response', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'pero-transfer-'));
    try {
      const path = join(folder, 'large.zip');
      const size = await saveStream(
        path,
        (async function* () {
          for (let i = 0; i < 22; i++)
            yield new Uint8Array(1024 * 1024).fill(i);
        })(),
        23 * 1024 * 1024,
      );
      expect(size).toBe(22 * 1024 * 1024);
      expect((await stat(path)).size).toBe(size);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
  it('checks actual bytes without relying on headers and removes partial files', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'pero-transfer-'));
    try {
      const path = join(folder, 'file');
      await expect(
        saveStream(path, responseChunks(new Response('123456')), 5),
      ).rejects.toThrow('limit');
      await expect(stat(path)).rejects.toThrow();
      await writeFile(path, 'keep');
      await expect(
        saveStream(path, responseChunks(new Response('new')), 5),
      ).rejects.toThrow();
      expect(await readFile(path, 'utf8')).toBe('keep');
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
});
